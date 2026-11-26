import type { Ctx, Disposer } from '@meng/core'
import type { SessionEvent, SessionService } from '@meng/session'
import type { ToolService } from '@meng/tools'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-tool-todo'
export const inject = ['session', 'tools']

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface TodoConfig {
  allowParallelInProgress?: boolean
}

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])

export function foldTodos(events: readonly SessionEvent[]): TodoItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'todo/write') continue
    const data = event.data as { todos?: unknown }
    if (!Array.isArray(data.todos)) return []
    return data.todos.flatMap((item): TodoItem[] => {
      if (!item || typeof item !== 'object') return []
      const row = item as { content?: unknown; status?: unknown }
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      const status = row.status as TodoStatus
      return content && STATUSES.has(status) ? [{ content, status }] : []
    })
  }
  return []
}

export function apply(ctx: Ctx, config: TodoConfig = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const prompt = ctx.get<{ section(section: { id: string; order: number; render: () => string }): Disposer }>('prompt')
  if (!session || !tools || !prompt) throw new Error('tool-todo 需要 session / tools / prompt')
  const allowParallel = config.allowParallelInProgress === true
  const offs: Disposer[] = []

  offs.push(tools.register({
    name: 'todo_write',
    group: 'todo',
    description:
      '创建或整体替换当前任务的待办清单。多步骤任务批准方案后使用；每次提交完整列表，状态只能是 pending / in_progress / completed。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '一步可独立完成并验证的任务' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    mutates: true,
    handler(args, _ctx, call) {
      const sessionId = call?.sessionId
      if (!sessionId) return { ok: false, text: '', error: 'todo_write 需要会话归属' }
      const raw = Array.isArray(args.todos) ? args.todos : []
      const todos: TodoItem[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        if (!item || typeof item !== 'object') return { ok: false, text: '', error: 'todo 必须是对象' }
        const row = item as { content?: unknown; status?: unknown }
        const content = String(row.content ?? '').trim()
        const status = String(row.status ?? '') as TodoStatus
        if (!content) return { ok: false, text: '', error: 'content 不能为空' }
        if (seen.has(content)) return { ok: false, text: '', error: `重复任务: ${content}` }
        if (!STATUSES.has(status)) return { ok: false, text: '', error: `非法状态: ${status}` }
        seen.add(content)
        todos.push({ content, status })
      }
      const running = todos.filter((item) => item.status === 'in_progress').length
      if (!allowParallel && running > 1) {
        return { ok: false, text: '', error: `最多一个任务可以处于进行中，实际 ${running} 个` }
      }
      session.append(sessionId, 'todo/write', { todos })
      const pending = todos.filter((item) => item.status === 'pending').length
      const completed = todos.filter((item) => item.status === 'completed').length
      return {
        ok: true,
        text: `Todo 已更新：${pending} 待处理，${running} 进行中，${completed} 已完成。\n当前清单：\n${todos.map((item) => `- [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '>' : ' '}] ${item.content}`).join('\n')}`,
        value: { todos, counts: { pending, inProgress: running, completed } },
      }
    },
  }))

  offs.push(prompt.section({
    id: 'tool/todo',
    order: 126,
    render: () => [
      '多步骤开发、迁移、审查或排障任务在方案明确后使用 todo_write。',
      '每次提交完整清单，不能只更新一项；最多一个任务处于 in_progress。',
      '开始一步前标为进行中，验证通过后立即标为完成。简单一问一答不要创建 Todo。',
      'Todo 是执行锚点：下一轮先看未完成项，不要重新规划已经确认的工作。',
    ].join('\n'),
  }))

  const webOffs: Disposer[] = []
  let boundWeb: WebService | undefined
  const bindWeb = (web: WebService): void => {
    if (boundWeb === web) return
    boundWeb = web
    webOffs.push(web.op('todo.status', (payload) => {
      const sessionId = String(payload.sessionId ?? '')
      if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
      return { todos: foldTodos(session.read(sessionId)) }
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
