/**
 * 内置 op —— 契约 docs/06 §1。
 *
 * 这里只放"内核必然要提供"的 op。业务 op 应该由插件用 `web.op()` 自己注册,
 * 不要往这个文件里塞 —— 塞进来就等于把业务钉回内核, 又变成 36 个 include_router。
 */

import { randomUUID } from 'node:crypto'
import type { Ctx, Disposer } from '@meng/core'
import type { ConfigService, ConfigWriteResult } from '@meng/config'
import type { SessionService } from '@meng/session'
import type { LLMService } from '@meng/llm'
import type { ToolService } from '@meng/tools'
import type { LoopService } from '@meng/loop'
import { HttpError, type OpHandler, type WebService } from './index.ts'
import { catalogOf } from './catalog.ts'

interface RunRegistry {
  runs: Map<string, AbortController>
}

export function registerBuiltinOps(
  ctx: Ctx,
  web: WebService,
  registry: RunRegistry,
): Disposer {
  const offs: Disposer[] = []
  const op = (name: string, handler: OpHandler) => offs.push(web.op(name, handler))

  const session = () => need<SessionService>(ctx, 'session')
  const llm = () => need<LLMService>(ctx, 'llm')
  const tools = () => need<ToolService>(ctx, 'tools')
  const loop = () => need<LoopService>(ctx, 'loop')
  const config = () => ctx.get<ConfigService>('config')

  // ── 内核 ──────────────────────────────────────────────
  // 与 ws hello 帧同一份 manifest, 给"用不了长连接"的环境 (HTTP 轮询) 兜底
  op('kernel.hello', () => web.manifest())

  op('kernel.status', () => ({
    capabilities: ['llm', 'session', 'tools', 'prompt', 'loop', 'questions', 'web'].filter((n) => ctx.get(n)),
    ops: web.ops(),
    connections: web.connections,
    uptimeMs: Math.round(process.uptime() * 1000),
  }))

  // ── 会话 ──────────────────────────────────────────────
  op('session.create', (payload) => {
    const title = String(payload.title ?? '新会话')
    const sessionId = randomUUID().slice(0, 8)
    session().append(sessionId, 'session/created', { title })
    return { sessionId, at: Date.now() }
  })

  op('session.list', () => session().sessions())

  op('session.read', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const since = Number(payload.since ?? 0)
    const events = session().read(sessionId)
    return since > 0 ? events.filter((e) => e.seq > since) : events
  })

  /**
   * 不等待结果 —— 一轮 agent 可能跑几十秒、调十几个工具。
   * 返回 runId 后所有进展走 WS, 前端靠 runId 分组。
   */
  op('session.send', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const text = String(payload.text ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    if (!text) throw new HttpError('bad-request', '缺 text')

    const runId = randomUUID().slice(0, 8)
    const ctrl = new AbortController()
    registry.runs.set(runId, ctrl)

    const model = payload.model ? String(payload.model) : undefined

    void (async () => {
      try {
        for await (const ev of loop().run({ sessionId, text, model, runId, signal: ctrl.signal })) {
          if (ev.type === 'text') {
            // chunk 不落库: 一轮几千个, 落进去事件流会爆炸。
            // 代价是断线重放没有 chunk, 前端用 llm/completed 的整段补齐
            web.broadcast('llm/chunk', { delta: ev.text, runId }, { sessionId, runId })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        web.broadcast('error', { code: 'internal', message, runId }, { sessionId, runId })
      } finally {
        registry.runs.delete(runId)
      }
    })()

    return { runId, accepted: true }
  })

  op('session.abort', (payload) => {
    const runId = String(payload.runId ?? '')
    const ctrl = registry.runs.get(runId)
    if (!ctrl) throw new HttpError('aborted', `run ${runId} 不存在或已结束`, 409)
    ctrl.abort()
    return { ok: true }
  })

  // ── 模型 / 工具 ───────────────────────────────────────
  // 只给**能用**的模型: 这个 op 喂的是"选模型", 列出没配 key 的那家的模型
  // 等于给用户一个点了就报错的选项
  op('llm.models', () => llm().models())

  /**
   * 供应商目录 —— 设置页「模型」分区的唯一数据源。
   *
   * 三个问题一次答完: 装了谁 (含**没配好的**)、各自要填什么 (schema + 当前值)、
   * 为什么现在不能用 (missing)。所以前端不需要自己拼 llm 和 config 两份数据,
   * 也不需要认识任何 provider 插件。
   */
  op('llm.catalog', () => catalogOf(llm().listProviders(), config()?.list() ?? []))

  op('tools.list', () => tools().list())

  // ── 配置读写 ──────────────────────────────────────────
  // 设置页跨进程生效的值必须走后端 (localStorage 只管纯视觉偏好)。
  // 这两个 op 是 packages/config 那道缝的出口, 语义全在缝里, 这里只做
  // 「全名 → (scope, name)」的翻译 —— 因为 scope 名本身带点 (`llm.deepseek`),
  // 按第一个点切会把 `llm.deepseek.apiKey` 切成 `llm` / `deepseek.apiKey`。
  op('config.list', () => needConfig(ctx).list())

  op('config.set', async (payload) => {
    const svc = needConfig(ctx)
    const entry = declared(svc, payload.key)
    // 形状由声明里的 schema 判定, 这里只挡"没给值"——
    // 在这里再列一遍允许的类型, 就是第二份规则, 而两份规则必然漂移
    if (!('value' in payload)) throw new HttpError('bad-request', '缺 value')
    return shape(await svc.set(entry.scope, entry.name, payload.value))
  })

  op('config.unset', async (payload) => {
    const svc = needConfig(ctx)
    const entry = declared(svc, payload.key)
    return shape(await svc.unset(entry.scope, entry.name))
  })

  // ── 插件状态图 ────────────────────────────────────────
  op('plugin.graph', () => {
    const graph = ctx.get<{ toJSON(): unknown }>('graph')
    if (!graph) throw new HttpError('no-capability', '状态图未挂载', 503)
    return graph.toJSON()
  })

  return () => {
    for (const off of offs.reverse()) off()
  }
}

function need<T>(ctx: Ctx, name: string): T {
  const service = ctx.get<T>(name)
  if (!service) throw new HttpError('no-capability', `能力面 ${name} 未装载`, 503)
  return service
}

/** 配置层是**可选**的: 没有它设置页只是没得改, 不该让整页 500 */
function needConfig(ctx: Ctx): ConfigService {
  const service = ctx.get<ConfigService>('config')
  if (!service) throw new HttpError('no-capability', '配置层未装载 (缺 plugins/config-local)', 503)
  return service
}

/** 按**全名**找已声明的项, 拿它拆出来的 (scope, name) —— 不猜点号怎么切 */
function declared(svc: ConfigService, raw: unknown) {
  const key = String(raw ?? '')
  if (!key) throw new HttpError('bad-request', '缺 key')
  const entry = svc.list().find((e) => e.key === key)
  if (!entry) throw new HttpError('bad-request', `${key} 不是已声明的配置项`, 400)
  return entry
}

function shape(result: ConfigWriteResult) {
  return { entry: result.entry, scopeEntries: result.scopeEntries }
}
