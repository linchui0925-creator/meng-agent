/**
 * transport · HTTP 上行 + WebSocket 下行 (web / mobile 连远端内核)。
 *
 * 抄 dsh 的双流分离: 上行命令要请求-响应语义和幂等重试, 下行事件流要推和重放。
 * 合成一条会在重连时丢掉"哪些命令已确认"的信息。
 *
 * 三条从 docs/06 搬过来的硬约束:
 *
 *   1. **先握手再派发**: hello 帧 (seq = -1) 校验 `protocol` 之后才转 online。
 *      协议版本不对是**不可恢复**错误 —— 重连多少次都一样, 所以直接 offline 并停手,
 *      而不是无限重连 (那会把"版本不匹配"伪装成"网络不好")。
 *   2. **重连带 `since=lastSeq`**, 且 `lastSeq` 必须跳过 hello 的 -1。
 *      判断依据是"参数有没有传", 不是"值大不大于 0"(后端也是这么写的), 所以首次连接不带。
 *   3. **重连后不清屏**: 重放的是增量, 前端把新事件追加进已有序列再重投影, 不清空。
 *
 * WebSocket / fetch / 存储全部是注入的 —— 于是这个文件在 node 下能直接跑断言
 * (test/ws.ts 里塞一个假 socket), 不需要真起服务器。
 */

import { HELLO_SEQ, type ConnectionState, type StreamEvent, type Transport } from './index.ts'

/** 握手帧带来的东西。只有远端 transport 有, inproc/ipc 没有 */
export interface HandshakeInfo {
  protocol: number
  /** 服务端清单 (boot manifest)。前端拿它决定装哪些插件 */
  manifest?: unknown
  at: number
}

/** 最小 socket 面 —— 只用到这四个成员, 于是测试能塞假的 */
export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: (() => void) | null
  onerror: ((err: unknown) => void) | null
  close(): void
}

/** seq 的落点。注入式, 默认 localStorage; node 测试塞内存实现 */
export interface SeqStore {
  read(): number | undefined
  write(seq: number): void
}

export interface WsTransportOptions {
  /** 上行基址, 如 `http://127.0.0.1:4721` */
  httpBase: string
  /** 下行地址, 如 `ws://127.0.0.1:4721/ws` */
  wsUrl: string
  /** 期望的协议版本。不匹配 = 不可恢复 */
  protocol?: number
  /** lastSeq 的落点。不传 = 不持久化(重连就重头开始) */
  store?: SeqStore
  /** 建 socket 的工厂。默认 `new WebSocket(url)` */
  connect?: (url: string) => SocketLike
  fetchImpl?: typeof fetch
  /** 退避: 第 n 次失败后等多少 ms。默认 500 * 2^n, 上限 8s */
  backoff?: (attempt: number) => number
  /** 0 = 一直重试(网络问题的正确策略)。默认 0 */
  maxAttempts?: number
  /** 写 lastSeq 的防抖间隔。默认 250ms —— 流式 chunk 一秒几十条, 每条都落盘太贵 */
  flushDelay?: number
  onFatal?: (err: Error) => void
}

export interface WsTransport extends Transport {
  /** 握手结果。还没握上手时是 undefined */
  handshake(): HandshakeInfo | undefined
}

const DEFAULT_PROTOCOL = 1

export function createWsTransport(options: WsTransportOptions): WsTransport {
  const {
    httpBase,
    wsUrl,
    protocol = DEFAULT_PROTOCOL,
    store,
    fetchImpl = fetch,
    backoff = defaultBackoff,
    maxAttempts = 0,
    flushDelay = 250,
    onFatal,
  } = options

  const connect =
    options.connect ??
    ((url: string): SocketLike => {
      const raw = new WebSocket(url)
      const shim: SocketLike = {
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close() {
          raw.close()
        },
      }
      raw.onopen = () => shim.onopen?.()
      raw.onmessage = (ev: MessageEvent) => shim.onmessage?.(String(ev.data))
      raw.onclose = () => shim.onclose?.()
      raw.onerror = () => shim.onerror?.(new Error('ws error'))
      return shim
    })

  const eventListeners = new Set<(event: StreamEvent) => void>()
  const stateListeners = new Set<(state: ConnectionState) => void>()

  let state: ConnectionState = 'connecting'
  let socket: SocketLike | undefined
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let fatal: Error | undefined
  let handshakeInfo: HandshakeInfo | undefined

  /** 已收到的最大 seq。重连时作为 since 发出去 */
  let lastSeq = store?.read()
  let pendingSeq = lastSeq

  function setState(next: ConnectionState): void {
    if (state === next) return
    state = next
    for (const fn of [...stateListeners]) {
      try {
        fn(next)
      } catch (err) {
        console.error('[ws] onStateChange 订阅者抛错:', err)
      }
    }
  }

  function scheduleFlush(): void {
    if (!store || pendingSeq === undefined || pendingSeq === lastSeq) return
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, flushDelay)
  }

  function flush(): void {
    if (!store || pendingSeq === undefined || pendingSeq === lastSeq) return
    lastSeq = pendingSeq
    store.write(lastSeq)
  }

  function url(): string {
    // 首次连接不带 since: 后端按"参数有没有传"判断, 传了 0 等于"我什么都收过了"
    if (lastSeq === undefined) return wsUrl
    const sep = wsUrl.includes('?') ? '&' : '?'
    return `${wsUrl}${sep}since=${lastSeq}`
  }

  function open(): void {
    if (disposed || fatal) return
    let sock: SocketLike
    try {
      sock = connect(url())
    } catch (err) {
      scheduleRetry(err)
      return
    }
    socket = sock

    sock.onopen = () => {
      // 注意: 这里**不**转 online —— 要等 hello 帧校验过协议版本才算连上
    }

    sock.onmessage = (data: string) => {
      let frame: StreamEvent
      try {
        frame = JSON.parse(data) as StreamEvent
      } catch {
        console.warn('[ws] 收到非 JSON 帧, 已丢弃:', String(data).slice(0, 80))
        return
      }
      if (typeof frame?.type !== 'string') return

      if (frame.type === 'hello') {
        const payload = (frame.payload ?? {}) as { protocol?: number; manifest?: unknown }
        if (payload.protocol !== protocol) {
          // 不可恢复: 重连多少次都是同一个版本。停手, 别装成网络问题
          fatal = new Error(
            `协议版本不匹配: 服务端 ${payload.protocol} / 前端 ${protocol}。请刷新页面加载新前端`,
          )
          sock.onclose = null
          sock.onmessage = null
          sock.close()
          setState('offline')
          onFatal?.(fatal)
          return
        }
        handshakeInfo = { protocol, manifest: payload.manifest, at: frame.at }
        attempt = 0
        setState('online')
        return
      }

      // hello 之外的帧: seq 必须是数字, 且跳过 -1 那个哨兵
      if (typeof frame.seq !== 'number' || frame.seq === HELLO_SEQ) return
      // 重放与实时流会重叠一段 —— 收过的就丢掉, 靠投影层兜底不如这里先挡一道
      if (pendingSeq !== undefined && frame.seq <= pendingSeq) return
      pendingSeq = frame.seq
      scheduleFlush()

      for (const fn of [...eventListeners]) {
        try {
          fn(frame)
        } catch (err) {
          console.error('[ws] 事件订阅者抛错:', err)
        }
      }
    }

    sock.onclose = () => {
      if (disposed || fatal) return
      scheduleRetry(undefined)
    }

    sock.onerror = (err: unknown) => {
      // 浏览器里 error 后必定跟 close, 重连由 close 那条路走, 这里只记
      console.warn('[ws] socket error:', err)
    }
  }

  function scheduleRetry(_err: unknown): void {
    if (disposed || fatal) return
    if (maxAttempts > 0 && attempt >= maxAttempts) {
      setState('offline')
      return
    }
    setState('reconnecting')
    const wait = backoff(attempt)
    attempt++
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      open()
    }, wait)
  }

  open()

  return {
    handshake() {
      return handshakeInfo
    },

    async invoke<T = unknown>(op: string, payload?: unknown): Promise<T> {
      // 上行走 HTTP, 不依赖下行是否连着 —— 断线时命令照样能发(后端会自己排队或拒绝)
      const res = await fetchImpl(`${httpBase}/api/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })

      let body: unknown
      try {
        body = await res.json()
      } catch {
        body = undefined
      }

      if (!res.ok) {
        const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error
        throw new Error(`invoke ${op} 失败 (${res.status}): ${err?.message ?? res.statusText}`)
      }
      return body as T
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
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flush() // 别把最后的 lastSeq 丢在防抖窗口里
      socket?.close()
      socket = undefined
      setState('offline')
      eventListeners.clear()
      stateListeners.clear()
    },
  }
}

/** 500ms 起步、翻倍、8s 封顶。没有抖动 —— 抖动会让断言变得不稳定, 而多台客户端同时重连的场景现在还没有 */
function defaultBackoff(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000)
}

/** localStorage 版 SeqStore。key 带上标识, 免得多个后端共用一份 */
export function localStorageSeqStore(key = 'meng.lastSeq'): SeqStore {
  return {
    read() {
      try {
        const raw = localStorage.getItem(key)
        if (raw === null) return undefined
        const n = Number(raw)
        return Number.isFinite(n) ? n : undefined
      } catch {
        return undefined
      }
    },
    write(seq) {
      try {
        localStorage.setItem(key, String(seq))
      } catch {
        // 隐私模式下写不进去 —— lastSeq 只是优化, 丢了下一次重头开始, 不影响正确性
      }
    },
  }
}

/** 内存版。测试用, 也用于"不希望跨刷新保留"的场景 */
export function memorySeqStore(initial?: number): SeqStore {
  let value = initial
  return {
    read() {
      return value
    },
    write(seq) {
      value = seq
    },
  }
}
