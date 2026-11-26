import type { Ctx } from '@meng/core'

export const TASK_ROUTER_CAPABILITY = 'task-router'

export type DeliveryMode = 'answer' | 'edit' | 'multi' | 'long'

export type TaskToolPolicy =
  | { kind: 'none' }
  | { kind: 'only'; names: readonly string[] }
  | { kind: 'except-groups'; groups: readonly string[] }
  | { kind: 'all' }

export interface TaskRoute {
  mode: DeliveryMode
  confidence: 'high' | 'medium' | 'low'
  reason: string
  workspaceContext: boolean
  requireTodo: boolean
  toolPolicy: TaskToolPolicy
  maxToolCalls?: number
}

export interface TaskRouteInput {
  sessionId: string
  text: string
  attachmentCount?: number
}

export interface TaskRouterService {
  /** 根据当前消息与会话状态生成路线；纯本地规则，不额外调用模型。 */
  classify(input: TaskRouteInput): TaskRoute
  /** 读取最近一轮已路由结果。没有用户轮次时返回 undefined。 */
  current(sessionId: string): TaskRoute | undefined
}

export function provideTaskRouter(ctx: Ctx, service: TaskRouterService) {
  return ctx.set<TaskRouterService>(TASK_ROUTER_CAPABILITY, service)
}

export function getTaskRouter(ctx: Ctx): TaskRouterService | undefined {
  return ctx.get<TaskRouterService>(TASK_ROUTER_CAPABILITY)
}

const EDIT_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep'] as const
const LONG_ONLY_GROUPS = ['goal', 'ralph'] as const

/**
 * 同一份分类逻辑既供插件使用，也供回归测试直接调用。
 *
 * 这里故意不调用小模型：分类发生在首 Token 之前，额外一次网络请求会把
 * “让简单问题更快”直接变成“多等一次模型”。规则只做保守判断，不确定时
 * 落到 multi，而不是把需要动手的请求误判成简答。
 */
export function classifyTask(input: {
  text: string
  attachmentCount?: number
  planActive?: boolean
  goalActive?: boolean
}): TaskRoute {
  const text = input.text.trim()
  const compact = text.replace(/\s+/g, ' ')
  const lower = compact.toLowerCase()

  if (input.goalActive) {
    return route('long', 'high', '会话已有进行中的长期目标，继续沿用 Goal 路线。')
  }

  if (isExplicitLong(lower)) {
    return route('long', 'high', '用户明确要求持续推进、定时、后台或跨轮工作。')
  }

  if (input.planActive) {
    return route('multi', 'high', '会话处于 Plan 模式，先调研并提交计划，不进入单轮直答。')
  }

  if (isDirectAnswer(compact, lower, input.attachmentCount ?? 0)) {
    return route('answer', 'high', '这是解释、判断或日常问答，不需要读取仓库或调用工具。')
  }

  if (isSmallEdit(compact, lower)) {
    return {
      ...route('edit', 'medium', '这是边界明确的小改动，只开放文件读取、修改和测试所需工具。'),
      maxToolCalls: 8,
    }
  }

  return route('multi', 'medium', '这是需要调查和执行的开发任务，但不像跨轮长期目标。')
}

function route(
  mode: DeliveryMode,
  confidence: TaskRoute['confidence'],
  reason: string,
): TaskRoute {
  if (mode === 'answer') {
    return {
      mode,
      confidence,
      reason,
      workspaceContext: false,
      requireTodo: false,
      toolPolicy: { kind: 'none' },
      maxToolCalls: 0,
    }
  }
  if (mode === 'edit') {
    return {
      mode,
      confidence,
      reason,
      workspaceContext: true,
      requireTodo: false,
      toolPolicy: { kind: 'only', names: EDIT_TOOLS },
    }
  }
  if (mode === 'multi') {
    return {
      mode,
      confidence,
      reason,
      workspaceContext: true,
      requireTodo: true,
      // 多步任务保留插件工坊等后续工具；只收起长期编排工具，等真正进入长期任务再开放。
      toolPolicy: { kind: 'except-groups', groups: LONG_ONLY_GROUPS },
    }
  }
  return {
    mode: 'long',
    confidence,
    reason,
    workspaceContext: true,
    requireTodo: true,
    toolPolicy: { kind: 'all' },
  }
}

const LONG_RE = /长期|持续|每天|每日|定时|周期|定期|跨天|接下来.{0,8}天|长期目标|后台任务|持续监控|一直做|不断推进|goal|ralph/
const DIRECT_RE = /^(你好|您好|hi\b|hello\b|嗨|谢谢|感谢|解释一下|解释下|说明一下|说明下|什么是|是什么|为什么|怎么理解|如何理解|有什么区别|区别是什么|能否|可以吗|你觉得|帮我判断|用大白话|简单说)/
const QUESTION_RE = /[?？]\s*$|[吗呢]\s*$|是什么|为什么|怎么样|如何理解|区别|是否|怎么|如何/
const IMPERATIVE_RE = /帮我|给我|替我|请你|麻烦你|你帮我|需要你|把.+?(?:改|修|加|删|做|弄|换|移|隐藏|显示)|(?:改|修|加|删|做|弄|换|移)(?:一下|下)/
const ACTION_RE = /改|修|加|删|创建|实现|开发|运行|执行|测试|检查|排查|读取|打开|安装|发布|提交|更新|优化|重构|迁移|替换|接入|适配|写一个|做一个|生成|修复|调整|增加|移除|处理|看一下|看看/
const SMALL_RE = /只改|只做|仅改|仅做|小改|微调|一行|文案|颜色|间距|字体|图标|按钮|标题|提示语|占位符|placeholder|tooltip|样式|居中|隐藏|显示|大小|边距|圆角|布局/
const BROAD_RE = /完整|全量|所有|整个|全仓|架构|重构|插件|发布|市场|多端|桌面端|移动端|前后端|数据库|接口|api|长任务|测试用例|迁移|适配|接入|安装|下载|部署/
const EXPLICIT_TARGET_RE = /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|`[^`]+`|[\w-]+\.(?:tsx?|jsx?|css|json|ya?ml|md)/

function isExplicitLong(text: string): boolean {
  return LONG_RE.test(text)
}

function isDirectAnswer(text: string, lower: string, attachmentCount: number): boolean {
  if (!text || attachmentCount > 0) return false
  if (text.length > 360) return false
  if (IMPERATIVE_RE.test(lower)) return false
  if (DIRECT_RE.test(lower)) return true
  if (!QUESTION_RE.test(text)) return false
  // 问“怎么装/为什么报错”通常先要解释；“帮我把/给我改”才是动手任务。
  return true
}

function isSmallEdit(text: string, lower: string): boolean {
  if (!ACTION_RE.test(lower)) return false
  if (BROAD_RE.test(lower)) return false
  if (EXPLICIT_TARGET_RE.test(text)) return true
  return SMALL_RE.test(lower) && text.length <= 260
}

export function toolAllowedByRoute(tool: { name: string; group?: string }, route: TaskRoute): boolean {
  const policy = route.toolPolicy
  if (policy.kind === 'none') return false
  if (policy.kind === 'only') return policy.names.includes(tool.name)
  if (policy.kind === 'except-groups') return !policy.groups.includes(tool.group ?? 'core')
  return true
}

export function filterToolsByRoute<T extends { name: string; group?: string }>(tools: readonly T[], route: TaskRoute): T[] {
  return tools.filter((tool) => toolAllowedByRoute(tool, route))
}

export function isTaskRoute(value: unknown): value is TaskRoute {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (row.mode !== 'answer' && row.mode !== 'edit' && row.mode !== 'multi' && row.mode !== 'long') return false
  if (row.confidence !== 'high' && row.confidence !== 'medium' && row.confidence !== 'low') return false
  if (typeof row.reason !== 'string' || typeof row.workspaceContext !== 'boolean' || typeof row.requireTodo !== 'boolean') return false
  const policy = row.toolPolicy
  if (!policy || typeof policy !== 'object') return false
  const kind = (policy as { kind?: unknown }).kind
  if (kind !== 'none' && kind !== 'only' && kind !== 'except-groups' && kind !== 'all') return false
  if (row.maxToolCalls !== undefined && (typeof row.maxToolCalls !== 'number' || row.maxToolCalls < 0)) return false
  return true
}
