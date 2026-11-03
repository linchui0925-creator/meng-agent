/**
 * harness Message[] → DeepSeek chat-completions 请求体。
 *
 * 抄自 dsh 的 `dsh-llm-deepseek/src/serialize.ts`（0.1.0-rc.6），
 * **抄的是它的血泪，不是它的框架**：那个包外面还裹着 schemastery / credentials /
 * settings 三件我们还没有的东西，硬搬进来就是死代码。这里只留把请求写对的部分。
 *
 * 四条不是"风格"而是"不这么写就 400"的规矩：
 *
 * ① **`thinking` 与 `reasoning_effort` 必须成对合法**。
 *    wire 上只有 enabled/disabled 两个 thinking 档位；`off` 是**我们这边的说法**，
 *    表示"别开思考"，落到 wire 是 `thinking: disabled` 且**不带** reasoning_effort。
 *    直接把 `off` 当 effort 传上去 = 非法枚举。
 *
 * ② **assistant 消息的 `content` 永远给**，即使只有一个工具调用、正文是空串。
 *    省略 content 字段在部分部署上会被判成畸形消息。
 *
 * ③ **带 tool_calls 的 assistant 必须把当轮 `reasoning_content` 带回去**。
 *    thinking 模式下模型"想想再调工具"是常态，下一轮请求里不给它自己上轮的思考，
 *    DeepSeek 会认为上下文断裂而报错。反过来，**纯文本轮次不要回传** reasoning
 *    （多花钱且没有任何收益）—— 这个非对称是刻意的。
 *
 * ④ 工具结果为空时给 `"(no output)"`。空串会让模型以为工具没返回，
 *    于是重试同一个调用，白烧一轮。
 */

import type { ContentBlock, Message, StreamRequest } from '@meng/llm'

/** wire 上的 thinking 档位。注意没有 `off` —— 那个只能活在配置层 */
export type ThinkingMode = 'enabled' | 'disabled'

/** 我们的推理档位。`off` 是"关掉思考"的意图，不直接上线 */
export type ReasoningEffort = 'off' | 'high' | 'max'

export interface ThinkingDefaults {
  /** 部署侧默认档位。留空 = 不往 wire 上写 thinking 字段，让服务端默认生效 */
  thinking?: ThinkingMode
  /** 调用方没指定 effort 时用这个 */
  reasoningEffort?: ReasoningEffort
}

/** 解析一次合法的 thinking/effort 配对。返回的字段按"有才给"组织 */
export function resolveThinking(
  requested: ReasoningEffort | undefined,
  defaults: ThinkingDefaults,
): { thinking?: ThinkingMode; reasoningEffort?: ReasoningEffort } {
  const effort = requested ?? defaults.reasoningEffort

  // 部署被钉死成"不许思考"，调用方却要开 → 当场拒绝。
  // 这里必须报错而不是静默降级: 用户要的是 deepseek-reasoner 的思考,
  // 悄悄给他一个不思考的回答, 比失败更难查
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new ReasoningEffortError(effort)
  }

  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') return { thinking: 'enabled', reasoningEffort: effort }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

export class ReasoningEffortError extends Error {
  readonly code = 'UNSUPPORTED_REASONING_EFFORT'
  constructor(effort: string) {
    super(`这个 DeepSeek 部署不支持推理档位 "${effort}"`)
    this.name = 'ReasoningEffortError'
  }
}

function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** 一条 assistant 消息: 正文 + 工具调用 + (仅当有工具调用时) 上轮思考 */
function serializeAssistant(message: Message): Record<string, unknown> {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'reasoning' }> => b.type === 'reasoning')
    .map((b) => b.text)
    .join('')
  const toolCalls = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
    .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.arguments } }))

  return {
    role: 'assistant',
    // 规矩 ②: content 永远给, 空串也写
    content: text,
    // 规矩 ③: 只有"带工具调用 + 确实有思考"才回传
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * 会话 → wire 消息。`tool-result` 块拆成独立的 `{role:'tool'}` 消息：
 * 一条 user 消息里可能挂着多个并发调用的结果，每个都要有自己的那一条。
 */
export function serializeMessages(messages: Message[]): unknown[] {
  const wire: unknown[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }

    const toolResults = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result',
    )
    const text = flattenText(message.content)

    // 既是"有正文"也是"没有工具结果"时才发 user —— 只有工具结果的消息
    // 发成一条空 user 消息, 会让模型看见一个它无法响应的空轮
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })

    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // 规矩 ④: 空输出给占位, 不给空串
        content: flattenText(result.content) || '(no output)',
      })
    }
  }

  return wire
}

export interface SerializeInput extends ThinkingDefaults {
  request: StreamRequest
  temperature?: number
  maxTokens?: number
}

/** 完整请求体。可选字段一律"有才写"，不写 null —— 让服务端默认值生效 */
export function serializeRequest(input: SerializeInput): Record<string, unknown> {
  const { request } = input
  // 调用方目前不指定 effort（StreamRequest 还没有这个字段），
  // 所以档位只来自插件配置。将来 loop 要按轮调档，从这里把值传进来即可
  const thinking = resolveThinking(undefined, input)
  const temperature = request.temperature ?? input.temperature
  const maxTokens = request.maxTokens ?? input.maxTokens

  return {
    model: request.model,
    messages: serializeMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking.thinking !== undefined ? { thinking: { type: thinking.thinking } } : {}),
    ...(thinking.reasoningEffort !== undefined ? { reasoning_effort: thinking.reasoningEffort } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  }
}
