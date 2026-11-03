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

import type { Ctx, Disposer } from '@meng/core'
import {
  LLM_CODE,
  LlmError,
  httpErrorCode,
  type ContentBlock,
  type FinishReason,
  type LLMService,
  type Message,
  type Provider,
  type StreamChunk,
  type StreamRequest,
  type ToolSpec,
} from '@meng/llm'
import { parseLine, sseLines } from './sse.ts'

export const name = 'provider-openai'
export const inject = ['llm']

export interface OpenAIConfig {
  id?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
  /** 不设置默认走的模型 (清单里 defaultModel 为空时用) */
  defaultModel?: string
  temperature?: number
}

export function apply(ctx: Ctx, config: OpenAIConfig = {}): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-openai 依赖 llm')

  const id = config.id ?? 'openai'
  const baseURL = stripSlash(
    config.baseURL ?? process.env.MENG_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  )
  const apiKey = config.apiKey ?? process.env.MENG_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
  const models = config.models ?? ['gpt-4o-mini']
  const temperature = config.temperature ?? 0.7

  const provider: Provider = {
    id,
    models,

    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      if (!apiKey) {
        throw new LlmError(`provider ${id} 未配置 apiKey (MENG_LLM_API_KEY)`, LLM_CODE.MISSING_CREDENTIAL)
      }

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // 不可关闭的自我标识: 上游统计/限流认这个, 也让请求一眼可分辨
          'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
        },
        body: JSON.stringify({
          model: req.model || models[0],
          messages: toOpenAI(req.messages),
          temperature,
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
  }

  const off = llm.register(provider)
  if (!process.env.MENG_QUIET) console.log(`[meng] provider ${id} · ${models.join(', ')} · ${baseURL}`)
  return off
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

export const invariant = {
  pkg: '@meng/provider-openai',
  checks: [
    {
      id: 'registered',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm) throw new Error('llm 未注册')
        if (!llm.models().length) throw new Error('没有任何模型, agent 无法启动')
      },
    },
  ],
}
