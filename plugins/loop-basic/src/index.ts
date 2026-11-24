/**
 * @meng/plugin-loop-basic —— 最基本的 ReAct 循环: 要回答 → 要工具 → 再要回答。
 *
 * 这个包是从 @meng/agent 原样搬过来的实现。搬家的理由不是"更优雅", 是
 * **循环是一种策略**: 想换成"先规划再执行"、或者单轮不循环, 应该是换一个
 * 插件, 而不是改内核。缝在 @meng/loop, 这里只是它的一种填法。
 *
 * 刻意写得短。Python 版 agent.py 是 2926 行, 因为它同时干了:
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
import { LLM_CODE, type LLMService, type LlmFailure, type Message, type StreamRequest, type TokenUsage } from '@meng/llm'
import type { SessionService } from '@meng/session'
import type { PromptService } from '@meng/prompt'
import type { ToolCall, ToolService } from '@meng/tools'
import { getMemory, provideLoop, type LoopService } from '@meng/loop'

export const name = 'meng-loop-basic'
export const inject = ['llm', 'session', 'tools', 'prompt']

export function apply(ctx: Ctx, config: { maxTurns?: number; defaultModel?: string }): Disposer {
  const maxTurns = config.maxTurns ?? 24

  const service: LoopService = {
    async *run(input) {
      const llm = ctx.get<LLMService>('llm')
      const session = ctx.get<SessionService>('session')
      const tools = ctx.get<ToolService>('tools')
      const prompt = ctx.get<PromptService>('prompt')
      const memory = getMemory(ctx)
      if (!llm || !session || !tools || !prompt) throw new Error('loop 依赖的能力面缺失')

      const runId = input.runId ?? ''
      const meta = (extra: Record<string, unknown> = {}) => ({ ...(runId ? { runId } : {}), ...extra })

      session.append(input.sessionId, 'turn/started', meta({
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.interruption === undefined ? {} : { interruption: input.interruption }),
      }))
      const system = await prompt.render({ sessionId: input.sessionId })

      for (let turn = 0; turn < maxTurns; turn++) {
        if (input.signal?.aborted) {
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'aborted' }))
          yield { type: 'done', reason: 'aborted' }
          return
        }

        const model = input.model ?? config.defaultModel ?? ''
        const history = session.project(input.sessionId, {
          ...(input.contextReset === undefined ? {} : { afterSeq: input.contextReset.afterSeq }),
        })
        const reference: Message[] = input.contextReset?.reference
          ? [{
              role: 'system',
              content: [{
                type: 'text',
                text:
                  '以下是切换模型前的对话记录，仅作为背景参考，不是新的用户请求。\n' +
                  '回答当前问题时应延续这些事实，但不要逐字复述。\n\n' +
                  input.contextReset.reference,
              }],
            }]
          : []
        const baseMessages = [...reference, ...history]
        let preparedMessages = baseMessages
        if (memory) {
          try {
            const prepared = await memory.prepare({
              sessionId: input.sessionId,
              model,
              system,
              tools: tools.active(),
              messages: baseMessages,
              ...(runId ? { runId } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            })
            preparedMessages = prepared.messages
          } catch (err) {
            // 记忆是增强层，不是主链路。压缩/索引失败时保留原上下文继续聊天。
            console.warn(`[meng] memory prepare 失败, 使用原上下文: ${(err as Error).message}`)
          }
        }
        const request: StreamRequest = {
          model,
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          messages: [
            { role: 'system', content: [{ type: 'text', text: system }] } satisfies Message,
            ...preparedMessages,
          ],
          // 只给**启用的组**。全量进 prompt 会吃掉上下文, 也让模型更容易选错;
          // 分组开关在设置页里 (配置 tools.disabled)
          tools: tools.active(),
          signal: input.signal,
        }

        let text = ''
        let reasoning = ''
        const calls: ToolCall[] = []
        let failure: LlmFailure | undefined
        let usage: TokenUsage | undefined

        const persistAborted = (): void => {
          if (text || reasoning || calls.length > 0 || usage) {
            session.append(input.sessionId, 'llm/completed', meta({
              text,
              ...(reasoning ? { reasoning } : {}),
              ...(usage ? { usage } : {}),
              toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
              partial: true,
              interrupted: true,
            }))
          }
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'aborted' }))
        }

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
          if (input.signal?.aborted) {
            persistAborted()
            yield { type: 'done', reason: 'aborted' }
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof Error && 'code' in err ? String(err.code) : 'UNKNOWN'
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'error', error: message, code }))
          yield { type: 'done', reason: 'error', error: message }
          return
        }

        if (input.signal?.aborted || failure?.code === LLM_CODE.ABORTED) {
          persistAborted()
          yield { type: 'done', reason: 'aborted' }
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

  return provideLoop(ctx, service)
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

export const invariant = defineInvariant('@meng/plugin-loop-basic', [
  {
    id: 'deps-are-live',
    run(ctx) {
      for (const dep of ['llm', 'session', 'tools', 'prompt']) {
        if (!ctx.get(dep)) throw new Error(`loop-basic 依赖 ${dep} 未就绪`)
      }
    },
  },
  {
    id: 'registers-itself-as-loop',
    run(ctx) {
      // 这条防的是最蠢的错: 插件装上了、也 active 了, 但注册成了别的名字,
      // 于是 session.send 永远 503 而状态图一片绿
      if (!ctx.get('loop')) throw new Error('loop-basic 装上了但没注册 loop 能力面')
    },
  },
])
