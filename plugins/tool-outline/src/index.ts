/**
 * @meng/plugin-tool-outline —— outline: 给长材料建**位置地图**。
 *
 * ## 它返回什么 (这是整个工具最要紧的一条)
 *
 * 块号 + 行区间 + 每块一句话 + 40 字原文开头 + 原文路径。**不返回内容。**
 * 名称也叫 outline 而不是 summarize —— 叫错名字, 模型就会把返回当答案直接用,
 * 那等于我们亲手造了一个无法核对的摘要。
 *
 * 为什么"无法核对"是致命的: 摘要错了, 模型知道自己在看二手货, 语气会软;
 * 地图错了, 模型照着错误的位置去读**真实的原文**, 然后以为自己核实过了。
 *
 * ## 为什么优先用代码切, 而不是一律交给小模型
 *
 * docs/decisions/dec-002 的实测: nodejs.org/api/fs.html (274KB / 8125 行) 切成 236 块,
 * 每一块的描述**就是原文自己的函数签名** (`fs.readFile(path[, options], callback)`)。
 * 代码从标题里直接读出来, 比模型写出来的更准, 而且零调用、零成本、零延迟。
 *
 * 所以分工是:
 *   有结构 (markdown 标题 / 代码顶层声明) → 代码生成地图, 不调模型
 *   没结构 (纯日志、编译输出、一坨没有分隔的代码) → 才轮到 smallModel
 *
 * 这不是省钱, 是**准确**: 结构本来就是作者写好的索引, 让模型复述一遍只会丢信息。
 *
 * ## 小模型的权限边界 (写死在这, 不开放配置)
 *
 *   · 不带 tools —— 它不能调用任何工具。它能调的话, outline 内部让小模型去 read,
 *     read 又触发一层, 就递归了
 *   · temperature 0 —— 索引必须可复现。同一份材料两次跑出两份地图,
 *     调试时"刚才那份说……"就对不上
 *   · 不落会话、不产生副作用 —— 它是一次纯函数调用: 文本进, 文本出
 *   · 只在没结构时才调 —— 这是**成本与隐私**两件事共同的边界:
 *     材料内容只有在这一步才会离开本机
 *
 * ## 输出必须有界
 *
 * 地图本身也是上下文。块数永远 <= maxBlocks (默认 80), 靠"切不动就换粗粒度"降级:
 * 先按 h1-h6 切, 块太多就按 h1-h3, 再不行 h1-h2, 最后按 maxBlocks 均分行。
 * 宁可地图粗一点, 也不能让"给长材料做索引"这件事自己变成一份长材料。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { FsCallOptions, FsService } from '@meng/fs'
import { collectBlocks, type LLMService } from '@meng/llm'
import { mainOf, readable } from '@meng/net'
import type { SessionService } from '@meng/session'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-outline'
export const inject = ['tools', 'fs']

export interface Config {
  /** 地图最多列多少块。超了就换粗粒度, 不截断 —— 截断会让后面的内容彻底不可见 */
  maxBlocks?: number
  /** 每块附多少字原文开头 */
  fingerprintChars?: number
  /** 短于这个行数的材料不需要地图, 直接 read */
  minLines?: number
  /**
   * 小模型名。**不配就完全不调模型** —— 这个工具在无结构材料上会老实说
   * "没有标题结构", 而不是假装看懂了。
   */
  smallModel?: string
  timeoutMs?: number
}

interface Chunk {
  no: number
  from: number
  to: number
  title: string
  /** 标题来自真实的标题/声明, 还是退而求其次取的首行 */
  named: boolean
  fingerprint: string
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

/** markdown 标题: `### 标题`。捕获 # 的个数与标题文本 */
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/
/**
 * 代码里的顶层声明。**只认行首** —— 缩进的必然是嵌套的, 拿它断块会切碎。
 * 函数级条目才是"一个 API"的粒度 (Node 文档就是这样, 实测按 h3 切刚好一块一个函数)
 */
const CODE_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:def|class)\s+([A-Za-z_]\w*)|^(?:pub\s+)?(?:fn|struct|enum|impl|trait)\s+([A-Za-z_]\w*)|^func\s+([A-Za-z_]\w*)/

/** 返回标题层级 (1 最小=最重要), 拿不到返回 undefined */
function levelOf(line: string): { level: number; title: string } | undefined {
  const md = MD_HEADING.exec(line)
  if (md?.[1] && md[2]) return { level: md[1].length, title: md[2] }
  const decl = CODE_DECL.exec(line)
  // 捕获组有四个分支, 命中哪个取决于语言。取第一个非空的
  const name = decl?.slice(1).find((g) => g !== undefined)
  if (name) return { level: 5, title: name }
  return undefined
}

/**
 * 按标题切块。
 * @param maxLevel 只认 level <= maxLevel 的标题 —— 降级就靠调它
 */
function chunk(lines: string[], maxLevel: number, maxBlocks: number): Chunk[] {
  const minLines = 3
  // 均分步长: 保证**任何**情况下块数都不超过 maxBlocks
  const stride = Math.max(1, Math.ceil(lines.length / maxBlocks))
  // 硬切上限。两个约束都要满足:
  //   · 不能太小 —— 200 是"一条 API 连说明带示例"的常见长度, 再小会把函数切两半
  //   · 不能无视 maxBlocks —— 没有标题的材料全靠硬切, 只按 200 行切的话
  //     块数 = 行数/200, 跟上限无关 (实测 20000 行切出 100 块, 超过 80 的上限)
  const maxLines = Math.max(200, stride)
  const out: Chunk[] = []
  let start = 0
  let pending: { level: number; title: string } | undefined
  // 硬切要标"（续 上一块标题）"。只记**真标题** —— 拿上一块的 title 去拼,
  // 第二刀就会变成"（续）（续）（续）…"
  let lastNamed = ''

  const push = (from: number, to: number, head: typeof pending, hard: boolean): void => {
    // 用 `<` 而不是 `<=`: 单行块是合法的 (`class Gamma {}` 独占一行就是一块),
    // 写成 <= 会把它整个丢掉
    if (to < from) return
    let title = ''
    let named = false
    if (head) {
      title = head.title
      named = true
      lastNamed = head.title
    } else if (hard) {
      // 硬切出来的段不是语义块, 标出来。不标的话模型会以为这块就叫这个,
      // 而它其实是上一块被截断的下半截
      title = lastNamed ? `（续 ${lastNamed}）` : '（续）'
    } else {
      title = (lines.slice(from - 1, to).find((l) => l.trim() !== '') ?? '').trim()
    }
    const body = lines.slice(from - 1, to).find((l) => l.trim() !== '' && l.trim() !== title) ?? ''
    out.push({
      no: out.length + 1,
      from,
      to,
      title: title.slice(0, 60),
      named,
      fingerprint: body.trim().slice(0, 120),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const hit = levelOf(lines[i] ?? '')
    const isBreak = hit !== undefined && hit.level <= maxLevel
    const far = i - start >= minLines
    const tooLong = i - start >= maxLines
    // 均分兜底: 连标题都没有时, 按步长切出等长的块, 保证块数有界
    const forced = maxLevel === 0 && (i - start) % stride === 0 && i - start > 0

    if ((isBreak && far) || tooLong || forced) {
      // 只有"因为太长而不得不切"才算硬切; 撞到新标题是正常断块
      push(start + 1, i, pending, tooLong || forced)
      start = i
      pending = isBreak ? hit : undefined
    } else if (isBreak && !pending) {
      pending = hit
    }
  }
  push(start + 1, lines.length, pending, false)
  return out
}

/**
 * 换粗粒度直到块数 <= maxBlocks。
 * 从最细(h6 + 代码声明)开始: 只要块数够少就用最细的, 信息最多。
 */
function adapt(lines: string[], maxBlocks: number): { chunks: Chunk[]; level: number } {
  // 逐级变粗, 不能跳档: 项目主人实测的 Node 文档, API 条目住在 h5 上,
  // 只试 h6 和 h3 的话, h6 切太碎、h3 又只剩章节标题, 中间那档正好被跳过
  for (const level of [6, 5, 4, 3, 2, 1]) {
    const chunks = chunk(lines, level, maxBlocks)
    if (chunks.length <= maxBlocks) return { chunks, level }
  }
  return { chunks: chunk(lines, 0, maxBlocks), level: 0 }
}

const isHtml = (text: string): boolean => /^\s*<(!doctype|html)/i.test(text.slice(0, 300))

/** 显示宽度: 中日韩字符占两列, 否则对齐是歪的 */
function width(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return w
}

function clip(s: string, max: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
    if (w + cw > max) return out + '…'
    w += cw
    out += ch
  }
  return out
}

const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)))

function renderMap(rel: string, lines: string[], chunks: Chunk[], level: number, fingerprintChars: number): string {
  const desc =
    level === 0 ? '按行数均分' : level >= 6 ? '按标题切(含代码声明)' : `按标题切到 h${level}`
  const head = [`材料 ${rel} · ${lines.length} 行 · ${chunks.length} 块 (${desc})`, '']
  const noW = String(chunks.length).length
  for (const c of chunks) {
    const no = `[${String(c.no).padStart(noW)}]`
    const range = `${c.from}-${c.to}`
    const title = clip(c.title || '(无标题)', 36)
    const fp = clip(c.fingerprint, fingerprintChars)
    head.push(`${no} ${range.padStart(11)}  ${pad(title, 37)}「${fp}」`)
  }
  head.push('')
  head.push(
    '—— 以上**只有位置和标题, 不含内容**。' +
      `要哪一块: read ${rel} 带 offset/limit 读对应行区间, 或 grep 关键词。`,
  )
  return head.join('\n')
}

/**
 * 让小模型给**没结构**的块补一句描述。
 *
 * 只传块号 + 首行, 不传内容 —— 内容可能几百 KB, 传过去就是在给第三方送材料。
 * 而且这里要的只是"这块大概是什么", 首行通常就够了。
 */
async function describeByModel(
  llm: LLMService,
  model: string,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<Map<number, string> | undefined> {
  const menu = chunks
    .map((c) => `${c.no}\t${clip(c.title || '(空)', 40)}\t${clip(c.fingerprint, 40)}`)
    .join('\n')
  const prompt =
    '下面是同一份材料按顺序切成的若干块。为每一块写一句不超过 15 个字的中文描述,\n' +
    '只说明"这一块是什么"(比如"报错堆栈""依赖安装""第三个测试用例"),\n' +
    '**不要总结内容、不要加标题、不要解释**。\n' +
    '严格按行输出, 每行一个: 块号<Tab>描述。不要输出其他任何文字。\n\n' +
    menu
  try {
    const { blocks } = await collectBlocks(
      llm.stream({
        model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: '你是一个只输出结构化索引的助手。' }] },
          { role: 'user', content: [{ type: 'text', text: prompt }] },
        ],
        // 索引要可复现: 两次跑出两份不同的地图, 等于没有地图
        temperature: 0,
        // 刻意**不传 tools** —— 小模型不能调工具, 这是权限边界不是遗漏
        signal,
      }),
    )
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const got = new Map<number, string>()
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s*[\t:：]\s*(.+?)\s*$/.exec(line)
      if (m?.[1] && m[2] && m[2].length <= 60) got.set(Number(m[1]), m[2])
    }
    return got.size > 0 ? got : undefined
  } catch {
    // 小模型挂了不能挡住这个工具 —— 地图已经能用了, 只是块标题糙一点
    return undefined
  }
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const fs = ctx.get<FsService>('fs')
  if (!fs) throw new Error('能力面 fs 未装载')
  const session = ctx.get<SessionService>('session')

  // 80 太紧: Node 文档的 API 条目是五级标题, 压到 80 块就只能按行硬切,
  // 地图上一连六块都叫"（续 Promises API）", 什么信息都没有。
  // dec-002 实测: 236 块的地图 12KB, 定向任务 8/8 命中 —— 说明这个粒度才对。
  // 200 是"每块约 90 字节 → 18KB 上限"的位置, 远在上下文能承受的范围里
  const maxBlocks = config.maxBlocks ?? 250
  const fingerprintChars = config.fingerprintChars ?? 40
  const minLines = config.minLines ?? 60
  // llm 是**可选**依赖: 不配 smallModel 时, 这个工具完全不碰模型
  const smallModel = config.smallModel ?? ''

  const def: ToolDef = {
    name: 'outline',
    description:
      '给一份长材料建位置地图: 块号 + 行区间 + 每块一句话 + 一句原文开头。\n' +
      '**它不返回内容** —— 只告诉你东西在哪、每一块大概是什么。\n' +
      '什么时候用: 面对读不完的长文件或长网页, 而且你**不知道该 grep 什么词**、' +
      '或者想知道它整体分几部分。\n' +
      '什么时候别用: 你已经知道要找哪个关键词 —— 直接 grep 更快更省。\n' +
      '拿到地图之后: read 同一个 path 带 offset/limit 读具体某块, 或 grep 关键词精读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径。可以是 web_fetch 落盘的那个, 也可以是工作区里任何文本文件' },
      },
      required: ['path'],
    },
    timeoutMs: config.timeoutMs,
    async handler(args, ctxHere, call) {
      const raw = String(args.path ?? '').trim()
      if (!raw) return fail('缺少 path')

      let read
      try {
        const workspace = call?.sessionId ? session?.workspaceOf(call.sessionId) : undefined
        const options: FsCallOptions = {
          ...(workspace ? { root: workspace } : {}),
          ...(call?.grants?.outside === true ? { outside: true } : {}),
          ...(call?.grants?.sensitive === true ? { sensitive: true } : {}),
        }
        read = await fs.readText(raw, options)
      } catch (err) {
        return fail(`读不了 ${raw}: ${err instanceof Error ? err.message : String(err)}`)
      }

      const joined = read.lines.join('\n')
      // HTML 要先剥。web_fetch 落的是原始 HTML, 不剥的话切块切在 <div> 上
      const source = isHtml(joined) ? readable(mainOf(joined)) : joined
      const lines = source.split('\n')

      if (lines.length < minLines) {
        return ok(
          `这份材料只有 ${lines.length} 行, 不需要地图 —— 直接 read ${read.rel} 就能看全。`,
        )
      }

      const { chunks, level } = adapt(lines, maxBlocks)
      // "有没有结构"数标题的个数, 不数块的比例 —— 比例会被硬切出来的续块拉低
      // (实测: 明明有 200 多个标题, 比例法却判成无结构)
      const headings = lines.reduce((n, l) => n + (levelOf(l) !== undefined ? 1 : 0), 0)
      const structured = headings >= 5

      let map = renderMap(read.rel, lines, chunks, level, fingerprintChars)

      // 没结构: 代码只能均分, 标题是首行原文, 说明不了这一块讲什么
      if (!structured) {
        const llm = ctxHere.get<LLMService>('llm')
        if (smallModel && llm) {
          const got = await describeByModel(llm, smallModel, chunks, call?.signal)
          if (got) {
            for (const c of chunks) {
              const d = got.get(c.no)
              if (d) c.title = d
            }
            map = renderMap(read.rel, lines, chunks, level, fingerprintChars)
            map += `\n（这份材料没有标题结构, 块描述由小模型 ${smallModel} 补写 —— 描述可能不准, 位置一定准）`
          } else {
            map +=
              `\n（这份材料没有标题结构, 块是按位置切的, 标题只是首行原文。` +
              `想让小模型补描述的话, 检查 ${smallModel} 是否可用 —— 这次没拿到可用结果, 已按原样返回）`
          }
        } else {
          map +=
            '\n（这份材料没有标题结构, 块是按位置切的, 标题只是首行原文 —— ' +
            '它说明不了这一块讲什么。位置仍然准确, 可以先 grep 关键词缩小范围）'
        }
      }

      return ok(map)
    },
  }

  const off = tools.register(def)
  return () => {
    off()
  }
}

export const invariant = defineInvariant('@meng/plugin-tool-outline', [
  {
    id: 'block-count-bounded',
    run() {
      // 地图自己也是上下文。"给长材料做索引"绝不能变成另一份长材料
      const big: string[] = []
      for (let i = 0; i < 20000; i++) big.push(`内容行 ${i}`)
      const { chunks } = adapt(big, 80)
      if (chunks.length > 80) throw new Error(`块数没被 maxBlocks 压住: ${chunks.length}`)
      if (chunks.length < 2) throw new Error('均分兜底没生效')
    },
  },
  {
    id: 'heading-becomes-title',
    run() {
      const lines = ['# 标题一', '内容一', '内容二', '## 标题二', '内容三', '内容四']
      const { chunks } = adapt(lines, 80)
      const titles = chunks.map((c) => c.title)
      if (JSON.stringify(titles) !== JSON.stringify(['标题一', '标题二'])) {
        throw new Error(`标题提取不对: ${JSON.stringify(titles)}`)
      }
    },
  },
  {
    id: 'code-decl-counts-as-structure',
    run() {
      const lines = [
        'export function alpha() {',
        '  return 1',
        '}',
        'export function beta() {',
        '  return 2',
        '}',
        'class Gamma {}',
      ]
      const { chunks } = adapt(lines, 80)
      if (chunks.filter((c) => c.named).length < 3) throw new Error('代码声明没被当成结构')
      if (!chunks.some((c) => c.title === 'Gamma')) {
        throw new Error(`class 名没提取到: ${JSON.stringify(chunks.map((c) => c.title))}`)
      }
    },
  },
  {
    id: 'map-is-much-smaller-than-source',
    run() {
      // "地图不含内容"这句口号的可量化版本: 地图必须比原文小一个数量级,
      // 否则就是在用另一种方式把原文塞回上下文
      const lines: string[] = []
      for (let i = 0; i < 3000; i++) lines.push(`这是第 ${i} 行的正文内容, 用来凑出一份真实长度的材料`)
      const { chunks, level } = adapt(lines, 80)
      const map = renderMap('x.txt', lines, chunks, level, 40)
      const ratio = utf8(map) / utf8(lines.join('\n'))
      if (ratio > 0.2) throw new Error(`地图占原文的 ${(ratio * 100).toFixed(1)}%, 太大了`)
      // 同时不能小到没信息: 至少得列出若干块
      if (chunks.length < 5) throw new Error(`只切出 ${chunks.length} 块, 地图没信息量`)
    },
  },
  {
    id: 'structureless-material-is-detected',
    run() {
      // 这条是防空转: 如果无结构永远判不出来, 小模型那条分支就永远走不到,
      // 而它恰恰是这个工具唯一需要模型的地方
      const log: string[] = []
      for (let i = 0; i < 200; i++) log.push(`2026-11-03 12:00:0${i % 10} INFO  something happened ${i}`)
      const headings = log.reduce((n, l) => n + (levelOf(l) !== undefined ? 1 : 0), 0)
      if (headings >= 5) throw new Error(`纯日志被误判成有结构 (数出 ${headings} 个标题)`)
    },
  },
  {
    id: 'small-model-gets-no-tools',
    async run(ctx) {
      // 小模型不能调工具 —— 它能的话, outline 内部让它去 read, read 又触发一层, 就递归了。
      // 探针 provider 把请求里的 tools 记下来, 跑完回看
      const llm = ctx.get<LLMService>('llm')
      if (!llm) return // 没装 llm 就完全不调模型, 这条自然成立
      let seen: number | undefined
      const off = llm.register({
        id: 'inv-outline-probe',
        models: ['inv-outline-small'],
        async *stream(req) {
          seen = req.tools?.length ?? 0
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '1\t第一块' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '1\t第一块' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })
      try {
        const chunks: Chunk[] = [
          { no: 1, from: 1, to: 10, title: 'x', named: false, fingerprint: 'y' },
        ]
        const got = await describeByModel(llm, 'inv-outline-small', chunks)
        if (seen !== 0) throw new Error(`小模型请求里带了 ${seen} 个工具`)
        if (got?.get(1) !== '第一块') throw new Error(`小模型输出没解析出来: ${JSON.stringify([...got ?? [] ])}`)
      } finally {
        off()
      }
    },
  },
])

function utf8(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}
