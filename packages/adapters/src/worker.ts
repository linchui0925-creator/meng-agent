/**
 * Worker 侧协议。插件 worker 只需调用 serveWorker({ tools, call, health })。
 *
 * 消息全部是单层 JSON，主线程不执行插件业务代码。
 */
import { parentPort, workerData } from 'node:worker_threads'

export interface WorkerTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  mutates?: boolean
  group?: string
  timeoutMs?: number
}

export interface WorkerRuntime {
  tools: WorkerTool[]
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown
  health?(): Promise<{ ok: boolean; status: string; detail?: string }> | { ok: boolean; status: string; detail?: string }
}

interface Request {
  type: 'call' | 'health'
  id: number
  name?: string
  args?: Record<string, unknown>
}

interface Response {
  type: 'response'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export async function serveWorker(load: (data: unknown) => Promise<WorkerRuntime> | WorkerRuntime): Promise<void> {
  if (!parentPort) throw new Error('serveWorker 必须在 worker_threads 中运行')
  const port = parentPort
  const runtime = await load(workerData)
  port.postMessage({ type: 'ready', tools: runtime.tools })

  port.on('message', (message: Request) => {
    void (async () => {
      try {
        if (message.type === 'call') {
          const value = await runtime.call(message.name ?? '', message.args ?? {})
          const response: Response = { type: 'response', id: message.id, ok: true, value }
          port.postMessage(response)
          return
        }
        if (message.type === 'health') {
          const value = runtime.health ? await runtime.health() : { ok: true, status: 'running' }
          port.postMessage({ type: 'response', id: message.id, ok: true, value } satisfies Response)
          return
        }
        port.postMessage({ type: 'response', id: message.id, ok: false, error: '未知 worker 请求' } satisfies Response)
      } catch (error) {
        port.postMessage({
          type: 'response',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies Response)
      }
    })()
  })
}
