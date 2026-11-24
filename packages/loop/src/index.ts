/**
 * @meng/loop —— 一轮对话的循环能力面 (seam)。**零实现**。
 *
 * 为什么循环要单独成一条缝:
 *   "循环"是策略, 不是内核。ReAct 是一种, 先规划再执行是另一种,
 *   单轮问答是第三种 (不循环)。把它们都塞进内核包, 等于宣布
 *   "本项目只有一种对话方式" —— 而 dsh 那边 loop 本来就是插件。
 *
 * 这条缝和已有五条 (fs / spill / exec / jobs / net) 同一个形状:
 *   缝里只有类型 + 一条注册函数; 谁循环、循环几次、要不要重试, 全在实现包里。
 *
 * 这条缝**不含**的判断 (留在插件, 别往下塞):
 *   · 循环几次 (maxTurns) —— 策略参数, 由实现自己收
 *   · 什么时候压缩上下文 —— 那是 compaction 插件监听 turn/ended 的事
 *   · 什么时候要审批 —— 那是 policy 插件挂在 tools/pre-execute 上的事
 *   · 兼容某厂商的怪癖 —— provider 自己负责, 循环不该知道 XML 长什么样
 *
 * 一条硬语义: **run 不抛异常表示"这一轮失败了"**。LLM 报错、被中止、
 * 到达上限, 都以 LoopEvent 的 done 结束并带上 reason —— 调用方据此写
 * turn/ended, 而不是靠 catch。只有"依赖的能力面压根没装"这种基础设施
 * 问题才 throw。
 */

import type { Ctx, Disposer } from '@meng/core'
import type { ToolCall } from '@meng/tools'
import type { Message, ReasoningEffort, ToolSpec } from '@meng/llm'

export type { ReasoningEffort } from '@meng/llm'

/** 能力面名。与包名 @meng/loop 一致 */
export const LOOP_CAPABILITY = 'loop'

/**
 * 可选的上下文/记忆能力面。
 *
 * 没装 memory 插件时 loop-basic 仍按原来的 `session.project()` 工作；装了它，
 * loop 在每次请求模型前把当前消息交给它做工具结果裁剪和超长摘要。
 */
export const MEMORY_CAPABILITY = 'memory'

export interface MemoryPrepareInput {
  sessionId: string
  model: string
  provider?: string
  system: string
  tools: ToolSpec[]
  messages: Message[]
  runId?: string
  signal?: AbortSignal
}

export interface MemoryPrepareResult {
  messages: Message[]
  compacted: boolean
  estimatedInputTokens?: number
  /** 压缩前/后的保守 token 估算；未压缩时缺省。 */
  beforeTokens?: number
  afterTokens?: number
  summarySeq?: number
  reason?: string
}

export interface MemoryStatus {
  sessionId: string
  model?: string
  contextWindow?: number
  usedTokens: number
  usedSource: 'estimate'
  thresholdRatio: number
  retainRatio: number
  thresholdTokens?: number
  compacted: boolean
  compactionCount: number
  lastCompactedAt?: number
  lastSummarySeq?: number
  canCompact: boolean
  reason?: string
}

export interface MemoryCompactInput {
  sessionId: string
  model?: string
  signal?: AbortSignal
}

export interface MemoryService {
  prepare(input: MemoryPrepareInput): Promise<MemoryPrepareResult>
  status(input: { sessionId: string; model?: string }): Promise<MemoryStatus>
  compactNow(input: MemoryCompactInput): Promise<MemoryPrepareResult>
}

export function provideMemory(ctx: Ctx, impl: MemoryService): Disposer {
  return ctx.set<MemoryService>(MEMORY_CAPABILITY, impl)
}

export function getMemory(ctx: Ctx): MemoryService | undefined {
  return ctx.get<MemoryService>(MEMORY_CAPABILITY)
}

export interface LoopAttachment {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
}

export interface ContextReset {
  /** 切换事件本身的 seq；事件流只投影它之后的新上下文。 */
  afterSeq: number
  /** 切换前只保留用户/助手文字的参考稿，不包含工具日志。 */
  reference: string
  estimatedInputTokens?: number
}

export interface RunInterruption {
  /** 被用户中断的上一轮。旧事件不删除，只给模型一条明确的修正说明。 */
  sourceRunId?: string
  mode: 'insert'
}

export interface RunInput {
  sessionId: string
  text: string
  /** 只传元数据；图片本体由 session.project 从本地附件库恢复。 */
  attachments?: LoopAttachment[]
  model?: string
  /** 仅覆盖本轮；缺省时由 llm 继承默认模型配置。 */
  reasoningEffort?: ReasoningEffort
  /** 模型切换后的新上下文边界。 */
  contextReset?: ContextReset
  /** 用户中断上一轮后立即补充指令。 */
  interruption?: RunInterruption
  /** 由调用方分配, 会写进每条事件的 data.runId —— 前端靠它给并发 run 分组 */
  runId?: string
  signal?: AbortSignal
}

/**
 * 循环对外吐的三件事。
 *
 * 刻意只有三种: 文本增量、工具调用结果、终态。
 * 中间过程 (reasoning / usage / 工具参数) 全部落进会话事件流, 不走这里 ——
 * 一条要发给浏览器的流每多一种类型, 前端就多一个分支, 而它未必需要。
 */
export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall; result: string }
  | { type: 'done'; reason: 'stop' | 'max-turns' | 'error' | 'aborted'; error?: string }

export interface LoopService {
  run(input: RunInput): AsyncIterable<LoopEvent>
}

/** 注册循环实现。返回 disposer —— 卸载时循环跟着消失, 不会留下半条 */
export function provideLoop(ctx: Ctx, impl: LoopService): Disposer {
  return ctx.set<LoopService>(LOOP_CAPABILITY, impl)
}

/** 取能力面。没装就返回 undefined —— 调用方自己决定报 503 还是降级 */
export function getLoop(ctx: Ctx): LoopService | undefined {
  return ctx.get<LoopService>(LOOP_CAPABILITY)
}
