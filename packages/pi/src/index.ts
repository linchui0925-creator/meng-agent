/**
 * pi-ai 桥 —— **全仓唯一允许 `import '@earendil-works/pi-ai'` 的地方**。
 *
 * ## 为什么不自己写 SSE 翻译
 *
 * pi-ai 的目录里有 9 种 wire 协议，其中只有 4 种是"纯 SSE 翻译"
 * （openai-completions / openai-responses / anthropic-messages /
 * google-generative-ai）。另外 5 种的门槛**不是 SSE，是认证协议**：
 *
 * - `amazon-bedrock`      → AWS SigV4 签名 + region，要 @aws-sdk
 * - `google-vertex`       → GCP project + location + ADC，要 @google/genai
 * - `azure-openai-responses` → 资源名 + api-version
 * - `openai-codex-responses` → OAuth 换 token
 * - `mistral-conversations`  → 官方 SDK 的会话协议
 *
 * 自己写这 5 种等于重写 AWS/GCP 的签名库。dsh 自己也不写 —— 它 import 的
 * 就是这里下面这 9 个 `.lazy` 工厂，一行不差。
 *
 * ## 为什么单独一个包
 *
 * pi-ai 是 ESM-only，带 10 个 SDK 依赖（全部懒加载，不调用的协议不会载入）。
 * 把 `import` 散进插件，将来换掉它就得改 N 个文件，而且没人说得清"到底哪几处
 * 真的碰到了上游 API"。这个包把接触面收成 5 个导出。
 *
 * ## 目录不手抄
 *
 * `catalog()` 是 pi-ai 目录的**投影**，不是我们复制的一份数据。上一版手抄了
 * 10 家 90 条，代价是"上游加了新模型，我们不知道"。现在 1109 条跟着上游走。
 *
 * @module @meng/pi
 */

import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type Tool,
  type Usage,
} from '@earendil-works/pi-ai'
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'

// 9 种协议，每种一个懒加载工厂。**调用工厂不等于加载实现** ——
// `lazyApi()` 只包一层，真正的 `import()` 发生在第一次发请求时。
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy'
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

// 模型列表探测（`GET /models` 那一族）—— 它和上面的 wire 实现是两件不同的事：
// 上面负责"发一句话收一段流"，这里负责"问端点你有哪些模型"。
// 放在同一个包里是因为"哪种协议有列表端点"这件事只有实现方知道。
import { listerOf, listableProtocols, readListing, type Lister, type ListingRequest } from './listing.ts'

export { listerOf, listableProtocols, readListing }
export type { Lister, ListingRequest }

import {
  LLM_CODE,
  textOf,
  type ContentBlock,
  type FinishReason,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ToolSpec,
} from '@meng/llm'

// ─────────────────────────────────────────────────────────────────────────────
// 协议表
// ─────────────────────────────────────────────────────────────────────────────

/** 协议 id 用 pi-ai 自己的名字，**不翻译** —— 报错文案里要能和上游对得上 */
export type ProtocolId =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations'
  | 'azure-openai-responses'
  | 'bedrock-converse-stream'
  | 'google-vertex'
  | 'openai-codex-responses'

export interface ProtocolInfo {
  id: ProtocolId
  /** 设置页上给人看的一行 */
  label: string
  /**
   * 端点上有可读的模型列表（设置页"获取可用模型"按钮亮不亮）。
   *
   * **由 `listerOf()` 算出来，不在下面的表里写** —— 写两处必然漂：
   * 表上说能拉、实现里没有，用户点了才 400。
   */
  listable: boolean
  /**
   * 这条协议还缺哪些**配置形状表达不了**的东西。
   * 空 = 一个 key（或环境里已有的凭据）就能跑。
   */
  needs?: string[]
}

/**
 * 顺序是**有意**的：第一个是默认值。新建一条网关时最可能是 openai-completions。
 *
 * `listable` 是**派生**的（见 `PROTOCOLS`），所以这里不写。写死的代价是
 * 加了 listter 忘了改这张表 —— 表现是"按钮灰着但明明实现好了"，没人会发现。
 */
const PROTOCOL_DEFS: readonly Omit<ProtocolInfo, 'listable'>[] = [
  { id: 'openai-completions', label: 'OpenAI 兼容 (/chat/completions)' },
  { id: 'openai-responses', label: 'OpenAI Responses (/responses)' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Gemini' },
  { id: 'mistral-conversations', label: 'Mistral' },
  {
    id: 'azure-openai-responses',
    label: 'Azure OpenAI',
    needs: ['资源名与 api-version（填在接口地址里）'],
  },
  {
    id: 'bedrock-converse-stream',
    label: 'Amazon Bedrock',
    needs: ['AWS 凭据（AWS_ACCESS_KEY_ID / AWS_PROFILE / IAM 角色）与区域'],
  },
  {
    id: 'google-vertex',
    label: 'Google Vertex AI',
    needs: ['GCP project + location + 应用默认凭据 (ADC)'],
  },
  {
    id: 'openai-codex-responses',
    label: 'OpenAI Codex',
    needs: ['OAuth 登录态（本仓库没有 OAuth 存储）'],
  },
]

export const PROTOCOLS: readonly ProtocolInfo[] = PROTOCOL_DEFS.map((def) => ({
  ...def,
  listable: listerOf(def.id) !== undefined,
}))

const PROTOCOL_BY_ID = new Map(PROTOCOLS.map((p) => [p.id, p]))

export function protocolOf(id: string): ProtocolInfo | undefined {
  return PROTOCOL_BY_ID.get(id as ProtocolId)
}

export function protocolIds(): string[] {
  return PROTOCOLS.map((p) => p.id)
}

/**
 * 协议 → 实现。**模块级常量**：工厂只包一层，调用它不触发 `import()`，
 * 所以这里一次性备好 9 份没有成本，真载入发生在第一次用某个协议时。
 */
const STREAMS: Record<string, ProviderStreams> = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
  'google-generative-ai': googleGenerativeAIApi(),
  'mistral-conversations': mistralConversationsApi(),
  'azure-openai-responses': azureOpenAIResponsesApi(),
  'bedrock-converse-stream': bedrockConverseStreamApi(),
  'google-vertex': googleVertexApi(),
  'openai-codex-responses': openAICodexResponsesApi(),
}

/**
 * Responses 网关的一次性 JSON 版本。
 *
 * 有些本地网关只实现 `POST /responses` 的 `stream:false`，或者在发完
 * `response.completed` 后不关闭 SSE 连接。前者用通用流客户端会一直等，
 * 后者会让整轮对话永远不落库。这里直接用 JSON 请求，拿到完整响应后
 * 再还原成 pi/梦需要的流事件。
 *
 * 这是**传输方式**，不是另一套模型协议：模型仍然标 `openai-responses`。
 */
export function responsesJsonApi(): ProviderStreams {
  const run = ((model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) => {
    const events = createAssistantMessageEventStream()
    const usage = zeroUsage()
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: 'stop',
      timestamp: Date.now(),
    }

    const fail = (err: unknown): void => {
      const reason = err instanceof Error ? err.message : String(err)
      message.stopReason = 'error'
      message.errorMessage = reason
      events.push({ type: 'error', reason: 'error', error: message })
      events.end(message)
    }

    events.push({ type: 'start', partial: message })
    void (async () => {
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`)
      const base = String(model.baseUrl ?? '').trim().replace(/\/+$/, '')
      if (!base) throw new Error(`模型 ${model.id} 没有接口地址`)
      const url = base.endsWith('/responses') ? base : `${base}/responses`

      const input = convertResponsesMessages(model, context, new Set([String(model.provider), 'openai']), {
        toolOptions: { supportsStrictMode: false },
      })
      const tools = context.tools?.length
        ? convertResponsesTools(context.tools, { supportsStrictMode: false })
        : undefined
      const body: Record<string, unknown> = {
        model: model.id,
        input,
        stream: false,
        store: false,
        ...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
        ...(tools ? { tools } : {}),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
        ...(options.reasoning
          ? { reasoning: { effort: options.reasoning, summary: 'auto' } }
          : {}),
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`Responses JSON ${res.status}: ${text.slice(0, 1200)}`)
      const payload = JSON.parse(text) as ResponsesJsonPayload

      message.responseId = payload.id
      message.responseModel = payload.model
      message.usage = usageOf(payload.usage)

      const output = Array.isArray(payload.output) ? payload.output : []
      let index = 0
      for (const item of output) {
        if (item.type === 'reasoning') {
          const thinking = (item.summary ?? [])
            .map((part) => part.text ?? '')
            .filter(Boolean)
            .join('\n\n')
          if (thinking || item.encrypted_content) {
            const at = index++
            const block = {
              type: 'thinking' as const,
              thinking,
              thinkingSignature: JSON.stringify(item),
            }
            message.content.push(block)
            if (thinking) {
              events.push({ type: 'thinking_start', contentIndex: at, partial: message })
              events.push({ type: 'thinking_delta', contentIndex: at, delta: thinking, partial: message })
              events.push({ type: 'thinking_end', contentIndex: at, content: thinking, partial: message })
            }
          }
          continue
        }

        if (item.type === 'message') {
          const text = (item.content ?? [])
            .map((part) => (part.type === 'output_text' ? (part.text ?? '') : ''))
            .join('')
          if (!text) continue
          const at = index++
          message.content.push({
            type: 'text',
            text,
            textSignature: JSON.stringify({ v: 1, id: item.id ?? `msg_json_${at}` }),
          })
          events.push({ type: 'text_start', contentIndex: at, partial: message })
          events.push({ type: 'text_delta', contentIndex: at, delta: text, partial: message })
          events.push({ type: 'text_end', contentIndex: at, content: text, partial: message })
          continue
        }

        if (item.type === 'function_call') {
          const at = index++
          const callId = item.call_id || item.id || `call_${at}`
          const toolCall = {
            type: 'toolCall' as const,
            id: item.id ? `${callId}|${item.id}` : callId,
            name: item.name || 'unknown',
            arguments: parseArgs(item.arguments ?? '{}'),
          }
          message.content.push(toolCall)
          events.push({ type: 'toolcall_start', contentIndex: at, partial: message })
          events.push({ type: 'toolcall_delta', contentIndex: at, delta: item.arguments ?? '{}', partial: message })
          events.push({ type: 'toolcall_end', contentIndex: at, toolCall, partial: message })
        }
      }

      if (message.content.length === 0) throw new Error('Responses JSON 没有返回可用的文本或工具调用')
      message.stopReason = message.content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop'
      events.push({ type: 'done', reason: message.stopReason, message })
      events.end(message)
    })().catch(fail)

    return events
  }) as ProviderStreams['streamSimple']
  return { stream: run as unknown as ProviderStreams['stream'], streamSimple: run }
}

/**
 * Responses SSE，但收到 terminal event 就主动断开。
 *
 * 有些网关会把 `response.completed` 发完却一直不关 HTTP 连接。通用 OpenAI
 * SDK 流会继续等 EOF，于是“内容已经出来了但这一轮永远不结束”。这个实现保留
 * 真正的 SSE 增量，只在 `response.completed` / `response.incomplete` /
 * `response.failed` 之后 cancel reader。
 */
type ResponsesStreamEvent = Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer T> ? T : never

export function responsesSseCloseApi(): ProviderStreams {
  const run = ((model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) => {
    const events = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    const fail = (err: unknown): void => {
      const reason = err instanceof Error ? err.message : String(err)
      message.stopReason = 'error'
      message.errorMessage = reason
      events.push({ type: 'error', reason: 'error', error: message })
      events.end(message)
    }

    events.push({ type: 'start', partial: message })
    void (async () => {
      if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`)
      const base = String(model.baseUrl ?? '').trim().replace(/\/+$/, '')
      if (!base) throw new Error(`模型 ${model.id} 没有接口地址`)
      const url = base.endsWith('/responses') ? base : `${base}/responses`
      const input = convertResponsesMessages(model, context, new Set([String(model.provider), 'openai']), {
        toolOptions: { supportsStrictMode: false },
      })
      const tools = context.tools?.length
        ? convertResponsesTools(context.tools, { supportsStrictMode: false })
        : undefined
      const body: Record<string, unknown> = {
        model: model.id,
        input,
        stream: true,
        store: false,
        ...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
        ...(tools ? { tools } : {}),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_output_tokens: Math.max(16, options.maxTokens) }),
        ...(options.reasoning
          ? { reasoning: { effort: options.reasoning, summary: 'auto' } }
          : {}),
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(model.headers ?? {}),
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Responses SSE ${res.status}: ${text.slice(0, 1200)}`)
      }
      if (!res.body) throw new Error('Responses SSE 没有响应体')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const stream = async function* (): AsyncIterable<ResponsesStreamEvent> {
        while (true) {
          const { value, done } = await reader.read()
          if (done) {
            buffer += decoder.decode()
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ''
          for (const block of blocks) {
            const lines = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
            if (!lines.length) continue
            const data = lines.map((line) => line.slice(5).trimStart()).join('\n').trim()
            if (!data || data === '[DONE]') return
            const event = JSON.parse(data) as ResponsesStreamEvent
            yield event
            const type = String(event.type ?? '')
            if (type === 'response.completed' || type === 'response.incomplete'
              || type === 'response.failed' || type === 'error') return
          }
        }
        if (buffer.trim().startsWith('data:')) {
          const data = buffer.trim().slice(5).trim()
          if (data && data !== '[DONE]') yield JSON.parse(data) as ResponsesStreamEvent
        }
      }

      try {
        await processResponsesStream(stream(), message, events, model, {})
      } finally {
        try { await reader.cancel() } catch { /* already closed */ }
      }
      if (message.content.length === 0) throw new Error('Responses SSE 没有返回可用的文本或工具调用')
      if (options.signal?.aborted) throw new Error('Request was aborted')
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(message.errorMessage || 'Responses SSE 失败')
      }
      events.push({ type: 'done', reason: message.stopReason, message })
      events.end(message)
    })().catch(fail)

    return events
  }) as ProviderStreams['streamSimple']
  return { stream: run as unknown as ProviderStreams['stream'], streamSimple: run }
}

interface ResponsesJsonPart {
  type?: string
  text?: string
}

interface ResponsesJsonOutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string
  summary?: ResponsesJsonPart[]
  content?: ResponsesJsonPart[]
}

interface ResponsesJsonPayload {
  id?: string
  model?: string
  output?: ResponsesJsonOutputItem[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function usageOf(raw: ResponsesJsonPayload['usage']): Usage {
  const cacheRead = raw?.input_tokens_details?.cached_tokens ?? 0
  const cacheWrite = raw?.input_tokens_details?.cache_write_tokens ?? 0
  const input = Math.max(0, (raw?.input_tokens ?? 0) - cacheRead - cacheWrite)
  const output = raw?.output_tokens ?? 0
  const reasoning = raw?.output_tokens_details?.reasoning_tokens
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 目录：pi-ai 的投影
// ─────────────────────────────────────────────────────────────────────────────

/** pi-ai 的模型条目原样透传 —— `compat` 里是各家的协议怪癖，丢了会当场变笨 */
export type CatalogModel = Model<string>

export interface CatalogProvider {
  id: string
  name: string
  /** 端点。**空 = 这家必须自己填**（azure / vertex / bedrock 要资源名） */
  baseUrl?: string
  /** 这家认哪些环境变量。探测得到，不含 AWS profile / ADC 这类环境凭据 */
  env: string[]
  /** 出现过的协议（一家里可能混着几种，opencode 就是） */
  protocols: string[]
  models: CatalogModel[]
  /** 这家能不能用"一个环境变量"配好 */
  keyOnly: boolean
}

/**
 * 探出这家 provider 认哪些环境变量。
 *
 * 为什么不在代码里硬编码一张 37 行的表：那张表会和 pi-ai 一起漂移，而且
 * 漂了没人发现（表现是"填了 key 却说没配"）。这里用的是 Provider.auth 的
 * **公开契约**：`resolve({ ctx, credential })` 会逐个问 `ctx.env(name)`，
 * 我们给一个记录被问过哪些名字的假 env。
 *
 * **必须 await**：`resolve` 里是 `for (const name of envVars) await ctx.env(name)`
 * 的循环，同步返回时只收集到第一个名字。
 *
 * 拿不到就是拿不到（bedrock 走 AWS 凭据链，不该有 api key 变量）——
 * 返回空数组比编一个 `BEDROCK_API_KEY` 诚实。
 */
async function envNamesOf(provider: unknown): Promise<string[]> {
  const asked: string[] = []
  const apiKey = (provider as { auth?: { apiKey?: unknown } } | undefined)?.auth?.apiKey as
    | {
        resolve?: (input: {
          ctx: { env: (name: string) => Promise<string | undefined> }
          credential: undefined
        }) => Promise<unknown>
      }
    | undefined
  if (typeof apiKey?.resolve !== 'function') return asked
  const ctx = {
    env: async (name: string) => {
      if (!asked.includes(name)) asked.push(name)
      return undefined
    },
  }
  await apiKey.resolve({ ctx, credential: undefined }).catch(() => undefined)
  return asked
}

let catalogCache: CatalogProvider[] | undefined
let priming: Promise<void> | undefined

/** 目录骨架。`env` 此时为空 —— 要 await 才拿得到，见 `primeCatalog()` */
function buildCatalog(): CatalogProvider[] {
  const out: CatalogProvider[] = []
  for (const id of getBuiltinProviders()) {
    const models = getBuiltinModels(id) as CatalogModel[]
    // 没有模型的 provider 不列：设置页加进去只会得到一条空清单
    if (models.length === 0) continue
    const first = models[0] as CatalogModel
    const protocols = [...new Set(models.map((m) => String(m.api)))]
    out.push({
      id,
      name: displayNameOf(id),
      ...(first.baseUrl === undefined ? {} : { baseUrl: first.baseUrl }),
      env: [],
      protocols,
      models,
      keyOnly: false,
    })
  }
  return out
}

/**
 * 把每家认的环境变量探出来。**插件 apply 时 await 一次**，之后 `catalog()`
 * 同步读到完整结果。
 *
 * 不做也行 —— 目录照样有 37 家 1109 条模型，只是 `env` 空、设置页不知道
 * 该预填哪个变量名。所以它是"预热"，不是"必须"。
 */
export function primeCatalog(): Promise<void> {
  priming ??= (async () => {
    const list = buildCatalog()
    const byId = new Map<string, unknown>()
    for (const factory of builtinProviders() as unknown as Array<() => unknown>) {
      const instance = typeof factory === 'function' ? factory() : factory
      const id = (instance as { id?: string }).id
      if (id !== undefined) byId.set(id, instance)
    }
    for (const entry of list) {
      entry.env = await envNamesOf(byId.get(entry.id))
      entry.keyOnly = entry.env.length > 0
    }
    catalogCache = list
  })()
  return priming
}

/**
 * 全部内置供应商，37 家 / 1109 条模型。
 *
 * **缓存**：构建一次要遍历 1100 个模型对象，设置页每次刷新都重建没必要。
 * 上游目录是静态生成的，进程生命周期内不会变。
 */
export function catalog(): readonly CatalogProvider[] {
  return (catalogCache ??= buildCatalog())
}

export function catalogProvider(id: string): CatalogProvider | undefined {
  return catalog().find((p) => p.id === id)
}

/**
 * 按接口地址认一家。**新建一条路由时手里只有地址，还没有路由 id** ——
 * 只按 id 认的话，那条路必然打不到目录、直接去吃 401。
 *
 * 尾斜杠和大小写归一：用户从文档里复制地址，结尾带不带 `/` 都是常态。
 */
export function catalogProviderByBaseURL(baseURL: string): CatalogProvider | undefined {
  const want = normalizeBaseUrl(baseURL)
  if (!want) return undefined
  return catalog().find((p) => p.baseUrl !== undefined && normalizeBaseUrl(p.baseUrl) === want)
}

const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()

/**
 * 目录里精确到一个模型 —— 主要是为了拿它的 `compat`。
 * 各家协议的怪癖（`thinkingFormat` / `supportsReasoningEffort` / 工具流式）
 * 都写在那里，丢了这些字段等于把模型降级成"一个名字"。
 */
export function catalogModel(provider: string, model: string): CatalogModel | undefined {
  return catalogProvider(provider)?.models.find((m) => m.id === model)
}

/** 上游给的显示名在 provider 实例上，不在模型条目里 —— 单独开一张小表 */
const DISPLAY_NAMES: Record<string, string> = {
  'amazon-bedrock': 'Amazon Bedrock',
  'ant-ling': 'Ant Ling',
  anthropic: 'Anthropic',
  'azure-openai-responses': 'Azure OpenAI',
  cerebras: 'Cerebras',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  'google-vertex': 'Google Vertex AI',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi For Coding',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax CN',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI CN',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Zen Go',
  openrouter: 'OpenRouter',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-cn': 'Qwen Token Plan CN',
  together: 'Together',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan AMS',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan CN',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan SGP',
  zai: 'Z.AI',
  'zai-coding-cn': 'Z.AI Coding CN',
}

function displayNameOf(id: string): string {
  return DISPLAY_NAMES[id] ?? id
}

/** 目录总规模。设置页脚注和测试用 */
export function catalogStats(): { providers: number; models: number } {
  const list = catalog()
  return { providers: list.length, models: list.reduce((n, p) => n + p.models.length, 0) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 建一条路由的 pi provider
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteSpec {
  /** 路由 id，同时是 pi 的 provider id */
  id: string
  name: string
  /** 不填就用目录里那家的地址 */
  baseUrl?: string
  headers?: Record<string, string>
  /** 这条路由能用的模型（含 `api` 字段，pi 按它分发到对应协议） */
  models: readonly CatalogModel[]
  /** 只覆盖本路由需要的传输实现；键仍是模型的 `api` */
  apiOverrides?: Record<string, ProviderStreams>
  /** **每次请求现读**：密钥可能刚在设置里换过 */
  key: () => string | undefined
}

/**
 * 构造一条路由的 pi provider。
 *
 * `api` 给的是**整张表**，不是选一个：pi 按 `model.api` 分发，所以同一条路由
 * 里 `glm-4.7`（completions）和 `claude-sonnet`（anthropic）可以并存 ——
 * opencode 那家本来就混着 4 种协议。
 */
export function createRouteProvider(route: RouteSpec): Provider {
  const models = [...route.models] as Model<string>[]
  return createProvider({
    id: route.id,
    name: route.name,
    ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    models,
    auth: {
      apiKey: {
        name: `${route.name} API key`,
        // 这里不抛错：`Models` 用它判断"配没配"，真正的拒绝发生在发请求前
        // （provider 那边会报 MISSING_CREDENTIAL，带路由名，比这里准）
        resolve: async () => {
          const key = route.key()
          // 没 key 就返回 `undefined`（不是 `{}`）：pi 用这个区分"配没配"，
          // 真正的拒绝发生在发请求前（provider 报 MISSING_CREDENTIAL，
          // 带路由名，比这里准）。
          //
          // 不填 `source`：那个字段是给"授权来源"做人类可读标签的
          // （`ANTHROPIC_API_KEY` / `OAuth` / `~/.aws/credentials`），
          // 我们这里只有"一个字面量 key"，说了就等于编。
          return key === undefined || key === '' ? undefined : { auth: { apiKey: key } }
        },
      },
    },
    api: { ...STREAMS, ...route.apiOverrides },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 我们的消息 → pi 的 Context
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    // 模型写出半截 JSON 是常态。这里**不能抛**：历史消息里有一条坏参数，
    // 整轮对话就再也发不出去了。退化成空对象，让协议层去背这个锅。
    return {}
  }
}

type PiContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

function toPiBlocks(blocks: readonly ContentBlock[]): PiContent[] {
  const out: PiContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text })
    if (block.type === 'image') out.push({ type: 'image', data: block.dataBase64, mimeType: block.mime })
  }
  return out
}

function toPiContent(blocks: readonly ContentBlock[]): string | PiContent[] {
  const content = toPiBlocks(blocks)
  const first = content[0]
  return content.length === 1 && blocks.length === 1 && first?.type === 'text' ? first.text : content
}

export interface ContextInput {
  messages: readonly Message[]
  tools?: readonly ToolSpec[]
  /** 当前这条路由的协议 —— 历史 assistant 消息要标它，pi 用它决定怎么重放 */
  api: string
  provider: string
  model: string
}

/**
 * 转成 pi 的 `Context`。
 *
 * 两处不能省：
 * 1. **`toolName`**：pi 的 `ToolResultMessage` 必填它，而我们的
 *    `ToolResultBlock` 只存 `toolCallId`。不补的话 anthropic 协议会把结果
 *    对不上调用。
 * 2. **历史 assistant 消息的 `api` / `provider` / `usage`**：pi 要拿它做
 *    多轮回放（有些协议要把上一轮的 thinking 签名原样带回去）。
 */
export function toContext(input: ContextInput): Context {
  const system: string[] = []
  const out: Context['messages'] = []
  const toolNames = new Map<string, string>()
  const now = Date.now()

  for (const message of input.messages) {
    if (message.role === 'system') {
      system.push(textOf(message))
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: toPiContent(message.content), timestamp: now })
      continue
    }
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        out.push({
          role: 'toolResult',
          toolCallId: block.toolCallId,
          toolName: toolNames.get(block.toolCallId) ?? 'unknown',
          content: toPiBlocks(block.content),
          isError: block.isError === true,
          timestamp: now,
        })
      }
      continue
    }

    // assistant
    const content: AssistantMessage['content'] = []
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
      else if (block.type === 'tool-call') {
        toolNames.set(block.id, block.name)
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArgs(block.arguments) })
      }
    }
    out.push({
      role: 'assistant',
      content,
      api: input.api,
      provider: input.provider,
      model: input.model,
      usage: ZERO_USAGE,
      stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
      timestamp: now,
    })
  }

  const tools = (input.tools ?? []).map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }) as unknown as Tool,
  )

  return {
    ...(system.length === 0 ? {} : { systemPrompt: system.join('\n\n') }),
    messages: out,
    ...(tools.length === 0 ? {} : { tools }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// pi 的事件 → 我们的 StreamChunk
// ─────────────────────────────────────────────────────────────────────────────

function mapUsage(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
  }
}

function mapStop(reason: 'stop' | 'length' | 'toolUse'): FinishReason {
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'toolUse') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * 事件映射。**1:1**，没有缓冲、没有重排 —— pi 的 `contentIndex` 直接当我们的
 * 块号用，交错的正文/思考/工具调用因此不会挤进同一个块。
 *
 * 那块"块号错了会静默丢回答"的坑（见 `plugins/provider-openai/test/blocks.ts`）
 * 在这里同样成立：`text_start` 必须开在**它自己的** `contentIndex` 上。
 */
export async function* toChunks(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const known =
          partial?.type === 'toolCall'
            ? { id: partial.id, name: partial.name }
            : { id: '', name: '' }
        toolIds.set(event.contentIndex, known)
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          ...(known?.id ? { id: known.id } : {}),
          ...(known?.name ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStop(event.reason) }
        return
      case 'error': {
        const aborted = event.reason === 'aborted'
        yield {
          type: 'finish',
          reason: aborted
            ? { kind: 'aborted', failure: { message: '请求被取消', code: LLM_CODE.ABORTED } }
            : {
                kind: 'error',
                failure: {
                  message: event.error.errorMessage ?? `${input_providerOf(event.error)} 返回了错误但没有说明原因`,
                  code: LLM_CODE.SERVER,
                },
              },
        }
        return
      }
    }
  }
}

/** 错误文案里带上哪家 —— 用户看见 "openai returned 400" 比 "出错了" 有用 */
function input_providerOf(message: AssistantMessage): string {
  return message.provider || message.model || 'provider'
}
