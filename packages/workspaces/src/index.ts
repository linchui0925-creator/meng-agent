/**
 * @meng/workspaces —— "记住哪些目录"（工作区列表）。
 *
 * ## 它只做一件事: 记住
 *
 * 会话自己带 `workspace`（写在 `session/created` 里），所以"有会话的工作区"
 * 本来就能从事件流推出来。这里存的是**另一部分**: 用户主动加过、但还没在里面
 * 开会话的目录 —— 选择器要用它们（"在这个目录里开一个"）。
 *
 * 分开存的好处是两边都不会被对方带偏: 删掉最后一个会话不该让目录从选择器里
 * 消失（用户明明加过它），而加一个目录也不该凭空造出一个会话。
 *
 * ## 为什么 `id` 就是绝对路径
 *
 * 路径本身是稳定的身份。换 uuid 意味着"同一个目录"在两次启动之间变成两个工作区,
 * 用户会看到同一个项目出现两次 —— 而这件事**没法从 uuid 反推**, 只能靠人记住。
 *
 * ## 为什么不用 config
 *
 * 配置项是"声明过的、有 schema 的、设置页要画控件的"。一份会随使用变长的目录清单
 * 塞进去, 用户会在设置页里看到一堆路径输入框。它是**运行时数据**, 不是配置。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const WORKSPACES_CAPABILITY = 'workspaces'

export interface WorkspaceEntry {
  /** 绝对路径。**同时也是 id** —— 路径就是身份 */
  path: string
  /** 给人看的名字: 目录名 */
  name: string
  /** 记住过, 但目录已经没了。调用方可以据此决定给不给这一项 */
  missing: boolean
}

export interface WorkspaceStore {
  /** 记住的那些（含 missing）。不排序 —— 排序是调用方的事 */
  list(): WorkspaceEntry[]
  /**
   * 记住一个目录。**目录不存在就建** —— "新建工作区"这个动作本来就包含建目录,
   * 让用户先去终端 mkdir 一次是把界面的活儿推回命令行。
   */
  add(input: string): WorkspaceEntry
  has(path: string): boolean
}

/**
 * 把用户输入变成一个绝对路径。
 *
 * 支持 `~` 前缀: 用户会这么打, 而 `resolve('~/x')` 会得到一个名为 `~` 的目录 ——
 * 那种失败极难看出来（目录真的被创建了, 只是位置离谱）。
 */
export function normalizePath(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('路径不能为空')
  const home = process.env['HOME'] ?? ''
  if (raw === '~' && home) return home
  if (raw.startsWith('~/') && home) return resolve(join(home, raw.slice(2)))
  return resolve(raw)
}

export function createWorkspaceStore(file: string): WorkspaceStore {
  const read = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { paths?: unknown }
      return Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string') : []
    } catch {
      // 文件不存在 / 写坏了 → 当成"一个都没记住"。
      // 这份清单是**可重建**的（会话里还有各自的工作区）, 不值得为它挡住启动
      return []
    }
  }

  let paths = read()

  const flush = (): void => {
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再 rename: 写一半断电不会留下半个 JSON
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ paths }, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  const entryOf = (path: string): WorkspaceEntry => ({
    path,
    name: basename(path) || path,
    missing: !isDir(path),
  })

  return {
    list() {
      return paths.map(entryOf)
    },

    add(input) {
      const path = normalizePath(input)
      if (existsSync(path) && !isDir(path)) {
        throw new Error(`${path} 已存在, 但不是目录`)
      }
      mkdirSync(path, { recursive: true })
      if (!paths.includes(path)) {
        paths = [...paths, path]
        flush()
      }
      return entryOf(path)
    },

    has(path) {
      return paths.includes(normalizePath(path))
    },
  }
}

export interface WorkspaceGitStatus {
  branch?: string
  dirty?: boolean
}

const execFileAsync = promisify(execFile)

/** 工作区的 Git 摘要。目录不存在、不是仓库或 Git 不可用都返回空对象。 */
export async function readGitStatus(path: string): Promise<WorkspaceGitStatus> {
  const cwd = normalizePath(path)
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  }
  try {
    if (await git(['rev-parse', '--is-inside-work-tree']) !== 'true') return {}
    const [branch, porcelain] = await Promise.all([
      git(['branch', '--show-current']),
      git(['status', '--porcelain=v1', '--untracked-files=normal']),
    ])
    return { ...(branch ? { branch } : {}), dirty: porcelain.length > 0 }
  } catch {
    return {}
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function apply(ctx: Ctx, config: { dir?: string; file?: string } = {}): Disposer {
  const file =
    config.file ?? join(config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng', 'workspaces.json')
  const store = createWorkspaceStore(file)
  const dispose = ctx.set<WorkspaceStore>(WORKSPACES_CAPABILITY, store)
  if (!process.env['MENG_QUIET']) {
    const all = store.list()
    console.log(`[meng] workspaces · ${file} · 记住 ${all.length} 个目录 (${all.filter((w) => w.missing).length} 个已不存在)`)
  }
  return () => dispose()
}

export function getWorkspaces(ctx: Ctx): WorkspaceStore | undefined {
  return ctx.get<WorkspaceStore>(WORKSPACES_CAPABILITY)
}

export const invariant = defineInvariant('@meng/workspaces', [
  {
    id: 'list-is-absolute',
    run(ctx) {
      const store = getWorkspaces(ctx)
      if (!store) throw new Error('能力面 workspaces 未注册')
      // 相对路径会让"同一个目录"在两次启动之间变成两个 id (cwd 可能不同),
      // 用户会看到同一个项目出现两次 —— 而这件事没法从 id 反推
      for (const w of store.list()) {
        if (!w.path.startsWith('/')) throw new Error(`工作区路径不是绝对路径: ${w.path}`)
        if (w.name === '') throw new Error(`工作区没有名字: ${w.path}`)
      }
    },
  },
])
