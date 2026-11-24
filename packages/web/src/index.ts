/**
 * @meng/web — HTTP 上行 / WebSocket 下行的**服务端**能力面。
 *
 * 契约见 docs/06-api-contract.md (v1)。那份文档是本文件的唯一真相源,
 * 改路由前先改文档。
 *
 * 这里最值得注意的一处设计: `op()` 是**开放注册**的 ——
 * 插件调用 `ctx.get('web').op('my.op', handler)` 就能贡献一个 `/api/my.op`。
 * Python 版做不到这件事: 36 个 `include_router` 全写在 main.py 里,
 * 插件想开 API 只能走 `POST /api/plugins/{id}/services/{name}` 这种后门。
 * 路由因此成为可插拔能力, 而不是内核的私有财产。
 */

import { randomUUID } from 'node:crypto'
import { defineInvariant, type Ctx, type Disposer, type NodeRecord } from '@meng/core'
import type { SessionService, SessionEvent, SessionEventType } from '@meng/session'
import type { StatusGraph } from '@meng/core'
import { attachWebSocket, type WSServer } from './ws.ts'
import { createHttpApp, HttpError, json, type HttpApp, type RouteCtx, type RouteHandler } from './http.ts'
import { registerBuiltinOps } from './ops.ts'

export const name = 'meng-web'
export const inject = ['session']

export const PROTOCOL_VERSION = 1

export type OpHandler = (payload: Record<string, unknown>, c: RouteCtx) => unknown | Promise<unknown>

export interface WebService {
  /** 注册一个上行 op → POST /api/{name}。返回 disposer, 卸载即摘路由 */
  op(name: string, handler: OpHandler): Disposer
  ops(): string[]
  /** 项目适配器专用：注册精确 HTTP 路由。 */
  route(method: string, path: string, handler: RouteHandler): Disposer
  /** 项目适配器专用：注册 HTTP 前缀路由；method 可为 '*'。 */
  prefix(method: string, prefix: string, handler: RouteHandler): Disposer
  /** 下行广播。seq 由内核统一分配, 前端靠它排序和断线重放 */
  broadcast(type: string, payload?: unknown, meta?: { sessionId?: string; runId?: string }): void
  /** 在线连接数, 给调试面板 */
  readonly connections: number
  readonly port: number
  readonly url: string
  /**
   * BootManifest —— 与 ws hello 帧里那份**同一个对象**。
   * 刻意做成方法而不是字段: 插件可能在启动后才注册工具/op,
   * 快照会让前端拿到一份"开机瞬间"的旧清单
   */
  manifest(): BootManifest
}

export interface BootManifest {
  protocol: number
  serverId: string
  startedAt: number
  capabilities: string[]
  ops: string[]
  events: string[]
  models: string[]
  tools: string[]
  /**
   * 状态图节点。有 `client` = 这个插件有前端面, 前端该去下载它。
   * 之前这里是 `Record<string, unknown>`, 等于告诉消费方"自己猜" ——
   * 前后端唯一的接缝上不该有无类型的兜底
   */
  plugins: NodeRecord[]
}

export interface WebConfig {
  port?: number
  host?: string
  /** 前端静态产物目录。存在时挂到 / */
  webRoot?: string
  /** 插件前端 bundle 目录。存在时挂到 /plugins */
  pluginRoot?: string
}

/**
 * 必须是 async 且 await 到 listen 完成 —— 装载器 await 了 apply 才标记 active,
 * 不 await 的话会出现"状态图说 web 已 active, 但端口还没开",
 * 紧接着发起的连接全部 Connection refused。
 */
export async function apply(ctx: Ctx, config: WebConfig = {}): Promise<Disposer> {
  const session = ctx.get<SessionService>('session')
  const app = createHttpApp()
  const ops = new Map<string, OpHandler>()
  const runs = new Map<string, AbortController>()

  const ws: WSServer = attachWebSocket(app.server, {
    path: '/ws',
    onConnect(conn, req) {
      // 1) hello 必须是第一条 —— 前端先校验 protocol 再干别的。
      //    seq 用 -1: 它是握手帧不是事件, 不能占用真实 seq,
      //    否则前端拿 max(seq) 当 lastSeq 时会把历史事件过滤掉
      conn.send(JSON.stringify({
        type: 'hello',
        seq: -1,
        at: Date.now(),
        payload: { protocol: PROTOCOL_VERSION, manifest: service.manifest() },
      }))

      // 2) 断线重放: 只补 since 之后的, 前端不要把已有消息清掉。
      //    since 是"我已收到的最后一条 seq", 所以 0 是合法值(全量补),
      //    判断依据是参数**有没有传**, 不是值大不大于 0
      const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('since')
      if (raw !== null) void replay(conn, session, Number(raw) || 0)
    },
  })

  const service: WebService = {
    op(opName, handler) {
      if (ops.has(opName)) throw new Error(`op 重复注册: ${opName}`)
      ops.set(opName, handler)
      const offRoute = app.route('POST', `/api/${opName}`, (c) => handler(c.body, c))
      return () => {
        ops.delete(opName)
        offRoute()
      }
    },

    ops() {
      return [...ops.keys()].sort()
    },

    route(method, path, handler) {
      return app.route(method, path, handler)
    },

    prefix(method, path, handler) {
      return app.prefix(method, path, handler)
    },

    broadcast(type, payload, meta) {
      const seq = session?.nextSeq() ?? 0
      const event = {
        type,
        seq,
        at: Date.now(),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.runId ? { runId: meta.runId } : {}),
        payload,
      }
      ws.broadcast(JSON.stringify(event))
    },

    get connections() {
      return ws.size
    },
    get port() {
      return (app.server.address() as { port?: number } | null)?.port ?? config.port ?? 0
    },
    get url() {
      return `http://${config.host ?? '127.0.0.1'}:${this.port}`
    },
    manifest() {
      return buildManifest(ctx, service)
    },
  }

  // 会话事件 → 下行。这是"事件流是唯一真相源"的兑现处:
  // 界面上看到的一切都是这条流的投影, 前端不另存一份状态
  const offEvent = ctx.on('session/event', (event: SessionEvent) => {
    ws.broadcast(JSON.stringify({
      type: event.type,
      seq: event.seq,
      at: event.at,
      sessionId: event.sessionId,
      runId: (event.data as { runId?: string } | null)?.runId,
      payload: event.data,
    }))
  })

  const offOps = registerBuiltinOps(ctx, service, { runs })

  app.route('GET', '/health', () => ({ ok: true, uptimeMs: process.uptime() * 1000 }))
  app.route('GET', '/api/boot-manifest', () => buildManifest(ctx, service))

  const port = config.port ?? 4721
  const host = config.host ?? '127.0.0.1'

  if (config.pluginRoot) app.static('/plugins', config.pluginRoot)
  if (config.webRoot) app.static('/', config.webRoot)
  await app.listen(port, host)
  if (!process.env.MENG_QUIET) {
    console.log(`[meng] web  ${service.url}  (ws: ws://${host}:${service.port}/ws)`)
  }

  ctx.set('web', service)

  return () => {
    offOps()
    offEvent()
    ws.dispose()
    for (const ctrl of runs.values()) ctrl.abort()
    runs.clear()
    void app.dispose()
  }
}

/** 断线重放: 只补增量。chunk 不落库所以不会重放, 前端靠 llm/completed 补齐整段 */
async function replay(conn: { send(text: string): void }, session: SessionService | undefined, since: number): Promise<void> {
  if (!session) return
  const events = session.all().filter((e) => e.seq > since)
  for (const event of events) {
    conn.send(JSON.stringify({
      type: event.type,
      seq: event.seq,
      at: event.at,
      sessionId: event.sessionId,
      runId: (event.data as { runId?: string } | null)?.runId,
      payload: event.data,
    }))
  }
}

function buildManifest(ctx: Ctx, web: WebService): BootManifest {
  // 状态图由 boot 注册成能力面, web 不需要知道它从哪来
  const graph = ctx.get<StatusGraph>('graph')
  return {
    protocol: PROTOCOL_VERSION,
    serverId: SERVER_ID,
    startedAt: STARTED_AT,
    capabilities: ['llm', 'session', 'tools', 'prompt', 'loop', 'memory', 'questions', 'web'].filter((n) => ctx.get(n)),
    ops: web.ops(),
    events: [...EVENT_TYPES],
    models: (ctx.get<{ models(): string[] }>('llm')?.models() ?? []),
    tools: (ctx.get<{ list(): Array<{ name: string }> }>('tools')?.list() ?? []).map((t) => t.name),
    plugins: graph?.toJSON().nodes ?? [],
  }
}

const SERVER_ID = randomUUID().slice(0, 8)
const STARTED_AT = Date.now()

export const invariant = defineInvariant('@meng/web', [
  {
    id: 'ops-registered',
    run(ctx) {
      const web = ctx.get<WebService>('web')
      if (!web) throw new Error('能力面 web 未注册')
      if (web.ops().length === 0) throw new Error('没有任何 op, 前端无法做任何事')
    },
  },
])

export { HttpError, json }
export type { HttpApp, RouteCtx, SessionEventType }

/** 前端/插件可复用的下行事件闭集。插件不许发明新 type (契约 §2) */
export const EVENT_TYPES = [
  'hello', 'session/created', 'turn/started', 'llm/chunk', 'llm/completed',
  'tool/called', 'tool/completed', 'tool/blocked', 'question/asked', 'question/answered',
  'model/switched', 'context/compacted', 'job/started', 'job/completed', 'turn/ended', 'plugin/graph', 'error',
] as const
