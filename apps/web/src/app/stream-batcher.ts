/**
 * 流式事件合帧器。
 *
 * dsh 的 conversation Definition 对 `assistant/chunk` 标的是
 * `publication: "animation-frame"`：模型每个 token 都进事件流，但 React
 * 订阅者一帧最多收到一次完整快照。这里做同一件事，且保留它的边界：
 *   · `llm/chunk` 攒到下一帧一起提交；
 *   · `llm/completed` / `tool/*` / `turn/ended` 等事件立即提交，
 *     所以工具卡、完成态和错误不会被拖慢；
 *   · 切会话或卸载时只取消队列，不把旧会话的碎片灌进新会话。
 */

import type { StreamEvent } from '@meng/transport'

export interface FrameScheduler {
  schedule(fn: () => void): unknown
  cancel(handle: unknown): void
}

export interface StreamBatcher {
  push(event: StreamEvent): void
  flush(): void
  cancel(): void
}

const defaultScheduler: FrameScheduler = {
  schedule(fn) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      return globalThis.requestAnimationFrame(fn)
    }
    return setTimeout(fn, 16)
  },
  cancel(handle) {
    if (typeof globalThis.cancelAnimationFrame === 'function' && typeof handle === 'number') {
      globalThis.cancelAnimationFrame(handle)
      return
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function createStreamBatcher(
  publish: (events: readonly StreamEvent[]) => void,
  scheduler: FrameScheduler = defaultScheduler,
): StreamBatcher {
  let pending: StreamEvent[] = []
  let handle: unknown

  function clearScheduled(): void {
    if (handle === undefined) return
    scheduler.cancel(handle)
    handle = undefined
  }

  function flushWith(boundary?: StreamEvent): void {
    clearScheduled()
    if (pending.length === 0 && boundary === undefined) return
    const events = boundary === undefined ? pending : [...pending, boundary]
    pending = []
    publish(events)
  }

  function schedule(): void {
    if (handle !== undefined) return
    handle = scheduler.schedule(() => {
      handle = undefined
      flushWith()
    })
  }

  return {
    push(event) {
      if (event.type === 'llm/chunk') {
        pending.push(event)
        schedule()
        return
      }
      // 非 chunk 是边界：把它和前面的文字放进同一次提交，既保序又只刷新一次。
      flushWith(event)
    },
    flush() {
      flushWith()
    },
    cancel() {
      clearScheduled()
      pending = []
    },
  }
}
