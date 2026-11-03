/**
 * @meng/spill —— 工具输出溢出落盘 (seam)。
 *
 * 为什么它不是 fs 的一部分:
 *   fs 管的是"工作区里的文件", spill 管的是"一次工具调用的产物"。
 *   两者语义冲突 —— spill 的东西必须**临时**、**可清理**、
 *   **不该被 glob/grep 搜到** (否则模型搜代码会搜出一堆自己的历史输出),
 *   也**不该计入"已观察"** (否则污染先读后写策略的记账)。
 *   所以它是一条独立的缝, 内部直接用 node:fs, 不经过 @meng/fs。
 *
 * 它和截断的关系:
 *   截断 = 丢弃。**瞬时产物** (bash 输出、grep 命中) 一丢就永远没了。
 *   spill = 落盘 + 回一个 locator, 模型想看全量自己 read 分段取回。
 *   read 工具本来就带 offset/limit, 召回路径是现成的, 不用新工具。
 *
 * 决定"多大算溢出"不在这里 —— 那是部署决策, 归 policy-spill。
 * 这一包只提供存放、取回、列举、清理四个动作。
 */

import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const name = 'meng-spill'
export const inject: string[] = []

export class SpillError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface SpillRef {
  id: string
  /** 相对工作区的路径 —— 给模型看, 拿去 read */
  rel: string
  /** 绝对路径, 内部与策略用 */
  path: string
  bytes: number
  tool?: string
  createdAt: number
}

export interface SpillInput {
  text: string
  tool?: string
  callId?: string
  /** 写完后只保留最新的 N 个。不传 = 不清理, 由调用方决定 */
  keep?: number
}

export interface PruneOptions {
  /** 超过这个年龄的文件清掉。0 = 全部清掉 */
  maxAgeMs?: number
  /** 只保留最新的 N 个 */
  maxFiles?: number
}

export interface SpillService {
  readonly dir: string
  readonly relDir: string
  /** 落盘并返回引用。文件数超限时顺手清一次, 避免无限堆积 */
  write(input: SpillInput): Promise<SpillRef>
  /** 取回全量。只认本目录内的路径, 越界抛 SPILL_OUT_OF_DIR */
  read(ref: string): Promise<string>
  list(): Promise<SpillRef[]>
  prune(options?: PruneOptions): Promise<number>
  /** 给模型看的那一行: 落哪了、多大、怎么取回 */
  locator(ref: SpillRef): string
}

export interface Config {
  root?: string
  /** 相对 root 的落盘目录。必须在 glob/grep 的 IGNORE 里, 否则模型会搜到自己的输出 */
  relDir?: string
}

/**
 * 建一个落盘仓库。抽成工厂是为了让 invariant 能在临时目录里自检,
 * 而不是往用户工作区里塞测试文件。
 */
export function createSpill(dir: string, relDir: string, emit?: (ref: SpillRef) => void): SpillService {
  function inDir(ref: string): string {
    const clean = ref.split('\\').join('/')
    // 先把 '..' 挡在门外: basename 会把 ../../etc/passwd 削成 passwd,
    // 于是"越界"退化成"文件不存在", 而这两件事对调用方含义完全不同
    if (clean.split('/').includes('..')) {
      throw new SpillError('SPILL_OUT_OF_DIR', `只允许读本目录内的溢出文件: ${ref}`)
    }
    // 既能接 rel (`.meng/spill/xxx.txt`) 也能接裸文件名
    const name = clean.startsWith(relDir + '/') ? clean.slice(relDir.length + 1) : basename(clean)
    const target = resolve(dir, name)
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new SpillError('SPILL_OUT_OF_DIR', `只允许读本目录内的溢出文件: ${ref}`)
    }
    return target
  }

  function parseName(file: string): { id: string; tool?: string } {
    const stem = file.replace(/\.txt$/, '')
    const parts = stem.split('-')
    const id = parts.length > 1 ? (parts[parts.length - 1] as string) : stem
    const tool = parts.length > 2 ? parts.slice(1, -1).join('-') : undefined
    return { id, ...(tool ? { tool } : {}) }
  }

  async function statOne(file: string): Promise<SpillRef> {
    const path = join(dir, file)
    const s = await stat(path)
    const { id, tool } = parseName(file)
    return {
      id,
      rel: `${relDir}/${file}`.split(sep).join('/'),
      path,
      bytes: s.size,
      ...(tool ? { tool } : {}),
      createdAt: s.mtimeMs,
    }
  }

  async function list(): Promise<SpillRef[]> {
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.txt'))
    } catch {
      return []
    }
    const out: SpillRef[] = []
    for (const f of files) {
      try {
        out.push(await statOne(f))
      } catch {
        // 读到一半被清理掉的文件, 跳过
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  return {
    dir,
    relDir,

    async write(input) {
      await mkdir(dir, { recursive: true })
      const tool = (input.tool ?? 'out').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'out'
      const id = randomUUID().slice(0, 8)
      const stamp = new Date().toISOString().slice(0, 10).split('-').join('')
      const file = `${stamp}-${tool}-${id}.txt`
      const path = join(dir, file)
      await writeFile(path, input.text, 'utf8')
      const s = await stat(path)
      const ref: SpillRef = {
        id,
        rel: `${relDir}/${file}`.split(sep).join('/'),
        path,
        bytes: s.size,
        tool,
        createdAt: s.mtimeMs,
      }
      emit?.(ref)
      // 机会性清理: 每次落盘顺手把超额的旧文件清掉。
      // 不能指望"以后有人调 prune" —— 长会话里 spill 是最容易无限堆积的东西
      if (input.keep && input.keep > 0) await this.prune({ maxFiles: input.keep })
      return ref
    },

    async read(ref) {
      return await readFile(inDir(ref), 'utf8')
    },

    list,

    async prune(options = {}) {
      const all = await list()
      // "没传" 和 "传了 0" 是两件事: 后者是"全清", 用来做测试与重置。
      // 用 ?? 0 会把两者混为一谈 —— 于是 prune({maxAgeMs: 0}) 变成空操作
      const byAge = options.maxAgeMs !== undefined
      const maxAgeMs = options.maxAgeMs ?? 0
      const maxFiles = options.maxFiles ?? 0
      const now = Date.now()
      let removed = 0
      for (const ref of all) {
        const tooOld = byAge && now - ref.createdAt >= maxAgeMs
        const tooMany = maxFiles > 0 ? all.indexOf(ref) >= maxFiles : false
        if (!tooOld && !tooMany) continue
        try {
          await unlink(ref.path)
          removed++
        } catch {
          // 已被别的进程清掉, 不算失败
        }
      }
      return removed
    },

    locator(ref) {
      return (
        `[完整输出已落盘] ${ref.rel} · 共 ${ref.bytes} 字节 · ` +
        `用 read 分段取回 (offset/limit, 每次 ≤ 51200 字节)`
      )
    },
  }
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const root = resolve((config.root ?? process.env.MENG_WORKSPACE) || process.cwd())
  const relDir = config.relDir ?? '.meng/spill'
  const service = createSpill(join(root, relDir), relDir, (ref) => {
    ctx.emit('spill/written', ref)
  })
  ctx.set('spill', service)
  return () => undefined
}

export const invariant = defineInvariant('@meng/spill', [
  {
    id: 'service-registered',
    run(ctx) {
      const spill = ctx.get<SpillService>('spill')
      if (!spill) throw new Error('能力面 spill 未注册')
      if (typeof spill.write !== 'function') throw new Error('spill.write 缺失')
    },
  },
  {
    // 落盘再取回必须逐字节一致 —— 落了却读不回来比不落更糟:
    // 模型拿着 locator 去 read, 拿到的是截断版, 等于被骗了一次
    id: 'roundtrip-is-lossless',
    async run() {
      const dir = join(tmpdir(), `meng-spill-invariant-${randomUUID().slice(0, 8)}`)
      const spill = createSpill(dir, '.meng/spill')
      try {
        const big = 'x'.repeat(2000) + '\n第二行\n第三行\n'
        const ref = await spill.write({ text: big, tool: 'invariant' })
        const back = await spill.read(ref.rel)
        if (back !== big) throw new Error(`取回内容不一致: ${back.length} vs ${big.length} 字节`)
        if (ref.bytes !== Buffer.byteLength(big)) throw new Error('落盘大小统计不准')
        const listed = await spill.list()
        if (listed.length !== 1) throw new Error(`list 应只有 1 个, 实际 ${listed.length}`)
        const gone = await spill.prune({ maxAgeMs: 0 })
        if (gone !== 1) throw new Error(`prune 应删 1 个, 实际 ${gone}`)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  },
  {
    id: 'read-blocks-escape',
    async run() {
      const dir = join(tmpdir(), `meng-spill-invariant-${randomUUID().slice(0, 8)}`)
      const spill = createSpill(dir, '.meng/spill')
      try {
        await spill.read('../../etc/passwd')
        throw new Error('越出溢出目录的读取竟被放行')
      } catch (err) {
        if (err instanceof SpillError && err.code === 'SPILL_OUT_OF_DIR') return
        throw err
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  },
])
