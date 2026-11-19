/**
 * @meng/plugin-tool-fetch —— web_fetch 薄壳: 只认能力面 net, 不自己发请求。
 *
 * 这个工具的职责只有两件: **把原始字节变成模型能读的文字**, 和**说清原文在哪**。
 * 抓取、超时、落盘全在 net-local; 换一个抓取实现 (curl / 代理 / 缓存), 这里一行不改。
 *
 * ## 为什么不做成"摘要"
 *
 * Claude Code 的 WebFetch 会把 markdown 交给一个小模型, 主模型只看到那份笔记 ——
 * 官方文档自己写的是 "lossy by design"。后果是: API 签名被"清理"成不存在的写法,
 * 四个代码块回来只剩三个, 而模型无从核对。
 *
 * 我们反过来: **原文一字不改地留在磁盘上**, 这里只做"去掉确定是噪音的部分"
 * (script / style / 注释)。不猜哪段是正文 —— 猜错了就把答案吃了,
 * 而"哪段有用"恰恰是模型比正则更擅长的事。
 *
 * ## 为什么 404 不算失败
 *
 * 和 bash 的非零退出同一条道理: 服务器拒绝你, 是**结果**。模型需要知道
 * "这页没了"然后换个来源, 而不是看到 isError 就以为工具坏了然后重试同一个网址。
 * 只有"根本没连上"(DNS / 超时 / 中止) 才判失败 —— 那时候重试是有意义的。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import { getNet, mainOf, readable, NetError, type NetResponse } from '@meng/net'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-fetch'
export const inject = ['tools', 'net']

export interface Config {
  /** 给模型看的预览长度 (字符)。太长会把上下文挤爆, 太短看不出这页有没有用 */
  displayChars?: number
  /** 请求 net 时预留的原始字符数。HTML 剥完会缩水, 所以要的多一些 */
  rawPreviewChars?: number
  timeoutMs?: number
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const isHtmlType = (t: string): boolean =>
  t === 'text/html' || t === 'application/xhtml+xml' || t === 'application/xml' || t === 'text/xml'

const isTextType = (t: string): boolean =>
  t.startsWith('text/') ||
  t === 'application/json' ||
  t.endsWith('+json') ||
  t.endsWith('+xml')

/** 状态行。模型靠它区分"这页没了"和"这页不让我看" */
function statusLine(res: NetResponse): string {
  const flags: string[] = []
  if (res.status >= 300 && res.status < 400) flags.push('重定向')
  if (res.status === 401 || res.status === 403) flags.push('拒绝访问')
  if (res.status === 404 || res.status === 410) flags.push('页面不存在')
  if (res.status >= 500) flags.push('服务器出错')
  const tag = flags.length ? ` ${flags.join(' · ')}` : ''
  return `[${res.status}${tag}] ${res.contentType || '未知类型'} · ${formatBytes(res.bytes)} · ${res.url}`
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const net = getNet(ctx)
  if (!net) throw new Error('能力面 net 未装载')

  const displayChars = config.displayChars ?? 4000
  // 要的比展示的多得多: 正文起点可能在一屏导航之后 (实测最远 23KB),
  // 只取展示长度的话, mainOf 根本找不到 <main>, 结果又是满屏菜单
  const rawPreviewChars = config.rawPreviewChars ?? 60000

  const def: ToolDef = {
    name: 'web_fetch',
    // 联网工具单独一组: "这一轮不需要上网"是能提前判断的, 关掉它省下的
    // 不只是 prompt 里的几行, 还有模型点它的概率
    group: 'web',
    description:
      '抓取一个网址并返回可读文本。用来读某个具体链接的内容。\n' +
      '返回 = 去掉 script/样式后的开头一段 + **原文落盘的路径**。\n' +
      '开头只是第一眼: 要精确定位某段内容, 拿返回的路径去 grep 搜关键词、read 分段读。\n' +
      '不做搜索 —— 不知道网址时它没用。\n' +
      '服务器返回 404/403 也算"抓取成功且结果为错误页", 不是工具故障, 别原地重试。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址, 必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
    async handler(args, _ctx, call) {
      const url = String(args.url ?? '').trim()
      if (!url) return fail('缺少 url')

      let res: NetResponse
      try {
        res = await net.fetch({
          url,
          signal: call?.signal,
          timeoutMs: config.timeoutMs,
          previewChars: rawPreviewChars,
        })
      } catch (err) {
        // 只有"没连上"走到这里。此时给一句能指导下一步的话, 而不是把栈丢给模型
        if (err instanceof NetError) {
          if (err.code === 'NET_ABORTED') return fail('抓取已被中止')
          if (err.code === 'NET_TIMEOUT') return fail(`抓取超时: ${url}`)
          if (err.code === 'NET_DNS') return fail(`域名解析失败 (网址可能拼错了): ${url}`)
          if (err.code === 'NET_BAD_URL') return fail(`网址不合法: ${err.message}`)
        }
        return fail(`抓取失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      const parts: string[] = [statusLine(res)]

      if (res.crossHost) {
        parts.push(
          `注意: 请求的 ${res.requested} 被重定向到另一个站点 (${res.url}) —— ` +
            '你拿到的可能不是原来那篇内容',
        )
      }
      if (res.truncated) {
        parts.push('注意: 超过单次抓取上限, 原文只存了开头部分')
      }
      if (res.status >= 400) {
        parts.push('服务器返回了错误, 下面是错误页的内容 (不是你要的那篇):')
      }

      const type = res.contentType
      const looksHtml =
        isHtmlType(type) || (type === '' && /^\s*<(!doctype|html)/i.test(res.head.slice(0, 200)))

      if (looksHtml) {
        const text = readable(mainOf(res.head))
        if (text.length < 40) {
          // 实测常见: 知乎 302 跳登录、SPA 只有骨架 —— 原始 HTML 里根本没有正文。
          // 这句提示比"内容为空"有用得多, 它直接告诉模型换一条路
          parts.push(
            '（剥完几乎没有文字: 这页的正文由 JavaScript 现场生成, 或需要登录才显示。\n' +
              '  原始 HTML 里没有可读内容, 换个来源试试 —— 重试同一个网址不会有变化）',
          )
        } else {
          parts.push(`（已剥掉 script/样式, 下面是开头 ${Math.min(displayChars, text.length)} 字）`)
          parts.push(text.slice(0, displayChars))
        }
      } else if (isTextType(type) || type === '') {
        parts.push(res.head.slice(0, displayChars))
      } else {
        parts.push(
          `这不是文本 (${type || '未知类型'}), 没有可读内容。` +
            '需要它的话用 bash 处理这个文件',
        )
      }

      parts.push(
        `—— 原文 ${formatBytes(res.bytes)} 存在 ${res.rel}\n` +
          `   要看全文或精确定位: read ${res.rel} (可带 offset) 或 grep 关键词`,
      )

      return ok(parts.join('\n'))
    },
  }

  const off = tools.register(def)
  return () => {
    off()
  }
}

export const invariant = defineInvariant('@meng/plugin-tool-fetch', [
  {
    id: 'html-preview-drops-noise',
    run() {
      const html =
        '<html><head><style>body{color:red}</style>' +
        '<script>var secret=1</script></head>' +
        '<body><h1>标题</h1><p>正文内容</p><!-- 注释 --></body></html>'
      const out = readable(html)
      for (const junk of ['secret', 'color:red', '注释']) {
        if (out.includes(junk)) throw new Error(`噪音没被剥掉: ${junk}`)
      }
      if (!out.includes('正文内容')) throw new Error('正文被误删了')
      // 标题必须留下结构记号, 否则模型分不清标题和正文
      if (!out.includes('# 标题')) throw new Error(`标题没转成 markdown: ${JSON.stringify(out)}`)
    },
  },
  {
    id: 'entity-not-double-decoded',
    run() {
      // 转义过的标签必须留成文字, 不能变成真标签再被吃掉
      const out = readable('<p>写法是 &lt;div&gt; 包起来</p>')
      if (out.includes('div') === false) throw new Error(`实体解错了: ${out}`)
      if (out.includes('<div>') === false) throw new Error(`&lt;div&gt; 应还原成文字 <div>: ${out}`)
    },
  },
  {
    id: 'nav-and-doctype-removed',
    run() {
      const html =
        '<!DOCTYPE html><html><body><nav><a>菜单一</a><a>菜单二</a></nav>' +
        '<p>真正文</p><footer>版权信息</footer></body></html>'
      const out = readable(html)
      for (const junk of ['doctype', 'DOCTYPE', '菜单一', '版权信息']) {
        if (out.includes(junk)) throw new Error(`没删干净: ${junk} → ${JSON.stringify(out)}`)
      }
      if (!out.includes('真正文')) throw new Error('正文被误删了')
    },
  },
  {
    id: 'main-wins-over-menu',
    run() {
      // 真实形状: 23KB 导航在前, 正文被 <main> 包着。取开头会取到一屏菜单
      const pad = '<li>导航项导航项导航项</li>'.repeat(80)
      const html = `<body><aside>${pad}</aside><main><h1>标题</h1><p>这是正文</p></main></body>`
      const scoped = mainOf(html)
      if (!scoped.includes('这是正文')) throw new Error('没找到 main 里的正文')
      const out = readable(scoped)
      if (out.includes('导航项')) throw new Error('main 之外的噪音漏进来了')
      // 找不到 main/article 时要老实退回全文, 而不是返回空
      const plain = '<body><p>没有 main 的页面</p></body>'
      if (mainOf(plain) !== plain) throw new Error('没有 main 时不该改动输入')
    },
  },
])
