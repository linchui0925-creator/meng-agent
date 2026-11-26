import type { Ctx, Disposer } from '@meng/core'
import { getSubagent } from '@meng/subagent'
import type { ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-ralph'
export const inject = ['tools', 'subagent']

export interface RalphConfig {
  maxRounds?: number
  maxReportChars?: number
}

type RalphStatus = 'continue' | 'complete' | 'blocked'

interface RalphReport {
  status: RalphStatus
  summary: string
  evidence: string[]
  nextSteps: string[]
  blocker?: string
}

function parseReport(raw: string): RalphReport | undefined {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>
    const status = String(value.status ?? '')
    if (status !== 'continue' && status !== 'complete' && status !== 'blocked') return undefined
    const summary = String(value.summary ?? '').trim()
    if (!summary) return undefined
    const list = (input: unknown): string[] => Array.isArray(input)
      ? input.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
      : []
    return {
      status,
      summary,
      evidence: list(value.evidence),
      nextSteps: list(value.nextSteps),
      ...(typeof value.blocker === 'string' && value.blocker.trim() ? { blocker: value.blocker.trim() } : {}),
    }
  } catch {
    return undefined
  }
}

export function apply(ctx: Ctx, config: RalphConfig = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  const subagent = getSubagent(ctx)
  if (!tools || !subagent) throw new Error('tool-ralph 需要 tools / subagent')
  const maxRounds = Math.max(1, Math.floor(config.maxRounds ?? 12))
  const maxReportChars = Math.max(2000, Math.floor(config.maxReportChars ?? 12_000))
  const offs: Disposer[] = []

  offs.push(tools.register({
    name: 'ralph',
    group: 'ralph',
    description:
      '仅在用户明确要求 Ralph 循环或全新子智能体迭代执行时使用。每轮新开子智能体，只传固定目标、轮次和上一轮交接；完成/阻塞来自子智能体自报。',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: '不可变的完整目标与验收标准' },
        maxRounds: { type: 'number', description: `最大轮数，部署上限 ${maxRounds}` },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    mutates: true,
    timeoutMs: 30 * 60_000,
    async handler(args, _ctx, call) {
      const parentSessionId = call?.sessionId
      if (!parentSessionId) return { ok: false, text: '', error: 'ralph 需要父会话' }
      const objective = String(args.objective ?? '').trim()
      if (!objective) return { ok: false, text: '', error: 'objective 不能为空' }
      const requested = typeof args.maxRounds === 'number' && Number.isFinite(args.maxRounds)
        ? Math.floor(args.maxRounds)
        : maxRounds
      const rounds = Math.max(1, Math.min(maxRounds, requested))
      let previous: RalphReport | undefined
      let last: { round: number; report: RalphReport; sessionId: string } | undefined

      for (let round = 1; round <= rounds; round++) {
        if (call?.signal?.aborted) return { ok: false, text: '', error: 'Ralph 被中止' }
        const handoff = previous
          ? JSON.stringify({
              round: round - 1,
              status: previous.status,
              summary: previous.summary,
              evidence: previous.evidence,
              nextSteps: previous.nextSteps,
              blocker: previous.blocker,
            }, null, 2)
          : '（第一轮，没有上一轮交接）'
        let run
        try {
          run = subagent.start({
            parentSessionId,
            title: `Ralph 第 ${round} 轮`,
            objective: [
              '<ralph_round>',
              `不可变目标：${objective}`,
              `当前轮次：${round}/${rounds}`,
              '工作区是跨轮长期记忆；你是一个全新子智能体，没有父对话历史。',
              '先检查工作区当前状态，再继续未完成工作。不要调用 subagent 或 ralph。',
              '结束时只输出一个 JSON 对象，格式：',
              '{"status":"continue|complete|blocked","summary":"本轮实际完成什么","evidence":["验证证据"],"nextSteps":["下一轮要做什么"],"blocker":"仅 blocked 时填写"}',
              '只有实际完成目标并通过验证才输出 complete；同一外部阻塞无法推进才输出 blocked。',
              `上一轮交接：\n${handoff}`,
              '</ralph_round>',
            ].join('\n'),
            ...(call?.runId ? { runId: `${call.runId}-ralph-${round}` } : {}),
            ...(call?.signal ? { signal: call.signal } : {}),
          })
        } catch (error) {
          return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
        }
        const result = await run.done
        if (result.status !== 'completed') {
          return { ok: false, text: '', error: `Ralph 第 ${round} 轮失败: ${result.error ?? result.summary}` }
        }
        const report = parseReport(result.summary)
        if (!report) {
          return {
            ok: false,
            text: '',
            error: `Ralph 第 ${round} 轮没有返回合法结构化交接: ${result.summary.slice(0, 1000)}`,
          }
        }
        previous = report
        last = { round, report, sessionId: result.sessionId }
        if (report.status === 'complete' || report.status === 'blocked') break
      }

      if (!last || !previous) return { ok: false, text: '', error: 'Ralph 没有产生结果' }
      const terminal = previous.status === 'continue' ? 'budget-limited' : previous.status
      const envelope = {
        status: terminal,
        roundsStarted: last.round,
        finalSessionId: last.sessionId,
        report: previous,
      }
      const text = JSON.stringify(envelope, null, 2).slice(0, maxReportChars)
      if (terminal === 'blocked') return { ok: true, text, value: envelope }
      return { ok: true, text, value: envelope }
    },
  }))

  offs.push(ctx.get<{ section(section: { id: string; order: number; render: () => string }): Disposer }>('prompt')?.section({
    id: 'tool/ralph',
    order: 129,
    render: () => [
      '只有在用户明确说 Ralph 循环、全新智能体迭代或等价要求时才使用 ralph。',
      'Ralph 每一轮都没有父对话记忆，工作区是唯一跨轮记忆；目标必须固定、可验收。',
      '普通长任务优先使用 Goal；一两次独立委派优先使用 subagent。',
    ].join('\n'),
  }) ?? (() => undefined))

  return () => {
    for (const off of offs.reverse()) off()
  }
}
