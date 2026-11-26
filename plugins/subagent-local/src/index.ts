import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Ctx, Disposer } from '@meng/core'
import type { LoopService } from '@meng/loop'
import type { PreDecision, ToolCall, ToolDef } from '@meng/tools'
import type { SessionEvent, SessionService } from '@meng/session'
import {
  provideSubagent,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRole,
  type SubagentRun,
  type SubagentService,
} from '@meng/subagent'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-subagent-local'
export const inject = ['session', 'loop']

export interface SubagentConfig {
  maxConcurrent?: number
  maxResultChars?: number
}

interface InternalRun extends SubagentRun {
  parentSessionId: string
  controller: AbortController
  settled: boolean
  role: SubagentRole
  writeScope: string[]
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function latestModel(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'llm/completed') continue
    const model = (event.data as { model?: unknown }).model
    if (typeof model === 'string' && model.trim()) return model
  }
  return undefined
}

function finalText(session: SessionService, sessionId: string): string {
  const events = session.read(sessionId)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'llm/completed') continue
    const data = event.data as { text?: unknown; toolCalls?: unknown }
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    if (text && (!Array.isArray(data.toolCalls) || data.toolCalls.length === 0)) return text
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'llm/completed') continue
    const text = (event.data as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}

function subagentPrompt(role: SubagentRole, objective: string, writeScope: readonly string[]): string {
  const common = [
    '<subagent_task>',
    `角色：${role}`,
    `目标：${objective}`,
    '你是隔离的子智能体，不继承父对话。只完成这个目标，不扩展范围。',
    '不要调用 subagent / ralph，也不要创建长期 goal。',
  ]
  const roleLines = role === 'explorer'
    ? [
        '只读探索：使用 read / grep / glob / skill 定位事实和文件。',
        '不要修改文件，不要运行会改状态的命令。',
        '报告格式：结论、证据路径、未确定项、建议父代理下一步。',
      ]
    : role === 'reviewer'
      ? [
          '独立审查：检查目标相关的改动、边界、回归风险和验收缺口。',
          '只读，不修改文件；发现问题必须给出文件/行为证据和严重度。',
          '报告格式：问题清单、证据、建议修复、尚未运行的验证。',
        ]
      : [
          `只允许在 write_scope 内写：${writeScope.join(', ')}。`,
          '不要修改范围外文件；不要做顺手重构。',
          '实施后运行与范围相关的验证，并报告改动文件、测试命令和剩余风险。',
        ]
  return [...common, ...roleLines, '</subagent_task>'].join('\n')
}

function excludedToolsForRole(role: SubagentRole): string[] {
  const common = ['subagent', 'ralph', 'create_goal', 'update_goal']
  if (role === 'explorer' || role === 'reviewer') {
    return [...common, 'write', 'edit', 'bash', 'todo_write', 'enter_plan_mode', 'exit_plan_mode']
  }
  return common
}

function normalizeScope(workspace: string | undefined, scopes: readonly string[]): string[] {
  const root = resolve(workspace ?? process.cwd())
  return scopes.map((scope) => {
    const abs = resolve(root, scope)
    const rel = relative(root, abs)
    if (!rel) return '.'
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`writeScope 越界: ${scope}`)
    return rel.split(sep).join('/')
  })
}

function withinScope(scopes: readonly string[], file: string, workspace: string | undefined): boolean {
  const root = resolve(workspace ?? process.cwd())
  const target = relative(root, resolve(root, file)).split(sep).join('/')
  if (target.startsWith('..') || isAbsolute(target)) return false
  return scopes.some((scope) => scope === '.' || target === scope || target.startsWith(`${scope}/`))
}

function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) =>
    left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  ))
}

export function apply(ctx: Ctx, config: SubagentConfig = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const loop = ctx.get<LoopService>('loop')
  if (!session || !loop) throw new Error('subagent-local 需要 session / loop')
  const maxConcurrent = Math.max(1, Math.floor(config.maxConcurrent ?? 4))
  const maxResultChars = Math.max(2000, Math.floor(config.maxResultChars ?? 16_000))
  const runs = new Map<string, InternalRun>()
  const byParent = new Map<string, Set<string>>()
  const childScopes = new Map<string, { role: SubagentRole; writeScope: string[]; workspace?: string }>()
  let active = 0
  const hasOverlappingWorker = (parentSessionId: string, scopes: readonly string[]): boolean => {
    for (const id of byParent.get(parentSessionId) ?? []) {
      const run = runs.get(id)
      if (!run || run.settled || run.role !== 'worker') continue
      if (scopesOverlap(run.writeScope, scopes)) return true
    }
    return false
  }

  const service: SubagentService = {
    start(input: SubagentRequest): SubagentRun {
      if (active >= maxConcurrent) throw new Error(`子智能体并发已达上限 ${maxConcurrent}`)
      const objective = input.objective.trim()
      if (!objective) throw new Error('子智能体 objective 不能为空')
      if (!input.parentSessionId) throw new Error('子智能体缺少 parentSessionId')
      const id = `sub-${randomUUID().slice(0, 8)}`
      const sessionId = `sess-${id}`
      const startedAt = Date.now()
      const controller = new AbortController()
      const parentSignal = input.signal
      if (parentSignal) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason)
        else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true })
      }
      const workspace = input.workspace ?? session.workspaceOf(input.parentSessionId)
      const model = input.model ?? latestModel(session.read(input.parentSessionId))
      const role = input.role ?? 'explorer'
      const writeScope = input.writeScope ?? []
      if (role === 'worker' && writeScope.length === 0) throw new Error('worker 必须提供 writeScope')
      const normalizedScope = role === 'worker' ? normalizeScope(workspace, writeScope) : []
      if (role === 'worker' && hasOverlappingWorker(input.parentSessionId, normalizedScope)) {
        throw new Error('同一父会话已有重叠写范围的 Worker 在运行；请拆成互不重叠的目录或串行执行')
      }

      session.append(sessionId, 'session/created', {
        title: `子智能体 · ${input.title?.trim() || objective.slice(0, 40)}`,
        ...(workspace ? { workspace } : {}),
      })
      session.append(input.parentSessionId, 'subagent/started', {
        id,
        childSessionId: sessionId,
        title: input.title?.trim() || objective.slice(0, 80),
        objective: objective.slice(0, 1000),
        role,
        ...(normalizedScope.length ? { writeScope: normalizedScope } : {}),
        startedAt,
      })
      const parentSet = byParent.get(input.parentSessionId) ?? new Set<string>()
      parentSet.add(id)
      byParent.set(input.parentSessionId, parentSet)
      active++
      childScopes.set(sessionId, { role, writeScope: normalizedScope, ...(workspace ? { workspace } : {}) })

      const done = (async (): Promise<SubagentResult> => {
        let status: SubagentResult['status'] = 'failed'
        let error: string | undefined
        try {
          for await (const event of loop.run({
            sessionId,
            text: subagentPrompt(role, objective, normalizedScope),
            ...(model ? { model } : {}),
            ...(input.runId ? { runId: `${input.runId}-${id}` } : { runId: id }),
            signal: controller.signal,
            excludeTools: excludedToolsForRole(role),
          })) {
            if (event.type === 'done') {
              status = event.reason === 'stop' ? 'completed' : event.reason === 'aborted' ? 'aborted' : 'failed'
              if (event.reason === 'error') error = event.error ?? '子智能体执行失败'
            }
          }
        } catch (err) {
          status = controller.signal.aborted ? 'aborted' : 'failed'
          error = errText(err)
        } finally {
          childScopes.delete(sessionId)
        }
        const finishedAt = Date.now()
        const summary = finalText(session, sessionId).slice(0, maxResultChars)
          || (status === 'completed' ? '子智能体完成，但没有返回文字报告' : (error ?? '子智能体未返回报告'))
        const result: SubagentResult = {
          id,
          sessionId,
          status,
          summary,
          ...(error ? { error } : {}),
          role,
          ...(normalizedScope.length ? { writeScope: normalizedScope } : {}),
          startedAt,
          finishedAt,
        }
        const run = runs.get(id)
        if (run) run.settled = true
        active = Math.max(0, active - 1)
        session.append(input.parentSessionId, 'subagent/completed', {
          id,
          childSessionId: sessionId,
          status,
          summary: summary.slice(0, 2000),
          role,
          ...(normalizedScope.length ? { writeScope: normalizedScope } : {}),
          finishedAt,
          ...(error ? { error } : {}),
        })
        return result
      })()

      const run: InternalRun = {
        id,
        sessionId,
        parentSessionId: input.parentSessionId,
        startedAt,
        done,
        settled: false,
        controller,
        role,
        writeScope: normalizedScope,
        cancel() {
          controller.abort('cancelled by parent')
        },
      }
      runs.set(id, run)
      return run
    },
    get(id) {
      return runs.get(id)
    },
    list(parentSessionId) {
      if (!parentSessionId) return [...runs.values()]
      return [...(byParent.get(parentSessionId) ?? [])].flatMap((id) => {
        const run = runs.get(id)
        return run ? [run] : []
      })
    },
  }

  const offService = provideSubagent(ctx, service)
  const offGuard = ctx.on('tools/pre-execute', (call: ToolCall, def: ToolDef, next: () => Promise<PreDecision>): Promise<PreDecision> | PreDecision => {
    const scope = call.sessionId ? childScopes.get(call.sessionId) : undefined
    if (!scope) return next()
    if (scope.role !== 'worker') {
      if (def.mutates === true || def.name === 'bash') {
        return { allow: false, reason: `${scope.role} 子智能体只读，不能调用 ${def.name}` }
      }
      return next()
    }
    if (def.name === 'write' || def.name === 'edit') {
      const file = typeof call.args.file_path === 'string' ? call.args.file_path : typeof call.args.path === 'string' ? call.args.path : ''
      if (!file || !withinScope(scope.writeScope, file, scope.workspace)) {
        return { allow: false, reason: `Worker 只能写 write_scope：${scope.writeScope.join(', ')}` }
      }
    }
    return next()
  }, { priority: 120 })
  const webOffs: Disposer[] = []
  let boundWeb: WebService | undefined
  const bindWeb = (web: WebService): void => {
    if (boundWeb === web) return
    boundWeb = web
    webOffs.push(web.op('subagent.status', (payload) => {
      const parentSessionId = String(payload.sessionId ?? '')
      if (!parentSessionId) throw new HttpError('bad-request', '缺 sessionId')
      return {
        runs: service.list(parentSessionId).map((run) => ({
          id: run.id,
          sessionId: run.sessionId,
          role: run.role ?? 'explorer',
          ...((run.writeScope ?? []).length ? { writeScope: run.writeScope } : {}),
          startedAt: run.startedAt,
          running: !runs.get(run.id)?.settled,
        })),
      }
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
    offGuard()
    offService()
  }
}
