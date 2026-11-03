/**
 * @meng/plugin-net-local —— 抓取缝的实现: node 自带 fetch + 流式落盘。
 *
 * 为什么流式写盘而不是 `await res.text()`:
 *   304KB 的页面在内存里过一遍只是浪费; 而 10MB 的页面直接吃掉内存。
 *   流式写盘还能天然支持 maxBytes 熔断 —— 收到上限就停, 不再等服务器
 *   把剩下的字节吭哧吭哧传完。
 *
 * 为什么存**原始字节**、把解码留给上层:
 *   网页编码不一定是 utf-8 (老站点还有 gbk), 解码要按 content-type 里的
 *   charset 来。落盘时统一成 utf-8 会二次转码, 转错了就再也修不回来。
 *   原始字节在磁盘上, 上层想按什么编码读都行。
 *
 * 为什么不伪装浏览器 UA:
 *   伪装 UA 是绕反爬。那是**使用者**该自己决定的事 (他可以在 headers 里传),
 *   不该由能力面偷偷做。我们诚实报自己是谁, 被 403 了就如实告诉模型 ——
 *   这比骗来一个页面更可信。
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import {
  NET_CODE,
  NetError,
  provideNet,
  type NetRequest,
  type NetResponse,
  type NetService,
} from '@meng/net'

export const name = 'meng-plugin-net-local'
export const inject: string[] = []

export interface Config {
  /** 落盘根目录。rel 是相对它的路径, 模型看到的也是这个 */
  root?: string
  /** 落盘子目录 */
  relDir?: string
  /** 单次抓取时间上限 */
  timeoutMs?: number
  /** 单次写入上限。超了截断并标记 */
  maxBytes?: number
  /** 目录里保留的文件数上限, 超出删最旧的 */
  maxFiles?: number
  /** 默认请求头。调用方传的 headers 会合并且在后面 (可覆盖) */
  userAgent?: string
}

/**
 * HTTP 头是 ByteString —— **只能装 latin-1**。这里写一个中文字都会让每个请求
 * 在 fetch 内部炸掉, 而报错是 "character at index 38 has a value of 26412",
 * 完全看不出是 UA 的问题 (踩过一次)。所以: 这行必须保持纯 ASCII
 */
const DEFAULT_UA = 'meng/0.0.1 (+https://github.com/meng)'

/**
 * `Accept: text/markdown` 放在最前面:
 * 支持内容协商的站点 (Cloudflare 的 Markdown for Agents 等) 会直接给 markdown,
 * 省掉我们自己去标签这一步, 而且体积常常只有 HTML 的 1/5。
 * 不支持的就退到 HTML —— 这个头**不会**让请求变慢, 不需要成本
 */
const DEFAULT_ACCEPT = 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5'

function parseContentType(raw: string | null): { type: string; charset: string } {
  if (!raw) return { type: '', charset: 'utf-8' }
  const parts = raw.split(';')
  const type = (parts[0] ?? '').trim().toLowerCase()
  let charset = 'utf-8'
  for (const p of parts.slice(1)) {
    const m = /charset\s*=\s*"?([^";]+)"?/i.exec(p)
    if (m?.[1]) charset = m[1].trim().toLowerCase()
  }
  return { type, charset }
}

const EXT: Record<string, string> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'json',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
}

function extOf(contentType: string): string {
  if (EXT[contentType]) return EXT[contentType]
  if (contentType.startsWith('image/')) return 'img'
  return 'bin'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 把错误翻译成能力面自己的码。模型看到的错误必须能指导下一步动作 */
function classify(err: unknown, timedOut: boolean, aborted: boolean): NetError {
  if (err instanceof NetError) return err
  if (timedOut) return new NetError(NET_CODE.TIMEOUT, '抓取超时')
  if (aborted) return new NetError(NET_CODE.ABORTED, '抓取已被中止')
  const e = err as { cause?: { code?: string }; message?: string }
  const code = e?.cause?.code ?? ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new NetError(NET_CODE.DNS, `域名解析失败${e?.message ? `: ${e.message}` : ''}`)
  }
  return new NetError(NET_CODE.TRANSPORT, e?.message ?? String(err))
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const root = resolve(config.root ?? process.env.MENG_WORKSPACE ?? process.cwd())
  const relDir = config.relDir ?? '.meng/web'
  const dir = resolve(root, relDir)
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxBytes = config.maxBytes ?? 5_000_000
  const maxFiles = config.maxFiles ?? 100
  const userAgent = config.userAgent ?? DEFAULT_UA

  /**
   * 这台机器很可能整套走代理 (HTTP_PROXY / HTTPS_PROXY)。
   * **curl 自己会读这两个变量, node 的 fetch 不会** —— 后果是所有抓取静默超时,
   * 而错误只说 "fetch failed"。这个警告值 30 秒的排查时间, 所以宁可吵
   */
  const hasProxy = Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy)
  const proxyEnabled =
    process.execArgv.includes('--use-env-proxy') || process.env.NODE_USE_ENV_PROXY === '1'
  if (hasProxy && !proxyEnabled) {
    console.warn(
      '[meng] net: 环境里有 HTTPS_PROXY, 但 Node 默认不读它 —— 抓取会全部超时。\n' +
        '        用 `node --use-env-proxy` 启动, 或设 NODE_USE_ENV_PROXY=1',
    )
  }

  /** 目录里只留最新的 maxFiles 个。抓取失败不影响清理 */
  async function prune(): Promise<void> {
    try {
      const names = await readdir(dir)
      if (names.length <= maxFiles) return
      const rows: Array<{ path: string; mtime: number }> = []
      for (const n of names) {
        const p = join(dir, n)
        try {
          const s = await stat(p)
          if (s.isFile()) rows.push({ path: p, mtime: s.mtimeMs })
        } catch {
          // 竞态: 别的进程刚删掉。跳过
        }
      }
      rows.sort((a, b) => a.mtime - b.mtime)
      for (const r of rows.slice(0, Math.max(0, rows.length - maxFiles))) {
        await unlink(r.path).catch(() => undefined)
      }
    } catch {
      // 目录还不存在 / 没权限。清理是尽力而为, 不该让抓取失败
    }
  }

  const service: NetService = {
    async fetch(req: NetRequest): Promise<NetResponse> {
      const raw = String(req.url ?? '').trim()
      if (!raw) throw new NetError(NET_CODE.BAD_URL, '缺少 url')
      let target: URL
      try {
        target = new URL(raw)
      } catch {
        throw new NetError(NET_CODE.BAD_URL, `不是合法的 URL: ${raw}`)
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new NetError(NET_CODE.BAD_URL, `只支持 http/https, 收到 ${target.protocol}`)
      }

      const budget = req.timeoutMs ?? timeoutMs
      const cap = req.maxBytes ?? maxBytes

      // 超时与调用方中止合并成一条信号 —— 两者对 fetch 来说都是"别再等了",
      // 但报给模型的码必须分开: 超时是"这站太慢", 中止是"你自己叫停的"
      const timer = AbortSignal.timeout(budget)
      const merged = req.signal ? AbortSignal.any([req.signal, timer]) : timer

      let res: Response
      try {
        res = await fetch(target, {
          signal: merged,
          redirect: 'follow',
          headers: {
            accept: DEFAULT_ACCEPT,
            'user-agent': userAgent,
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            ...(req.headers ?? {}),
          },
        })
      } catch (err) {
        throw classify(err, timer.aborted, req.signal?.aborted === true)
      }

      const { type, charset } = parseContentType(res.headers.get('content-type'))
      const finalUrl = res.url || target.href
      const hash = createHash('sha1').update(finalUrl).digest('hex').slice(0, 12)
      const file = `${hash}.${extOf(type)}`
      await mkdir(dir, { recursive: true })
      const path = join(dir, file)

      let bytes = 0
      let truncated = false
      // 预览用的内存副本。64KB 字节够覆盖大多数页面的正文起点 ——
      // 实测 nodejs.org/about 的 <main> 在 23KB 处, 32KB 只是勉强够
      const PREVIEW_LIMIT = 64 * 1024
      const previewChunks: Uint8Array[] = []
      let previewBytes = 0
      const handle = await open(path, 'w')
      try {
        if (res.body) {
          const reader = res.body.getReader()
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (!value) continue
              if (previewBytes < PREVIEW_LIMIT) {
                const take = Math.min(value.byteLength, PREVIEW_LIMIT - previewBytes)
                previewChunks.push(value.subarray(0, take))
                previewBytes += take
              }
              const remain = cap - bytes
              if (value.byteLength >= remain) {
                if (remain > 0) await handle.write(value.subarray(0, remain))
                bytes += Math.max(0, remain)
                // 到上限就不再要后面的字节: 熔断的意义是省下传输, 不是省下解析。
                // 这里用 >= 而不是 >, 因为"刚好装满"时后面可能还有 —— 宁可多标一次截断,
                // 也不能让模型以为它看到的是全文
                truncated = true
                await reader.cancel().catch(() => undefined)
                break
              }
              await handle.write(value)
              bytes += value.byteLength
            }
          } finally {
            reader.releaseLock()
          }
        }
      } catch (err) {
        // 传输中途断了: 已经收到的字节留在盘上 —— 半截页面也比什么都没有强,
        // 模型至少能看出对面返回了什么开头
        throw classify(err, timer.aborted, req.signal?.aborted === true)
      } finally {
        await handle.close()
      }

      void prune()

      const previewChars = req.previewChars ?? 8000
      let head = ''
      if (previewBytes > 0) {
        const buf = Buffer.concat(
          previewChunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
        )
        try {
          head = new TextDecoder(charset).decode(buf)
        } catch {
          // 站点瞎标编码 (gb2312 写成 gb2312-80 之类) 时别让整次抓取失败:
          // 退到 utf-8 给个大概, 模型至少能看出这页是什么
          head = buf.toString('utf8')
        }
        head = head.slice(0, previewChars)
      }

      const requestedHost = hostOf(target.href)
      const finalHost = hostOf(finalUrl)
      return {
        requested: target.href,
        url: finalUrl,
        status: res.status,
        contentType: type,
        charset,
        bytes,
        truncated,
        path,
        rel: relative(root, path).split(sep).join('/'),
        head,
        redirected: res.redirected,
        crossHost: Boolean(requestedHost) && requestedHost !== finalHost,
      }
    },
  }

  const off = provideNet(ctx, service)

  return () => {
    off()
  }
}

export const invariant = defineInvariant('@meng/plugin-net-local', [
  {
    id: 'service-registered',
    run(ctx) {
      const net = ctx.get<NetService>('net')
      if (!net) throw new Error('能力面 net 未注册')
      if (typeof net.fetch !== 'function') throw new Error('net.fetch 缺失')
    },
  },
  {
    id: 'rejects-bad-url-before-touching-network',
    async run(ctx) {
      const net = ctx.get<NetService>('net')
      if (!net) throw new Error('能力面 net 未注册')
      // 非法协议必须在**发请求之前**就被拦下 —— 否则 file:// / data: 这类
      // URL 会让"抓网页"变成"读本机文件", 那是能力面自己开的越权口子
      try {
        await net.fetch({ url: 'file:///etc/passwd' })
        throw new Error('file:// 竟被放行')
      } catch (err) {
        if (!(err instanceof NetError)) throw err
        if (err.code !== NET_CODE.BAD_URL) throw new Error(`错误码不对: ${err.code}`)
      }
    },
  },
])
