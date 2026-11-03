/**
 * DeepSeek wire chunk → 中立 StreamChunk。
 *
 * 抄自 dsh 的 `dsh-llm-deepseek/src/translate.ts`，**但有一处刻意的不同**：
 *
 * dsh 的 translate 自己组建完整块、自己吐 block-end、自己判 EMPTY_RESPONSE。
 * 我们的分工是「provider 只吐 delta，组装一律在 @meng/llm 的 assemble()」——
 * 这是 docs/10 §12.2 拍板的第 2 个决定：**新增厂商不可能长出不一致的组装行为**
 * （dsh 靠 review 保证，我们靠结构保证）。所以这里只管三件事：
 *
 *   1. 块号怎么分配
 *   2. 什么时候算"这轮说完了"（`[DONE]` 才是唯一信号）
 *   3. wire 的枚举/口径怎么映射到中立词汇表
 *
 * ── 块号：按**出现顺序**分配（这是抄得最值钱的一条）──────────────────────
 * 我们旧的 provider-openai 是「文本固定 0、工具 1+index」。那套在纯文本上没毛病，
 * 但 DeepSeek thinking 模式下模型会**先思考再说话**：reasoning-delta 和 text-delta
 * 都往 0 号块里塞，assemble 看到的是一条类型自相矛盾的块
 * （先按 reasoning 开块，后到的 text 却进了同一个 index）。
 * dsh 的做法是 nextIndex++，谁先开口谁拿号 —— reasoning=0, text=1, 工具=2、3…
 *
 * ── 收尾：`[DONE]` 才发 finish ────────────────────────────────────────────
 * `finish_reason` 只是"模型说完了"，usage 可能还在后面另起一个 chunk。
 * 见到 finish_reason 立刻 return 的写法会漏掉计费。这里先缓存，`[DONE]` 一起吐：
 * block-end / usage / finish 的顺序由 assemble() 保证（它会把 finish 排在最后）。
 */

import type { FinishReason, LlmFailure, StreamChunk, TokenUsage } from '@meng/llm'
import { LLM_CODE, LlmError } from '@meng/llm'
import { DONE } from './sse.ts'

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  /** DeepSeek 的原始字段名。和上面那个是同一件事的两种写法 */
  prompt_cache_hit_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: WireUsage
  error?: { message?: string; type?: string; code?: string }
}

export async function* translate(payloads: AsyncIterable<string>): AsyncIterable<StreamChunk> {
  let nextIndex = 0
  let reasoningIndex: number | undefined
  let textIndex: number | undefined
  /** wire 的 tool_calls[].index → 我们自己分配的块号 */
  const toolIndex = new Map<number, number>()

  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  let sawToolCall = false

  for await (const payload of payloads) {
    if (payload === DONE) {
      // 唯一收尾点。空响应不在这里判 —— assemble() 见到"stop 但零块"会判
      // EMPTY_RESPONSE，那是全仓统一的一条规则，不在每个 provider 里各写一遍
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      yield {
        type: 'finish',
        reason: pendingFinish ?? { kind: 'stop' },
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`DeepSeek 吐了非 JSON 的 SSE 负载: ${payload.slice(0, 120)}`, LLM_CODE.MALFORMED_RESPONSE)
    }

    // 有些部署把错误塞在 200 的流里而不是走 HTTP 状态
    if (chunk.error?.message) throw wireFailure(chunk.error)

    // usage 先攒着：DeepSeek 可能在任意位置给一次，但只能吐一次
    if (chunk.usage) pendingUsage = toUsage(chunk.usage)

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
      }

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        if (textIndex === undefined) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }

      for (const call of delta?.tool_calls ?? []) {
        const wireIndex = call.index ?? 0
        let blockIndex = toolIndex.get(wireIndex)
        if (blockIndex === undefined) {
          blockIndex = nextIndex++
          toolIndex.set(wireIndex, blockIndex)
          sawToolCall = true
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
        }
        // 第一个分片带 id/name，后续只有 arguments 增量。
        // 累积是 assemble() 的活 —— 这里一个字都不攒
        yield {
          type: 'tool-call-delta',
          index: blockIndex,
          ...(call.id ? { id: call.id } : {}),
          ...(call.function?.name ? { name: call.function.name } : {}),
          argumentsDelta: call.function?.arguments ?? '',
        }
      }

      if (choice.finish_reason) {
        pendingFinish = toFinish(choice.finish_reason, sawToolCall)
        // 注意: 这里**不** return。usage 可能还在后面
      }
    }
  }

  // 走到这里说明流断在 [DONE] 之前。什么都不补 ——
  // assemble() 会补一个 TRANSPORT 错误 finish，不伪装成正常结束
}

// ── 映射 ─────────────────────────────────────────────────────────────────────

/**
 * wire finish_reason → 中立 FinishReason。
 *
 * 和 dsh 的一处差异: 它把 `stop` 一律当 stop，我们额外修一次
 * 「说了 stop 但确实调了工具」。原因是我们 loop 的续跑判断依赖 finish，
 * 而 DeepSeek 在工具轮次上偶尔给 stop 而不是 tool_calls —— 认了 stop 就会
 * "调完工具却不读结果"，一轮白跑。等 loop 改成看块不看 reason，这段可以删。
 */
function toFinish(reason: string, sawToolCall: boolean): FinishReason {
  if (reason === 'tool_calls' || (reason === 'stop' && sawToolCall)) return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'stop') return { kind: 'stop' }
  // content_filter / insufficient_system_resource 这类: 不当成功, 也不编造语义,
  // 把原值大写当 code 出去, 上层能原样显示
  const failure: LlmFailure = { message: `模型停止原因: ${reason}`, code: reason.toUpperCase() }
  return { kind: 'error', failure }
}

/**
 * Token 口径: **互斥计数**。
 * DeepSeek 的 `prompt_tokens = 命中缓存 + 未命中`，不把缓存减出来就会重复计费。
 * 两种字段名都要认：官方文档用 `prompt_cache_hit_tokens`，
 * 新版 OpenAI 兼容层用 `prompt_tokens_details.cached_tokens`。
 */
function toUsage(wire: WireUsage): TokenUsage {
  const cacheRead = wire.prompt_tokens_details?.cached_tokens ?? wire.prompt_cache_hit_tokens
  const reasoning = wire.completion_tokens_details?.reasoning_tokens
  const prompt = wire.prompt_tokens ?? 0
  const cached = cacheRead ?? 0

  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: wire.completion_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

function wireFailure(error: NonNullable<WireChunk['error']>): LlmError {
  const code = (error.code ?? error.type ?? '').toLowerCase()
  const mapped =
    code.includes('rate') ? LLM_CODE.RATE_LIMIT
    : code.includes('auth') || code.includes('key') ? LLM_CODE.AUTH
    : code.includes('quota') || code.includes('balance') ? LLM_CODE.QUOTA
    : LLM_CODE.MALFORMED_RESPONSE
  return new LlmError(`DeepSeek: ${error.message ?? '流内错误'}`, mapped)
}
