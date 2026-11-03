/**
 * 最小 HTTP 框架 (~120 行)。
 *
 * 不用 express 的理由同 ws.ts: 内核不该把上行通道交给第三方版本节奏,
 * 而且我们只需要「op 路由 + 静态文件」两件事。
 *
 * 刻意缺失的能力 (加进来都属于猜需求): cookie / 表单 / 模板 /
 * multipart / range。上传要等 v2 有真实用例再说。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

export interface RouteCtx {
  req: IncomingMessage
  res: ServerResponse
  /** 已解析的 JSON body; 非 JSON 请求为 {} */
  body: Record<string, unknown>
  query: URLSearchParams
  url: URL
}

export type RouteHandler = (c: RouteCtx) => unknown | Promise<unknown>

/** 不用 TS parameter property: strip-only 模式不支持, 会让整个包 import 失败 */
export class HttpError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface HttpApp {
  server: Server
  route(method: string, path: string, fn: RouteHandler): () => void
  /** 静态目录。命中返回 true */
  static(prefix: string, dir: string): void
  listen(port: number, host: string): Promise<{ port: number }>
  dispose(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export function createHttpApp(): HttpApp {
  const server = createServer()
  const routes = new Map<string, RouteHandler>()
  const statics: Array<{ prefix: string; dir: string }> = []

  server.on('request', (req, res) => {
    void handle(req, res).catch((err) => {
      if (res.headersSent) return
      const e = err as HttpError
      const status = typeof e.status === 'number' ? e.status : 500
      json(res, status, { error: { code: e.code ?? 'internal', message: e.message ?? String(err) } })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const path = normalize(url.pathname).replace(/\/$/, '') || '/'

    const exact = routes.get(`${method} ${path}`)
    if (exact) {
      const body = await readBody(req)
      const out = await exact({ req, res, body, query: url.searchParams, url })
      if (!res.headersSent) json(res, 200, out ?? { ok: true })
      return
    }

    for (const s of statics) {
      if (path === s.prefix || path.startsWith(s.prefix + '/')) {
        await serveStatic(res, s.dir, s.prefix, path)
        return
      }
    }

    throw new HttpError('not-found', `${method} ${path}`, 404)
  }

  async function serveStatic(res: ServerResponse, dir: string, prefix: string, path: string): Promise<void> {
    const rel = path === prefix ? '/index.html' : path.slice(prefix.length)
    // 防目录穿越: normalize 后必须仍在 dir 内
    const target = resolve(join(dir, rel))
    if (!target.startsWith(resolve(dir))) throw new HttpError('bad-request', '路径越界', 400)

    try {
      const info = await stat(target)
      if (!info.isFile()) throw new HttpError('not-found', '不是文件', 404)
      const data = await readFile(target)
      res.writeHead(200, {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError('not-found', '静态资源不存在', 404)
    }
  }

  return {
    server,
    route(method, path, fn) {
      const key = `${method.toUpperCase()} ${path}`
      if (routes.has(key)) throw new Error(`路由重复: ${key}`)
      routes.set(key, fn)
      return () => routes.delete(key)
    },
    static(prefix, dir) {
      statics.push({ prefix: prefix === '/' ? '' : prefix, dir })
    },
    listen(port, host) {
      return new Promise((ok, fail) => {
        server.once('error', fail)
        server.listen(port, host, () => {
          const addr = server.address()
          const actual = addr && typeof addr === 'object' ? addr.port : port
          ok({ port: actual })
        })
      })
    },
    dispose() {
      return new Promise<void>((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      })
    },
  }
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

const MAX_BODY = 2 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError('bad-request', '请求体过大', 413)
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new HttpError('bad-request', '请求体不是合法 JSON', 400)
  }
}
