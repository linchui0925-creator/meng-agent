/**
 * @meng/fs —— 文件能力面 (seam)。
 *
 * 抄 dsh 的分层真相: 19 个 dsh-tool-* 是薄壳, 真活在 ctx.fs / ctx.shell / ctx.jobs
 * 这些 seam 里。工具不许 import node:fs —— 这条将来进 lint。
 * 这样托管版换一个 fs 提供方 (只读 / 虚拟 / 远端), 工具一行都不用改。
 *
 * 两类入口:
 *   - 读: readText / stat / listDir。读成功会广播 `fs/read`
 *     (观察策略靠它记账"模型读过什么")
 *   - 写: writeText / editText。写之前必过两个**单决策槽**:
 *       fs/write-intent / fs/edit-intent
 *     占槽的策略可以抛错否决 (FS_NOT_OBSERVED / FS_SENSITIVE / FS_OUT_OF_ROOT)。
 *     没人占槽 = 裸提供方 = 无条件写 —— "先读后写"是部署决策, 不是硬编码。
 *
 * 路径围栏在这里就有一道 (越界抛 FS_OUT_OF_ROOT), 不是因为不信任策略插件,
 * 而是纵深防御: 哪天策略被卸载, 工具本身也读不到 root 之外。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const name = 'meng-fs'
export const inject: string[] = []

/** 带错误码的异常: 工具层据此给模型回可操作的错误信息 */
export class FsError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface FsStat {
  exists: boolean
  isFile: boolean
  isDir: boolean
  size: number
  mtimeMs: number
}

/** read 的原始产物。截断/行号/字节上限是 tool-fs 的职责, seam 只管读 */
export interface ReadResult {
  /** 相对 root 的路径 —— 给模型看, 不回显宿主机绝对路径 */
  rel: string
  totalLines: number
  lines: string[]
}

export interface WriteResult {
  rel: string
  operation: 'create' | 'update'
  bytes: number
}

export interface EditResult {
  rel: string
  replaced: number
}

export interface FsIntent {
  kind: 'write' | 'edit'
  /** 绝对路径, seam 与策略内部用 */
  path: string
  /** 相对 root */
  rel: string
  /** 目标文件当前是否存在 (先读后写策略的判断依据) */
  exists: boolean
}

export interface FsService {
  readonly root: string
  /** 解析并围栏。越界直接抛 FS_OUT_OF_ROOT */
  resolve(input: string): string
  stat(rel: string): Promise<FsStat>
  readText(rel: string): Promise<ReadResult>
  writeText(rel: string, content: string): Promise<WriteResult>
  editText(rel: string, oldString: string, newString: string, replaceAll: boolean): Promise<EditResult>
  listDir(rel: string): Promise<Array<{ name: string; dir: boolean; size: number }>>
}

export interface Config {
  root?: string
}

/** 纯函数版围栏。invariant 用它自检, 不走工具管线 */
export function isWithin(root: string, target: string): boolean {
  const abs = resolve(root, target)
  return abs === root || abs.startsWith(root + sep)
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const root = resolve(config.root ?? process.cwd())

  function safeResolve(input: unknown): string {
    const raw = String(input ?? '')
    if (!raw) throw new FsError('FS_EMPTY_PATH', '缺少路径参数')
    const abs = resolve(root, raw)
    if (!isWithin(root, raw)) {
      // 不回显绝对路径: 那等于把宿主机目录结构泄露给模型
      throw new FsError('FS_OUT_OF_ROOT', `路径越界: ${raw} 不在工作区内`)
    }
    return abs
  }

  async function statAbs(abs: string): Promise<FsStat> {
    try {
      const s = await stat(abs)
      return { exists: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return { exists: false, isFile: false, isDir: false, size: 0, mtimeMs: 0 }
    }
  }

  const service: FsService = {
    root,
    resolve: (input: string) => safeResolve(input),

    async stat(rel) {
      return statAbs(safeResolve(rel))
    },

    async readText(rel) {
      const abs = safeResolve(rel)
      const raw = await readFile(abs, 'utf8')
      const out: ReadResult = {
        rel: relative(root, abs) || '.',
        totalLines: 0,
        lines: raw.split('\n'),
      }
      out.totalLines = out.lines.length
      // 观察策略靠这个事件记账 —— editText 内部的读取不发这条,
      // seam 自己读不算"模型读过"
      ctx.emit('fs/read', { rel: out.rel, path: abs })
      return out
    },

    async writeText(rel, content) {
      const abs = safeResolve(rel)
      const s = await statAbs(abs)
      const intent: FsIntent = {
        kind: 'write',
        path: abs,
        rel: relative(root, abs) || '.',
        exists: s.exists,
      }
      // 单决策槽: 策略占住即拥有否决权 (抛错), 调 next() 即放行
      await ctx.waterfall('fs/write-intent', [intent], () => undefined)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      // 刚写过的文件视为"已观察": write → edit 的连续操作不该被
      // 先读后写策略再拦一次 (dsh 的 createIfAbsent 同款语义)
      ctx.emit('fs/written', { rel: intent.rel, path: abs, kind: 'write' })
      return { rel: intent.rel, operation: s.exists ? 'update' : 'create', bytes: Buffer.byteLength(content) }
    },

    async editText(rel, oldString, newString, replaceAll) {
      if (!oldString) throw new FsError('FS_EMPTY_OLD', 'old_string 不能为空')
      const abs = safeResolve(rel)
      const s = await statAbs(abs)
      if (!s.exists) throw new FsError('FS_NOT_FOUND', `文件不存在: ${rel}`)
      const intent: FsIntent = { kind: 'edit', path: abs, rel: relative(root, abs) || '.', exists: true }
      await ctx.waterfall('fs/edit-intent', [intent], () => undefined)
      const raw = await readFile(abs, 'utf8')
      const count = countOccurrences(raw, oldString)
      if (count === 0) throw new FsError('FS_NO_MATCH', 'old_string 在文件中未出现')
      if (count > 1 && !replaceAll) {
        throw new FsError('FS_AMBIGUOUS', `old_string 出现 ${count} 次: 加 replace_all 或带更多上下文让它唯一`)
      }
      const next = replaceAll ? raw.split(oldString).join(newString) : raw.replace(oldString, newString)
      await writeFile(abs, next, 'utf8')
      ctx.emit('fs/written', { rel: intent.rel, path: abs, kind: 'edit' })
      return { rel: intent.rel, replaced: replaceAll ? count : 1 }
    },

    async listDir(rel) {
      const abs = safeResolve(rel)
      const entries = await readdir(abs, { withFileTypes: true })
      const out: Array<{ name: string; dir: boolean; size: number }> = []
      for (const e of entries) {
        if (e.isDirectory()) out.push({ name: e.name, dir: true, size: 0 })
        else if (e.isFile()) {
          const s = await statAbs(`${abs}/${e.name}`)
          out.push({ name: e.name, dir: false, size: s.size })
        }
      }
      return out
    },
  }

  ctx.set('fs', service)
  return () => undefined
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

export const invariant = defineInvariant('@meng/fs', [
  {
    id: 'service-registered',
    run(ctx) {
      const fs = ctx.get<FsService>('fs')
      if (!fs) throw new Error('能力面 fs 未注册')
      if (typeof fs.readText !== 'function') throw new Error('fs.readText 缺失')
    },
  },
  {
    id: 'fence-blocks-escape',
    run() {
      // 围栏必须真的拦得住, 不能只是"代码里写了"。
      // root 的取值要和 kit 清单里的表达式保持一致 —— 改那边记得改这里
      const root = resolve(process.env.MENG_WORKSPACE || process.cwd())
      if (isWithin(root, '/etc/passwd')) throw new Error('路径围栏失效: 绝对路径竟算作工作区内')
      if (isWithin(root, '../../etc/passwd')) throw new Error('路径围栏失效: ../ 逃逸竟算作工作区内')
      if (!isWithin(root, 'README.md')) throw new Error('路径围栏误伤: 工作区内文件竟被判越界')
    },
  },
])
