import type { Ctx, Disposer } from '@meng/core'
import type { QuestionsService } from '@meng/questions'
import type { SessionEvent, SessionService } from '@meng/session'
import type { PreDecision, ToolCall, ToolDef, ToolService } from '@meng/tools'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-plan-mode'
export const inject = ['session', 'tools', 'questions']

export interface PlanState {
  active: boolean
  plan?: string
  submittedAt?: number
}

export function foldPlan(events: readonly SessionEvent[]): PlanState {
  let state: PlanState = { active: false }
  for (const event of events) {
    if (event.type === 'plan/mode') {
      const data = event.data as { active?: unknown }
      state = { ...state, active: data.active === true }
    }
    if (event.type === 'plan/submitted') {
      const data = event.data as { plan?: unknown }
      const plan = typeof data.plan === 'string' ? data.plan.trim() : ''
      state = { ...state, ...(plan ? { plan } : {}), submittedAt: event.at }
    }
  }
  return state
}

function planOf(session: SessionService, sessionId: string): PlanState {
  return foldPlan(session.read(sessionId))
}

function appendMode(session: SessionService, sessionId: string, active: boolean): void {
  session.append(sessionId, 'plan/mode', { active })
}

export function apply(ctx: Ctx): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const questions = ctx.get<QuestionsService>('questions')
  const prompt = ctx.get<{ section(section: { id: string; order: number; render: (ctx: Ctx, input?: { sessionId?: string }) => string }): Disposer }>('prompt')
  if (!session || !tools || !questions || !prompt) throw new Error('plan-mode 需要 session / tools / questions / prompt')

  const offs: Disposer[] = []
  const planAllowedMutations = new Set(['enter_plan_mode', 'exit_plan_mode'])
  offs.push(ctx.on('tools/pre-execute', (call: ToolCall, def: ToolDef, next: () => Promise<PreDecision>) => {
    if (!call.sessionId || !def.mutates || planAllowedMutations.has(call.name)) return next()
    const state = planOf(session, call.sessionId)
    if (!state.active) return next()
    return {
      allow: false as const,
      reason: 'Plan 模式只允许调研和提交计划；该工具会修改状态或文件。先调用 exit_plan_mode 并取得用户批准。',
    }
  }, { priority: 95 }))

  offs.push(tools.register({
    name: 'enter_plan_mode',
    group: 'plan',
    description: '进入 Plan 模式。明确要求先规划、先出方案，或用户消息以 /plan 开头时先调用它；进入后只调研，不修改文件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    mutates: true,
    handler(_args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: '缺少会话归属' }
      appendMode(session, sessionId, true)
      return {
        ok: true,
        text: '已进入 Plan 模式。先完成只读调研，再调用 exit_plan_mode 提交完整方案；批准前不要写入、编辑或执行会改文件的命令。',
      }
    },
  }))

  offs.push(tools.register({
    name: 'exit_plan_mode',
    group: 'plan',
    description: '提交完整实施计划并请求用户批准。计划必须包含目标、成功标准、涉及文件/模块、步骤、测试与验收、风险和假设。',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '完整 Markdown 计划，以一级标题开头' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    mutates: true,
    timeoutMs: 300_000,
    async handler(args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: '缺少会话归属' }
      if (!planOf(session, sessionId).active) return { ok: false, text: '', error: '当前不在 Plan 模式' }
      const plan = String(args.plan ?? '').trim()
      if (!plan) return { ok: false, text: '', error: '计划正文不能为空' }
      const resolution = await questions.ask({
        kind: 'approval',
        title: '批准计划',
        body: plan,
        choices: [
          { key: 'approve', label: '批准并执行', description: '退出 Plan 模式，按这份计划继续' },
          { key: 'reject', label: '暂不批准', description: '继续讨论或修改计划' },
        ],
        toolName: 'exit_plan_mode',
        callId: call?.id,
        sessionId,
        runId: call?.runId,
        signal: call?.signal,
      })
      if (resolution.outcome === 'approved' || resolution.answer === 'approve') {
        appendMode(session, sessionId, false)
        session.append(sessionId, 'plan/submitted', { plan })
        return { ok: true, text: '计划已获用户批准。现在可以按计划执行；每完成一个阶段要验证结果，不重新调研已经确认的事实。' }
      }
      if (resolution.outcome === 'timeout') return { ok: false, text: '', error: '计划审批超时，仍在 Plan 模式' }
      if (resolution.outcome === 'aborted') return { ok: false, text: '', error: '计划审批被中止，仍在 Plan 模式' }
      const note = resolution.note ? `\n用户意见: ${resolution.note}` : ''
      return { ok: false, text: '', error: `用户暂未批准计划。继续留在 Plan 模式并修改方案。${note}` }
    },
  }))

  offs.push(prompt.section({
    id: 'plan/mode',
    order: 118,
    render: (_ctx, input) => {
      if (!input?.sessionId || !planOf(session, input.sessionId).active) return ''
      return [
        '你当前处于 Plan 模式。',
        '目标是把实施计划做完整并提交用户审批，不是开始实现。',
        '只做只读调研、搜索、分析和不会改文件的检查；不要写文件、改配置、运行会改文件的命令或提交代码。',
        '优先沿用现有结构和能力，不发明第二套机制。',
        '计划必须包含：目标与成功标准；受影响的文件/模块；按子系统分组的改动；公共接口、数据和事件变化；失败模式与边界；测试和验收步骤；明确假设。',
        '调研完成且方案可执行时，调用 exit_plan_mode，把完整 Markdown 计划作为唯一参数。不要用普通回复代替计划提交。',
      ].join('\n')
    },
  }))

  const webOffs: Disposer[] = []
  let boundWeb: WebService | undefined
  const bindWeb = (web: WebService): void => {
    if (boundWeb === web) return
    boundWeb = web
    webOffs.push(web.op('plan.status', (payload) => {
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) return { active: false }
      return planOf(session, sessionId)
    }))
    webOffs.push(web.op('plan.set', (payload) => {
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
      appendMode(session, sessionId, payload.active === true)
      return planOf(session, sessionId)
    }))
  }
  const existingWeb = ctx.get<WebService>('web')
  if (existingWeb) bindWeb(existingWeb)
  const offWebRegistered = ctx.on('capability/registered', (capability: string, value: unknown) => {
    if (capability === 'web') bindWeb(value as WebService)
  })
  const offWebUnregistered = ctx.on('capability/unregistered', (capability: string) => {
    if (capability !== 'web') return
    for (const off of webOffs.splice(0).reverse()) off()
    boundWeb = undefined
  })

  return () => {
    offWebUnregistered()
    offWebRegistered()
    for (const off of webOffs.splice(0).reverse()) off()
    for (const off of offs.reverse()) off()
  }
}
