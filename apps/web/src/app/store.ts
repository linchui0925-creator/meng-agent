/**
 * 会话状态 = 事件序列本身。
 *
 * **没有 messages 字段, 这是故意的。** 消息由 conversation.ts 的 project() 现算。
 * 一旦在这里再存一份消息数组, 就会出现"事件到了但消息没更新"或反之的分叉,
 * 而分叉之后没有任何办法判断哪份是对的。
 *
 * 不持久化 (persist): 事件序列的真相在后端 JSONL 里 (packages/persistence),
 * 前端再存一份只会带来"回放顺序与本地缓存不一致"的新问题。刷新就从 session.read 重放。
 */

import { createStore, type StoreInstance, type StoreSpec } from '@meng/slots'
import type { StreamEvent } from '@meng/transport'

export interface ConversationState {
  events: StreamEvent[]
  /** 已见最大 seq, 用于丢弃重放导致的重复事件 */
  lastSeq: number
}

type ConversationActions = {
  /** 单条写入；非流式事件仍走这里。 */
  ingest: (state: ConversationState, event: StreamEvent) => ConversationState
  /** 一帧的 chunk 一次性写入，避免每个 token 都复制事件数组/通知 React。 */
  ingestMany: (state: ConversationState, events: readonly StreamEvent[]) => ConversationState
  reset: (state: ConversationState) => ConversationState
}

/** 单个会话最多留这么多事件, 再多就丢掉最早的 (界面只显示最近一段) */
const MAX_EVENTS = 4000

/**
 * 批量追加。**一次复制 + 一次通知**是这段的核心：
 * 流式 token 可能一秒几十条, 逐条 `[...events, event]` 会让事件数组从
 * O(n) 复制变成 O(n × token 数), 还会让每个 token 都触发一次 React 重渲染。
 */
function appendEvents(state: ConversationState, incoming: readonly StreamEvent[]): ConversationState {
  const fresh: StreamEvent[] = []
  let lastSeq = state.lastSeq
  for (const event of incoming) {
    // 断线重连会重放; seq 不递增说明这条已经见过
    if (event.seq <= lastSeq) continue
    fresh.push(event)
    lastSeq = event.seq
  }
  if (fresh.length === 0) return state
  const merged = [...state.events, ...fresh]
  return {
    events: merged.length > MAX_EVENTS ? merged.slice(-MAX_EVENTS) : merged,
    lastSeq,
  }
}

export const conversationSpec: StoreSpec<ConversationState, ConversationActions> = {
  init: () => ({ events: [], lastSeq: 0 }),
  actions: {
    ingest(state, event) {
      return appendEvents(state, [event])
    },
    ingestMany(state, incoming) {
      return appendEvents(state, incoming)
    },
    reset() {
      return { events: [], lastSeq: 0 }
    },
  },
}

export type ConversationStore = StoreInstance<ConversationState, ConversationActions>

export function createConversationStore(): ConversationStore {
  return createStore(conversationSpec)
}
