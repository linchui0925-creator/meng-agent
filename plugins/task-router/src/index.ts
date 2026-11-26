import type { Ctx, Disposer } from '@meng/core'
import type { PromptService } from '@meng/prompt'
import type { SessionEvent, SessionService } from '@meng/session'
import {
  classifyTask,
  isTaskRoute,
  provideTaskRouter,
  toolAllowedByRoute,
  type DeliveryMode,
  type TaskRoute,
  type TaskRouterService,
} from '@meng/task-router'
import type { PreDecision, ToolCall, ToolDef, ToolService } from '@meng/tools'

export const name = 'meng-plugin-task-router'
export const inject = ['session', 'tools', 'prompt']

export interface Config {
  smallEditMaxTools?: number
  requireTodoForMulti?: boolean
}

const PLAN_REQUEST_RE = /先.{0,8}(方案|计划|规划)|先规划|先调研|plan\s*mode|只出方案/

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const prompt = ctx.get<PromptService>('prompt')
  if (!session || !tools || !prompt) throw new Error('task-router 需要 session / tools / prompt')

  const smallEditMaxTools = Math.max(1, Math.floor(config.smallEditMaxTools ?? 8))
  const requireTodoForMulti = config.requireTodoForMulti !== false
  const offs: Disposer[] = []

  const classify = (input: { sessionId: string; text: string; attachmentCount?: number }): TaskRoute => {
    const events = session.read(input.sessionId)
    const state = sessionSignals(events)
    const base = classifyTask({
      text: input.text,
      ...(input.attachmentCount === undefined ? {} : { attachmentCount: input.attachmentCount }),
      ...(state.planActive ? { planActive: true } : {}),
      ...(state.goalActive ? { goalActive: true } : {}),
    })
    const planRequested = PLAN_REQUEST_RE.test(input.text)
    const internalSubagent = input.sessionId.startsWith('sess-')
    const route = internalSubagent
      ? { ...base, requireTodo: false, reason: `${base.reason} 内部子智能体由角色权限约束，不套主会话的 Todo 前置。` }
      : (planRequested || state.planActive) && base.mode === 'multi'
        ? { ...base, requireTodo: false, reason: `${base.reason} 当前先完成方案审批，Todo 等计划批准后再建。` }
        : base
    return route.mode === 'edit'
      ? { ...route, maxToolCalls: smallEditMaxTools }
      : route
  }

  const service: TaskRouterService = {
    classify,
    current(sessionId) {
      const events = session.read(sessionId)
      const turn = latestTurn(events)
      if (!turn) return undefined
      const stored = (turn.data as { taskRoute?: unknown }).taskRoute
      if (isTaskRoute(stored)) return stored
      const data = turn.data as { text?: unknown; attachments?: unknown }
      return classify({
        sessionId,
        text: typeof data.text === 'string' ? data.text : '',
        ...(Array.isArray(data.attachments) ? { attachmentCount: data.attachments.length } : {}),
      })
    },
  }

  offs.push(provideTaskRouter(ctx, service))

  offs.push(prompt.section({
    id: 'task/route',
    order: 105,
    render: (_ctx, input) => {
      const route = input?.sessionId ? service.current(input.sessionId) : undefined
      return route ? renderRoute(route) : ''
    },
  }))

  offs.push(ctx.on('tools/pre-execute', (call: ToolCall, def: ToolDef, next: () => Promise<PreDecision>) => {
    if (!call.sessionId) return next()
    const route = service.current(call.sessionId)
    if (!route) return next()

    if (!toolAllowedByRoute(def, route)) {
      return deny(`当前是${modeLabel(route.mode)}，工具 ${call.name} 不在本轮允许范围内。${route.reason}`)
    }

    if (route.requireTodo && requireTodoForMulti && tools.list().some((tool) => tool.name === 'todo_write')) {
      const hasTodo = sessionHasTodo(session.read(call.sessionId))
      if (!hasTodo && !allowedBeforeTodo(call)) {
        return deny('这是多步骤任务，但当前会话还没有 Todo。先调用 todo_write 提交完整清单；如需先确认技能，可先调用 skill 读取。')
      }
    }

    if (route.maxToolCalls !== undefined) {
      const events = session.read(call.sessionId)
      const turn = latestTurn(events)
      const used = turn
        ? events.filter((event) => event.seq > turn.seq && event.type === 'tool/called').length
        : 0
      if (used >= route.maxToolCalls) {
        return deny(
          `本轮=${modeLabel(route.mode)}，工具预算 ${route.maxToolCalls} 次已用完。` +
          '停止继续探索，基于现有结果完成并汇报；如果确实需要更多步骤，请明确说明还缺什么。',
        )
      }
    }

    return next()
  }, { priority: 110 }))

  return () => {
    for (const off of offs.reverse()) off()
  }
}

function deny(reason: string): PreDecision {
  return { allow: false, reason }
}

function allowedBeforeTodo(call: ToolCall): boolean {
  if (call.name === 'todo_write' || call.name === 'skill') return true
  if (call.name !== 'read') return false
  const file = call.args.file_path
  return typeof file === 'string' && /(?:^|[\\/])skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(file)
}

function latestTurn(events: readonly SessionEvent[]): SessionEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/started') return events[i]
  }
  return undefined
}

function sessionSignals(events: readonly SessionEvent[]): { planActive: boolean; goalActive: boolean } {
  let planActive = false
  let goalActive = false
  for (const event of events) {
    if (event.type === 'plan/mode') {
      planActive = (event.data as { active?: unknown }).active === true
    }
    if (event.type === 'goal/change') {
      const goal = (event.data as { goal?: unknown }).goal
      if (!goal || typeof goal !== 'object') {
        goalActive = false
      } else {
        const phase = (goal as { phase?: unknown }).phase
        goalActive = phase === 'active' || phase === 'paused' || phase === 'blocked'
      }
    }
  }
  return { planActive, goalActive }
}

function sessionHasTodo(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'todo/write') continue
    const todos = (event.data as { todos?: unknown }).todos
    return Array.isArray(todos) && todos.length > 0
  }
  return false
}

function modeLabel(mode: DeliveryMode): string {
  if (mode === 'answer') return '简答'
  if (mode === 'edit') return '小改'
  if (mode === 'multi') return '多步任务'
  return '长期任务'
}

function renderRoute(route: TaskRoute): string {
  const lines = [
    '<task-route>',
    `mode: ${route.mode}`,
    `reason: ${route.reason}`,
    `workspace_context: ${route.workspaceContext ? 'on' : 'off'}`,
  ]
  if (route.mode === 'answer') {
    lines.push('本轮不挂任何工具，也不要扫描仓库；直接给出清晰答案。')
  } else if (route.mode === 'edit') {
    lines.push(`本轮是小改，最多 ${route.maxToolCalls ?? 8} 次工具调用。`)
    lines.push('只使用 read / grep / glob / edit / write，测试用 bash；不要全仓扫描，不要创建 Todo 或 Goal。')
    lines.push('先用最短路径定位目标，再做最小修改，最后跑针对性验证。')
  } else if (route.mode === 'multi') {
    lines.push('这是多步骤任务。先读命中的 skill（如有），再提交 todo_write 清单，然后按当前步骤使用最少必要工具。')
    lines.push('不要创建 Goal 或 Ralph；独立旁路任务可主动交给 Explorer / Reviewer / Worker 子智能体。')
    lines.push('完成前回到 Todo，逐项核对结果和验证证据。')
  } else {
    lines.push('这是长期任务。先 get_goal；没有目标就 create_goal，并维护 Todo。')
    lines.push('独立旁路任务可用 subagent，长命令放后台并用 job_output 收结果。')
    lines.push('每一轮都从 Goal 和 Todo 的未完成项继续，不要重复已完成工作。')
  }
  lines.push('</task-route>')
  return lines.join('\n')
}
