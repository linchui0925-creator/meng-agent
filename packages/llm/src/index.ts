/**
 * @meng/llm — 模型访问的能力面。
 *
 * 设计要点 (对位 Python 版的教训 + dsh 调研 docs/09):
 * - Python 版有 4 张并行的 provider 表 (factory / catalog / AVAILABLE / key_map),
 *   加一个 provider 要改 6-7 处。这里只有一张 `Map<id, Provider>`,
 *   注册即生效 (`register()` 是唯一入口), 没有第二处需要同步。
 * - provider 只负责"把消息变成 chunk 流", 重试/超时/计费都是独立的插件,
 *   靠 `llm/request` waterfall 拦截 —— 不做进 provider 里。
 * - **词汇表是中立层**: provider 吐 delta, 组装 (BlockAssembler) 在这里做。
 *   以前 provider-openai 里有个 ToolCallAccumulator 自己攒 tool_calls ——
 *   那是中立层的活, 每个厂商各写一遍必然长出不一致的行为。
 *
 * 词汇表对齐 dsh (docs/09 §2/§3): ContentBlock 联合、7 种 StreamChunk 带 block index。
 * 一处刻意的简化: 没有 image 块 —— 我们没有 attachment seam, 加了就是死代码。
 * 等 attachment 落地再往 ContentBlockMap 里 declare 一块。
 */

import { MengError, defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const name = 'meng-llm'
export const inject: string[] = []

// ─────────────────────────────────────────────────────────────────────────────
// 内容块
// ─────────────────────────────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

/** 思考/推理内容, 与可见文本分开。前端可以折叠, 压缩策略可以优先丢它 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  /** provider 给的调用 id, 和随后的 tool-result 靠它配对 */
  id: string
  name: string
  /** **原始 JSON 字符串**, 不是已解析对象。
   *  模型写出截断/非法 JSON 是常态; 在这里 parse 就等于替调用方决定"丢了还是报错" */
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

/**
 * 块类型注册表。新块**只能**往这张表 declare merge, 不许直接改联合类型 ——
 * 这样"新增一种内容"是一个可审阅的、有名字的动作。
 * 新块进核心的前提: provider / 前端 / 压缩策略三方都支持, 否则就是死代码。
 */
export interface ContentBlockMap {
  text: TextBlock
  reasoning: ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

export type BlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[BlockType]

// ─────────────────────────────────────────────────────────────────────────────
// 消息
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  /** 块数组而不是扁平字符串: 一条 assistant 消息要能同时带
   *  "文本 + 思考 + 多个工具调用", 扁平 content 装不下 */
  content: ContentBlock[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 取一条消息的纯文本。给"我只关心文字"的调用方 (mock / 标题生成 / 日志) */
export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

export function userText(text: string): Message {
  return { role: 'user', content: textBlocks(text) }
}

export function systemText(text: string): Message {
  return { role: 'system', content: textBlocks(text) }
}

export function toolResultBlock(toolCallId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool-result', toolCallId, content: textBlocks(text), ...(isError ? { isError } : {}) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误: 稳定 code, 不解析 message
// ─────────────────────────────────────────────────────────────────────────────

/** 结构化失败事实。可序列化 —— 能落事件流、能过 WS、能给 UI 分类 */
export interface LlmFailure {
  message: string
  code: string
  status?: number
  /** provider 用 Retry-After 要求的等待毫秒数, 有效才给 */
  providerRetryAfterMs?: number
  /** provider 自己的 request id, 报障时对得上 */
  requestId?: string
}

export class LlmError extends MengError {
  readonly failure: LlmFailure

  constructor(
    message: string,
    code: string,
    options: { status?: number; providerRetryAfterMs?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, code, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.failure = {
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    }
  }
}

export const LLM_CODE = {
  /** 上下文超界 (结构化 code 或文案命中都归到这里) */
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  QUOTA: 'QUOTA',
  /** 正常结束但一个块都没有 —— 空消息会静默结束一轮, 判为可重试的失败 */
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  /** 凭据畸形 (不是缺失): 重试一百次也是同样的错 */
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  NO_ADAPTER: 'NO_ADAPTER',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  AUTH: 'AUTH',
  BAD_REQUEST: 'BAD_REQUEST',
} as const

/** 默认可重试码。重试策略插件还没落地, 但词表先定死, 免得各家自己编 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  LLM_CODE.EMPTY_RESPONSE,
  LLM_CODE.RATE_LIMIT,
  LLM_CODE.SERVER,
  LLM_CODE.TIMEOUT,
  LLM_CODE.TRANSPORT,
])

/**
 * 上下文超界的文案识别。
 * 各厂商措辞差得远 ("context length is 8192" / "maximum context window exceeded"
 * / "request too large for the model's context window"), 所以做**两段判定**:
 * 出现 context length/window, 且同一段里出现超限词。单看任一半都会误判。
 */
const CONTEXT_NOUN = /context[\s_-](?:length|window)/i
const OVERFLOW_WORD = /\b(?:exceed(?:ed|s|ing)?|overflow(?:ed)?|too\s+(?:large|long|many)|limited|maximum|max(?:imum)?\s+(?:context|token))\b/i
const TOO_LARGE_FOR_CONTEXT =
  /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i
const QUOTA_WORDS = /\b(?:quota|balance|insufficient|out of credits|充值|余额不足)\b/i

/**
 * HTTP 状态 → 稳定码。
 *
 * 各厂商文案不统一, 所以除了状态码还要扫一眼 message:
 * 400 里说 "context length exceeded" 的必须归到 CONTEXT_WINDOW_EXCEEDED,
 * 否则压缩策略认不出来, 表现为"模型突然失忆"。
 */
export function httpErrorCode(status: number, wireMessage?: string): string {
  const text = wireMessage ?? ''
  if ((CONTEXT_NOUN.test(text) && OVERFLOW_WORD.test(text)) || TOO_LARGE_FOR_CONTEXT.test(text)) {
    return LLM_CODE.CONTEXT_WINDOW_EXCEEDED
  }
  if (QUOTA_WORDS.test(text)) return LLM_CODE.QUOTA

  if (status === 401 || status === 403) return LLM_CODE.AUTH
  if (status === 408) return LLM_CODE.TIMEOUT
  if (status === 429) return LLM_CODE.RATE_LIMIT
  if (status === 400) return LLM_CODE.BAD_REQUEST
  if (status >= 500) return LLM_CODE.SERVER
  return `HTTP_${status}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 流协议
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token 计数。**互斥**: inputTokens 只算未缓存输入, 缓存命中另算。
 * 厂商把 cache 折进总 prompt 数的 (DeepSeek: prompt_tokens = hit + miss),
 * 由 provider 减出来, 否则缓存流量被重复计进成本。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/** provider 吐的原始流。`index` 是块号, 用来关联交错的 delta */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: BlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  /** 组装完成的块。provider 不吐, 由 assemble() 补齐 */
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  /** 必须是最后一个 chunk */
  | { type: 'finish'; reason: FinishReason }

export interface StreamRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 组装器: 把 delta 变成块
// ─────────────────────────────────────────────────────────────────────────────

interface PendingBlock {
  index: number
  blockType: BlockType
  text?: string
  id?: string
  name?: string
  args?: string
}

/**
 * 中立层的组装器。provider 只管吐 delta, 这里负责:
 *   1. 攒出完整块, 在 finish 之前补齐 block-end (按 index 升序)
 *   2. 保证 finish 是最后一个 chunk
 *   3. stop 却一个块都没开 → 判成 EMPTY_RESPONSE 错误, 而不是"静默结束一轮"
 *
 * 对 provider 宽容: 没发 block-start 直接发 delta 也认 (自动补开块)。
 * 第三方 provider 不会严格遵守我们的协议, 但组装契约不能因此松动。
 */
export async function* assemble(chunks: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const open = new Map<number, PendingBlock>()
  const order: number[] = []
  let sawBlock = false

  const openAt = (index: number, blockType: BlockType): PendingBlock => {
    const found = open.get(index)
    if (found) return found
    const created: PendingBlock = { index, blockType }
    open.set(index, created)
    order.push(index)
    return created
  }

  const close = function* (): Generator<StreamChunk> {
    for (const index of [...order].sort((a, b) => a - b)) {
      const pending = open.get(index)
      if (!pending) continue
      let block: ContentBlock
      if (pending.blockType === 'text') block = { type: 'text', text: pending.text ?? '' }
      else if (pending.blockType === 'reasoning') block = { type: 'reasoning', text: pending.text ?? '' }
      else if (pending.blockType === 'tool-call') {
        block = { type: 'tool-call', id: pending.id ?? '', name: pending.name ?? '', arguments: pending.args ?? '' }
      } else {
        // tool-result 是调用方塞进消息的, 不会出现在模型输出流里
        continue
      }
      yield { type: 'block-end', index, block }
    }
    open.clear()
    order.length = 0
  }

  for await (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      sawBlock = true
      openAt(chunk.index, chunk.blockType)
      yield chunk
      continue
    }
    if (chunk.type === 'text-delta') {
      sawBlock = true
      const at = openAt(chunk.index, 'text')
      at.text = (at.text ?? '') + chunk.text
      yield chunk
      continue
    }
    if (chunk.type === 'reasoning-delta') {
      sawBlock = true
      const at = openAt(chunk.index, 'reasoning')
      at.text = (at.text ?? '') + chunk.text
      yield chunk
      continue
    }
    if (chunk.type === 'tool-call-delta') {
      sawBlock = true
      const at = openAt(chunk.index, 'tool-call')
      if (chunk.id) at.id = chunk.id
      if (chunk.name) at.name = (at.name ?? '') + chunk.name
      at.args = (at.args ?? '') + chunk.argumentsDelta
      yield chunk
      continue
    }
    if (chunk.type === 'usage') {
      yield chunk
      continue
    }
    if (chunk.type === 'block-end') {
      // provider 自己吐了 block-end: 尊重它, 关掉我们这边的同名块
      open.delete(chunk.index)
      sawBlock = true
      yield chunk
      continue
    }
    // finish
    yield* close()
    yield { type: 'finish', reason: degenerateStop(chunk.reason, sawBlock) }
    return
  }

  // 流断在 finish 之前 (连接掉了 / provider 忘了发): 补一个 error, 不是静默成功
  yield* close()
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'provider 流在未完成状态下结束', code: LLM_CODE.TRANSPORT },
    },
  }
}

function degenerateStop(reason: FinishReason, sawBlock: boolean): FinishReason {
  if (reason.kind !== 'stop' || sawBlock) return reason
  return {
    kind: 'error',
    failure: {
      message: 'provider 正常结束但没有产出任何内容块',
      code: LLM_CODE.EMPTY_RESPONSE,
    },
  }
}

/** 抽干一个组装后的流, 只要最终块。给不想处理 delta 的调用方 (标题生成 / 一次性问答) */
export async function collectBlocks(chunks: AsyncIterable<StreamChunk>): Promise<{
  blocks: ContentBlock[]
  usage?: TokenUsage
  reason: FinishReason
}> {
  const blocks: ContentBlock[] = []
  let usage: TokenUsage | undefined
  let reason: FinishReason = { kind: 'stop' }

  for await (const chunk of chunks) {
    if (chunk.type === 'block-end') blocks.push(chunk.block)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') reason = chunk.reason
  }
  return { blocks, ...(usage ? { usage } : {}), reason }
}

// ─────────────────────────────────────────────────────────────────────────────
// 服务
// ─────────────────────────────────────────────────────────────────────────────

export interface Provider {
  id: string
  models: string[]
  /** 原始流: block-start / delta / usage / finish。组装不由你做 */
  stream(req: StreamRequest): AsyncIterable<StreamChunk>
}

export interface LLMService {
  register(provider: Provider): Disposer
  resolve(model?: string): Provider
  models(): string[]
  /** 未经组装的原始流。调试 provider 时用 */
  raw(req: StreamRequest): AsyncIterable<StreamChunk>
  /** 组装后的流: 块齐备、finish 收尾、空响应判错。业务一律用这个 */
  stream(req: StreamRequest): AsyncIterable<StreamChunk>
}

export function apply(ctx: Ctx, config: { defaultModel?: string }): Disposer {
  const providers = new Map<string, Provider>()
  let defaultModel = config.defaultModel ?? ''

  const resolve = (model?: string): Provider => {
    // 用 || 而不是 ?? : 调用方传空字符串是常态(agent 的 defaultModel 没配时就是 ''),
    // ?? 只在 null/undefined 时回退, 空串会直接走到"找不到 provider" ——
    // 而且异常被 agent 的 try 吞掉后表现为"一句话也不说", 极难定位
    const wanted = model || defaultModel
    // 模型名优先, 其次 provider id —— 别要求插件记住 provider↔model 的映射
    for (const provider of providers.values()) {
      if (provider.models.includes(wanted) || provider.id === wanted) return provider
    }
    // 没指定就用第一个注册者。清单里 defaultModel 留空是合法配置
    const first = providers.values().next().value
    if (!wanted && first) return first
    throw new LlmError(`没有 provider 能提供模型 ${wanted || '(未指定)'}`, LLM_CODE.NO_ADAPTER)
  }

  const service: LLMService = {
    register(provider) {
      if (providers.has(provider.id)) throw new Error(`provider ${provider.id} 重复注册`)
      providers.set(provider.id, provider)
      if (!defaultModel && provider.models[0]) defaultModel = provider.models[0]
      ctx.emit('llm/provider-added', provider.id)
      return () => {
        providers.delete(provider.id)
        ctx.emit('llm/provider-removed', provider.id)
      }
    },

    resolve,

    models() {
      return [...providers.values()].flatMap((p) => p.models)
    },

    raw(req) {
      return resolve(req.model).stream(req)
    },

    stream(req) {
      return assemble(resolve(req.model).stream(req))
    },
  }

  ctx.set('llm', service)
  ctx.emit('llm/ready', { models: service.models() })

  return () => {
    providers.clear()
  }
}

export const invariant = defineInvariant('@meng/llm', [
  {
    id: 'capability-present',
    run(ctx) {
      if (!ctx.get('llm')) throw new Error('能力面 llm 未注册')
    },
  },
  {
    // 组装器是中立层契约, 坏了会表现为"工具调用时有时无"这种最难查的 bug。
    // 每次启动拿一段合成的 delta 流跑一遍, 比等真 provider 暴露便宜得多。
    id: 'assembler-contract',
    async run() {
      async function* fixture(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '你好' }
        // 没发 block-start 直接发 delta —— 对 provider 宽容这条必须一直成立
        yield { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read', argumentsDelta: '{"fi' }
        yield { type: 'tool-call-delta', index: 1, argumentsDelta: 'le_path":"a"}' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }

      const seen: StreamChunk[] = []
      for await (const chunk of assemble(fixture())) seen.push(chunk)

      const ends = seen.filter((c) => c.type === 'block-end')
      if (ends.length !== 2) throw new Error(`组装器应补齐 2 个 block-end, 实际 ${ends.length}`)

      const last = seen[seen.length - 1]
      if (last?.type !== 'finish') throw new Error('assemble 的最后一个 chunk 必须是 finish')

      const call = ends.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
      if (!call || call.type !== 'block-end' || call.block.type !== 'tool-call') {
        throw new Error('工具块没被组装出来')
      }
      if (call.block.arguments !== '{"file_path":"a"}') {
        throw new Error(`tool-call arguments 应由 delta 累积: ${call.block.arguments}`)
      }

      const usageAt = seen.findIndex((c) => c.type === 'usage')
      const finishAt = seen.findIndex((c) => c.type === 'finish')
      if (usageAt < 0 || usageAt > finishAt) throw new Error('usage 必须出现在 finish 之前')
    },
  },
  {
    id: 'empty-response-is-error',
    async run() {
      async function* fixture(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      let reason: FinishReason | undefined
      for await (const chunk of assemble(fixture())) {
        if (chunk.type === 'finish') reason = chunk.reason
      }
      if (reason?.kind !== 'error' || reason.failure.code !== LLM_CODE.EMPTY_RESPONSE) {
        throw new Error('stop 却无块必须判成 EMPTY_RESPONSE, 不能静默结束一轮')
      }
    },
  },
])
