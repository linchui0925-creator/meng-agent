/**
 * @meng/net —— 抓取能力面 (seam)。**零实现**。
 *
 * 和 fs / exec / jobs 一样: 只有类型和一条注册函数。谁去抓、怎么抓
 * (node fetch / curl / 托管代理 / 本地缓存), 全在实现包里。
 *
 * ## 这条缝唯一重要的决定: 返回"内容落在哪个文件", 不返回"内容是什么"
 *
 * 直觉做法是 `fetchText(url): Promise<string>`, 一行就够用。但那样做不到三件事:
 *   1. 网页动辄几百 KB (实测 nodejs.org/en/about 304KB), 塞进内存是浪费,
 *      塞进上下文是灾难
 *   2. 模型没法"只看第 3 节" —— 它拿到的是整段字符串, 要么全看, 要么丢
 *   3. **没法核对**。原文一旦被上层压缩成摘要, 模型再也回不到原句
 *
 * 落盘之后这三件都有解: grep 找关键词、read 按行分段、事后复审。
 * 代价是多一次磁盘 IO —— 相对于几百 KB 的网络请求, 可以忽略。
 *
 * ## 这条缝**不含**的判断 (留在上层)
 *   · HTML 剥完之后给模型看多少 —— 那是 tool-fetch 的 render
 *   · **怎么把长材料切成块、块要不要配一句描述** —— 那是 tool-outline
 *   · 多大算"太大"要不要落盘 —— 落盘在这里是**必然**, 不是策略:
 *     这条缝的契约就是"一定给你一个文件", 没有"内联返回"这个模式
 *   · 反爬怎么办、要不要伪装 UA —— 那是实现方的事, 但见下面第 5 条不变量
 *
 * ## 不变量 (实现方必须全部满足, net-local 的 invariant 逐条验)
 *   1. **任何** HTTP 状态都 resolve。404 / 500 是**结果**, 不是异常 ——
 *      服务器拒绝你, 和你把域名打错, 是两种故事, 模型需要区分
 *   2. 只有"根本没连上"才 reject: DNS 失败 / 超时 / 被中止 / URL 非法
 *   3. 返回的 path 一定指向一个**已存在且已落盘**的文件, 哪怕 0 字节
 *   4. bytes 是**实际写入**的字节数, truncated 为真时它小于服务器给的
 *   5. 不伪装成浏览器 UA。我们诚实地报自己是谁 —— 伪装 UA 是绕反爬,
 *      那是使用者该自己决定的事, 不该在能力面里偷偷做
 *   6. 遵守 signal: 用户点停止时, 连接要立刻断, 落盘要留已经收到的部分
 */

import type { Ctx, Disposer } from '@meng/core'

/** 能力面名。故意和包名一致, 免得又多一个记不住的字符串 */
export const NET_CAPABILITY = 'net'

export interface NetRequest {
  url: string
  /**
   * 调用方传下来的中止信号。**必须**遵守 —— 模型可以随时取消,
   * 用户点"停止"时不该还挂着一条 60 秒的连接
   */
  signal?: AbortSignal
  /** 单次抓取的时间上限。缺省由实现决定, 缺省值要写进实现文档 */
  timeoutMs?: number
  /** 写入上限。超过就停, 已收到的部分保留并标 truncated */
  maxBytes?: number
  /** 额外请求头。`Accept: text/markdown` 能让部分站点直接给 markdown */
  headers?: Record<string, string>
  /**
   * 预览要多少字符 (不额外读盘 —— 实现顺手在内存里留一份开头)。
   * 上层拿它做"第一眼", 不做精读: 精读永远走 path 上的文件
   */
  previewChars?: number
}

export interface NetResponse {
  /** 请求的原始地址 —— 模型拿到的永远是它, 便于对上自己的意图 */
  requested: string
  /** 最终地址 (跟随重定向之后)。和 requested 不同时看 redirected */
  url: string
  status: number
  /** 小写、不含 `; charset=` —— 上层要能直接 `=== 'text/html'` 判断 */
  contentType: string
  /** 从 content-type 里解出来的编码。落盘存的是**原始字节**, 解码在上层 */
  charset: string
  /** 实际写入磁盘的字节数 */
  bytes: number
  /** 被 maxBytes 砍过 */
  truncated: boolean
  /** 落盘的绝对路径 */
  path: string
  /** 相对工作区的路径 —— 给模型看, 不回显宿主机目录结构 */
  rel: string
  /**
   * 按 charset 解码后的开头若干字符。**只是第一眼**, 不是真相 ——
   * 真相永远是 path 上的文件。之所以不省掉它: 上层若为此再读一次盘,
   * 同一份数据就要走两遍 IO, 而这份数据在写盘时本来就在内存里
   */
  head: string
  /**
   * 是否发生过重定向。
   * 只给布尔、不给"跳了几次 / 什么状态码": node fetch 的 follow 模式拿不到轨迹,
   * 硬编一个 status 字段等于在契约里撒谎。真需要轨迹时改用 manual 循环再补
   */
  redirected: boolean
  /**
   * 重定向是否跨了 host。跨 host 意味着"你以为抓的是 A, 实际是 B",
   * 上层要把这件事告诉模型: 内容可能完全不是它要的
   */
  crossHost: boolean
}

export interface NetService {
  fetch(req: NetRequest): Promise<NetResponse>
}

export const NET_CODE = {
  /** URL 非法 / 协议不是 http(s) */
  BAD_URL: 'NET_BAD_URL',
  /** 域名解析不了 —— 通常是拼错了, 不是网络问题 */
  DNS: 'NET_DNS',
  TIMEOUT: 'NET_TIMEOUT',
  ABORTED: 'NET_ABORTED',
  /** 连上了但传输中断 */
  TRANSPORT: 'NET_TRANSPORT',
} as const

export type NetCode = (typeof NET_CODE)[keyof typeof NET_CODE]

export class NetError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NetError'
    this.code = code
  }
}

export function provideNet(ctx: Ctx, impl: NetService): Disposer {
  return ctx.set<NetService>(NET_CAPABILITY, impl)
}

/** 取能力面。工具侧统一走它, 免得每处都写字符串 */
export function getNet(ctx: Ctx): NetService | undefined {
  return ctx.get<NetService>(NET_CAPABILITY)
}

// ─────────────────────────────────────────────────────────────────────────────
// 下面是**同层的纯函数**, 不是 seam 契约的一部分。
//
// 放在这里而不是某个工具插件里, 理由只有一个: 两个工具都要它。
// web_fetch 要"把抓回来的字节变成字", outline 要"把存在盘上的 HTML 变成字" ——
// 同一件事写两遍, 迟早两遍的行为不一样, 而它们必须对同一个文件给出同一个结果。
//
// 仍然放在 net 而不是单开一个包, 因为它的归属就是"从外面进来的内容"。
// 纯字符串进出, 不碰 fs / 不 import node: 任何东西, 所以不破坏这条缝的零实现。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 页面自己标了"哪儿是正文", 就听它的。
 *
 * `<main>` 是 HTML5 里唯一专门标记主要内容的标签 —— 用它不是启发式猜测,
 * 是**读页面自己的声明**。实测 nodejs.org/en/about: 正文在 23041 字节处,
 * 前面 23KB 全是导航和侧栏, 取开头等于取了一屏菜单。
 *
 * `<article>` 是退一步的选择 (博客/新闻页常这么标)。两个都没有, 就老实用全文。
 */
export function mainOf(raw: string): string {
  for (const tag of ['main', 'article']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(raw)
    if (m?.[1] && m[1].trim().length > 200) return m[1]
  }
  return raw
}

/**
 * HTML → 可读文本。**只删确定是噪音的东西**, 不判断正文在哪。
 *
 * 三条顺序上的讲究:
 *   1. 注释最先删 —— 条件注释里常整段包着 script
 *   2. 结构标签先转成 markdown 记号 (## / - / 换行), 再删剩余标签。
 *      反过来的话只剩一坨文字, 模型分不清哪句是标题、哪句是正文
 *   3. 实体最后解 —— 否则 `&lt;script&gt;` 会先变成真标签被规则 2 吃掉
 */
export function readable(raw: string): string {
  let s = raw
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // doctype / CDATA 不是标签也不是内容, 但 `<[a-zA-Z]` 那条规则抓不到它们
  s = s.replace(/<!doctype[^>]*>/gi, ' ')
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
  s = s.replace(
    /<(script|style|noscript|svg|template|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  )
  s = s.replace(/<(script|style|noscript)\b[^>]*\/?>/gi, ' ')
  // 导航 / 页脚 / 侧栏: 语义上就不是正文。删整块而不是删标签 ——
  // 只删标签会把里面的菜单文字留在原地, 那比不删还糟 (一堆无上下文的词)
  s = s.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  // 标题里的锚点标记: `<h2>File system<a href=#file_system>#</a></h2>`
  // 不删的话每个标题后面都挂一个 #, 切块时它会被当成标题的一部分。
  // href 值三种写法都要认 (实测这个页面**大量不带引号**): "x" / 'x' / x
  s = s.replace(
    /<a\b[^>]*href=(?:"[^"]*#[^"]*"|'[^']*#[^']*'|[^\s>]*#[^\s>]*)[^>]*>\s*#?\s*<\/a>/gi,
    '',
  )
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m: string, n: string) => `\n\n${'#'.repeat(Number(n))} `)
  s = s.replace(/<li\b[^>]*>/gi, '\n- ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(
    /<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|article|header|footer|blockquote|pre|dd|dt|main|nav)>/gi,
    '\n',
  )
  // 只吃"字母开头的标签": 正文里 "3 < 5 且 7 > 2" 不能被当成标签删掉
  s = s.replace(/<\/?[a-zA-Z][^>]{0,2000}>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ')
  s = s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  s = s.replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'")
  // 数字实体: 代码块里满地都是 (&#x27; &#x2F; 之类), 不解码会把代码读成乱码
  s = s.replace(/&#(x?)([0-9a-f]+);/gi, (m: string, hex: string, code: string) => {
    const n = Number.parseInt(code, hex ? 16 : 10)
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
  })
  s = s.replace(/&amp;/gi, '&')
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  // 列表项之间的空行删掉。`<li>` 转 `- ` 加一次换行、`</li>` 又加一次,
  // 于是每个列表项后面都空一行 —— 目录因此变成 `- a\n\n- b\n\n- c`,
  // 后面"连续短列表项=目录"的判断就永远连不起来。顺带正文清单也清爽了
  s = s.replace(/\n\n+(?=- )/g, '\n')
  // 目录 / 索引 / 导航块: **连续十几行都是超短的列表项** —— 那是目录, 不是内容。
  //
  // 放在这里(标签删完、行已经成形之后)而不是对着 <ul> 下刀: 目录常常是嵌套的
  // (`<ul><li><a>…</a><ul><li>…</li></ul></li></ul>`), 正则匹配不了嵌套 ——
  // 非贪婪会停在**第一个** </ul>, 把外层切成半个, 反而留下更乱的残渣。
  // 看最终形态就与嵌套无关: 无论怎么嵌套, 目录最后都是一长串短行。
  //
  // 实测 nodejs.org/api/fs.html: 没有 main/nav/aside 可用, 正文前 1600 行全是
  // 这种目录; 不删的话 outline 的地图开头八块都是它
  s = s.replace(/(?:^-\s+\S[^\n]{0,58}\n){12,}/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
