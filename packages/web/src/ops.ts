/**
 * 内置 op —— 契约 docs/06 §1。
 *
 * 这里只放"内核必然要提供"的 op。业务 op 应该由插件用 `web.op()` 自己注册,
 * 不要往这个文件里塞 —— 塞进来就等于把业务钉回内核, 又变成 36 个 include_router。
 */

import { randomUUID } from 'node:crypto'
import type { Ctx, Disposer } from '@meng/core'
import type { SessionService } from '@meng/session'
import type { LLMService } from '@meng/llm'
import type { ToolService } from '@meng/tools'
import type { AgentService } from '@meng/agent'
import { HttpError, type OpHandler, type WebService } from './index.ts'

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
  const agent = () => need<AgentService>(ctx, 'agent')

  // ── 内核 ──────────────────────────────────────────────
  // 与 ws hello 帧同一份 manifest, 给"用不了长连接"的环境 (HTTP 轮询) 兜底
  op('kernel.hello', () => web.manifest())

  op('kernel.status', () => ({
    capabilities: ['llm', 'session', 'tools', 'prompt', 'agent', 'questions', 'web'].filter((n) => ctx.get(n)),
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
        for await (const ev of agent().run({ sessionId, text, model, runId, signal: ctrl.signal })) {
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
  op('llm.models', () => llm().models())
  op('tools.list', () => tools().list())

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
