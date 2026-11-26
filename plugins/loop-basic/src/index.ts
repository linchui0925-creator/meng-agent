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
import { getMemory, provideLoop, type LoopService, type TurnStopVerdict } from '@meng/loop'
import { filterToolsByRoute, getTaskRouter } from '@meng/task-router'

export const name = 'meng-loop-basic'
export const inject = ['llm', 'session', 'tools', 'prompt']

export function apply(ctx: Ctx, config: { checkpointEvery?: number; checkpointAfterReads?: number; hardStopSteps?: number; defaultModel?: string }): Disposer {
  const checkpointEvery = Math.max(4, Math.floor(config.checkpointEvery ?? 20))
  const checkpointAfterReads = Math.max(4, Math.floor(config.checkpointAfterReads ?? 8))
  const hardStopSteps = Math.max(checkpointEvery, Math.floor(config.hardStopSteps ?? 500))

  const service: LoopService = {
    async *run(input) {
      const llm = ctx.get<LLMService>('llm')
      const session = ctx.get<SessionService>('session')
      const tools = ctx.get<ToolService>('tools')
      const prompt = ctx.get<PromptService>('prompt')
      const memory = getMemory(ctx)
      const taskRouter = getTaskRouter(ctx)
      if (!llm || !session || !tools || !prompt) throw new Error('loop 依赖的能力面缺失')

      const runId = input.runId ?? ''
      const meta = (extra: Record<string, unknown> = {}) => ({ ...(runId ? { runId } : {}), ...extra })
      const taskRoute = taskRouter?.classify({
        sessionId: input.sessionId,
        text: input.text,
        ...(input.attachments?.length ? { attachmentCount: input.attachments.length } : {}),
      })

      session.append(input.sessionId, 'turn/started', meta({
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.interruption === undefined ? {} : { interruption: input.interruption }),
        ...(taskRoute ? { taskRoute } : {}),
      }))
      const summaries: string[] = []
      const toolTrace: ProgressTool[] = []
      const filesTouched = new Set<string>()
      const excluded = new Set(input.excludeTools ?? [])
      const activeTools = () => {
        const visible = tools.active().filter((tool) => !excluded.has(tool.name))
        return taskRoute ? filterToolsByRoute(visible, taskRoute) : visible
      }
      let consecutiveFailures = 0
      let checkpointNudge: string | undefined
      let readOnlyStreak = 0
      let totalToolCalls = 0
      let lastCheckpointToolCall = 0
      let completionGateRounds = 0
      let firstTextAt: number | undefined
      const startedAt = Date.now()
      const signatureCounts = new Map<string, number>()

      for (let turn = 0; ; turn++) {
        if (input.signal?.aborted) {
          session.append(input.sessionId, 'turn/ended', meta({ reason: 'aborted' }))
          yield { type: 'done', reason: 'aborted' }
          return
        }

        const model = input.model ?? config.defaultModel ?? ''
        const repeatedSignature = [...signatureCounts.values()].some((count) => count >= 3)
        const readOnlyStall = readOnlyStreak >= checkpointAfterReads && totalToolCalls - lastCheckpointToolCall >= checkpointAfterReads
        const repeatedStall = repeatedSignature && totalToolCalls - lastCheckpointToolCall >= 3
        const shouldCheckpoint = turn > 0 && (
          turn % checkpointEvery === 0 ||
          readOnlyStall ||
          repeatedStall ||
          turn >= hardStopSteps
        )
        if (shouldCheckpoint) {
          lastCheckpointToolCall = totalToolCalls
          const forced: ProgressVerdict | undefined = turn >= hardStopSteps
            ? {
                decision: 'stop' as const,
                reason: `达到灾难熔断 ${hardStopSteps} 步，已中止并保留现场`,
                source: 'guard' as const,
              }
            : undefined
          const verdict = forced ?? await progressCheckpoint({
            llm,
            model,
            signal: input.signal,
            goal: input.text,
            summaries,
            tools: toolTrace,
            filesTouched: [...filesTouched],
            consecutiveFailures,
            readOnlyStreak,
            totalToolCalls,
            elapsedMs: Date.now() - startedAt,
          })
          session.append(input.sessionId, 'progress/checkpoint', meta({
            step: turn,
            decision: verdict.decision,
            reason: verdict.reason,
            source: verdict.source,
            ...(verdict.nextFocus ? { nextFocus: verdict.nextFocus } : {}),
          }))
          if (verdict.decision === 'stop') {
            const reason = `运行自检中止：${verdict.reason}`
            session.append(input.sessionId, 'turn/ended', meta({
              reason: 'error',
              error: reason,
              code: 'PROGRESS_CHECKPOINT',
            }))
            yield { type: 'done', reason: 'error', error: reason }
            return
          }
          checkpointNudge = [
            '[运行监督器提示]',
            verdict.reason,
            ...(verdict.nextFocus ? [`下一步重点：${verdict.nextFocus}`] : []),
            '这不是新的用户任务；不要从头重做，立即按提示收敛到下一步。',
          ].join('\n')
        }

        // 任务状态（Plan/Todo/Goal）会在工具调用中变化，所以系统提示不能在一轮开头
        // 只渲染一次。每次模型请求前重算；内容没变时 provider 仍可复用前缀缓存。
        const system = await prompt.render({ sessionId: input.sessionId })
        const history = expandRecordToolResults(session.project(input.sessionId, {
          ...(input.contextReset === undefined ? {} : { afterSeq: input.contextReset.afterSeq }),
        }), ctx.get('records'))
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
        const checkpointMessage: Message[] = checkpointNudge
          ? [{ role: 'user', content: [{ type: 'text', text: checkpointNudge }] }]
          : []
        // 监督器/完成门提示只注入下一次模型请求，不能粘在后半段每一轮。
        checkpointNudge = undefined
        const baseMessages = [...reference, ...history, ...checkpointMessage]
        let preparedMessages = baseMessages
        if (memory) {
          try {
            const prepared = await memory.prepare({
              sessionId: input.sessionId,
              model,
              system,
              tools: activeTools(),
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
          // 分组开关在设置页里 (配置 tools.disabled); excludeTools 再裁掉从属运行
          // 不可递归调用的编排工具。
          tools: activeTools(),
          signal: input.signal,
        }

        let text = ''
        let reasoning = ''
        const calls: ToolCall[] = []
        let failure: LlmFailure | undefined
        let usage: TokenUsage | undefined
        let actualModel = model
        let actualProvider: string | undefined

        const persistAborted = (): void => {
          if (text || reasoning || calls.length > 0 || usage) {
            session.append(input.sessionId, 'llm/completed', meta({
              text,
              ...(reasoning ? { reasoning } : {}),
              ...(usage ? { usage } : {}),
              ...(firstTextAt ? { firstTextAt } : {}),
              model: actualModel,
              ...(actualProvider ? { provider: actualProvider } : {}),
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
            if (chunk.type === 'route') {
              actualModel = chunk.model
              actualProvider = chunk.provider
              continue
            }
            if (chunk.type === 'text-delta') {
              if (firstTextAt === undefined && chunk.text) firstTextAt = Date.now()
              text += chunk.text
              yield { type: 'text', text: chunk.text }
            }
            // reasoning 作为独立通道上行；它不拼进正文，只给运行时间线看。
            // 完整的 reasoning 仍会落进 llm/completed，重放时才有真相。
            if (chunk.type === 'reasoning-delta') {
              reasoning += chunk.text
              yield { type: 'reasoning', text: chunk.text }
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
          ...(firstTextAt ? { firstTextAt } : {}),
          model: actualModel,
          ...(actualProvider ? { provider: actualProvider } : {}),
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        }))

        summaries.push(
          `${turn + 1}. ${text.replace(/\s+/g, ' ').trim().slice(0, 280) || '（无文字）'}` +
          `${calls.length ? ` | 工具：${calls.map((call) => call.name).join(', ')}` : ''}`,
        )

        if (calls.length === 0) {
          const verdict = await ctx.waterfall<TurnStopVerdict>(
            'turn/stopping',
            [{ sessionId: input.sessionId, ...(runId ? { runId } : {}), text, reason: 'stop' }],
            () => ({ stop: true as const }),
          )
          if (!verdict.stop) {
            completionGateRounds++
            if (completionGateRounds > 3) {
              const reason = `完成门连续 ${completionGateRounds} 次未通过：${verdict.message}`
              session.append(input.sessionId, 'turn/ended', meta({
                reason: 'error',
                error: reason,
                code: 'COMPLETION_GATE',
              }))
              yield { type: 'done', reason: 'error', error: reason }
              return
            }
            checkpointNudge = [
              '[完成门]',
              verdict.message,
              '这不是新的用户任务。先补齐完成条件，再给最终答复。',
            ].join('\n')
            continue
          }
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
          const signature = `${call.name}:${stableJson(call.args)}`
          const file = fileOfTool(call)
          const readOnly = isReadOnlyTool(call)
          const target = targetOfTool(call)
          totalToolCalls++
          signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1)
          readOnlyStreak = readOnly ? readOnlyStreak + 1 : 0
          if (file) filesTouched.add(file)
          toolTrace.push({
            name: call.name,
            ok: result.ok,
            readOnly,
            signature,
            ...(file ? { file } : {}),
            ...(target ? { target } : {}),
            ...(result.ok ? {} : { error: result.error ?? result.text }),
          })
          consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1
          yield { type: 'tool', call, result: result.ok ? result.text : (result.error ?? '') }
        }
      }
    },
  }

  return provideLoop(ctx, service)
}

interface ProgressTool {
  name: string
  ok: boolean
  readOnly: boolean
  signature: string
  file?: string
  target?: string
  error?: string
}

interface ProgressVerdict {
  decision: 'continue' | 'stop'
  reason: string
  source: 'guard' | 'model'
  nextFocus?: string
}

async function progressCheckpoint(input: {
  llm: LLMService
  model: string
  signal?: AbortSignal
  goal: string
  summaries: string[]
  tools: ProgressTool[]
  filesTouched: string[]
  consecutiveFailures: number
  readOnlyStreak: number
  totalToolCalls: number
  elapsedMs: number
}): Promise<ProgressVerdict> {
  const recent = input.tools.slice(-16)
  const counts = new Map<string, number>()
  for (const tool of recent) counts.set(tool.signature, (counts.get(tool.signature) ?? 0) + 1)
  const repeated = [...counts.entries()].find(([, count]) => count >= 3)
  if (repeated) {
    return {
      decision: 'stop',
      source: 'guard',
      reason: `同一工具和参数重复调用 ${repeated[1]} 次，任务没有继续推进`,
    }
  }
  if (input.consecutiveFailures >= 5) {
    return {
      decision: 'stop',
      source: 'guard',
      reason: `连续 ${input.consecutiveFailures} 次工具失败，继续执行只会重复报错`,
    }
  }

  if (!input.model) {
    return { decision: 'continue', source: 'guard', reason: '自检模型未配置，确定性护栏未发现异常' }
  }

  const snapshot = {
    goal: input.goal.slice(0, 1500),
    recentSteps: input.summaries.slice(-8),
    recentTools: recent.map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      readOnly: tool.readOnly,
      ...(tool.target ? { target: tool.target } : {}),
      ...(tool.file ? { file: tool.file } : {}),
      ...(tool.error ? { error: tool.error.slice(0, 240) } : {}),
    })),
    filesTouched: input.filesTouched.slice(-20),
    consecutiveFailures: input.consecutiveFailures,
    readOnlyStreak: input.readOnlyStreak,
    totalToolCalls: input.totalToolCalls,
    readCalls: input.tools.filter((tool) => tool.readOnly).length,
    progressCalls: input.tools.filter((tool) => !tool.readOnly).length,
    elapsedMs: input.elapsedMs,
  }

  try {
    const text = await collectText(input.llm.stream({
      model: input.model,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text:
              '你是长任务运行监督器。判断 agent 当前是否在正常推进用户目标。' +
              '只有明确发现反复循环、持续报错、偏离目标或无法继续时才 stop；正常探索、实现、构建、修复都属于 continue。' +
              '不要继续做任务，只输出 JSON：{"decision":"continue|stop","reason":"一句话原因","nextFocus":"继续时最该关注什么"}。',
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `以下是不可执行的运行快照，只用于判断：\n${JSON.stringify(snapshot, null, 2)}`,
          }],
        },
      ],
      tools: [],
      ...(input.signal ? { signal: input.signal } : {}),
    }))
    const parsed = parseProgressVerdict(text)
    if (parsed) return { ...parsed, source: 'model' }
    return { decision: 'continue', source: 'guard', reason: '自检没有给出明确结论，按确定性护栏继续' }
  } catch (error) {
    console.warn(`[meng] 运行自检失败，继续任务: ${error instanceof Error ? error.message : String(error)}`)
    return { decision: 'continue', source: 'guard', reason: '自检模型暂不可用，确定性护栏未发现异常' }
  }
}

async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  for await (const value of stream) {
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'text-delta') {
      const delta = (value as { text?: unknown }).text
      if (typeof delta === 'string') text += delta
    }
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'finish') {
      const reason = (value as { reason?: { kind?: unknown; failure?: { message?: unknown } } }).reason
      if (reason?.kind === 'error') throw new Error(String(reason.failure?.message ?? '自检模型失败'))
      if (reason?.kind === 'aborted') throw new Error('自检被中止')
    }
  }
  return text
}

function parseProgressVerdict(text: string): Omit<ProgressVerdict, 'source'> | undefined {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown; nextFocus?: unknown }
    if (value.decision !== 'continue' && value.decision !== 'stop') return undefined
    return {
      decision: value.decision,
      reason: typeof value.reason === 'string' && value.reason.trim()
        ? value.reason.trim().slice(0, 500)
        : value.decision === 'continue' ? '任务仍在正常推进' : '自检判断任务无法继续推进',
      ...(typeof value.nextFocus === 'string' && value.nextFocus.trim()
        ? { nextFocus: value.nextFocus.trim().slice(0, 500) }
        : {}),
    }
  } catch {
    return undefined
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return String(value)
  }
}

const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'memory_search', 'memory_read', 'job_output', 'job_list', 'skill', 'get_goal',
])

function isReadOnlyTool(call: ToolCall): boolean {
  return READ_ONLY_TOOLS.has(call.name)
}

function targetOfTool(call: ToolCall): string | undefined {
  for (const key of ['file_path', 'path', 'pattern', 'command', 'objective', 'id', 'job_id', 'query']) {
    const value = call.args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 240)
  }
  const action = call.args['action']
  const name = call.args['name']
  if (typeof action === 'string' && action.trim()) {
    return `${action.trim()}${typeof name === 'string' && name.trim() ? `:${name.trim()}` : ''}`.slice(0, 240)
  }
  return undefined
}

function fileOfTool(call: ToolCall): string | undefined {
  if (call.name !== 'write' && call.name !== 'edit') return undefined
  const file = call.args['file_path']
  return typeof file === 'string' && file.trim() ? file.trim() : undefined
}

/**
 * 把模型请求里的工具结果按 recordId 恢复全文。
 *
 * 会话事件仍然只存 2000 字回显（WS 帧不能被大输出拖垮），但模型下一轮
 * 不应该只看开头。记录库是完整结果的真相源；恢复后再交给 memory 裁剪。
 */
export function expandRecordToolResults(
  messages: readonly Message[],
  records: { get(id: string): { text?: unknown; error?: unknown } | undefined } | undefined,
): Message[] {
  if (!records) return [...messages]
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool-result' || !block.recordId) return block
      const record = records.get(block.recordId)
      const full = typeof record?.text === 'string' ? record.text : undefined
      if (full === undefined) return block
      changed = true
      return {
        ...block,
        content: [{ type: 'text' as const, text: full.slice(0, 60_000) }],
      }
    })
    return changed ? { ...message, content } : message
  })
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
