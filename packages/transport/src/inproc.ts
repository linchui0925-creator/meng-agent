/**
 * transport · 进程内直连 (测试 / 单进程部署)。
 *
 * 测试价值很大: 不用起服务器和 WebSocket 就能跑完整条链路,
 * 让 M3 之后的每条验收都能在 `node` 里一键复现。
 *
 * **签名与原骨架不同**: 原来是 `createInprocTransport()` 无参数 —— 那实现不了。
 * 进程内直连必须知道"打给谁", 所以补一个 `InprocKernel` 参数。
 * 这是唯一需要改契约形状的地方, ws / ipc 不需要。
 */

import type { ConnectionState, StreamEvent, Transport } from './index.ts'

/**
 * 进程内内核的接缝。
 *
 * 形状对齐 `POST /api/{op}` + WS 下行:
 * `call` 是上行 (对应 invoke), `subscribe` 是下行 (对应事件流)。
 * fixture / 真内核 / 测试桩都实现它, 于是 transport 侧一行代码不用改。
 */
export interface InprocKernel {
  call(op: string, payload?: unknown): Promise<unknown>
  subscribe(fn: (event: StreamEvent) => void): () => void
}

export interface InprocOptions {
  /**
   * 连上之前的延迟 (ms)。默认 0。
   *
   * 即便传 0 也**不会同步就 online** —— 状态仍走 connecting → online 两拍。
   * 这是刻意的: 加载页要能在"连接中"这个状态下渲染。
   * 如果 inproc 同步就 online, 那段 UI 在测试里永远测不到,
   * 等换成 ws 才发现写错了。
   */
  connectDelay?: number
}

export function createInprocTransport(kernel: InprocKernel, options: InprocOptions = {}): Transport {
  const { connectDelay = 0 } = options

  const eventListeners = new Set<(event: StreamEvent) => void>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let state: ConnectionState = 'connecting'
  let offKernel: (() => void) | undefined
  let disposed = false

  let announceOnline: (() => void) | undefined
  const online = new Promise<void>((resolve) => {
    announceOnline = resolve
  })

  function setState(next: ConnectionState): void {
    if (state === next) return
    state = next
    // 拷贝后遍历: 监听器里退订自己不会打乱这一次派发
    for (const fn of [...stateListeners]) {
      try {
        fn(next)
      } catch (err) {
        console.error('[inproc] onStateChange 订阅者抛错:', err)
      }
    }
  }

  function goOnline(): void {
    if (disposed || state === 'online') return
    setState('online')
    // 连上之后才订阅下行 —— 和 ws 一致: 没连上之前不收事件
    offKernel = kernel.subscribe((event) => {
      for (const fn of [...eventListeners]) {
        try {
          fn(event)
        } catch (err) {
          console.error('[inproc] 事件订阅者抛错:', err)
        }
      }
    })
    announceOnline?.()
  }

  if (connectDelay <= 0) queueMicrotask(goOnline)
  else setTimeout(goOnline, connectDelay)

  return {
    async invoke<T = unknown>(op: string, payload?: unknown): Promise<T> {
      // 连上之前的 invoke 挂住而不是报错 —— 与真实网络行为一致
      await online
      if (disposed) throw new Error('inproc: transport 已 dispose')
      return (await kernel.call(op, payload)) as T
    },

    subscribe(fn: (event: StreamEvent) => void): () => void {
      eventListeners.add(fn)
      return () => {
        eventListeners.delete(fn)
      }
    },

    state(): ConnectionState {
      return state
    },

    onStateChange(fn: (state: ConnectionState) => void): () => void {
      stateListeners.add(fn)
      // 晚到的订阅者不该错过"已经 online"这个事实,
      // 否则 UI 会停在 loading 上等一个永远不会再来的事件
      if (state !== 'connecting') {
        queueMicrotask(() => {
          if (stateListeners.has(fn)) fn(state)
        })
      }
      return () => {
        stateListeners.delete(fn)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      offKernel?.()
      offKernel = undefined
      eventListeners.clear()
      setState('offline')
      stateListeners.clear()
      // 唤醒还挂在 await 上的 invoke, 让它们走到 disposed 检查处抛错,
      // 而不是永远挂着 (那会变成清理不掉的泄漏)
      announceOnline?.()
    },
  }
}
