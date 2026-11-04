/**
 * @meng/provider-openai — OpenAI 兼容 provider (含 edgefn / 智谱 / minimax 等)。
 *
 * 边界: provider **只负责"把消息变成 delta 流"**。组块、重试、超时、计费、
 * 上下文压缩都不在这里 —— 组块是 @meng/llm 的 assemble(), 其余是
 * `llm/request` waterfall 上的插件。
 * Python 版把这些塞进 provider 基类, 结果是加一个厂商要改 6-7 处。
 *
 * 厂商怪癖(比如 minimax 把 tool_call 写成嵌套 XML、闭标签还写错)
 * 由**各自的 provider 插件**负责, 绝不能漏进 agent 循环。
 */

import * as z from 'zod'
import type { Ctx, Disposer } from '@meng/core'
import { openScope } from '@meng/config'
import {
  LLM_CODE,
  LlmError,
  httpErrorCode,
  type ContentBlock,
  type FinishReason,
  type LLMService,
  type Message,
  type Provider,
  type ProviderInfo,
  type StreamChunk,
  type StreamRequest,
  type ToolSpec,
} from '@meng/llm'
import { parseLine, sseLines } from './sse.ts'

export const name = 'provider-openai'
export const inject = ['llm']

export const CONFIG_SCOPE = 'llm.openai'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODELS = ['gpt-4o-mini']
const DEFAULT_API_KEY_ENV = 'MENG_LLM_API_KEY'
const DEFAULT_TEMPERATURE = 0.7

/**
 * 一条路由的 profile。**对应 dsh-llm-pi-ai 里 `providers` 字典的一个 value。**
 *
 * 这个形状是"自由配置供应商"的全部秘密: 以前整个插件只有一份配置, 于是
 * 它只能代表**一家**。改成字典之后, 键就是路由名, 一个 key 一家 ——
 * 用户想接自己的网关, 不需要等我们写插件。
 *
 * `apiKeyEnv` 是**每条路由各自的**: 两家第三方网关两个 key 是常态,
 * 共用一个环境变量名等于其中一家永远拿错凭据。
 */
const RouteSchema = z.object({
  /** 给人看的名字。留空回落成路由名 (路由名是英文 id, 不该直接上界面) */
  displayName: z.string().optional(),

  baseURL: z.string().min(1),

  /**
   * **环境变量名, 不是密钥。** 值只从 `process.env` 读, 永不落盘 ——
   * 这条来自 dsh: a literal key is not a configuration value。
   */
  apiKeyEnv: z.string().min(1).default(DEFAULT_API_KEY_ENV),

  /** 这个路由能用的模型名。空数组回落成默认那一个 (见 `modelsOf`) */
  models: z.array(z.string()).default([]),

  temperature: z.number().min(0).max(2).optional(),
})

export type RouteProfile = z.infer<typeof RouteSchema>
export type RouteMap = Record<string, RouteProfile>

/**
 * 配置声明。**只有一项**: 一张路由表。
 *
 * 为什么不是"每个字段一项" (baseURL / apiKey / models 各一条 entry):
 * 那样只能描述一家。要做多供应商, 配置本身必须是**可增删键的结构**,
 * 而"可增删键"在 JSON Schema 里就是 object + additionalProperties ——
 * 正好也是设置页要画的那个东西。
 *
 * 默认值里带一条 `openai`: 升级后行为不变, 用户打开设置页就能看到一条
 * 能直接填 key 的路由, 而不是一个空表 + 一句"请自行添加"。
 */
export const CONFIG = {
  routes: z
    .record(z.string(), RouteSchema)
    .default({
      openai: {
        displayName: 'OpenAI',
        baseURL: DEFAULT_BASE_URL,
        apiKeyEnv: DEFAULT_API_KEY_ENV,
        models: DEFAULT_MODELS,
      },
    })
    .meta({
      description:
        '一组 OpenAI 协议路由: 键是路由名, 值是它的地址 / 密钥变量名 / 模型。加一条就是多一家供应商, 立刻生效',
    }),
}

export function apply(ctx: Ctx): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-openai 依赖 llm')

  const { scope, dispose } = openScope(ctx, CONFIG_SCOPE, CONFIG)
  ctx.effect(() => dispose)

  /**
   * 当前这一份路由表。**每次读 scope, 不缓存。**
   *
   * 于是"改了某条路由的地址/模型名"下一个请求就生效, 不需要重新注册 ——
   * 重新注册会让在飞的请求拿到一个正在被卸掉的路由。只有**增删键**才要重注册。
   */
  const routes = (): RouteMap => {
    const raw = scope.get<RouteMap>('routes')
    return raw !== null && typeof raw === 'object' ? raw : {}
  }

  const profileOf = (id: string): RouteProfile | undefined => routes()[id]

  /**
   * 一条路由能用的模型。空列表回落成默认那一个。
   *
   * 为什么不让它空着: 空 models 的路由会从"选模型"的列表里彻底消失 ——
   * 用户刚加了一行却看不见它, 会以为没生效。
   */
  const modelsOf = (id: string): string[] => {
    const list = profileOf(id)?.models ?? []
    return list.length > 0 ? list : DEFAULT_MODELS
  }

  /** 一条路由的凭据**值**。路由里存的是变量名, 值只从 env 读 */
  const apiKeyOf = (profile: RouteProfile | undefined): string => {
    if (!profile) return ''
    const envName = profile.apiKeyEnv || DEFAULT_API_KEY_ENV
    const own = (process.env[envName] ?? '').trim()
    if (own) return own
    // 历史名字。**只在绑的是默认名时**才看它: 用户显式绑了 MY_KEY 却去读
    // OPENAI_API_KEY, 会让"我明明绑了却没生效"变得毫无线索
    if (envName === DEFAULT_API_KEY_ENV) return (process.env['OPENAI_API_KEY'] ?? '').trim()
    return ''
  }

  /**
   * 一条路由 → 一个 Provider。
   *
   * 读的全部是 getter / 现读 scope, 没有快照 —— 所以 `sync()` 只在增删键时
   * 需要被调用, 值的变化天然实时。
   */
  const providerOf = (id: string): Provider => ({
    id,

    // getter 而不是常量: 改显示名不该要求重新注册一条路由
    get displayName() {
      return profileOf(id)?.displayName ?? id
    },

    configScope: CONFIG_SCOPE,

    get models(): string[] {
      return modelsOf(id)
    },

    available: () => apiKeyOf(profileOf(id)) !== '',

    missing: () => {
      const profile = profileOf(id)
      if (!profile) return [`路由 ${id} 已经不在配置里, 但还挂在注册表上`]
      if (apiKeyOf(profile)) return []
      return [`环境变量 ${profile.apiKeyEnv} 里没有值`]
    },

    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      const profile = profileOf(id)
      if (!profile) {
        throw new LlmError(`路由 ${id} 已经从配置里删掉了`, LLM_CODE.NO_ADAPTER)
      }
      const apiKey = apiKeyOf(profile)
      if (!apiKey) {
        throw new LlmError(
          `路由 ${id} 没拿到凭据: 环境变量 ${profile.apiKeyEnv} 是空的`,
          LLM_CODE.MISSING_CREDENTIAL,
        )
      }

      const res = await fetch(`${stripSlash(profile.baseURL)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // 不可关闭的自我标识: 上游统计/限流认这个, 也让请求一眼可分辨
          'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
        },
        body: JSON.stringify({
          model: req.model || modelsOf(id)[0],
          messages: toOpenAI(req.messages),
          temperature: profile.temperature ?? DEFAULT_TEMPERATURE,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.tools?.length ? { tools: toTools(req.tools) } : {}),
        }),
        signal: req.signal,
      })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw wireError(id, res.status, text, res.headers)
      }

      // 块号按**出现顺序**分配, 不是"正文固定 0 号"。
      // 旧写法在"先思考再说话"的模型上是错的: reasoning 和正文都往 0 号块塞,
      // assemble() 以先开的类型为准 (reasoning), 于是回答被并进思考块 ——
      // 而思考不上行广播, 界面上就只剩思考、没有回答。
      // 同一条规矩见 provider-deepseek/src/translate.ts
      let nextIndex = 0
      let textIndex: number | undefined
      let reasoningIndex: number | undefined
      const toolIndex = new Map<number, number>()
      let sawToolCall = false

      for await (const line of sseLines(res.body)) {
        const chunk = parseLine(line)
        if (!chunk) continue

        if (chunk.error?.message) {
          throw new LlmError(`provider ${id}: ${chunk.error.message}`, LLM_CODE.MALFORMED_RESPONSE)
        }

        if (chunk.usage) {
          yield { type: 'usage', usage: toUsage(chunk.usage) }
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta

          if (delta?.reasoning_content) {
            reasoningIndex ??= nextIndex++
            yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
          }
          if (delta?.content) {
            textIndex ??= nextIndex++
            yield { type: 'text-delta', index: textIndex, text: delta.content }
          }
          if (delta?.tool_calls?.length) {
            for (const call of delta.tool_calls) {
              const wireIndex = call.index ?? 0
              let index = toolIndex.get(wireIndex)
              if (index === undefined) {
                index = nextIndex++
                toolIndex.set(wireIndex, index)
              }
              // 第一个分片带 id/name, 后续只有 arguments 增量
              if (call.id || call.function?.name) sawToolCall = true
              yield {
                type: 'tool-call-delta',
                index,
                ...(call.id ? { id: call.id } : {}),
                ...(call.function?.name ? { name: call.function.name } : {}),
                argumentsDelta: call.function?.arguments ?? '',
              }
            }
          }
          if (choice.finish_reason) {
            yield { type: 'finish', reason: toFinish(choice.finish_reason, sawToolCall) }
            return
          }
        }
      }

      // 流断在 finish 之前 (连接掉了 / provider 忘了收尾): 交给 assemble() 补一个
      // error finish —— 这里补不出更多事实, 也不该伪装成成功
    },
  })

  /**
   * 活着的路由: id → 卸装函数。**只有增删键时才动它。**
   *
   * 这张表和 `routes()` 的关系是"注册表 vs 配置": 配置是愿望, 注册表是现状。
   * 两者只在 sync() 里对齐 —— 所以任何时刻都不会出现"配置里有、注册表里没有"
   * 的中间态被别处看到 (sync 是同步的, 没有 await)。
   */
  const live = new Map<string, Disposer>()

  const sync = (): void => {
    const want = routes()

    // 先删: 用户删掉一条路由, 它必须立刻从注册表消失,
    // 否则它会继续出现在"选模型"的列表里, 点了却发不出去
    for (const [id, off] of live) {
      if (Object.hasOwn(want, id)) continue
      off()
      live.delete(id)
    }

    // 再加
    for (const id of Object.keys(want)) {
      if (live.has(id)) continue
      try {
        live.set(id, llm.register(providerOf(id)))
      } catch (err) {
        // 撞了别的插件占用的路由名 (用户把路由命名成 deepseek 就会这样)。
        // 一条坏路由不能拖垮其余那些, 但**绝不能静默** —— 用户得知道它没生效
        console.error(`[meng] provider-openai: 路由 "${id}" 注册失败, 已跳过:`, err)
      }
    }
  }

  sync()

  // 配置一变就对一遍。**订阅而不是轮询**: 没有变化就没有开销,
  // 也没有"两次轮询之间加了路由看不见"的窗口
  ctx.effect(() => scope.onChange(sync))

  if (!process.env.MENG_QUIET) {
    for (const id of Object.keys(routes())) {
      const profile = profileOf(id)
      if (!profile) continue
      const key = apiKeyOf(profile) ? '' : ` · 未配置 (${profile.apiKeyEnv} 为空)`
      console.log(`[meng] provider ${id} · ${modelsOf(id).join(', ')} · ${stripSlash(profile.baseURL)}${key}`)
    }
  }

  return () => {
    for (const off of live.values()) off()
    live.clear()
    dispose()
  }
}

// ── wire ↔ 中立层 ─────────────────────────────────────────────────────────────

function wireError(providerId: string, status: number, body: string, headers: Headers): LlmError {
  let wireMessage = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error?: { message?: string } }).error
      if (err?.message) wireMessage = err.message
    }
  } catch {
    // 非 JSON 的错误体 (网关 HTML 页等), 原样截断
  }
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const requestId = headers.get('x-request-id') ?? headers.get('request-id') ?? undefined
  return new LlmError(`provider ${providerId} 返回 ${status}: ${wireMessage.slice(0, 300)}`, httpErrorCode(status, wireMessage), {
    status,
    ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
    ...(requestId ? { requestId } : {}),
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

function toFinish(reason: string, sawToolCall: boolean): FinishReason {
  if (reason === 'tool_calls' || (reason === 'stop' && sawToolCall)) return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Token 口径: 互斥计数。OpenAI 系的 prompt_tokens 含缓存命中
 * (prompt_tokens_details.cached_tokens), 不减出来缓存流量会被重复计进成本
 */
function toUsage(wire: {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number } {
  const cached = wire.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, (wire.prompt_tokens ?? 0) - cached),
    outputTokens: wire.completion_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(wire.completion_tokens_details?.reasoning_tokens
      ? { reasoningTokens: wire.completion_tokens_details.reasoning_tokens }
      : {}),
  }
}

// ── 序列化: 块 → OpenAI wire ─────────────────────────────────────────────────

function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** Message[] → OpenAI wire 格式。导出是为了能被单测直接打 */
export function toOpenAI(messages: Message[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // tool-result 块按 OpenAI 语义拆成独立的 {role:'tool'} 消息;
      // 并发调用时一条 user 消息里会有多个结果, 每个都要出自己的那条
      const text = flattenText(m.content)
      if (text) out.push({ role: 'user', content: text })
      for (const block of m.content) {
        if (block.type === 'tool-result') {
          out.push({ role: 'tool', content: flattenText(block.content), tool_call_id: block.toolCallId })
        }
      }
      continue
    }
    if (m.role === 'assistant') {
      const text = flattenText(m.content)
      const toolCalls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.arguments } }))
      out.push({
        role: 'assistant',
        // 有 tool_calls 时给空 content 是非法的 (provider 直接 400)
        ...(text ? { content: text } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    out.push({ role: m.role, content: flattenText(m.content) })
  }
  return out
}

function toTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 本插件注册的全部路由。现在不止一条, 所以按 configScope 认亲, 不按固定 id */
const routesOf = (ctx: Ctx): ProviderInfo[] =>
  ctx.get<LLMService>('llm')?.listProviders().filter((p) => p.configScope === CONFIG_SCOPE) ?? []

export const invariant = {
  pkg: '@meng/provider-openai',
  checks: [
    {
      id: 'declared',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm) throw new Error('llm 未注册')
        const mine = routesOf(ctx)
        // 默认配置里有一条 openai, 所以"一条都没有"只可能是配置被清空成 {} 了 ——
        // 那是用户能做出来的事, 说出来比默默没有供应商好
        if (mine.length === 0) throw new Error(`${CONFIG_SCOPE} 下一条路由都没有 (routes 是空表)`)
        for (const info of mine) {
          if (!info.configScope) throw new Error(`路由 ${info.id} 没挂 configScope, 设置页找不到它的配置`)
        }
      },
    },
    {
      /** 见 provider-deepseek 里同名检查的注释: 只在"没有别的可用 provider"时才算失败 */
      id: 'credential-present',
      run(ctx: Ctx) {
        const mine = routesOf(ctx)
        if (mine.some((p) => p.available)) return
        const llm = ctx.get<LLMService>('llm')
        const others = llm?.listProviders().filter((p) => p.configScope !== CONFIG_SCOPE && p.available) ?? []
        if (others.length > 0) return
        // 缺什么由 provider 自己说 (它知道每条路由绑的是哪个变量名)
        const missing = mine.flatMap((p) => p.missing ?? [])
        throw new Error(
          `provider-openai 没有一条可用路由${missing.length > 0 ? `: ${missing.join('; ')}` : ''} —— 而也没有别的可用 provider`,
        )
      },
    },
  ],
}
