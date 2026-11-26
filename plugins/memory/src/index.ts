/**
 * @meng/plugin-memory —— 会话记忆、检索和 Anthropic 风格上下文压缩。
 *
 * 外部是一个插件；内部拆成四个职责：
 *   · compaction.ts       先剪工具结果，再压较早轮次
 *   · store.ts            独立 SQLite FTS5 检索库
 *   · prune.ts / tokens.ts 无模型、可测试的预处理
 *   · skills/...          模型在何时搜索、如何核对原文
 *
 * 原始会话仍在 session SQLite；本插件的检索库是可丢弃、可重建的派生索引。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx, Disposer } from '@meng/core'
import { provideMemory, type MemoryCompactInput, type MemoryPrepareInput } from '@meng/loop'
import { defineInvariant } from '@meng/core'
import type { SessionEvent, SessionService } from '@meng/session'
import type { PromptService } from '@meng/prompt'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'
import { getTaskRouter } from '@meng/task-router'
import { prepareContext, statusOf, type CompactionConfig } from './compaction.ts'
import { createMemoryStore, type MemoryDoc, type MemoryStore } from './store.ts'

export const name = 'meng-plugin-memory'
export const inject = ['llm', 'session', 'tools', 'prompt']

export interface Config extends CompactionConfig {
  dir?: string
  /** 检索库位置；缺省为 <dataDir>/retrieval.db */
  retrievalFile?: string
  /** 工作区规则文件；缺省为 AGENTS.md */
  instructionFilename?: string
  /** 工作区规则上限；缺省 64KB */
  instructionMaxBytes?: number
  /** 当前任务状态注入上限；缺省 12KB */
  taskStateMaxChars?: number
}

const DEFAULT_SKILL = `# 记忆检索

当用户提到之前、上次、继续旧任务，或需要核对历史决策、错误和文件时，调用 memory_search。

- 优先搜当前会话，再搜全部会话。
- 用 memory_read 读原文核对，旧记忆不能覆盖当前文件和新要求。
- 只引用与当前任务直接相关的事实；没有找到就说没有找到。`

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const prompt = ctx.get<PromptService>('prompt')
  if (!session || !tools || !prompt) throw new Error('memory 依赖 session / tools / prompt')

  const dir = config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng'
  const store = createMemoryStore(config.retrievalFile ?? join(dir, 'retrieval.db'))
  const records = ctx.get<{ get(id: string): { id: string; tool: string; text: string; value?: unknown; presentation?: unknown } | undefined }>('records')
  const skill = readSkill()

  const indexEvent = (event: SessionEvent): void => {
    for (const doc of docsOf(event)) store.index(doc)
  }

  // 先把已有会话补进派生索引；之后每来一个事件就增量更新。
  for (const event of session.all()) indexEvent(event)
  ctx.effect(() => ctx.on('session/event', indexEvent))
  ctx.effect(() => () => store.close())

  const searchDef: ToolDef = {
    name: 'memory_search',
    group: 'memory',
    description: '搜索本机会话记忆和已压缩摘要。用户提到之前、上次、继续旧任务，或需要核对历史决策、错误、文件时使用。结果只是证据，重要事实再用 memory_read 核对。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词或短句' },
        sessionId: { type: 'string', description: '只搜某个会话；缺省搜全部会话' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'assistant', 'tool', 'summary', 'job'] },
          description: '限定文档类型',
        },
        limit: { type: 'number', description: '返回数量，默认 8，最大 50' },
      },
      required: ['query'],
    },
    async handler(args): Promise<ToolResult> {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, text: '', error: '缺参数 query' }
      const hits = store.search({
        query,
        ...(typeof args.sessionId === 'string' && args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(Array.isArray(args.kinds) ? { kinds: args.kinds.filter((x): x is string => typeof x === 'string') } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      })
      return {
        ok: true,
        text: JSON.stringify({
          query,
          count: hits.length,
          hits: hits.map((hit) => ({
            sessionId: hit.sessionId,
            seq: hit.seq,
            kind: hit.kind,
            title: hit.title,
            snippet: hit.snippet,
            score: hit.score,
            ...(hit.recordId ? { recordId: hit.recordId } : {}),
          })),
        }),
      }
    },
  }

  const readDef: ToolDef = {
    name: 'memory_read',
    group: 'memory',
    description: '读取记忆命中的原文事件；用于核对摘要和检索片段，不要凭检索片段猜原文。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id' },
        seq: { type: 'number', description: '事件序号；缺省读取最近事件' },
        recordId: { type: 'string', description: '工具结果全文记录 id；有就优先返回全文' },
        before: { type: 'number', description: '向前多读几个事件，默认 0' },
        after: { type: 'number', description: '向后多读几个事件，默认 0' },
      },
      required: ['sessionId'],
    },
    async handler(args): Promise<ToolResult> {
      const sessionId = String(args.sessionId ?? '').trim()
      if (!sessionId) return { ok: false, text: '', error: '缺参数 sessionId' }
      const events = session.read(sessionId)
      const seq = typeof args.seq === 'number' && Number.isFinite(args.seq) ? Math.floor(args.seq) : events.at(-1)?.seq
      if (seq === undefined) return { ok: false, text: '', error: '这个会话没有可读事件' }
      const at = events.findIndex((event) => event.seq === seq)
      if (at < 0) return { ok: false, text: '', error: `事件 ${seq} 不存在` }
      const before = Math.max(0, Math.min(20, Math.floor(Number(args.before ?? 0))))
      const after = Math.max(0, Math.min(20, Math.floor(Number(args.after ?? 0))))
      const selected = events.slice(Math.max(0, at - before), at + after + 1)
      const recordId = typeof args.recordId === 'string' && args.recordId ? args.recordId : undefined
      const fullRecord = recordId ? records?.get(recordId) : undefined
      const text = JSON.stringify({
        sessionId,
        events: selected,
        ...(fullRecord ? { record: fullRecord } : {}),
      })
      return { ok: true, text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n… 读取结果已截断` : text }
    },
  }

  const offTools = [ctx.effect(() => tools.register(searchDef)), ctx.effect(() => tools.register(readDef))]
  const instructionFilename = config.instructionFilename?.trim() || 'AGENTS.md'
  const instructionMaxBytes = Math.max(1024, Math.floor(config.instructionMaxBytes ?? 64 * 1024))
  const offPrompt = ctx.effect(() => prompt.section({
    id: 'memory/retrieval-skill',
    order: 150,
    render: () => skill,
  }))
  const offWorkspaceContext = ctx.effect(() => prompt.section({
    id: 'workspace/context',
    order: 130,
    render: (_ctx, input) => {
      const route = input?.sessionId ? getTaskRouter(ctx)?.current(input.sessionId) : undefined
      if (route?.workspaceContext === false) return ''
      const workspace = input?.sessionId ? session.workspaceOf(input.sessionId) : undefined
      return workspace ? workspaceBrief(workspace) : ''
    },
  }))
  const offInstructions = ctx.effect(() => prompt.section({
    id: 'workspace/agent-instructions',
    order: 140,
    render: (_ctx, input) => {
      const workspace = input?.sessionId ? session.workspaceOf(input.sessionId) : undefined
      return workspace ? loadAgentInstructions(workspace, instructionFilename, instructionMaxBytes) : ''
    },
  }))
  const taskStateMaxChars = Math.max(2000, Math.floor(config.taskStateMaxChars ?? 12_000))
  const offTaskState = ctx.effect(() => prompt.section({
    id: 'task/state',
    order: 145,
    render: (_ctx, input) => input?.sessionId ? taskStateBrief(session, input.sessionId, taskStateMaxChars) : '',
  }))
  const offMemory = ctx.effect(() => provideMemory(ctx, {
    prepare(input: MemoryPrepareInput) {
      return prepareContext(ctx, input, config)
    },
    status(input) {
      return statusOf(ctx, input, config)
    },
    async compactNow(input: MemoryCompactInput) {
      const messages = session.project(input.sessionId)
      const system = await prompt.render({ sessionId: input.sessionId })
      return prepareContext(ctx, {
        sessionId: input.sessionId,
        model: input.model ?? '',
        system,
        tools: tools.active(),
        messages,
        ...(input.signal ? { signal: input.signal } : {}),
      }, config, { force: true })
    },
  }))

  return () => {
    offMemory()
    offWorkspaceContext()
    offInstructions()
    offTaskState()
    offPrompt()
    for (const off of offTools) off()
  }
}

export const invariant = defineInvariant('@meng/plugin-memory', [
  {
    id: 'capability-present',
    run(ctx) {
      if (!ctx.get('memory')) throw new Error('memory 能力面没有注册')
      const tools = ctx.get<ToolService>('tools')
      if (!tools?.list().some((tool) => tool.name === 'memory_search')) {
        throw new Error('memory_search 工具没有注册')
      }
      if (!tools.list().some((tool) => tool.name === 'memory_read')) {
        throw new Error('memory_read 工具没有注册')
      }
    },
  },
])

/**
 * 当前任务状态必须来自会话日志的**最新快照**，不能依赖压缩摘要或旧工具调用是否
 * 还在上下文里。它每轮重新注入：Plan 模式 / 已批准计划 / Todo / Goal。
 */
function taskStateBrief(session: SessionService, sessionId: string, maxChars: number): string {
  const events = session.read(sessionId)
  let planActive = false
  let approvedPlan = ''
  let todos: Array<{ content: string; status: string }> = []
  let goal: { id: string; objective: string; phase: string; roundsStarted: number; maxGoalRounds: number; blockedReason?: string } | undefined

  for (const event of events) {
    if (event.type === 'plan/mode') {
      planActive = (event.data as { active?: unknown }).active === true
    } else if (event.type === 'plan/submitted') {
      const plan = (event.data as { plan?: unknown }).plan
      if (typeof plan === 'string' && plan.trim()) approvedPlan = plan.trim()
    } else if (event.type === 'todo/write') {
      const raw = (event.data as { todos?: unknown }).todos
      todos = Array.isArray(raw) ? raw.flatMap((item): Array<{ content: string; status: string }> => {
        if (!item || typeof item !== 'object') return []
        const row = item as { content?: unknown; status?: unknown }
        const content = typeof row.content === 'string' ? row.content.trim() : ''
        const status = typeof row.status === 'string' ? row.status : ''
        return content && status ? [{ content, status }] : []
      }) : []
    } else if (event.type === 'goal/change') {
      const raw = (event.data as { goal?: unknown }).goal
      if (!raw || typeof raw !== 'object') {
        goal = undefined
      } else {
        const row = raw as Record<string, unknown>
        if (
          typeof row.id === 'string' && typeof row.objective === 'string' && typeof row.phase === 'string' &&
          typeof row.roundsStarted === 'number' && typeof row.maxGoalRounds === 'number'
        ) {
          goal = {
            id: row.id,
            objective: row.objective,
            phase: row.phase,
            roundsStarted: row.roundsStarted,
            maxGoalRounds: row.maxGoalRounds,
            ...(typeof row.blockedReason === 'string' && row.blockedReason ? { blockedReason: row.blockedReason } : {}),
          }
        }
      }
    }
  }

  if (!planActive && !approvedPlan && todos.length === 0 && (!goal || goal.phase === 'completed')) return ''

  const lines = [
    '<task-state>',
    '这是当前任务的权威状态快照，不是新的用户请求。每轮都以此为准，不要重新规划已完成项。',
    `plan_mode: ${planActive ? 'active' : 'off'}`,
  ]
  if (approvedPlan) {
    const planLimit = Math.max(1000, Math.floor(maxChars * 0.55))
    const plan = approvedPlan.length > planLimit ? `${approvedPlan.slice(0, planLimit)}
… 计划已截断` : approvedPlan
    lines.push('approved_plan:', plan)
  }
  if (todos.length > 0) {
    const completed = todos.filter((item) => item.status === 'completed').length
    lines.push(`todo: ${completed}/${todos.length} completed`)
    for (const item of todos.slice(0, 80)) {
      lines.push(`- [${item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '>' : ' '}] ${item.content}`)
    }
    if (todos.length > 80) lines.push(`- … 还有 ${todos.length - 80} 项`)
  }
  if (goal && goal.phase !== 'completed') {
    lines.push(`goal: ${goal.phase} · ${goal.roundsStarted}/${goal.maxGoalRounds}`)
    lines.push(`goal_objective: ${goal.objective}`)
    if (goal.blockedReason) lines.push(`goal_blocked_reason: ${goal.blockedReason}`)
  }
  lines.push('下一步必须从当前未完成项继续；如果本快照与旧消息冲突，以本快照为准。')
  lines.push('</task-state>')
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[task-state 已截断]` : text
}

/**
 * 给模型一张“这个工作区有什么”的轻薄地图。
 *
 * dsh 的 agent-instructions 负责把工作区规则送进上下文；这里再补一层
 * 文件布局，避免模型明明有专用搜索工具，却先靠猜目录、反复扫全仓。
 * 只列入口级目录和 web app 文件，不读取文件内容，也不替代 glob/grep。
 */
function workspaceBrief(workspace: string): string {
  const lines = ['<workspace-context>', `cwd: ${workspace}`]
  const pkg = safeJson(join(workspace, 'package.json'))
  if (pkg && typeof pkg.name === 'string') lines.push(`package: ${pkg.name}`)

  const apps = namesOf(join(workspace, 'apps'), true)
  const packages = namesOf(join(workspace, 'packages'), true)
  const plugins = namesOf(join(workspace, 'plugins'), true)
  if (apps.length) lines.push(`apps/: ${apps.slice(0, 30).join(', ')}`)
  if (packages.length) lines.push(`packages/: ${packages.slice(0, 40).join(', ')}`)
  if (plugins.length) lines.push(`plugins/: ${plugins.slice(0, 40).join(', ')}`)

  for (const rel of ['apps/web/src/app', 'apps/server/src', 'packages']) {
    const names = namesOf(join(workspace, rel), false)
    if (names.length) lines.push(`${rel}/: ${names.slice(0, 80).join(', ')}`)
  }
  lines.push('先用这张地图选目标；修改前仍要 read 对应文件，需要内容时用 glob/grep/read。')
  lines.push('</workspace-context>')
  return lines.join('\n')
}

function safeJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function namesOf(dir: string, dirsOnly: boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && (!dirsOnly || entry.isDirectory()))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort()
  } catch {
    return []
  }
}

function loadAgentInstructions(workspace: string, filename: string, maxBytes: number): string {
  const file = join(workspace, filename)
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return ''
    const raw = readFileSync(file, 'utf8')
    const bytes = Buffer.from(raw, 'utf8')
    const body = bytes.length > maxBytes ? bytes.subarray(0, maxBytes).toString('utf8') : raw
    return [
      '<system-reminder>',
      'The following workspace instructions apply to this session. Use them as project guidance. More specific user instructions and higher-priority system instructions take precedence.',
      '',
      `Instructions from: ${file}`,
      '',
      body.trim().replace(/<\/system-reminder>/gi, '<\\/system-reminder>'),
      ...(bytes.length > maxBytes ? ['', `[AGENTS.md 已截断到 ${maxBytes} 字节]`] : []),
      '</system-reminder>',
    ].join('\n')
  } catch (error) {
    console.warn(`[meng] AGENTS.md 读取失败 (${file}): ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function readSkill(): string {
  try {
    const raw = readFileSync(new URL('../skills/memory-retrieval/SKILL.md', import.meta.url), 'utf8')
    // 目录里的 frontmatter 是技能发现元数据，注入系统提示时只保留正文。
    return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
  } catch {
    return DEFAULT_SKILL
  }
}

function docsOf(event: SessionEvent): MemoryDoc[] {
  const data = (event.data ?? {}) as Record<string, unknown>
  const base = { sessionId: event.sessionId, seq: event.seq, at: event.at }
  if (event.type === 'turn/started') {
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    if (!text) return []
    return [{ ...base, kind: 'user', title: '用户消息', text }]
  }
  if (event.type === 'llm/completed') {
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    if (!text) return []
    return [{ ...base, kind: 'assistant', title: '助手回复', text }]
  }
  if (event.type === 'tool/completed') {
    const text = typeof data.result === 'string'
      ? data.result
      : typeof data.text === 'string'
        ? data.text
        : ''
    if (!text.trim()) return []
    return [{
      ...base,
      kind: 'tool',
      title: typeof data.tool === 'string' ? `工具 · ${data.tool}` : '工具结果',
      text: text.trim(),
      ...(typeof data.recordId === 'string' && data.recordId ? { recordId: data.recordId } : {}),
    }]
  }
  if (event.type === 'context/compacted') {
    const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
    if (!summary) return []
    return [{ ...base, kind: 'summary', title: '上下文摘要', text: summary }]
  }
  if (event.type === 'job/completed') {
    const detail = typeof data.detail === 'string' ? data.detail : ''
    const label = typeof data.label === 'string' ? data.label : ''
    const text = [label, detail].filter(Boolean).join(' — ')
    if (!text) return []
    return [{ ...base, kind: 'job', title: '后台任务', text }]
  }
  return []
}
