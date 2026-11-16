/**
 * @meng/plugin-tool-search —— glob / grep, 对齐 dsh-tool-fs-search。
 *
 * dsh 在这里也走薄壳: glob/grep 真活在 ctx.subprocess (rg / fd), node 原生只是退化。
 * 我们还没有 subprocess seam, 先用 node 原生实现 —— 但围栏、上限、结果格式
 * 已经按 seam 的形状写好, 将来换 rg 只动 walker, 不动 schema。
 *
 * 上限抄 dsh (对齐 Claude Code):
 *   globMaxResults  100   次数上限
 *   grepMaxMatches  250   命中上限
 *   grepMaxLineBytes 2000 单行预览截断
 *
 * 刻意不做 `ls`: dsh 没有。目录发现走 glob (只吐文件路径),
 * 这是对的 —— 模型要的是"哪里有什么文件", 不是"目录里有什么条目"。
 *
 * 注意: 这里的文件读取**不发** `fs/read` 事件 —— grep 一把扫过几百个文件,
 * 不能让它们都变成"模型读过" (那会让先读后写策略形同虚设)。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { sandboxRoot } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-search'
export const inject = ['tools']

export interface Config {
  // 工作区根由 @meng/config 统一给, 见 sandboxRoot()
  globMaxResults?: number
  grepMaxMatches?: number
  grepMaxLineBytes?: number
  maxEntries?: number
  /** grep 的硬预算。搜大仓库时它是最容易跑飞的那个 —— 逐文件 readFile, 没有天然上限 */
  grepTimeoutMs?: number
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

/** 不进搜索的目录 —— 体积第一, 噪音第二 */
const IGNORE = new Set([
  'node_modules', '.git', '.meng', 'dist', 'build', '.next', '.venv311',
  '__pycache__', '.cache', 'coverage', '.DS_Store',
])

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')

  /**
   * 工作区根 —— **每次调用现读**。设置页改了工作区, 下一次 glob/grep 就按新根搜。
   * 抓成常量的话, 改完工作区搜的还是旧目录, 而界面上看不出为什么。
   */
  const rootOf = (): string => sandboxRoot(ctx)
  const globMaxResults = config.globMaxResults ?? 100
  const grepMaxMatches = config.grepMaxMatches ?? 250
  const grepMaxLineBytes = config.grepMaxLineBytes ?? 2000
  const maxEntries = config.maxEntries ?? 50_000
  const grepTimeoutMs = config.grepTimeoutMs ?? 20_000

  /**
   * 围栏。`outside` 来自本次调用的授权凭据 —— 用户在工作区外点过"允许"之后,
   * 这里不能再拦 (否则界面说允许了、搜索还是报越界)。
   */
  function fence(input: unknown, root: string, outside: boolean): string {
    const raw = String(input ?? '.')
    const abs = resolve(root, raw || '.')
    if (!outside && abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`路径越界: ${raw} 不在工作区内`)
    }
    return abs
  }

  /**
   * 报告路径的基准。工作区内用工作区根 (和以前一致); 越界搜索用**被搜的那个
   * 目录** —— 在 `/etc` 里搜到的东西报成 `hosts` 才有意义, 报成
   * `../../../etc/hosts` 既难读又容易被模型再拼一次。
   */
  const baseOf = (root: string, start: string): string =>
    start === root || start.startsWith(root + sep) ? root : start

  /** 收集 root 下的全部文件 (相对路径, posix 分隔符)。带熔断: 大仓库不许拖垮一轮 */
  function walk(startDir: string, base: string): string[] {
    const files: string[] = []
    const stack: Array<{ dir: string; depth: number }> = [{ dir: startDir, depth: 0 }]
    let visited = 0
    while (stack.length) {
      const { dir } = stack.pop()!
      if (++visited > maxEntries) break
      let entries
      try {
        entries = readdirSyncSafe(dir)
      } catch {
        continue // 权限/竞态: 跳过这个目录, 不让整轮失败
      }
      for (const name of entries) {
        if (IGNORE.has(name)) continue
        const full = join(dir, name)
        const s = statSafe(full)
        if (!s) continue
        if (s.isDirectory()) stack.push({ dir: full, depth: 0 })
        else if (s.isFile()) files.push(relative(base, full).split(sep).join('/'))
      }
    }
    return files
  }

  const defs: ToolDef[] = [
    {
      name: 'glob',
      description:
        `按通配模式找文件 (支持 ** / * / ? / [] / {a,b}), 返回相对路径, 按修改时间新→旧排序, 最多 ${globMaxResults} 条。` +
        '找"某类文件在哪"用它, 不要用它读内容',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '通配模式, 如 "packages/*/src/index.ts" 或 "**/*.test.ts"' },
          path: { type: 'string', description: '限定子目录, 缺省为整个工作区' },
        },
        required: ['pattern'],
      },
      async handler(args, _ctx, call) {
        try {
          const pattern = String(args.pattern ?? '')
          if (!pattern) return fail('缺参数 pattern')
          // 一个 handler 只取一次: walk 报的相对路径与后面 join 回绝对路径
          // 必须基于**同一个**根, 否则中途换根会把文件指到别处
          const root = rootOf()
          const start = fence(args.path, root, call?.grants?.outside === true)
          const base = baseOf(root, start)
          const re = globToRegExp(pattern)
          const matched: Array<{ rel: string; mtimeMs: number }> = []
          for (const rel of walk(start, base)) {
            if (!re.test(rel)) continue
            const abs = join(base, rel)
            const s = statSafe(abs)
            matched.push({ rel, mtimeMs: s?.mtimeMs ?? 0 })
            if (matched.length >= globMaxResults * 2) break // 排序前先粗收, 双倍上限足够
          }
          matched.sort((a, b) => b.mtimeMs - a.mtimeMs)
          const top = matched.slice(0, globMaxResults)
          if (!top.length) return ok(`无匹配: ${pattern}`)
          const foot = matched.length > top.length ? `\n… 匹配 ${matched.length} 条, 只显示前 ${globMaxResults} 条 — 用更具体的 pattern` : ''
          return ok(top.map((m) => m.rel).join('\n') + foot)
        } catch (err) {
          return fail(`glob 失败: ${errText(err)}`)
        }
      },
    },

    {
      name: 'grep',
      description:
        `按正则 (JS 语法) 搜索文件内容, 返回 路径:行号:内容, 最多 ${grepMaxMatches} 条命中。` +
        '适合"这个函数在哪定义/谁在调用"这类问题',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式 (JS 语法)' },
          path: { type: 'string', description: '限定子目录, 缺省为整个工作区' },
          include: { type: 'string', description: '只搜匹配此 glob 的文件, 如 "*.ts"' },
        },
        required: ['pattern'],
      },
      /**
       * 声明预算 = 同意"到点可以被叫停"。策略层 (policy-timeout) 会给
       * call.signal 装一个合并信号, 这里每个文件之间看一眼 ——
       * 逐文件 readFile 太碎, 检查点只能放在文件边界上, 单文件内部不再打断
       */
      timeoutMs: grepTimeoutMs,
      async handler(args, _ctx, call) {
        try {
          const pattern = String(args.pattern ?? '')
          if (!pattern) return fail('缺参数 pattern')
          let re: RegExp
          try {
            re = new RegExp(pattern)
          } catch {
            return fail(`非法正则: ${pattern}`)
          }
          const root = rootOf()
          const start = fence(args.path, root, call?.grants?.outside === true)
          const base = baseOf(root, start)
          const include = args.include ? globToRegExp(String(args.include)) : null
          const hits: string[] = []
          for (const rel of walk(start, base)) {
            if (hits.length >= grepMaxMatches) break
            // 被叫停时把**已经搜到的**还回去: 部分结果比空结果有用,
            // 而且模型能从"搜了一半被停"读出"该缩小范围了"
            if (call?.signal?.aborted) {
              return fail(`已中止: 收到停止信号时已搜到 ${hits.length} 条命中 (结果不完整)`)
            }
            if (include && !include.test(rel) && !include.test(rel.split('/').pop() ?? '')) continue
            let text: string
            try {
              text = await readFile(join(base, rel), 'utf8')
            } catch {
              continue
            }
            if (text.includes('\u0000')) continue // 二进制文件跳过
            const lines = text.split('\n')
            for (let i = 0; i < lines.length && hits.length < grepMaxMatches; i++) {
              const line = lines[i] ?? ''
              if (re.test(line)) hits.push(`${rel}:${i + 1}:${trimLine(line, grepMaxLineBytes)}`)
            }
          }
          if (!hits.length) return ok(`无匹配: ${pattern}`)
          const foot = hits.length >= grepMaxMatches ? `\n… 命中数已达上限 ${grepMaxMatches} — 缩小 pattern/path/include` : ''
          return ok(hits.join('\n') + foot)
        } catch (err) {
          return fail(`grep 失败: ${errText(err)}`)
        }
      },
    },
  ]

  const disposers = defs.map((def) => ctx.effect(() => tools.register(def)))
  return () => {
    for (const off of disposers.reverse()) off()
  }
}

// ── 同步小工具: walker 里混 async 会把"跳过权限错误"变成"整轮失败" ──

import { readdirSync, statSync } from 'node:fs'

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir)
}

function statSafe(abs: string): { isDirectory(): boolean; isFile(): boolean; mtimeMs: number } | null {
  try {
    return statSync(abs)
  } catch {
    return null
  }
}

// ── glob → RegExp: 支持 ** / * / ? / [...] / {a,b} ──

export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++
        if (pattern[i + 1] === '/') {
          i++ // `**/` → 零或多层目录
          re += '(?:[^/]+/)*'
        } else {
          re += '.*' // 裸 `**` 跨目录
        }
      } else {
        re += '[^/]*' // 单 `*` 不跨目录
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close > i) {
        re += pattern.slice(i, close + 1)
        i = close
      } else {
        re += '\\['
      }
    } else if (c === '{') {
      const close = pattern.indexOf('}', i + 1)
      if (close > i) {
        const body = pattern.slice(i + 1, close)
        if (body.includes(',')) re += `(?:${body.split(',').map((alt) => alt.trim()).map(escapeRe).join('|')})`
        else re += escapeRe(body)
        i = close
      } else {
        re += '\\{'
      }
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp(`^${re}$`)
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** 单行预览截断。按字符切但以字节计量, 尽量不撕开多字节字符 */
function trimLine(line: string, maxBytes: number): string {
  let bytes = 0
  for (let i = 0; i < line.length; i++) {
    bytes += Buffer.byteLength(line[i]!)
    if (bytes > maxBytes) return line.slice(0, Math.max(0, i - 1)).trimEnd() + '…'
  }
  return line.trimEnd()
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const invariant = defineInvariant('@meng/plugin-tool-search', [
  {
    id: 'tools-registered',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      const names = tools.list().map((t) => t.name)
      for (const required of ['glob', 'grep']) {
        if (!names.includes(required)) throw new Error(`搜索工具 ${required} 未注册`)
      }
    },
  },
  {
    id: 'glob-matcher-sane',
    run() {
      const cases: Array<[string, string, boolean]> = [
        ['**/*.ts', 'a/b/c.ts', true],
        ['**/*.ts', 'a/b/c.js', false],
        ['*.ts', 'a.ts', true],
        ['*.ts', 'a/b.ts', false], // 单 * 不跨目录
        ['packages/*/src/index.ts', 'packages/core/src/index.ts', true],
        ['packages/*/src/index.ts', 'packages/core/lib/index.ts', false],
        ['**/*.test.{ts,tsx}', 'x/y.test.tsx', true],
      ]
      for (const [pattern, path, want] of cases) {
        const got = globToRegExp(pattern).test(path)
        if (got !== want) throw new Error(`glob 匹配错: ${pattern} × ${path} → ${got}, 应为 ${want}`)
      }
    },
  },
])
