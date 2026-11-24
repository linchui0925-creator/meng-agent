/** 输入框等待队列的纯状态。消息真正发出前不进入会话事件流。 */

import type { ReasoningEffort } from '@meng/llm'

export interface QueuedAttachment {
  id: string
  name: string
}

export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  attachments: QueuedAttachment[]
  model?: string
  reasoningEffort?: ReasoningEffort
  createdAt: number
  /** 用户点过“立即插入”时记录被中断的 run；发送时进入模型上下文。 */
  interruptRunId?: string
}

export type QueueBySession = Record<string, QueuedMessage[]>
export type QueueEditing = { sessionId: string; id: string }

export function queueOf(queue: QueueBySession, sessionId: string | undefined): QueuedMessage[] {
  return sessionId === undefined ? [] : (queue[sessionId] ?? [])
}

export function addQueued(queue: QueueBySession, message: QueuedMessage, front = false): QueueBySession {
  const current = queue[message.sessionId] ?? []
  return {
    ...queue,
    [message.sessionId]: front ? [message, ...current] : [...current, message],
  }
}

export function editQueued(queue: QueueBySession, sessionId: string, id: string, text: string): QueueBySession {
  const current = queue[sessionId] ?? []
  return {
    ...queue,
    [sessionId]: current.map((message) => message.id === id ? { ...message, text } : message),
  }
}

export function removeQueued(queue: QueueBySession, sessionId: string, id: string): QueueBySession {
  const next = (queue[sessionId] ?? []).filter((message) => message.id !== id)
  if (next.length > 0) return { ...queue, [sessionId]: next }
  const copy = { ...queue }
  delete copy[sessionId]
  return copy
}

export function insertQueued(queue: QueueBySession, sessionId: string, id: string, runId?: string): QueueBySession {
  const current = queue[sessionId] ?? []
  const found = current.find((message) => message.id === id)
  if (!found) return queue
  const { interruptRunId: _ignored, ...plain } = found
  const promoted: QueuedMessage = {
    ...plain,
    ...(runId === undefined ? {} : { interruptRunId: runId }),
  }
  return {
    ...queue,
    [sessionId]: [promoted, ...current.filter((message) => message.id !== id)],
  }
}

export function nextQueued(queue: QueueBySession, sessionId: string): QueuedMessage | undefined {
  return queue[sessionId]?.[0]
}

export function isEditingQueued(editing: QueueEditing | undefined, sessionId: string): boolean {
  return editing?.sessionId === sessionId
}
