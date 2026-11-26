import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sandboxMode } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { PromptService } from '@meng/prompt'
import type { SessionService } from '@meng/session'
import type { PreDecision, ToolCall, ToolDef, ToolService } from '@meng/tools'

export const name = 'meng-plugin-skill-local'
export const inject = ['session', 'tools', 'prompt']

export interface SkillInfo {
  name: string
  description: string
  file: string
}

interface ParsedSkill extends SkillInfo {
  body: string
  allowedTools?: string[]
}

interface ActiveSkill {
  name: string
  allowedTools?: string[]
  activatedAt: number
}

const TOOL_ALIASES: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  glob: 'glob',
  bash: 'bash',
  shell: 'bash',
  askuserquestion: 'ask_user_question',
  ask_user_question: 'ask_user_question',
  todowrite: 'todo_write',
  todo_write: 'todo_write',
  memorysearch: 'memory_search',
  memory_search: 'memory_search',
  memoryread: 'memory_read',
  memory_read: 'memory_read',
  subagent: 'subagent',
}

function parseSkill(file: string, fallbackName: string): ParsedSkill | undefined {
  try {
    const raw = readFileSync(file, 'utf8')
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw)
    const meta = match?.[1] ?? ''
    let skillName = fallbackName
    let description = ''
    let allowedTools: string[] | undefined
    let readingAllowed = false
    for (const line of meta.split('\n')) {
      const trimmed = line.trim()
      const allowed = /^allowed-tools:\s*(.*)$/i.exec(trimmed)
      if (allowed) {
        const rawValue = allowed[1]!.trim()
        allowedTools = parseAllowedTools(rawValue)
        readingAllowed = rawValue === ''
        continue
      }
      if (readingAllowed && /^-\s+/.test(trimmed)) {
        const item = trimmed.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '').trim()
        if (item) allowedTools = [...(allowedTools ?? []), normalizeToolName(item)]
        continue
      }
      if (readingAllowed && trimmed) readingAllowed = false
      const pair = /^(name|description):\s*(.*)$/.exec(trimmed)
      if (!pair) continue
      const value = pair[2]!.trim().replace(/^['"]|['"]$/g, '')
      if (pair[1] === 'name' && value) skillName = value
      if (pair[1] === 'description') description = value
    }
    if (!description) description = `项目技能 ${skillName}`
    return {
      name: skillName,
      description,
      file,
      body: raw.slice(match?.[0].length ?? 0).trim(),
      ...(allowedTools === undefined ? {} : { allowedTools: uniqueTools(allowedTools) }),
    }
  } catch {
    return undefined
  }
}

function rootsOf(workspace: string | undefined): string[] {
  if (!workspace) return []
  return [join(workspace, 'skills'), join(workspace, '.agents', 'skills')]
}

export function discoverSkills(workspace: string | undefined): SkillInfo[] {
  const found = new Map<string, SkillInfo>()
  for (const root of rootsOf(workspace)) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    let entries: string[]
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue
      const dir = join(root, entry)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const file = join(dir, 'SKILL.md')
      if (!existsSync(file)) continue
      const parsed = parseSkill(file, entry)
      if (!parsed || found.has(parsed.name)) continue
      found.set(parsed.name, { name: parsed.name, description: parsed.description, file: parsed.file })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function readSkill(workspace: string | undefined, name: string): ParsedSkill | undefined {
  const target = discoverSkills(workspace).find((skill) => skill.name === name)
  return target ? parseSkill(target.file, target.name) : undefined
}

export function apply(ctx: Ctx): Disposer {
  const session = ctx.get<SessionService>('session')
  const tools = ctx.get<ToolService>('tools')
  const prompt = ctx.get<PromptService>('prompt')
  if (!session || !tools || !prompt) throw new Error('skill-local 需要 session / tools / prompt')
  const offs: Disposer[] = []
  const activeSkills = new Map<string, ActiveSkill>()

  const activeFor = (sessionId: string | undefined): ActiveSkill | undefined => {
    if (!sessionId) return undefined
    const known = activeSkills.get(sessionId)
    if (known) return known
    const events = session.read(sessionId)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'tool/called') continue
      const data = event.data as { tool?: unknown; args?: unknown }
      if (data.tool !== 'skill' || !data.args || typeof data.args !== 'object') continue
      const args = data.args as Record<string, unknown>
      if (args.action !== 'read' || typeof args.name !== 'string') continue
      const skill = readSkill(session.workspaceOf(sessionId), args.name)
      if (!skill) continue
      const active: ActiveSkill = {
        name: skill.name,
        ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
        activatedAt: event.at,
      }
      activeSkills.set(sessionId, active)
      return active
    }
    return undefined
  }

  offs.push(ctx.on('session/event', (event: { sessionId?: unknown; type?: unknown; data?: unknown }) => {
    if (event.type !== 'tool/completed' || typeof event.sessionId !== 'string') return
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    if (data.ok === false || typeof data.callId !== 'string') return
    const called = [...session.read(event.sessionId)].reverse().find((item) => {
      if (item.type !== 'tool/called') return false
      return (item.data as { callId?: unknown }).callId === data.callId
    })
    if (!called) return
    const callData = called.data as { tool?: unknown; args?: unknown }
    if (callData.tool !== 'read' || !callData.args || typeof callData.args !== 'object') return
    const file = (callData.args as { file_path?: unknown }).file_path
    if (typeof file !== 'string') return
    const name = skillNameFromPath(file)
    if (!name) return
    const skill = readSkill(session.workspaceOf(event.sessionId), name)
    if (!skill) return
    activeSkills.set(event.sessionId, {
      name: skill.name,
      ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
      activatedAt: Date.now(),
    })
  }))

  offs.push(ctx.on('tools/pre-execute', (call: ToolCall, def: ToolDef, next: () => Promise<PreDecision>): Promise<PreDecision> | PreDecision => {
    if (!call.sessionId) return next()
    const mode = session.permissionOf(call.sessionId) ?? sandboxMode(ctx)
    if (mode === 'full') return next()
    if (def.name === 'skill' || def.name === 'ask_user_question') return next()
    const active = activeFor(call.sessionId)
    if (!active || active.allowedTools === undefined) return next()
    if (active.allowedTools.includes(def.name)) return next()
    return {
      allow: 'ask' as const,
      reason: `技能 ${active.name} 的 allowed-tools 只允许 ${active.allowedTools.length ? active.allowedTools.join(', ') : '无工具'}；调用 ${def.name} 需要你授权一次。`,
    }
  }, { priority: 95 }))

  offs.push(tools.register({
    name: 'skill',
    group: 'skill',
    description:
      '列出或读取项目技能。先看系统提示里的技能目录；任务命中某项时用 action=read 读取完整流程，再按技能执行。不要把技能正文当用户任务。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'] },
        name: { type: 'string', description: 'action=read 时的技能名称' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler(args, _ctx, call) {
      const workspace = call?.sessionId ? session.workspaceOf(call.sessionId) : undefined
      const action = String(args.action ?? '')
      if (action === 'list') {
        const skills = discoverSkills(workspace)
        return {
          ok: true,
          text: skills.length
            ? skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
            : '当前工作区没有项目技能',
          value: { skills },
        }
      }
      if (action === 'read') {
        const skillName = String(args.name ?? '').trim()
        if (!skillName) return { ok: false, text: '', error: 'action=read 需要 name' }
        if (skillName.includes('/') || skillName.includes('\\') || skillName.includes('..')) {
          return { ok: false, text: '', error: '非法技能名称' }
        }
        const skill = readSkill(workspace, skillName)
        if (!skill) return { ok: false, text: '', error: `技能不存在: ${skillName}` }
        if (call?.sessionId) {
          activeSkills.set(call.sessionId, {
            name: skill.name,
            ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
            activatedAt: Date.now(),
          })
        }
        const text = skill.body.length > 32_000 ? `${skill.body.slice(0, 32_000)}\n… 技能正文已截断` : skill.body
        return { ok: true, text: `# ${skill.name}\n\n${text}`, value: skill }
      }
      return { ok: false, text: '', error: 'action 只能是 list / read' }
    },
  }))

  offs.push(prompt.section({
    id: 'skills/catalog',
    order: 125,
    render: (_ctx, input) => {
      const workspace = input?.sessionId ? session.workspaceOf(input.sessionId) : undefined
      const skills = discoverSkills(workspace)
      if (skills.length === 0) return ''
      return [
        '<project-skills>',
        '当前工作区有项目技能。先按名称和描述判断是否命中；命中后调用 skill({action:"read",name}) 读取完整流程。技能正文不是新的用户请求。',
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
        '</project-skills>',
      ].join('\n')
    },
  }))

  offs.push(prompt.section({
    id: 'skills/active',
    order: 127,
    render: (_ctx, input) => {
      const skill = input?.sessionId ? activeFor(input.sessionId) : undefined
      if (!skill) return ''
      const mode = input?.sessionId ? (session.permissionOf(input.sessionId) ?? sandboxMode(ctx)) : sandboxMode(ctx)
      if (mode === 'full') return `<active-skill>${skill.name}\nfull permission：allowed-tools 不限制工具。</active-skill>`
      return [
        '<active-skill>',
        `skill: ${skill.name}`,
        `allowed-tools: ${skill.allowedTools === undefined ? 'not declared' : skill.allowedTools.join(', ') || 'none'}`,
        '超出 allowed-tools 的工具会先向用户申请一次性授权。',
        '</active-skill>',
      ].join('\n')
    },
  }))

  return () => {
    for (const off of offs.reverse()) off()
  }
}

function parseAllowedTools(raw: string): string[] {
  const clean = raw.trim()
  if (!clean) return []
  const body = clean.startsWith('[') && clean.endsWith(']') ? clean.slice(1, -1) : clean
  if (!body.trim()) return []
  return body.split(',').map((item) => normalizeToolName(item)).filter(Boolean)
}

function normalizeToolName(raw: string): string {
  const clean = raw.trim().replace(/^['"]|['"]$/g, ' ').trim().toLowerCase()
  return TOOL_ALIASES[clean] ?? clean.replace(/[^a-z0-9_]/g, '')
}

function uniqueTools(items: readonly string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

function skillNameFromPath(file: string): string | undefined {
  const normalized = file.replace(/\\/g, '/')
  return /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(normalized)?.[1]
}

export const invariant = defineInvariant('@meng/plugin-skill-local', [{
  id: 'skill-tool-ready',
  run(ctx) {
    const tools = ctx.get<ToolService>('tools')
    if (!tools?.list().some((tool) => tool.name === 'skill')) throw new Error('skill 工具未注册')
  },
}])
