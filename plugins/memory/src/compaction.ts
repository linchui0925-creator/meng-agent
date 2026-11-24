/**
 * Anthropic 风格的分层上下文压缩。
 *
 * 顺序：先裁旧工具结果；如果还超过预算，再把较早轮次压成结构化检查点。
 * 最近工作集保留原文，摘要以新事件追加，原始会话不修改。
 */
import type { Ctx } from '@meng/core'
import type { LLMService, Message, ModelInfo, StreamChunk } from '@meng/llm'
import type { MemoryPrepareInput, MemoryPrepareResult, MemoryStatus } from '@meng/loop'
import { compactionCheckpointMessage, type SessionService } from '@meng/session'
import type { PromptService } from '@meng/prompt'
import type { ToolService } from '@meng/tools'
import { DEFAULT_PRUNE, pruneToolResults } from './prune.ts'
import { estimateTokens } from './tokens.ts'

export interface CompactionConfig {
  thresholdRatio?: number
  retainRatio?: number
  summaryMaxTokens?: number
  pruneThresholdChars?: number
  pruneHeadChars?: number
  pruneTailChars?: number
}

export const DEFAULT_COMPACTION: Required<CompactionConfig> = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  summaryMaxTokens: 8192,
  pruneThresholdChars: DEFAULT_PRUNE.thresholdChars,
  pruneHeadChars: DEFAULT_PRUNE.headChars,
  pruneTailChars: DEFAULT_PRUNE.tailChars,
}

export const COMPACTION_INSTRUCTION = [
  'You are a compaction engine for an AI coding assistant. Condense the conversation above into a structured checkpoint so another model can resume the work without losing essential context.',
  '',
  'Output exactly the Markdown structure below, keeping every section in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section and never remove a section.',
  '',
  '## 主要请求与目标',
  '- [用户的原始目标和后续变化；需要精确措辞时引用原文]',
  '',
  '## 关键技术概念',
  '- [技术、框架、模式和约定]',
  '',
  '## 文件与代码',
  '- [精确路径：为什么重要，以及关键改动或片段]',
  '',
  '## 错误与修复',
  '- [错误：怎么修复的，用户反馈了什么]',
  '',
  '## 待办任务',
  '- [明确要求但尚未完成的工作]',
  '',
  '## 当前工作',
  '- [检查点发生时正在进行的精确工作]',
  '',
  '## 下一步',
  '- [与最近请求一致的下一个动作；没有就写 (none)]',
  '',
  '## 关键上下文',
  '- [决策及理由、约束、用户偏好、开放问题、继续任务所需的数据]',
  '',
  'Rules: preserve exact file paths, commands, error strings, identifiers, numbers, function signatures and syntax. Capture user corrections faithfully. Do not mention this summarization request or that the context was compacted. Do not call tools. Output only the checkpoint text. If an existing checkpoint is present, merge still-true facts and drop stale ones instead of copying it verbatim.',
].join('\n')

export async function prepareContext(
  ctx: Ctx,
  input: MemoryPrepareInput,
  config: CompactionConfig = {},
  options: { force?: boolean } = {},
): Promise<MemoryPrepareResult> {
  const policy = { ...DEFAULT_COMPACTION, ...config }
  const llm = ctx.get<LLMService>('llm')
  const session = ctx.get<SessionService>('session')
  if (!llm || !session) return { messages: input.messages, compacted: false }

  const pruned = pruneToolResults(input.messages, {
    thresholdChars: policy.pruneThresholdChars,
    headChars: policy.pruneHeadChars,
    tailChars: policy.pruneTailChars,
  })
  const beforeTokens = estimateTokens(pruned.messages, input.system, input.tools)
  const target = modelInfoOf(llm, input.model)
  if (!target?.contextWindow || target.contextWindow <= 0) {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens, reason: '模型没有报告上下文窗口' }
  }
  const thresholdTokens = Math.floor(target.contextWindow * policy.thresholdRatio)
  if (!options.force && beforeTokens < thresholdTokens) {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens }
  }

  const keepStart = retainStart(pruned.messages, Math.floor(target.contextWindow * policy.retainRatio))
  if (keepStart <= 0) {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens, reason: '没有可压缩的较早轮次' }
  }

  const events = session.read(input.sessionId)
  const turnSeqs = events.filter((event) => event.type === 'turn/started').map((event) => event.seq)
  const keptUserCount = pruned.messages.slice(keepStart).filter((message) => message.role === 'user').length
  const firstRetainedUser = turnSeqs[turnSeqs.length - keptUserCount]
  if (firstRetainedUser === undefined) {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens, reason: '没有可压缩的较早轮次' }
  }
  const throughSeq = firstRetainedUser - 1
  const prefix = pruned.messages.slice(0, keepStart)
  if (prefix.length === 0) {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens }
  }

  let summary: string
  try {
    summary = await summarize(ctx, llm, input, target, prefix, policy.summaryMaxTokens)
  } catch (err) {
    console.warn(`[meng] memory compaction 摘要失败，使用确定性裁剪: ${(err as Error).message}`)
    summary = fallbackSummary(prefix)
  }
  if (summary.trim() === '') {
    return { messages: pruned.messages, compacted: false, estimatedInputTokens: beforeTokens }
  }

  const messages = [compactionCheckpointMessage(summary), ...pruned.messages.slice(keepStart)]
  const afterTokens = estimateTokens(messages, input.system, input.tools)
  const event = session.append(input.sessionId, 'context/compacted', {
    summary: summary.trim(),
    throughSeq,
    trigger: options.force ? 'manual' : 'pressure',
    provider: target.provider,
    model: target.model,
    estimatedInputTokens: beforeTokens,
    beforeTokens,
    afterTokens,
    retainedMessages: pruned.messages.length - keepStart,
    ...(input.runId ? { runId: input.runId } : {}),
  })
  return {
    messages,
    compacted: true,
    estimatedInputTokens: afterTokens,
    beforeTokens,
    afterTokens,
    summarySeq: event.seq,
  }
}

/** 给输入框下方状态条使用的只读快照；不触发压缩。 */
export async function statusOf(
  ctx: Ctx,
  input: { sessionId: string; model?: string },
  config: CompactionConfig = {},
): Promise<MemoryStatus> {
  const policy = { ...DEFAULT_COMPACTION, ...config }
  const llm = ctx.get<LLMService>('llm')
  const session = ctx.get<SessionService>('session')
  const prompt = ctx.get<PromptService>('prompt')
  const tools = ctx.get<ToolService>('tools')
  if (!llm || !session) {
    return {
      sessionId: input.sessionId,
      usedTokens: 0,
      usedSource: 'estimate',
      thresholdRatio: policy.thresholdRatio,
      retainRatio: policy.retainRatio,
      compacted: false,
      compactionCount: 0,
      canCompact: false,
      reason: '记忆服务未装载',
    }
  }
  const history = session.project(input.sessionId)
  const system = prompt ? await prompt.render({ sessionId: input.sessionId }) : ''
  const activeTools = tools?.active() ?? []
  const usedTokens = estimateTokens(history, system, activeTools)
  const target = modelInfoOf(llm, input.model ?? '')
  const events = session.read(input.sessionId)
  const compactions = events.filter((event) => event.type === 'context/compacted')
  const last = compactions.at(-1)
  const keepStart = target?.contextWindow
    ? retainStart(history, Math.floor(target.contextWindow * policy.retainRatio))
    : 0
  const canCompact = Boolean(target?.contextWindow && keepStart > 0)
  return {
    sessionId: input.sessionId,
    ...(input.model ? { model: input.model } : {}),
    ...(target?.contextWindow ? { contextWindow: target.contextWindow } : {}),
    usedTokens,
    usedSource: 'estimate',
    thresholdRatio: policy.thresholdRatio,
    retainRatio: policy.retainRatio,
    ...(target?.contextWindow ? { thresholdTokens: Math.floor(target.contextWindow * policy.thresholdRatio) } : {}),
    compacted: compactions.length > 0,
    compactionCount: compactions.length,
    ...(last ? { lastCompactedAt: last.at, lastSummarySeq: last.seq } : {}),
    canCompact,
    ...(canCompact ? {} : { reason: target?.contextWindow ? '没有可压缩的较早轮次' : '模型没有报告上下文窗口' }),
  }
}

function modelInfoOf(llm: LLMService, model: string): (ModelInfo & { provider: string; model: string }) | undefined {
  try {
    const target = llm.resolve(model || undefined)
    const info = llm.listProviders().find((provider) => provider.id === target.id)?.models.find((item) => item.id === target.model)
    return info ? { ...info, provider: target.id, model: target.model } : undefined
  } catch {
    return undefined
  }
}

/** 挑一个以用户轮次为边界的保留尾巴，避免切断工具调用/结果配对。 */
export function retainStart(messages: readonly Message[], retainTokens: number): number {
  const userIndexes = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []))
  if (userIndexes.length === 0) return 0
  let start = messages.length
  for (let index = userIndexes.length - 1; index >= 0; index--) {
    const candidate = userIndexes[index]!
    const tokens = estimateTokens(messages.slice(candidate))
    if (tokens > retainTokens && start < messages.length) break
    start = candidate
  }
  return start
}

async function summarize(
  ctx: Ctx,
  llm: LLMService,
  input: MemoryPrepareInput,
  target: ModelInfo & { provider: string; model: string },
  prefix: readonly Message[],
  maxTokens: number,
): Promise<string> {
  const system: Message = {
    role: 'system',
    content: [{ type: 'text', text: 'You compress conversation history into a durable technical checkpoint. Follow the requested structure exactly.' }],
  }
  const instruction: Message = {
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  }
  let text = ''
  for await (const chunk of llm.stream({
    model: target.model,
    provider: target.provider,
    messages: [system, ...prefix, instruction],
    maxTokens,
    ...(input.signal ? { signal: input.signal } : {}),
  }) as AsyncIterable<StreamChunk>) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text.trim()
}

function fallbackSummary(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('').trim()
    if (!text) continue
    lines.push(`${message.role}: ${text.replace(/\s+/g, ' ').slice(0, 1200)}`)
  }
  const body = lines.join('\n').slice(-12_000) || '(none)'
  return `## 主要请求与目标\n- ${body}\n\n## 关键技术概念\n- (none)\n\n## 文件与代码\n- (none)\n\n## 错误与修复\n- (none)\n\n## 待办任务\n- (none)\n\n## 当前工作\n- 自动摘要失败，保留最近工作集。\n\n## 下一步\n- 继续当前任务。\n\n## 关键上下文\n- 以上内容由确定性裁剪生成。`
}
