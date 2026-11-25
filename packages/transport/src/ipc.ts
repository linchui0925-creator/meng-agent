/**
 * transport · Electron IPC (桌面端连本地内核)。
 *
 * 渲染进程拿不到 Node，也不能直接连主进程对象。preload 只暴露一层窄桥：
 * invoke / subscribe / state / manifest。这里把桥包装成与 WS 完全相同的
 * Transport 接口，业务插件不需要知道内核在主进程里。
 */

import type { BootManifestLike, ConnectionState, StreamEvent, Transport } from './index.ts'

export interface IpcBridge {
  invoke(op: string, payload?: unknown): Promise<unknown>
  subscribe(fn: (event: StreamEvent) => void): () => void
  state(): ConnectionState
  onStateChange(fn: (state: ConnectionState) => void): () => void
  manifest(): BootManifestLike | undefined
}

export type IpcTransport = Transport & {
  /** 与 ws transport 同名，main.tsx 用能力检测拿插件清单。 */
  handshake?(): { manifest?: BootManifestLike } | undefined
}

function defaultBridge(): IpcBridge {
  const host = globalThis as unknown as { mengDesktop?: IpcBridge }
  if (!host.mengDesktop) throw new Error('desktop IPC bridge 未注入 (preload 没加载?)')
  return host.mengDesktop
}

export function createIpcTransport(bridge: IpcBridge = defaultBridge()): IpcTransport {
  let disposed = false
  const subscriptions = new Set<() => void>()

  return {
    invoke<T = unknown>(op: string, payload?: unknown): Promise<T> {
      return bridge.invoke(op, payload) as Promise<T>
    },
    subscribe(fn) {
      const off = bridge.subscribe((event) => {
        if (!disposed) fn(event)
      })
      subscriptions.add(off)
      return () => {
        subscriptions.delete(off)
        off()
      }
    },
    state() {
      return disposed ? 'offline' : bridge.state()
    },
    onStateChange(fn) {
      return bridge.onStateChange(fn)
    },
    handshake() {
      const manifest = bridge.manifest()
      return manifest === undefined ? undefined : { manifest }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of subscriptions) off()
      subscriptions.clear()
    },
  }
}
