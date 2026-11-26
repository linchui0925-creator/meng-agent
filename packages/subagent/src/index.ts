/**
 * @meng/subagent — 子智能体能力面。
 *
 * 这层只定义"如何启动一个隔离的子运行"，不规定它由进程内、线程还是远程
 * provider 实现。工具、Ralph 和其他编排插件都只认这条缝。
 */
import type { Ctx, Disposer } from '@meng/core'

export const SUBAGENT_CAPABILITY = 'subagent'

export type SubagentStatus = 'completed' | 'failed' | 'aborted' | 'budget-limited'
export type SubagentRole = 'explorer' | 'reviewer' | 'worker'

export interface SubagentRequest {
  parentSessionId: string
  objective: string
  title?: string
  role?: SubagentRole
  /** Worker 可写的路径范围；相对工作区。Explorer/Reviewer 不需要。 */
  writeScope?: string[]
  workspace?: string
  model?: string
  runId?: string
  signal?: AbortSignal
}

export interface SubagentResult {
  id: string
  sessionId: string
  status: SubagentStatus
  summary: string
  error?: string
  role?: SubagentRole
  writeScope?: string[]
  startedAt: number
  finishedAt: number
}

export interface SubagentRun {
  id: string
  sessionId: string
  role?: SubagentRole
  writeScope?: string[]
  startedAt: number
  done: Promise<SubagentResult>
  cancel(): void
}

export interface SubagentService {
  start(input: SubagentRequest): SubagentRun
  get(id: string): SubagentRun | undefined
  list(parentSessionId?: string): SubagentRun[]
}

export function provideSubagent(ctx: Ctx, service: SubagentService): Disposer {
  return ctx.set(SUBAGENT_CAPABILITY, service)
}

export function getSubagent(ctx: Ctx): SubagentService | undefined {
  return ctx.get<SubagentService>(SUBAGENT_CAPABILITY)
}
