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
import { LlmError, type LLMService } from '@meng/llm'
import { PROTOCOLS } from '@meng/pi'
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
  op('llm.catalog', () =>
    catalogOf(llm().listProviders(), config()?.list() ?? [], llm().listConfigurableProviders()),
  )

  /**
   * 可选的 wire 协议（9 种）。
   *
   * 为什么要单独一个 op：设置页"新建自定义 API"要画一个协议选择框，而**能选
   * 哪些**是后端的能力，不是前端的常量。硬编码在前端的话，后端加一种协议，
   * 界面上永远选不到 —— 而且不会有任何报错。
   *
   * 为什么从 `@meng/pi` 拿而不是从 config 的 schema 里挖：schema 里的 enum
   * 只有 id，没有"这条协议还需不需要 AWS 凭据"这类要说给用户听的话。
   * 这里一起给。
   */
  op('llm.protocols', () => PROTOCOLS)

  /**
   * 模型发现 —— 设置页的「获取可用模型」。
   *
   * payload 是**草稿**: 编辑一条已有路由时给 `provider`; 新建一条时给
   * `baseURL` / `protocol` / `apiKeyEnv`（此时它还没有路由 id）。
   * `scope` 用来找"谁负责探测这类供应商"—— 探测器由插件按 scope 注册,
   * 出口层不认识任何厂商。
   */
  op('llm.discoverModels', async (payload) => {
    const scope = typeof payload.scope === 'string' ? payload.scope.trim() : ''
    if (!scope) throw new HttpError('bad-request', '缺 scope（这些供应商属于哪个插件）')
    try {
      return await llm().discoverModels(scope, {
        ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
        ...(typeof payload.baseURL === 'string' ? { baseURL: payload.baseURL } : {}),
        ...(typeof payload.protocol === 'string' ? { protocol: payload.protocol } : {}),
        ...(typeof payload.apiKeyEnv === 'string' ? { apiKeyEnv: payload.apiKeyEnv } : {}),
        // 只在明确要说"别翻目录、去问端点"时透传。默认值留在缝里，
        // 这里再写一遍 `: 'catalog'` 就等于同一个默认值有两份
        ...(payload.source === 'endpoint' ? { source: 'endpoint' as const } : {}),
      })
    } catch (err) {
      // 这条链路最需要的是"为什么没拉到": 401 / 连不上 / 不是模型清单。
      // 原样冒会变成 500 的通用壳, 那句话就丢了
      if (err instanceof LlmError) throw new HttpError(err.failure.code.toLowerCase(), err.message, 400)
      throw err
    }
  })

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
    // 带了 path = 只改组合配置里的那一格 (从磁盘上的当前值出发)。
    // 不带 = 写整值, 与以前完全一样
    return shape(await svc.set(entry.scope, entry.name, payload.value, pathOf(payload.path)))
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

/**
 * `config.set` 的 `path`: 只改组合配置里的一格。
 *
 * 为什么要在这一层挡而不是交给下面: 下面只认 `(scope, key, value, path)` 四件,
 * 一个 `path: 'zai.baseURL'` (字符串) 传下去会被当成"没有 path" —— 于是
 * **整张路由表被这一格的值替换掉**。那是静默的数据删除, 比 400 难查一万倍。
 *
 * 数组下标也允许 (改列表里的第 n 项), 但每一段必须是字符串或数字:
 * 数字字符串 `'0'` 按对象键处理, JS 里对数组也成立。
 */
function pathOf(raw: unknown): Array<string | number> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError('bad-request', 'path 必须是非空数组, 如 ["zai", "baseURL"]')
  }
  return raw.map((seg: unknown) => {
    if (typeof seg === 'number' && Number.isFinite(seg)) return seg
    if (typeof seg === 'string' && seg !== '') return seg
    throw new HttpError('bad-request', 'path 的每一段必须是非空字符串或数字')
  })
}
