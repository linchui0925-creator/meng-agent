import { randomUUID } from 'node:crypto'

import type { Ctx, Disposer } from '@meng/core'
import type { LoopService } from '@meng/loop'
import type { SessionEvent, SessionService } from '@meng/session'
import type { ToolService } from '@meng/tools'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-goal'
export const inject = ['session', 'tools', 'loop']

export type GoalPhase = 'active' | 'paused' | 'completed' | 'blocked'

export interface Goal {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  roundsStarted: number
  maxGoalRounds: number
  createdAt: number
  updatedAt: number
  blockedReason?: string
}

export interface GoalConfig {
  autoContinue?: boolean
  maxGoalRounds?: number
  defaultModel?: string
}

export function foldGoal(events: readonly SessionEvent[]): Goal | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'goal/change') continue
    const data = event.data as { goal?: unknown }
    return normalizeGoal(data.goal)
  }
  return undefined
}

function normalizeGoal(value: unknown): Goal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const g = value as Partial<Goal>
  if (typeof g.id !== 'string' || !g.id) return undefined
  if (typeof g.objective !== 'string' || !g.objective.trim()) return undefined
  if (!Number.isInteger(g.revision) || (g.revision ?? 0) < 1) return undefined
  if (!Number.isInteger(g.roundsStarted) || (g.roundsStarted ?? -1) < 0) return undefined
  if (!Number.isInteger(g.maxGoalRounds) || (g.maxGoalRounds ?? 0) < 1) return undefined
  if (!['active', 'paused', 'completed', 'blocked'].includes(String(g.phase))) return undefined
  return {
    id: g.id,
    revision: Number(g.revision),
    objective: g.objective.trim(),
    phase: g.phase as GoalPhase,
    roundsStarted: Number(g.roundsStarted),
    maxGoalRounds: Number(g.maxGoalRounds),
    createdAt: Number(g.createdAt ?? Date.now()),
    updatedAt: Number(g.updatedAt ?? Date.now()),
    ...(typeof g.blockedReason === 'string' && g.blockedReason.trim() ? { blockedReason: g.blockedReason.trim() } : {}),
  }
}

function goalOf(session: SessionService, sessionId: string): Goal | undefined {
  return foldGoal(session.read(sessionId))
}

function writeGoal(session: SessionService, sessionId: string, goal: Goal | undefined): void {
  session.append(sessionId, 'goal/change', { goal: goal ?? null })
}

function modelOf(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'llm/completed') continue
    const model = (event.data as { model?: unknown }).model
    if (typeof model === 'string' && model.trim()) return model
  }
  return undefined
}

function planActive(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'plan/mode') continue
    return (event.data as { active?: unknown }).active === true
  }
  return false
}

export function apply(ctx: Ctx, config: GoalConfig = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const loop = ctx.get<LoopService>('loop')
  const prompt = ctx.get<{ section(section: { id: string; order: number; render: () => string }): Disposer }>('prompt')
  if (!session || !tools || !loop || !prompt) throw new Error('goal 需要 session / tools / loop / prompt')

  const sessionService: SessionService = session
  const loopService: LoopService = loop
  const defaultRounds = Math.max(1, Math.floor(config.maxGoalRounds ?? 12))
  const autoContinue = config.autoContinue !== false
  const running = new Set<string>()
  const scheduled = new Set<string>()
  const offs: Disposer[] = []

  const resultOf = (goal: Goal | undefined) => goal ? { goal } : { goal: null }

  offs.push(tools.register({
    name: 'get_goal',
    group: 'goal',
    description: '读取当前会话的长期目标、阶段、轮次和阻塞原因。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler(_args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: '缺少会话归属' }
      const goal = goalOf(sessionService, sessionId)
      return { ok: true, text: JSON.stringify(resultOf(goal), null, 2), value: resultOf(goal) }
    },
  }))

  offs.push(tools.register({
    name: 'create_goal',
    group: 'goal',
    description: '为一个需要多轮持续完成的目标创建长期 Goal。普通单轮任务不要创建；同一会话最多一个当前目标。',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: '完整、可验收的目标' },
        maxGoalRounds: { type: 'number', description: '最多自动续轮数；缺省使用部署上限' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    mutates: true,
    handler(args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: '缺少会话归属' }
      const current = goalOf(sessionService, sessionId)
      if (current && current.phase !== 'completed') {
        return { ok: false, text: '', error: `当前已有目标 (${current.id})，先完成、暂停或阻塞它` }
      }
      const objective = String(args.objective ?? '').trim()
      if (!objective) return { ok: false, text: '', error: 'objective 不能为空' }
      const cap = typeof args.maxGoalRounds === 'number' && Number.isFinite(args.maxGoalRounds)
        ? Math.max(1, Math.min(defaultRounds, Math.floor(args.maxGoalRounds)))
        : defaultRounds
      const now = Date.now()
      const goal: Goal = {
        id: randomUUID().slice(0, 8),
        revision: 1,
        objective,
        phase: 'active',
        roundsStarted: 0,
        maxGoalRounds: cap,
        createdAt: now,
        updatedAt: now,
      }
      writeGoal(sessionService, sessionId, goal)
      return { ok: true, text: `长期目标已创建并启用：${objective}\n当前轮次 0/${cap}。`, value: { goal } }
    },
  }))

  offs.push(tools.register({
    name: 'update_goal',
    group: 'goal',
    description: '修改、暂停、恢复、完成或阻塞当前长期目标。先 get_goal 并使用精确 id/revision。完成必须基于实际验证证据。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        revision: { type: 'number' },
        action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
        objective: { type: 'string' },
        maxGoalRounds: { type: 'number' },
        blockedReason: { type: 'string' },
      },
      required: ['goalId', 'revision', 'action'],
      additionalProperties: false,
    },
    mutates: true,
    handler(args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: '缺少会话归属' }
      const current = goalOf(sessionService, sessionId)
      if (!current) return { ok: false, text: '', error: '当前没有目标' }
      if (current.id !== String(args.goalId ?? '') || current.revision !== Number(args.revision)) {
        return { ok: false, text: '', error: '目标 id 或 revision 已过期，先重新 get_goal' }
      }
      const action = String(args.action ?? '')
      let phase = current.phase
      let objective = current.objective
      let maxGoalRounds = current.maxGoalRounds
      let blockedReason = current.blockedReason
      if (action === 'edit') {
        const next = String(args.objective ?? '').trim()
        if (!next) return { ok: false, text: '', error: 'edit 需要 non-empty objective' }
        objective = next
        if (typeof args.maxGoalRounds === 'number') maxGoalRounds = Math.max(1, Math.min(defaultRounds, Math.floor(args.maxGoalRounds)))
      } else if (action === 'pause') {
        phase = 'paused'
        blockedReason = undefined
      } else if (action === 'resume') {
        if (current.roundsStarted >= current.maxGoalRounds) return { ok: false, text: '', error: '目标轮次预算已耗尽' }
        phase = 'active'
        blockedReason = undefined
      } else if (action === 'complete') {
        phase = 'completed'
        blockedReason = undefined
      } else if (action === 'blocked') {
        const reason = String(args.blockedReason ?? '').trim()
        if (!reason) return { ok: false, text: '', error: 'blocked 需要具体原因' }
        phase = 'blocked'
        blockedReason = reason
      } else {
        return { ok: false, text: '', error: `非法 action: ${action}` }
      }
      const goal: Goal = {
        ...current,
        revision: current.revision + 1,
        objective,
        phase,
        maxGoalRounds,
        updatedAt: Date.now(),
        ...(blockedReason ? { blockedReason } : {}),
      }
      writeGoal(sessionService, sessionId, goal)
      return { ok: true, text: `目标已更新：${goal.phase}。`, value: { goal } }
    },
  }))

  offs.push(prompt.section({
    id: 'tool/goal',
    order: 124,
    render: () => [
      '只为一个需要多轮持续完成、可验收的目标创建 Goal；普通单轮工作不要创建。',
      '同一会话最多一个当前 Goal。先 get_goal，再使用精确 id/revision 调 update_goal。',
      '每轮都要基于工作区和测试结果推进；完成前必须有证据。仅当同一阻塞条件持续三次且无法推进时才标记 blocked。',
      '用户暂停或停止后不要自行恢复；只有用户明确要求继续时才 update_goal resume。',
    ].join('\n'),
  }))

  async function runGoalRound(sessionId: string): Promise<void> {
    if (running.has(sessionId)) return
    const current = goalOf(sessionService, sessionId)
    const events = sessionService.read(sessionId)
    if (!current || current.phase !== 'active' || planActive(events)) return
    if (current.roundsStarted >= current.maxGoalRounds) {
      writeGoal(sessionService, sessionId, {
        ...current,
        revision: current.revision + 1,
        phase: 'blocked',
        blockedReason: `达到最大自动轮次 ${current.maxGoalRounds}`,
        updatedAt: Date.now(),
      })
      return
    }
    const next: Goal = {
      ...current,
      revision: current.revision + 1,
      roundsStarted: current.roundsStarted + 1,
      updatedAt: Date.now(),
    }
    writeGoal(sessionService, sessionId, next)
    running.add(sessionId)
    try {
      const model = modelOf(events) ?? config.defaultModel
      for await (const _ of loopService.run({
        sessionId,
        text: [
          `<goal_round id="${next.id}" round="${next.roundsStarted}/${next.maxGoalRounds}">`,
          `目标：${next.objective}`,
          '这是同一会话的自动续轮。不要从头重做；先检查工作区、已有改动和测试结果，继续完成尚未满足的验收条件。',
          '有实际进展就继续；目标全部达成时调用 update_goal complete。只有同一阻塞条件持续且无法推进时才调用 update_goal blocked。',
          '</goal_round>',
        ].join('\n'),
        ...(model ? { model } : {}),
        runId: `goal-${next.id}-${next.roundsStarted}`,
        excludeTools: ['create_goal'],
      })) void _
    } catch (error) {
      const latest = goalOf(sessionService, sessionId)
      if (latest?.phase === 'active') {
        writeGoal(sessionService, sessionId, {
          ...latest,
          revision: latest.revision + 1,
          phase: 'paused',
          blockedReason: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        })
      }
    } finally {
      running.delete(sessionId)
      const latest = goalOf(sessionService, sessionId)
      if (latest?.phase === 'active') schedule(sessionId)
    }
  }

  function schedule(sessionId: string): void {
    if (!autoContinue || scheduled.has(sessionId) || running.has(sessionId)) return
    scheduled.add(sessionId)
    queueMicrotask(() => {
      scheduled.delete(sessionId)
      void runGoalRound(sessionId)
    })
  }

  offs.push(ctx.on('session/event', (event: SessionEvent) => {
    if (event.type !== 'turn/ended' || event.sessionId.startsWith('sess-')) return
    const goal = goalOf(sessionService, event.sessionId)
    if (!goal) return
    const reason = String((event.data as { reason?: unknown }).reason ?? 'stop')
    if (reason === 'aborted' || reason === 'error') {
      if (goal.phase === 'active') {
        writeGoal(sessionService, event.sessionId, {
          ...goal,
          revision: goal.revision + 1,
          phase: 'paused',
          blockedReason: reason === 'aborted' ? '用户停止了执行' : '上一轮执行失败',
          updatedAt: Date.now(),
        })
      }
      return
    }
    if (goal.phase === 'active') schedule(event.sessionId)
  }))

  const webOffs: Disposer[] = []
  let boundWeb: WebService | undefined
  const bindWeb = (web: WebService): void => {
    if (boundWeb === web) return
    boundWeb = web
    webOffs.push(web.op('goal.status', (payload) => {
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
      return resultOf(goalOf(sessionService, sessionId))
    }))
    webOffs.push(web.op('goal.control', (payload) => {
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
      const goal = goalOf(sessionService, sessionId)
      if (!goal) throw new HttpError('not-found', '当前没有目标', 404)
      const action = String(payload.action ?? '')
      let phase = goal.phase
      if (action === 'pause') phase = 'paused'
      else if (action === 'resume') phase = 'active'
      else if (action === 'complete') phase = 'completed'
      else throw new HttpError('bad-request', 'action 只能是 pause / resume / complete')
      const next: Goal = {
        ...goal,
        revision: goal.revision + 1,
        phase,
        updatedAt: Date.now(),
        ...(action === 'resume' ? { blockedReason: undefined } : {}),
      }
      writeGoal(sessionService, sessionId, next)
      if (phase === 'active') schedule(sessionId)
      return { goal: next }
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
