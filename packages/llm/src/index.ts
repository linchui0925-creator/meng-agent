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
 * 图片是输入块：session 事件只存附件元数据，发给 provider 前才恢复 Base64。
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

/** 图片输入。dataBase64 只在内存与 provider 请求里出现，不写会话事件。 */
export interface ImageBlock {
  type: 'image'
  mime: string
  dataBase64: string
  /** 原始文件名，仅供界面与诊断展示。 */
  name?: string
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
  image: ImageBlock
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
  /**
   * 工具分组（`core` / `web` / `jobs` …）。只给"要不要把这一组塞进 prompt"用,
   * 模型看不见它 —— 进 wire 的只有上面三个字段。
   */
  group?: string
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
  /** 探测供应商的模型列表失败（连不上 / 返回不是模型清单） */
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  /** 这个协议没有可读的模型列表（比如 anthropic 的 /models 形状不同） */
  DISCOVERY_UNSUPPORTED: 'DISCOVERY_UNSUPPORTED',
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

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 默认调用的完整身份：路由、模型、推理档位缺一不可再靠猜。 */
export interface DefaultModel {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffort
}

export interface StreamRequest {
  model: string
  /**
   * 点名哪条路由。**不传 = 按模型名猜** (老行为)。
   *
   * 为什么要有它: 两家供应商都有 `gpt-4o` 时, 一个模型名是歧义的。
   * dsh 的 `GenerateOptions.provider` 是必填; 我们留可选, 因为
   * "只有一个 provider"的部署不该被迫背这个字段。
   */
  provider?: string
  /** 本次调用的推理档位；缺省时才可能继承默认模型三件套里的值。 */
  reasoningEffort?: ReasoningEffort
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
// 模型条目
// ─────────────────────────────────────────────────────────────────────────────

export type ModelModality = 'text' | 'image'

/**
 * 一条模型。**这是设置页与模型选择器读的东西**, 不是 wire 格式。
 *
 * 为什么不能只有名字: 上下文窗口决定"这段历史塞不塞得下", 最大输出决定
 * "要不要压缩", 模态决定"这张图能不能发"。dsh 的 `LlmModelInfo` /
 * `LlmResolvedModelInfo` 就是这一层。
 *
 * 除 `id` 外都可缺省 —— 缺 = **未知**, 不是不支持。编码时别把"未知"写成
 * "不支持": 前者可以试, 后者会拒。
 */
export interface ModelInfo {
  id: string
  /** 显示名。缺省 = id (界面上不该出现空白) */
  name: string
  /** 上下文总容量 (输入 + 输出), 单位 token。未知就不给 */
  contextWindow?: number
  /** 单轮最大输出 token。未知就不给 */
  maxTokens?: number
  /** 接受的输入模态。缺省 = 未知 */
  input?: ModelModality[]
  /** 能产出的输出模态。缺省 = 未知 */
  output?: ModelModality[]
  /** 是否支持推理档位 (effort / thinking)。缺省 = 未知 */
  reasoning?: boolean
  /** 厂商实时申报的推理档位。缺省 = 未知；空数组 = 明确没有 */
  reasoningEfforts?: ReasoningEffort[]
  /** 厂商实时申报的默认推理档位。缺省 = 跟随服务端 */
  defaultReasoningEffort?: ReasoningEffort
  /**
   * 这个模型走哪种 wire 协议（`openai-completions` / `anthropic-messages` …）。
   *
   * **一条路由里可能混着几种**：opencode 那家 58 个模型分属 4 种协议。
   * 缺省 = 跟随路由的 `protocol`。
   */
  api?: string
  /** 给用户看的一句区别说明 */
  description?: string
}

/**
 * 模型的两种写法: 只给名字, 或者给全。
 *
 * 这是**同一个东西的两种输入格式**, 不是两套机制 —— 归一只有
 * `toModelInfo()` 一处。单路由插件 (mock / deepseek 的早期写法) 写
 * `['deepseek-chat']` 不必编造容量; 多路由插件给全字段。
 */
export type ModelEntry = string | ModelInfo

export function toModelInfo(entry: ModelEntry): ModelInfo {
  if (typeof entry === 'string') return { id: entry, name: entry }
  return { ...entry, name: entry.name || entry.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由与适配器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条路由的静态事实。**全部现读, 不缓存** —— 回调实现里读配置即可,
 * 于是"改显示名 / 改凭据变量名"这类值的改动下一个请求就生效。
 */
export interface RouteFacts {
  /** 给人看的名字。缺省用路由名 */
  name?: string
  /**
   * wire 协议 (`openai-completions` / `deepseek-chat` / ...)。
   *
   * 缝**不解释**它, 只透传给设置页显示 —— 协议语义属于 adapter。
   * 让 llm 认识协议表, 就等于让它认识厂商。
   */
  protocol?: string
  /** 它的配置在哪个 config scope。设置页靠它把路由和配置行连起来 */
  configScope?: string
  /**
   * 这条路由**只因为配置才存在** (用户自己加的网关), 不是内置目录里的。
   * 设置页据此把"内置"和"自定义"分开画。
   */
  declared?: boolean
  /** 现在能不能真发请求。缺省恒 true */
  available?: boolean
  /** 还差什么。人话, 直接显示。只在不可用时有意义 */
  missing?: string[]
  /**
   * 模型 ID 是否由用户手填（而不是从过期内置目录推断）。
   * 手填清单在厂商 /models 拉不到时仍可用，但来源必须标成 manual。
   */
  manualModels?: boolean
}

/**
 * 一个 adapter 服务**多条**路由。
 *
 * 这是 dsh `LlmAdapter` 的形状, 也是"自由配置供应商"的地基: 一个插件
 * 不该为每家厂商各写一份 stream。`provider-openai` 用它把配置里
 * `routes` 字典的每个 key 变成一条路由。
 *
 * 只有 `stream` 是必填 —— 其余都可缺省, 缺省即"没有额外事实", 而不是
 * "没实现"。
 */
export interface Adapter {
  info?(route: string): RouteFacts
  /** 这条路由能服务的模型。**advisory**: 在列表里不等于只能用它 */
  models?(route: string): ModelEntry[]
  /** 精确路由的模型能力。未知就不给 —— 别返回编造的容量 */
  resolveModel?(route: string, model: string): ModelInfo | undefined
  stream(route: string, req: StreamRequest): AsyncIterable<StreamChunk>
}

/**
 * `registerAdapter()` 的返回值: 既能卸装, 也能**原子换**路由集合。
 *
 * `replace()` 的价值: 配置里增删一条供应商, 不必"先卸光再重注册" ——
 * 那个中间态会被并发请求看到 (表现为"模型列表突然空了")。
 */
export interface AdapterHandle {
  (): void
  replace(routes: readonly string[]): void
}

/**
 * 单路由的便捷形态。**它会在内部被包成 Adapter**, 不是另一套机制。
 *
 * 保留它是因为大多数插件只有一条路由 (mock / deepseek), 让它们去写
 * `(route, req) => ...` 只是多一层噪音。
 */
export interface Provider {
  id: string
  displayName?: string
  protocol?: string
  configScope?: string
  models: ModelEntry[]
  available?: () => boolean
  missing?: () => string[]
  /** 原始流: block-start / delta / usage / finish。组装不由你做 */
  stream(req: StreamRequest): AsyncIterable<StreamChunk>
}

/** 路由的对外描述。`llm.catalog` 与设置页读它, 不碰 adapter 本体 */
export type ModelSource = 'catalog' | 'endpoint' | 'manual' | 'error'

export interface ProviderInfo {
  id: string
  name: string
  protocol?: string
  /** 已归一成对象。实时成功时，顺序与厂商端点一致。 */
  models: ModelInfo[]
  /** 见 `RouteFacts.available`。实时清单失败或为空时也为 false */
  available: boolean
  /** 清单来源：静态目录 / 厂商端点 / 手动配置 / 拉取失败 */
  modelSource?: ModelSource
  /** 本次实时拉取失败的人话原因；不能拿旧目录伪装成功 */
  modelsError?: string
  /** 最近一次端点结果（含失败）的本地时间戳 */
  modelsFetchedAt?: number
  /** 见 `RouteFacts.missing`。不可用时才有内容 */
  missing?: string[]
  configScope?: string
  declared?: boolean
}

/**
 * 一条**可以被配置激活**的路由。目录与注册表的区别是这一对问题的答案:
 *
 *   · 注册表 (`listProviders()`) = **现在**能发请求的路由
 *   · 目录 (`listConfigurableProviders()`) = adapter 装了之后**可能**有的路由
 *
 * 为什么两本账都要: 内置供应商 (智谱 / 月之暗面 / Groq) 在用户填 key、
 * 写进配置之前不会出现在注册表里 —— 只靠注册表, 设置页就没有"添加一家"
 * 的入口。dsh 的 `LlmConfigurableProvider` 就是解决这件事的。
 */
export interface ConfigurableProvider {
  /** 路由 id。配置里 `routes` 的键就是它 */
  provider: string
  displayName: string
  /** 配置在哪个 scope */
  configScope: string
  /**
   * 这条路由的 profile 在那个 scope 里的地址。我们是 `['routes', id]`。
   * 设置页靠它知道"该写哪个键", 而不是硬记形状。
   */
  configPath: readonly string[]
  /** adapter 自己也不认识这条路由 (用户自加的自定义供应商) */
  declared?: boolean
  /** 激活之后会有的模型。给设置页显示"这家能用什么", 不必先写配置 */
  models?: ModelEntry[]
  /**
   * 这家目录里**有多少款**模型。
   *
   * 为什么单独给一个数字: 模型清单本身不再随目录下发 (37 家 / 1110 条一次 199 KB),
   * 但界面得能说"点添加会带来 6 款" —— 只说"目录里还没有"是假话。
   * 一个整数几十字节, 全量下发也无所谓。
   */
  modelCount?: number
  /**
   * 激活这条路由时要写进去的初始 profile（用户点"添加"时整条写）。
   * **不透明**: `@meng/llm` 不认识里面的字段, 只负责转交。
   */
  template?: Record<string, unknown>
}

/**
 * 一次"问供应商它有哪些模型"的请求。
 *
 * 关键: 它是**草稿态**的 —— 请求描述的是用户正在编辑的那一条, 可能还没
 * 存进配置。所以它带 baseURL / 协议 / 密钥变量名, 而不是一个路由 id。
 * 一条已经存过的路由可以只给 provider, 让 adapter 从自己的目录里答
 * （零网络请求, 而且比端点更准）。
 */
export interface ModelDiscoveryRequest {
  /** 已经在配置里的路由 id。给了就能走"已知答案"这条快路 */
  provider?: string
  /** 要问的端点。路由不认识时必须给 */
  baseURL?: string
  /** wire 协议。缺省由 adapter 决定 */
  protocol?: string
  /**
   * **密钥的凭据引用名**, 不是密钥值。
   *
   * dsh 的对应字段是 `apiKey`（一次性凭据）。我们刻意不同: 探测请求只带
   * 引用名，明文由 `credential.set` 单独写入本机凭据库（0600）；这样密钥
   * 不经过这条发现请求，也不会随配置或目录快照下发。
   */
  apiKeyEnv?: string
  /**
   * 问谁：`catalog`（默认）优先翻内置目录，`endpoint` 强制打网络。
   *
   * 为什么要有这个开关：目录是**快照**（37 家 1109 条，跟着 pi-ai 的版本走），
   * 供应商下线一款、上线一款它都不知道。默认走目录是因为省一次网络、而且
   * 容量比多数 `/models` 端点报得全 —— 但那条快路不该变成"永远问不到真话"。
   * 用户觉得"我账号里明明有这款"时，用它绕过目录。
   */
  source?: 'catalog' | 'endpoint'
  signal?: AbortSignal
}

/** 端点自己报出来的一条模型。除 id 外都可能缺 —— 大多数端点只报 id */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ModelModality[]
  output?: ModelModality[]
  reasoning?: boolean
  reasoningEfforts?: ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
}

/** `registerModelDiscovery()` 的返回值 */
export type DiscoveryDisposer = () => void

/** `registerConfigurableProviders()` 的返回值, 和 AdapterHandle 同形 */
export interface DirectoryHandle {
  (): void
  replace(entries: readonly ConfigurableProvider[]): void
}

/** `resolve()` 的结果: 一条确切的路由 + 这一次要用的模型 */
export interface ResolvedRoute {
  /** 路由 id。老代码读 `.id`, 保留 */
  readonly id: string
  /** 这一次请求实际用的模型 id (调用方没点名时 = 该路由第一个) */
  readonly model: string
  /** 默认三件套带出的档位；显式路由或自动回落不硬塞默认值。 */
  readonly reasoningEffort?: ReasoningEffort
  readonly adapter: Adapter
}

interface Registration {
  routes: string[]
  adapter: Adapter
}

export interface LLMService {
  /** 单路由注册。等价于 `registerAdapter([p.id], providerAdapter(p))` */
  register(provider: Provider): Disposer
  /**
   * 一个 adapter 注册多条路由。`routes` 里的每个名字都会出现在
   * `listProviders()` 里, 也都能被 `resolve(model, route)` 点名。
   *
   * 冲突是**全或无**: 任何一条已被别处占用, 整个注册被拒, 注册表不变。
   */
  registerAdapter(routes: readonly string[], adapter: Adapter): AdapterHandle
  /**
   * 声明本插件**可配置**的路由（含还没激活的）。
   *
   * 与 `registerAdapter` 的区别: 后者说"这些路由现在能发请求", 前者说
   * "这些路由可以被配置出来"。内置供应商靠它进设置页的"添加"列表。
   *
   * 冲突是**全或无**: 同一个 provider 被两个注册声明 → 整个注册被拒。
   */
  registerConfigurableProviders(entries: readonly ConfigurableProvider[]): DirectoryHandle
  /** 全部已声明的可配置路由, 含激活的和还没激活的。顺序 = 声明顺序 */
  listConfigurableProviders(): ConfigurableProvider[]
  /**
   * 声明"这个 scope 的供应商, 模型列表怎么问"。
   *
   * 按 **config scope** 而不是 provider 注册: 设置页手里只有 scope
   * （从 catalog 的 `configScope` 来）, 而草稿态的那条路由还没有 id。
   * dsh 用 settings namespace 做键, 是同一个理由。
   */
  registerModelDiscovery(
    scope: string,
    discover: (request: ModelDiscoveryRequest) => Promise<readonly DiscoveredModel[]>,
  ): DiscoveryDisposer
  /** 问一个 scope 的供应商要模型列表。没人注册 = 抛 DISCOVERY_UNSUPPORTED */
  discoverModels(scope: string, request: ModelDiscoveryRequest): Promise<DiscoveredModel[]>
  /** 刷新已配置路由的实时清单；默认短时复用，force 用于页面读取/手动刷新 */
  refreshModels(options?: { force?: boolean }): Promise<ProviderInfo[]>
  /** 配置变化后作废旧清单；进行中的旧请求即使晚到也不能覆盖下一次刷新 */
  invalidateModels(): void
  /** 已注册的全部路由, 含**不可用**的 (设置页要列出"装了但没配"的那些) */
  listProviders(): ProviderInfo[]
  /**
   * 点名到一条确切的路由。
   * @param model 模型 id。留空 = 该路由的第一个模型
   * @param provider 路由 id。留空 = 按模型名猜 (老行为)
   */
  resolve(model?: string, provider?: string): ResolvedRoute
  /** **可用** provider 的模型 id。它是"选模型"的输入, 所以不给用不了的 */
  models(): string[]
  /** 未经组装的原始流。调试 provider 时用 */
  raw(req: StreamRequest): AsyncIterable<StreamChunk>
  /** 组装后的流: 块齐备、finish 收尾、空响应判错。业务一律用这个 */
  stream(req: StreamRequest): AsyncIterable<StreamChunk>
}

/** 把单路由的 `Provider` 包成 `Adapter`。唯一的一处归一 */
function providerAdapter(p: Provider): Adapter {
  return {
    resolveModel: (_route, model) => {
      const entry = p.models.find((item) => toModelInfo(item).id === model)
      return entry === undefined ? undefined : toModelInfo(entry)
    },
    info: () => ({
      ...(p.displayName === undefined ? {} : { name: p.displayName }),
      ...(p.protocol === undefined ? {} : { protocol: p.protocol }),
      ...(p.configScope === undefined ? {} : { configScope: p.configScope }),
      ...(p.available === undefined ? {} : { available: p.available() }),
      ...(p.missing === undefined ? {} : { missing: p.missing() }),
    }),
    models: () => p.models,
    stream: (_route, req) => p.stream(req),
  }
}

export function apply(ctx: Ctx, config: { defaultModel?: string | DefaultModel } = {}): Disposer {
  /** 路由 → 它的归属。一个 adapter 可以出现在多个 key 上 */
  const regs = new Map<string, Registration>()
  /** 可配置路由的登记: 每个注册一份, 便于 replace / 卸装 */
  const dirs: { entries: ConfigurableProvider[] }[] = []
  /** scope → 探测器。一个 scope 一个实现 (一个插件一个 scope) */
  const discoveries = new Map<string, (request: ModelDiscoveryRequest) => Promise<readonly DiscoveredModel[]>>()
  type DiscoveryState =
    | { status: 'live'; models: ModelInfo[]; fetchedAt: number }
    | { status: 'error'; error: string; fetchedAt: number }
    | { status: 'manual'; fetchedAt: number; error?: string }
  const discoveryStates = new Map<string, DiscoveryState>()
  const discoveryPending = new Map<string, Promise<void>>()
  let discoveryRevision = 0
  const DISCOVERY_TTL_MS = 60_000
  const configuredDefault = typeof config.defaultModel === 'object' && config.defaultModel !== null
    ? config.defaultModel
    : undefined
  const defaultProvider = configuredDefault?.provider ?? ''
  const defaultReasoningEffort = configuredDefault?.reasoningEffort
  let defaultModel = typeof config.defaultModel === 'string'
    ? config.defaultModel
    : configuredDefault?.model ?? ''

  const staticModelList = (route: string): ModelInfo[] => {
    const reg = regs.get(route)
    if (!reg) return []
    return (reg.adapter.models?.(route) ?? []).map(toModelInfo)
  }

  const modelList = (route: string): ModelInfo[] => {
    const state = discoveryStates.get(route)
    if (state?.status === 'error') return []
    if (state?.status === 'live') return state.models
    return staticModelList(route)
  }

  const usable = (route: string): boolean => {
    const reg = regs.get(route)
    if (!reg || !(reg.adapter.info?.(route).available ?? true)) return false
    const state = discoveryStates.get(route)
    if (state?.status === 'error') return false
    if (state?.status === 'live' && state.models.length === 0) return false
    return true
  }

  const discoveryFailure = (route: string): LlmError | undefined => {
    const state = discoveryStates.get(route)
    if (state?.status === 'error') {
      return new LlmError(`路由 ${route} 的实时模型清单拉取失败: ${state.error}`, LLM_CODE.DISCOVERY_FAILED)
    }
    if (state?.status === 'live' && state.models.length === 0) {
      return new LlmError(`路由 ${route} 的厂商实时模型清单为空`, LLM_CODE.NO_ADAPTER)
    }
    return undefined
  }

  const resolve = (model?: string, provider?: string): ResolvedRoute => {
    if (provider) {
      const reg = regs.get(provider)
      if (!reg) {
        throw new LlmError(`没有路由 ${provider} (已注册: ${[...regs.keys()].join(', ') || '无'})`, LLM_CODE.NO_ADAPTER)
      }
      const failed = discoveryFailure(provider)
      if (failed) throw failed
      const state = discoveryStates.get(provider)
      if (state?.status === 'live' && model && !state.models.some((m) => m.id === model)) {
        throw new LlmError(`路由 ${provider} 的厂商实时清单没有模型 ${model}`, LLM_CODE.NO_ADAPTER)
      }
      return { id: provider, model: model || modelList(provider)[0]?.id || '', adapter: reg.adapter }
    }

    const explicit = typeof model === 'string' && model !== ''

    if (!explicit && defaultProvider) {
      const reg = regs.get(defaultProvider)
      if (reg) {
        const failed = discoveryFailure(defaultProvider)
        if (failed) throw failed
        const listed = modelList(defaultProvider)
        const state = discoveryStates.get(defaultProvider)
        const picked = state?.status === 'live'
          ? (listed.some((m) => m.id === defaultModel) ? defaultModel : listed[0]?.id ?? '')
          : defaultModel || listed[0]?.id || ''
        if (picked) {
          return {
            id: defaultProvider,
            model: picked,
            ...(defaultReasoningEffort ? { reasoningEffort: defaultReasoningEffort } : {}),
            adapter: reg.adapter,
          }
        }
      }
    } else {
      const wanted = model || defaultModel
      if (wanted) {
        for (const [route, reg] of regs) {
          const state = discoveryStates.get(route)
          const wasStaticDefault = staticModelList(route).some((m) => m.id === wanted) || route === wanted
          if (!explicit && wasStaticDefault) {
            const failed = discoveryFailure(route)
            if (failed) throw failed
            if (state?.status === 'live' && !state.models.some((m) => m.id === wanted)) {
              const replacement = state.models[0]?.id
              if (replacement) {
                return {
                  id: route,
                  model: replacement,
                  ...(!explicit && defaultReasoningEffort ? { reasoningEffort: defaultReasoningEffort } : {}),
                  adapter: reg.adapter,
                }
              }
            }
          }
          if (modelList(route).some((m) => m.id === wanted) || route === wanted) {
            return {
              id: route,
              model: wanted,
              ...(!explicit && defaultReasoningEffort ? { reasoningEffort: defaultReasoningEffort } : {}),
              adapter: reg.adapter,
            }
          }
        }
        if (explicit) throw new LlmError(`没有 provider 能提供模型 ${wanted}`, LLM_CODE.NO_ADAPTER)
      }
    }

    const first = [...regs.keys()].find(usable)
    if (first) {
      const picked = modelList(first)[0]?.id ?? ''
      return { id: first, model: picked || (defaultProvider ? '' : defaultModel), adapter: regs.get(first)!.adapter }
    }

    const known = [...regs.keys()]
    const failed = known.map(discoveryFailure).find(Boolean)
    if (failed) throw failed
    throw new LlmError(
      known.length === 0
        ? '一个 provider 都没装'
        : `已装载的 provider 都不可用 (${known.join(', ')}) —— 检查它们的凭据配置`,
      LLM_CODE.NO_ADAPTER,
    )
  }

  const refreshRoute = async (route: string, force: boolean): Promise<void> => {
    const reg = regs.get(route)
    if (!reg) return
    const facts = reg.adapter.info?.(route) ?? {}
    const discover = facts.configScope ? discoveries.get(facts.configScope) : undefined
    if (!discover || !(facts.available ?? true)) return
    const previous = discoveryStates.get(route)
    if (!force && previous && Date.now() - previous.fetchedAt < DISCOVERY_TTL_MS) return
    const pending = discoveryPending.get(route)
    if (pending) return pending

    const revision = discoveryRevision
    const commitState = (state: DiscoveryState): void => {
      if (revision === discoveryRevision && regs.get(route) === reg) discoveryStates.set(route, state)
    }
    const task = (async () => {
      try {
        const found = await discover({ provider: route, source: 'endpoint' })
        const seen = new Set<string>()
        const models = found.filter((m) => {
          if (!m.id || seen.has(m.id)) return false
          seen.add(m.id)
          return true
        }).map((found) => {
          const base = staticModelList(route).find((m) => m.id === found.id)
          return { ...base, ...found, name: found.name || base?.name || found.id }
        })
        if (facts.manualModels && models.length === 0) {
          commitState({
            status: 'manual',
            fetchedAt: Date.now(),
            error: '厂商实时模型清单为空',
          })
        } else {
          commitState({ status: 'live', models, fetchedAt: Date.now() })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if ((err instanceof LlmError && err.code === LLM_CODE.DISCOVERY_UNSUPPORTED) || facts.manualModels) {
          commitState({ status: 'manual', fetchedAt: Date.now(), ...(message ? { error: message } : {}) })
        } else {
          commitState({
            status: 'error',
            error: message,
            fetchedAt: Date.now(),
          })
        }
      }
    })()
    discoveryPending.set(route, task)
    try {
      await task
    } finally {
      if (discoveryPending.get(route) === task) discoveryPending.delete(route)
    }
  }

  const infoOf = (route: string): ProviderInfo => {
    const reg = regs.get(route)!
    const facts = reg.adapter.info?.(route) ?? {}
    const state = discoveryStates.get(route)
    const discover = facts.configScope ? discoveries.get(facts.configScope) : undefined
    const discoveryError = state?.status === 'error'
      ? `实时模型清单拉取失败: ${state.error}`
      : state?.status === 'live' && state.models.length === 0
        ? '厂商实时模型清单为空'
        : undefined
    const manualWarning = state?.status === 'manual' && state.error
      ? `实时模型清单未拉到，使用手动清单: ${state.error}`
      : undefined
    const available = (facts.available ?? true) && !discoveryError
    const missing = available ? [] : [...(facts.missing ?? []), ...(discoveryError ? [discoveryError] : [])]
    const modelSource: ModelSource = state?.status === 'live'
      ? 'endpoint'
      : state?.status === 'error'
        ? 'error'
        : state?.status === 'manual' || !discover
          ? 'manual'
          : 'catalog'
    return {
      id: route,
      name: facts.name || route,
      models: modelList(route),
      available,
      modelSource,
      ...(discoveryError || manualWarning ? { modelsError: discoveryError ?? manualWarning } : {}),
      ...(state ? { modelsFetchedAt: state.fetchedAt } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      ...(facts.protocol ? { protocol: facts.protocol } : {}),
      ...(facts.configScope ? { configScope: facts.configScope } : {}),
      ...(facts.declared ? { declared: true } : {}),
    }
  }

  /** 冲突检查 + 落表。全或无 */
  const commit = (routes: readonly string[], adapter: Adapter, owner: Registration): void => {
    const seen = new Set<string>()
    for (const route of routes) {
      if (!route) throw new Error('路由名不能是空字符串')
      if (seen.has(route)) throw new Error(`路由 ${route} 在一个注册里出现了两次`)
      seen.add(route)
      const held = regs.get(route)
      if (held && held !== owner) throw new Error(`provider ${route} 已被另一个 adapter 占用`)
    }
    // 先撤掉这个 owner 现在持有的全部, 再按新集合落 —— 中间不 await,
    // 别处看不到"半张表"
    for (const [route, reg] of regs) if (reg === owner) regs.delete(route)
    owner.routes = [...routes]
    for (const route of routes) regs.set(route, owner)
  }

  const assertImageInput = (target: ResolvedRoute, req: StreamRequest): void => {
    const hasImage = (blocks: readonly ContentBlock[]): boolean => blocks.some((block) =>
      block.type === 'image' || (block.type === 'tool-result' && hasImage(block.content)),
    )
    if (!req.messages.some((message) => hasImage(message.content))) return
    const model = modelList(target.id).find((item) => item.id === target.model)
      ?? target.adapter.resolveModel?.(target.id, target.model)
    // 缺 input = 能力未知，按模型目录契约允许尝试；明确不含 image 才拒。
    if (model?.input && !model.input.includes('image')) {
      throw new LlmError(`模型 ${target.model} 不支持图片输入，请换用视觉模型`, LLM_CODE.BAD_REQUEST)
    }
  }

  const assertReasoningEffort = (target: ResolvedRoute, effort?: ReasoningEffort): void => {
    if (!effort) return
    const model = modelList(target.id).find((item) => item.id === target.model)
    // 未申报 = 能力未知，交给 adapter 尝试；申报过就必须以厂商清单为准。
    if (!model?.reasoningEfforts || model.reasoningEfforts.includes(effort)) return
    const supported = model.reasoningEfforts.join(' / ') || '无'
    throw new LlmError(
      `模型 ${target.model} 不支持推理档位 "${effort}"（厂商支持: ${supported}）`,
      LLM_CODE.BAD_REQUEST,
    )
  }

  const service: LLMService = {
    register(provider) {
      return service.registerAdapter([provider.id], providerAdapter(provider))
    },

    registerAdapter(routes, adapter) {
      const owner: Registration = { routes: [], adapter }
      commit(routes, adapter, owner)
      // 只在"能用"的路由上落默认模型: 一个没配 key 的 provider 抢走默认,
      // 表现为"用户配好的那家永远用不上"
      if (!defaultModel && !defaultProvider) {
        const usableRoute = routes.find(usable)
        const first = usableRoute ? modelList(usableRoute)[0]?.id : undefined
        if (first) defaultModel = first
      }
      for (const route of routes) ctx.emit('llm/provider-added', route)
      ctx.emit('llm/providers-updated')
      ctx.emit('llm/adapters-updated')

      let disposed = false
      const handle = (() => {
        if (disposed) return
        disposed = true
        const mine = [...regs.entries()].filter(([, reg]) => reg === owner).map(([route]) => route)
        for (const route of mine) regs.delete(route)
        for (const route of mine) ctx.emit('llm/provider-removed', route)
        ctx.emit('llm/providers-updated')
        ctx.emit('llm/adapters-updated')
      }) as AdapterHandle

      handle.replace = (next) => {
        if (disposed) throw new Error('这个注册已经卸装, 不能再 replace')
        commit(next, adapter, owner)
        ctx.emit('llm/providers-updated')
        ctx.emit('llm/adapters-updated')
      }

      return handle
    },

    registerConfigurableProviders(entries) {
      const owner = { entries: [] as ConfigurableProvider[] }
      const commitDirectory = (next: readonly ConfigurableProvider[]): void => {
        const seen = new Set<string>()
        for (const entry of next) {
          if (!entry.provider) throw new Error('目录条目的 provider 不能为空')
          if (seen.has(entry.provider)) throw new Error(`目录里 ${entry.provider} 出现了两次`)
          seen.add(entry.provider)
          for (const other of dirs) {
            if (other === owner) continue
            if (other.entries.some((e) => e.provider === entry.provider)) {
              throw new Error(`可配置路由 ${entry.provider} 已被另一个注册声明`)
            }
          }
        }
        owner.entries = [...next]
        if (!dirs.includes(owner)) dirs.push(owner)
        ctx.emit('llm/adapters-updated')
      }

      commitDirectory(entries)

      let disposed = false
      const handle = (() => {
        if (disposed) return
        disposed = true
        const at = dirs.indexOf(owner)
        if (at >= 0) dirs.splice(at, 1)
        ctx.emit('llm/adapters-updated')
      }) as DirectoryHandle
      handle.replace = (next) => {
        if (disposed) throw new Error('这个目录注册已经卸装, 不能再 replace')
        commitDirectory(next)
      }
      return handle
    },

    listConfigurableProviders() {
      return dirs.flatMap((d) => d.entries).map((e) => ({ ...e, configPath: [...e.configPath] }))
    },

    registerModelDiscovery(scope, discover) {
      discoveries.set(scope, discover)
      return () => {
        // 只有还是自己那一个时才删 —— 后注册者覆盖前一个, 前一个的卸装
        // 不该把后一个也带走
        if (discoveries.get(scope) === discover) discoveries.delete(scope)
      }
    },

    async discoverModels(scope, request) {
      const discover = discoveries.get(scope)
      if (!discover) {
        throw new LlmError(`scope ${scope} 没有注册模型发现 (没人知道怎么问它要模型列表)`, LLM_CODE.DISCOVERY_UNSUPPORTED)
      }
      const found = await discover(request)
      // 端点经常把同一个 id 报两次; 去重保持顺序
      const seen = new Set<string>()
      return found.filter((m) => {
        if (!m.id || seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
    },

    async refreshModels(options = {}) {
      const force = options.force ?? false
      await Promise.all([...regs.keys()].map((route) => refreshRoute(route, force)))
      ctx.emit('llm/providers-updated')
      return [...regs.keys()].map(infoOf)
    },

    invalidateModels() {
      discoveryRevision++
      discoveryStates.clear()
      discoveryPending.clear()
      ctx.emit('llm/providers-updated')
    },

    listProviders() {
      return [...regs.keys()].map(infoOf)
    },

    resolve,

    models() {
      return [...regs.keys()].filter(usable).flatMap((route) => modelList(route).map((m) => m.id))
    },

    raw(req) {
      return (async function* () {
        await service.refreshModels()
        const target = resolve(req.model, req.provider)
        assertImageInput(target, req)
        const reasoningEffort = req.reasoningEffort ?? target.reasoningEffort
        assertReasoningEffort(target, reasoningEffort)
        yield* target.adapter.stream(target.id, {
          ...req,
          model: target.model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        })
      })()
    },

    stream(req) {
      return (async function* () {
        await service.refreshModels()
        const target = resolve(req.model, req.provider)
        assertImageInput(target, req)
        const reasoningEffort = req.reasoningEffort ?? target.reasoningEffort
        assertReasoningEffort(target, reasoningEffort)
        yield* assemble(target.adapter.stream(target.id, {
          ...req,
          model: target.model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }))
      })()
    },
  }

  ctx.set('llm', service)
  ctx.emit('llm/ready', { models: service.models() })

  return () => {
    discoveryRevision++
    regs.clear()
    dirs.length = 0
    discoveries.clear()
    discoveryStates.clear()
    discoveryPending.clear()
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
    id: 'default-route-usable',
    run(ctx) {
      const llm = ctx.get<LLMService>('llm')
      if (!llm) throw new Error('能力面 llm 未注册')
      const list = llm.listProviders()
      // 空列表不在这里管: 只装 base 的场景 (测试 / graph) 本来就没有 provider,
      // 该由 provider 插件自己的不变量去抱怨"装了却不能用"
      if (list.length === 0) return
      const usable = list.filter((p) => p.available)
      if (usable.length === 0) {
        // "装了但都不可用"是**静默的死局**: 用户打第一句话才看到报错,
        // 而那时他以为是模型坏了。启动就红, 指向凭据
        throw new Error(
          `已装载的 provider 都不可用 (${list.map((p) => p.id).join(', ')}) —— 检查凭据配置`,
        )
      }
      // 默认路由必须真能落到一个可用的 provider 上。这一条防的是
      // "defaultModel 指向一个没配 key 的模型"和"resolve 的顺序写反了"
      const picked = llm.resolve()
      if (!usable.some((p) => p.id === picked.id)) {
        throw new Error(`默认路由落到了不可用的 provider ${picked.id}`)
      }
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
