import type { Ctx, Disposer } from '@meng/core'
import type { TurnStopInput, TurnStopVerdict } from '@meng/loop'
import { hasValidationAfterLastWrite, snapshotCurrentRun } from '@meng/run-state'
import type { SessionEvent, SessionService } from '@meng/session'
import { getTaskRouter, type TaskRoute } from '@meng/task-router'
import type { ToolService } from '@meng/tools'

export const name = 'meng-plugin-completion-gate'
export const inject = ['session', 'task-router']

const COMPLETION_CLAIM_RE = /完成|已完成|已修复|已实现|已更新|改好|搞定|通过|成功|done|completed|fixed|implemented/i

export function evaluateCompletion(input: {
  events: readonly SessionEvent[]
  route: TaskRoute | undefined
  text: string
  hasTodoTool: boolean
}): TurnStopVerdict {
  const { events, route, text, hasTodoTool } = input
  if (route?.mode === 'answer') return { stop: true }

  const plan = planState(events)
  if (plan.active && !plan.submittedAfterActivation) {
    return {
      stop: false,
      source: 'plan',
      message: '当前还在 Plan 模式，计划尚未通过 exit_plan_mode 提交。先调研并提交完整计划；不要直接结束。',
    }
  }

  if (route?.requireTodo && hasTodoTool) {
    const todos = latestTodos(events)
    if (!todos.eventFound) {
      return {
        stop: false,
        source: 'todo',
        message: '这是多步骤任务，但还没有 Todo。先调用 todo_write 提交完整清单，再继续执行和结束。',
      }
    }
    const unfinished = todos.items.filter((item) => item.status !== 'completed')
    if (unfinished.length > 0) {
      return {
        stop: false,
        source: 'todo',
        message: `Todo 还有 ${unfinished.length} 项未完成：${unfinished.slice(0, 5).map((item) => item.content).join('；')}。完成并验证后在 Todo 中标记 completed。`,
      }
    }
  }

  if (COMPLETION_CLAIM_RE.test(text)) {
    const snapshot = snapshotCurrentRun(events)
    if (snapshot && snapshot.modifiedFiles.length > 0 && !hasValidationAfterLastWrite(snapshot)) {
      return {
        stop: false,
        source: 'validation',
        message: `已经修改 ${snapshot.modifiedFiles.join(', ')}，但最后一次修改后没有可用的验证证据。代码改动先跑相关测试/类型检查/构建；非代码文件至少重新读取核对。`,
      }
    }
  }

  return { stop: true }
}

export function apply(ctx: Ctx): Disposer {
  const session = ctx.get<SessionService>('session')
  const router = getTaskRouter(ctx)
  const tools = ctx.get<ToolService>('tools')
  if (!session || !router) throw new Error('completion-gate 需要 session / task-router')

  return ctx.on('turn/stopping', (input: TurnStopInput, next: () => Promise<TurnStopVerdict>): TurnStopVerdict | Promise<TurnStopVerdict> => {
    const events = session.read(input.sessionId)
    const route = router.current(input.sessionId)
    const hasTodoTool = tools?.list().some((tool) => tool.name === 'todo_write') ?? false
    const verdict = evaluateCompletion({ events, route, text: input.text, hasTodoTool })
    if (!verdict.stop) return verdict
    return next()
  }, { priority: 100 })
}

function planState(events: readonly SessionEvent[]): { active: boolean; submittedAfterActivation: boolean } {
  let active = false
  let submittedAfterActivation = false
  for (const event of events) {
    if (event.type === 'plan/mode') {
      active = (event.data as { active?: unknown }).active === true
      if (active) submittedAfterActivation = false
    } else if (event.type === 'plan/submitted' && active) {
      submittedAfterActivation = true
    }
  }
  return { active, submittedAfterActivation }
}

function latestTodos(events: readonly SessionEvent[]): {
  eventFound: boolean
  items: Array<{ content: string; status: string }>
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'todo/write') continue
    const raw = (event.data as { todos?: unknown }).todos
    const items = Array.isArray(raw) ? raw.flatMap((item): Array<{ content: string; status: string }> => {
      if (!item || typeof item !== 'object') return []
      const row = item as { content?: unknown; status?: unknown }
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      const status = typeof row.status === 'string' ? row.status : ''
      return content && status ? [{ content, status }] : []
    }) : []
    return { eventFound: true, items }
  }
  return { eventFound: false, items: [] }
}
