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
  ingest: (state: ConversationState, event: StreamEvent) => ConversationState
  reset: (state: ConversationState) => ConversationState
}

/** 单个会话最多留这么多事件, 再多就丢掉最早的 (界面只显示最近一段) */
const MAX_EVENTS = 4000

export const conversationSpec: StoreSpec<ConversationState, ConversationActions> = {
  init: () => ({ events: [], lastSeq: 0 }),
  actions: {
    ingest(state, event) {
      // 断线重连会重放; seq 不递增说明这条已经见过, 返回同一引用 = 不通知不重渲染
      if (event.seq <= state.lastSeq) return state
      const events = state.events.length >= MAX_EVENTS ? state.events.slice(-MAX_EVENTS + 1) : state.events
      return { events: [...events, event], lastSeq: event.seq }
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
