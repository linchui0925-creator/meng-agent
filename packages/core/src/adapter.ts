import type { Ctx } from './context.ts'

export const ADAPTER_KINDS = ['library', 'cli', 'http', 'sidecar', 'mcp', 'ui'] as const
export type AdapterKind = (typeof ADAPTER_KINDS)[number]

export const ADAPTER_RUNTIME_MODES = ['in-process', 'worker', 'child-process', 'remote'] as const
export type AdapterRuntimeMode = (typeof ADAPTER_RUNTIME_MODES)[number]

export interface ProjectSource {
  kind: AdapterKind
  package?: string
  version?: string
  root?: string
  entry?: string
}

export interface AdapterCapabilityReport {
  id: string
  source: ProjectSource
  tools: string[]
  webOps: string[]
  prompts: string[]
  client?: {
    available: boolean
    entry?: string
    slots?: string[]
  }
  unsupported: string[]
}

export interface AdapterHealth {
  ok: boolean
  status: string
  detail?: string
}

/**
 * 适配器启动时拿到的宿主面。
 *
 * 这里故意只给稳定的通用入口，不把梦内部服务对象直接散给项目。
 * 适配器要 registerTools/registerWeb 时自行调用 ctx，或由 host 提供薄包装。
 */
export interface AdapterHostContext {
  readonly id: string
  readonly dataRoot: string
  readonly ctx: Ctx
  readonly signal: AbortSignal
  readonly env: Readonly<Record<string, string>>
}

/**
 * 任意项目接入梦的统一契约。
 *
 * `inspect()` 必须只做静态/受控探测；真正启动外部代码发生在 `start()`。
 */
export interface ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  inspect(): Promise<AdapterCapabilityReport>
  start(host: AdapterHostContext): Promise<void>
  stop(): Promise<void>
  health(): Promise<AdapterHealth>
}
