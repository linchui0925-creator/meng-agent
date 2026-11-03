/**
 * @meng/agent — 一轮对话的循环。
 *
 * 刻意写得短 (不到 120 行)。Python 版 agent.py 是 2926 行, 因为它同时干了:
 * 循环 / 上下文压缩 / 审批 / 记忆 / 工具结果格式化 / 厂商怪癖兼容 / 落库。
 * 这里只保留循环本身, 其余全部是插件:
 *   压缩    → compaction 插件, 监听 turn/ended
 *   审批    → approval 插件, 监听 tools/pre-execute
 *   记忆    → memory 插件, 监听 turn/ended
 *   兼容    → provider 自己负责, 别让循环知道 minimax 的 XML 长什么样
 *
 * 这条边界一旦破了 (比如"就加个 if 判断"), 三年后就是第二个 2926 行。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { LLMService, LlmFailure, Message, StreamRequest, TokenUsage } from '@meng/llm'
import type { SessionService } from '@meng/session'
import type { PromptService } from '@meng/prompt'
import type { ToolCall, ToolService } from '@meng/tools'

export const name = 'meng-agent'
export const inject = ['llm', 'session', 'tools', 'prompt']

export interface RunInput {
  sessionId: string
  text: string
  model?: string
  /** 由调用方分配, 会写进每条事件的 data.runId —— 前端靠它给并发 run 分组 */
  runId?: string
  signal?: AbortSignal
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall; result: string }
  | { type: 'done'; reason: 'stop' | 'max-turns' | 'error' | 'aborted'; error?: string }

export interface AgentService {
  run(input: RunInput): AsyncIterable<AgentEvent>
}

export function apply(ctx: Ctx, config: { maxTurns?: number; defaultModel?: string }): Disposer {
  const maxTurns = config.maxTurns ?? 24

  const service: AgentService = {
    async *run(input) {
      const llm = ctx.get<LLMService>('llm')
      const session = ctx.get<SessionService>('session')
      const tools = ctx.get<ToolService>('tools')
      const prompt = ctx.get<PromptService>('prompt')
      if (!llm || !session || !tools || !prompt) throw new Error('agent 依赖的能力面缺失')

      const runId = input.runId ?? ''
      const meta = (extra: Record<string, unknown> = {}) => ({ ...(runId ? { runId } : {}), ...extra })

      session.append(input.sessionId, 'turn/started', meta({ text: input.text }))
      const system = await prompt.render()

      for (let turn = 0; turn < maxTurns; turn++) {
        if (input.signal?.aborted) {
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'aborted' }))
          yield { type: 'done', reason: 'aborted' }
          return
        }

        const model = input.model ?? config.defaultModel ?? ''
        const request: StreamRequest = {
          model,
          messages: [
            { role: 'system', content: [{ type: 'text', text: system }] } satisfies Message,
            ...session.project(input.sessionId),
          ],
          tools: tools.list(),
          signal: input.signal,
        }

        let text = ''
        let reasoning = ''
        const calls: ToolCall[] = []
        let failure: LlmFailure | undefined
        let usage: TokenUsage | undefined

        try {
          // 走 llm.stream() (组装后的流) 而不是 resolve().stream():
          // 块组装是中立层的活, provider 只吐 delta
          for await (const chunk of llm.stream(request)) {
            if (chunk.type === 'text-delta') {
              text += chunk.text
              yield { type: 'text', text: chunk.text }
            }
            // reasoning 不上行广播: 契约里没有这个事件类型, 加了前端就得改。
            // 它照样落进 llm/completed, 将来要显示再加 (那时才动契约)
            if (chunk.type === 'reasoning-delta') {
              reasoning += chunk.text
            }
            if (chunk.type === 'usage') {
              usage = chunk.usage
            }
            if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
              calls.push({
                id: chunk.block.id,
                name: chunk.block.name,
                args: parseArgs(chunk.block.arguments),
                sessionId: input.sessionId,
                runId,
              })
            }
            if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              failure = chunk.reason.failure
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String(err.code) : 'UNKNOWN'
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'error', error: message, code }))
          yield { type: 'done', reason: 'error', error: message }
          return
        }

        // finish 里带错误也算失败: provider 把失败编进流里(而不是 throw)是合法的,
        // 不检查就会变成一个"没有文本也没有工具调用"的空轮, 静默结束
        if (failure) {
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'error', error: failure.message, code: failure.code }))
          yield { type: 'done', reason: 'error', error: failure.message }
          return
        }

        // toolCalls 必须落库: 下一轮 project 要靠它还原 assistant 的"我要调这些工具",
        // 否则 provider 收到孤立的 tool 结果会 400
        session.append(input.sessionId, 'llm/completed', meta({
          text,
          ...(reasoning ? { reasoning } : {}),
          ...(usage ? { usage } : {}),
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        }))

        if (calls.length === 0) {
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'stop' }))
          yield { type: 'done', reason: 'stop' }
          return
        }

        for (const call of calls) {
          // signal 透传给工具: 审批等待中用户点"中止", 问题要能跟着取消
          const result = await tools.call({
            ...call,
            sessionId: input.sessionId,
            runId,
            signal: input.signal,
          })
          yield { type: 'tool', call, result: result.ok ? result.text : (result.error ?? '') }
        }
      }

      session.append(input.sessionId, 'turn/ended', meta({ reason: 'max-turns' }))
      yield { type: 'done', reason: 'max-turns' }
    },
  }

  ctx.set('agent', service)
  return () => undefined
}

/**
 * 解析工具参数。模型写出截断/非法 JSON 是常态, 不是异常 ——
 * 交给工具侧报"参数不合法", 比在这里静默丢弃好定位。
 */
function parseArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { __raw: text }
  }
}

export const invariant = defineInvariant('@meng/agent', [
  {
    id: 'deps-are-live',
    run(ctx) {
      for (const dep of ['llm', 'session', 'tools', 'prompt']) {
        if (!ctx.get(dep)) throw new Error(`agent 依赖 ${dep} 未就绪`)
      }
    },
  },
])
