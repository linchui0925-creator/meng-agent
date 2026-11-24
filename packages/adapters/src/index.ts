/**
 * 通用项目适配器 —— P1 基础实现。
 *
 * 这里只做三件可验证的事：
 *   · library：import 项目模块，按声明注册工具
 *   · cli：把命令包装成工具
 *   · http：把端点包装成工具
 *
 * 不解析源码，不复制业务实现。工具注册和卸载必须对称。
 */
import { execFile, spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  AdapterCapabilityReport,
  AdapterHealth,
  AdapterHostContext,
  ProjectAdapter,
  ProjectSource,
} from '@meng/core'
import type { ToolCall, ToolDef, ToolResult, ToolService } from '@meng/tools'

const execFileAsync = promisify(execFile)

interface AdapterTool<M = unknown> {
  name: string
  description: string
  parameters: Record<string, unknown>
  mutates?: boolean
  group?: string
  timeoutMs?: number
  invoke(module: M, args: Record<string, unknown>, call?: ToolCall): Promise<ToolResult> | ToolResult
}

function toolsOf(host: AdapterHostContext): ToolService {
  const tools = host.ctx.get<ToolService>('tools')
  if (!tools) throw new Error(`适配器 ${host.id} 需要 tools 能力面`)
  return tools
}

function sourceOf(id: string, kind: ProjectSource['kind'], input: Omit<ProjectSource, 'kind'> = {}): ProjectSource {
  return { kind, ...input, ...(input.root === undefined && input.package === undefined && input.entry === undefined
    ? { package: id }
    : {}) }
}

function health(ok: boolean, status: string, detail?: string): AdapterHealth {
  return { ok, status, ...(detail ? { detail } : {}) }
}

function report(id: string, source: ProjectSource, tools: string[], unsupported: string[] = []): AdapterCapabilityReport {
  return {
    id,
    source,
    tools,
    webOps: [],
    prompts: [],
    unsupported,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// library
// ─────────────────────────────────────────────────────────────────────────────

export interface LibraryAdapterOptions<M = unknown> {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  load?: () => Promise<M>
  entry?: string
  tools?: Array<AdapterTool<M>>
  start?: (module: M, host: AdapterHostContext) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  stop?: (module: M) => void | Promise<void>
  unsupported?: string[]
}

export class LibraryAdapter<M = unknown> implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: LibraryAdapterOptions<M>
  private module: M | undefined
  private disposers: Array<() => void | Promise<void>> = []
  private started = false

  constructor(options: LibraryAdapterOptions<M>) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'library', {
      ...options.source,
      ...(options.entry ? { entry: options.entry } : {}),
    })
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, (this.options.tools ?? []).map((tool) => tool.name), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    const module = await this.load()
    try {
      const service = toolsOf(host)
      for (const tool of this.options.tools ?? []) {
        const def: ToolDef = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.mutates === undefined ? {} : { mutates: tool.mutates }),
          ...(tool.group === undefined ? {} : { group: tool.group }),
          ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
          handler: (args, _ctx, call) => tool.invoke(module, args, call),
        }
        this.disposers.push(service.register(def))
      }
      const lifecycle = await this.options.start?.(module, host)
      if (typeof lifecycle === 'function') this.disposers.push(lifecycle)
      this.module = module
      this.started = true
    } catch (error) {
      await this.disposeAll()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.disposeAll()
    if (this.module !== undefined) await this.options.stop?.(this.module)
    this.module = undefined
    this.started = false
  }

  private async disposeAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
  }

  async health(): Promise<AdapterHealth> {
    return health(this.started, this.started ? 'running' : 'stopped')
  }

  private async load(): Promise<M> {
    if (this.options.load) return this.options.load()
    const target = this.options.entry ?? this.options.source?.entry ?? this.options.source?.package ?? this.id
    return await import(target) as M
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// cli
// ─────────────────────────────────────────────────────────────────────────────

export interface CliCommand {
  name: string
  description: string
  parameters: Record<string, unknown>
  command: string
  args?: (args: Record<string, unknown>) => string[]
  cwd?: string | ((args: Record<string, unknown>) => string | undefined)
  env?: (args: Record<string, unknown>) => Record<string, string>
  timeoutMs?: number
  mutates?: boolean
  group?: string
  mapResult?: (result: CliRunResult) => ToolResult
}

export interface CliRunResult {
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
}

export interface CliAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  commands: CliCommand[]
  health?: { command: string; args?: string[] }
  unsupported?: string[]
}

export class CliAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: CliAdapterOptions
  private disposers: Array<() => void | Promise<void>> = []
  private started = false

  constructor(options: CliAdapterOptions) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'cli', options.source)
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, this.options.commands.map((command) => command.name), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    try {
      const service = toolsOf(host)
      for (const command of this.options.commands) {
        this.disposers.push(service.register({
          name: command.name,
          description: command.description,
          parameters: command.parameters,
          ...(command.mutates === undefined ? {} : { mutates: command.mutates }),
          ...(command.group === undefined ? {} : { group: command.group }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
          handler: (args, _ctx, call) => this.runCommand(command, args, call),
        }))
      }
      this.started = true
    } catch (error) {
      await this.disposeAll()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.disposeAll()
    this.started = false
  }

  private async disposeAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
  }

  async health(): Promise<AdapterHealth> {
    if (!this.started) return health(false, 'stopped')
    if (!this.options.health) return health(true, 'ready')
    try {
      await runCli(this.options.health.command, this.options.health.args ?? [], { timeoutMs: 10_000 })
      return health(true, 'healthy')
    } catch (error) {
      return health(false, 'unhealthy', error instanceof Error ? error.message : String(error))
    }
  }

  private async runCommand(command: CliCommand, args: Record<string, unknown>, call?: ToolCall): Promise<ToolResult> {
    const argv = command.args?.(args) ?? []
    if (!argv.every((item) => typeof item === 'string')) throw new Error(`CLI ${command.name} 生成非法参数`)
    const cwd = typeof command.cwd === 'function' ? command.cwd(args) : command.cwd
    try {
      const result = await runCli(command.command, argv, {
        ...(cwd ? { cwd } : {}),
        ...(command.env ? { env: command.env(args) } : {}),
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
        ...(call?.signal ? { signal: call.signal } : {}),
      })
      return command.mapResult?.(result) ?? {
        ok: result.exitCode === 0,
        text: result.exitCode === 0 ? result.stdout : (result.stderr || result.stdout || `退出码 ${result.exitCode}`),
        ...(result.exitCode === 0 ? {} : { error: result.stderr || `退出码 ${result.exitCode}` }),
        value: result,
        presentation: { command: [result.command, ...result.args].join(' '), exitCode: result.exitCode },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, text: message, error: message }
    }
  }
}

async function runCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CliRunResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { command, args, exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const e = error as Error & { code?: number | string; stdout?: string; stderr?: string }
    if (typeof e.code === 'number') {
      return { command, args, exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// http
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpEndpoint {
  name: string
  description: string
  parameters: Record<string, unknown>
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string | ((args: Record<string, unknown>) => string)
  query?: (args: Record<string, unknown>) => Record<string, string | number | boolean | undefined>
  body?: (args: Record<string, unknown>) => unknown
  headers?: Record<string, string>
  timeoutMs?: number
  mutates?: boolean
  group?: string
}

export interface HttpAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  baseUrl: string
  headers?: Record<string, string>
  healthPath?: string
  endpoints: HttpEndpoint[]
  unsupported?: string[]
}

export class HttpAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: HttpAdapterOptions
  private disposers: Array<() => void | Promise<void>> = []
  private started = false

  constructor(options: HttpAdapterOptions) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'http', options.source)
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, this.options.endpoints.map((endpoint) => endpoint.name), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    try {
      const service = toolsOf(host)
      for (const endpoint of this.options.endpoints) {
        this.disposers.push(service.register({
          name: endpoint.name,
          description: endpoint.description,
          parameters: endpoint.parameters,
          ...(endpoint.mutates === undefined ? {} : { mutates: endpoint.mutates }),
          ...(endpoint.group === undefined ? {} : { group: endpoint.group }),
          ...(endpoint.timeoutMs === undefined ? {} : { timeoutMs: endpoint.timeoutMs }),
          handler: (args, _ctx, call) => this.call(endpoint, args, call),
        }))
      }
      this.started = true
    } catch (error) {
      await this.disposeAll()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.disposeAll()
    this.started = false
  }

  private async disposeAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
  }

  async health(): Promise<AdapterHealth> {
    if (!this.started) return health(false, 'stopped')
    if (!this.options.healthPath) return health(true, 'ready')
    try {
      const response = await fetch(urlOf(this.options.baseUrl, this.options.healthPath), {
        headers: this.options.headers,
        signal: AbortSignal.timeout(10_000),
      })
      return response.ok
        ? health(true, 'healthy')
        : health(false, 'unhealthy', `${response.status} ${response.statusText}`)
    } catch (error) {
      return health(false, 'unhealthy', error instanceof Error ? error.message : String(error))
    }
  }

  private async call(endpoint: HttpEndpoint, args: Record<string, unknown>, call?: ToolCall): Promise<ToolResult> {
    const path = typeof endpoint.path === 'function' ? endpoint.path(args) : endpoint.path
    const url = new URL(urlOf(this.options.baseUrl, path))
    for (const [key, value] of Object.entries(endpoint.query?.(args) ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const method = endpoint.method ?? 'GET'
    const timeout = endpoint.timeoutMs ?? 30_000
    const signal = call?.signal
      ? AbortSignal.any([call.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout)
    try {
      const response = await fetch(url, {
        method,
        headers: { ...this.options.headers, ...endpoint.headers, ...(endpoint.body ? { 'content-type': 'application/json' } : {}) },
        ...(endpoint.body ? { body: JSON.stringify(endpoint.body(args)) } : {}),
        signal,
      })
      const text = await response.text()
      const value = parseBody(text, response.headers.get('content-type'))
      const output = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return {
        ok: response.ok,
        text: response.ok ? output : `${response.status} ${response.statusText}\n${output}`,
        ...(response.ok ? {} : { error: `${response.status} ${response.statusText}` }),
        value: { status: response.status, headers: Object.fromEntries(response.headers), body: value },
        presentation: { method, url: url.toString(), status: response.status },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, text: message, error: message }
    }
  }
}

function urlOf(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null
  if (contentType?.includes('json')) {
    try { return JSON.parse(text) } catch { return text }
  }
  return text
}


// ─────────────────────────────────────────────────────────────────────────────
// ui
// ─────────────────────────────────────────────────────────────────────────────

export interface UiAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  entry: string
  slots: string[]
  platforms?: Array<'web' | 'desktop' | 'mobile'>
  root?: string
  unsupported?: string[]
}

/**
 * UI 适配器只做静态校验和生命周期报告。
 *
 * 真正的页面加载由宿主读取 package.json 的 meng.client 后完成；
 * 适配器不复制前端代码，也不自己注入 DOM。
 */
export class UiAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: UiAdapterOptions
  private started = false

  constructor(options: UiAdapterOptions) {
    if (options.slots.length === 0) throw new Error('UiAdapter 至少需要一个 slot')
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'ui', options.source)
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    const entry = this.entry()
    const available = existsSync(entry)
    return {
      ...report(
        this.id,
        this.source,
        [],
        available ? (this.options.unsupported ?? []) : [...(this.options.unsupported ?? []), 'client bundle 不存在'],
      ),
      client: {
        available,
        entry,
        slots: [...this.options.slots],
      },
    }
  }

  async start(_host: AdapterHostContext): Promise<void> {
    const entry = this.entry()
    if (!existsSync(entry)) throw new Error(`UI client bundle 不存在: ${entry}`)
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  async health(): Promise<AdapterHealth> {
    const entry = this.entry()
    if (!this.started) return health(false, 'stopped')
    return existsSync(entry)
      ? health(true, 'ready')
      : health(false, 'missing-client', entry)
  }

  private entry(): string {
    return resolve(this.options.root ?? '.', this.options.entry)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sidecar / mcp shared JSON-RPC process channel
// ─────────────────────────────────────────────────────────────────────────────

interface RpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

class JsonRpcProcess {
  private child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private buffer = ''
  private stderr = ''
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  private readonly command: string
  private readonly args: string[]
  private readonly options: { cwd?: string; env?: Record<string, string> }

  constructor(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ) {
    this.command = command
    this.args = args
    this.options = options
  }

  start(): void {
    if (this.child) return
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192)
    })
    this.child.once('error', (error) => {
      this.rejectAll(`sidecar 启动/运行失败: ${error.message}${this.stderr ? `\n${this.stderr}` : ''}`)
      this.child = undefined
    })
    this.child.once('exit', (code, signal) => {
      this.rejectAll(`sidecar 已退出 code=${String(code)} signal=${String(signal)}${this.stderr ? `\n${this.stderr}` : ''}`)
      this.child = undefined
    })
  }

  alive(): boolean {
    return Boolean(this.child && this.child.exitCode === null)
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child) throw new Error('sidecar 尚未启动')
    if (signal?.aborted) throw new Error('请求已取消')
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC ${method} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      const abort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`RPC ${method} 已取消`))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      })
      this.child!.stdin.write(`${payload}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) throw new Error('sidecar 尚未启动')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private rejectAll(detail: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`RPC #${id} 失败: ${detail}`))
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) return
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (!line) continue
      let message: RpcResponse
      try { message = JSON.parse(line) as RpcResponse } catch { continue }
      if (typeof message.id !== 'number') continue
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(message.error.message || `RPC 错误 ${message.error.code ?? ''}`))
      } else {
        entry.resolve(message.result)
      }
    }
  }
}

export interface SidecarTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  method: string
  params?: (args: Record<string, unknown>) => unknown
  mapResult?: (result: unknown) => ToolResult
  mutates?: boolean
  group?: string
  timeoutMs?: number
}

export interface SidecarAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  tools: SidecarTool[]
  healthMethod?: string
  timeoutMs?: number
  unsupported?: string[]
}

export class SidecarAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: SidecarAdapterOptions
  private readonly rpc: JsonRpcProcess
  private disposers: Array<() => void | Promise<void>> = []
  private started = false

  constructor(options: SidecarAdapterOptions) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'sidecar', options.source)
    this.rpc = new JsonRpcProcess(options.command, options.args ?? [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, this.options.tools.map((tool) => tool.name), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    this.rpc.start()
    try {
      const service = toolsOf(host)
      for (const tool of this.options.tools) {
        this.disposers.push(service.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.mutates === undefined ? {} : { mutates: tool.mutates }),
          ...(tool.group === undefined ? {} : { group: tool.group }),
          ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
          handler: async (args, _ctx, call) => {
            try {
              const result = await this.rpc.request(
                tool.method,
                tool.params?.(args) ?? args,
                tool.timeoutMs ?? this.options.timeoutMs ?? 30_000,
                call?.signal,
              )
              return tool.mapResult?.(result) ?? { ok: true, text: stringify(result), value: result }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return { ok: false, text: message, error: message }
            }
          },
        }))
      }
      this.started = true
    } catch (error) {
      await this.disposeAll()
      await this.rpc.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.disposeAll()
    await this.rpc.stop()
    this.started = false
  }

  async health(): Promise<AdapterHealth> {
    if (!this.started || !this.rpc.alive()) return health(false, 'stopped')
    if (!this.options.healthMethod) return health(true, 'running')
    try {
      await this.rpc.request(this.options.healthMethod, {}, 10_000)
      return health(true, 'healthy')
    } catch (error) {
      return health(false, 'unhealthy', error instanceof Error ? error.message : String(error))
    }
  }

  private async disposeAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
  }
}

export interface McpAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  protocolVersion?: string
  timeoutMs?: number
  unsupported?: string[]
}

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class McpAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: McpAdapterOptions
  private readonly rpc: JsonRpcProcess
  private disposers: Array<() => void | Promise<void>> = []
  private tools: McpToolDefinition[] = []
  private capabilities: { resources?: unknown; prompts?: unknown } = {}
  private started = false

  constructor(options: McpAdapterOptions) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'mcp', options.source)
    this.rpc = new JsonRpcProcess(options.command, options.args ?? [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, this.tools.map((tool) => toolName(tool.name)), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    this.rpc.start()
    try {
      const initialized = await this.rpc.request('initialize', {
        protocolVersion: this.options.protocolVersion ?? '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'meng', version: '0.0.0' },
      }, this.options.timeoutMs ?? 30_000, host.signal) as {
        capabilities?: { resources?: unknown; prompts?: unknown }
      }
      this.capabilities = initialized?.capabilities ?? {}
      this.rpc.notify('notifications/initialized')
      const listed = await this.rpc.request('tools/list', {}, this.options.timeoutMs ?? 30_000, host.signal) as {
        tools?: McpToolDefinition[]
      }
      this.tools = Array.isArray(listed?.tools) ? listed.tools : []
      const service = toolsOf(host)
      for (const tool of this.tools) {
        const name = toolName(tool.name)
        this.disposers.push(service.register({
          name,
          description: tool.description || `MCP 工具 ${tool.name}`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
          handler: async (args, _ctx, call) => {
            try {
              const result = await this.rpc.request('tools/call', {
                name: tool.name,
                arguments: args,
              }, this.options.timeoutMs ?? 60_000, call?.signal)
              return mcpResult(result)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return { ok: false, text: message, error: message }
            }
          },
        }))
      }
      const prefix = toolName(this.id)
      if (this.capabilities.resources) {
        this.disposers.push(service.register({
          name: `${prefix}_resources_list`,
          description: '列出 MCP resources',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          handler: async (_args, _ctx, call) => this.mcpCall('resources/list', {}, call?.signal),
        }))
        this.disposers.push(service.register({
          name: `${prefix}_resource_read`,
          description: '读取 MCP resource',
          parameters: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
          handler: async (args, _ctx, call) => this.mcpCall('resources/read', { uri: String(args.uri ?? '') }, call?.signal),
        }))
      }
      if (this.capabilities.prompts) {
        this.disposers.push(service.register({
          name: `${prefix}_prompts_list`,
          description: '列出 MCP prompts',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          handler: async (_args, _ctx, call) => this.mcpCall('prompts/list', {}, call?.signal),
        }))
        this.disposers.push(service.register({
          name: `${prefix}_prompt_get`,
          description: '获取 MCP prompt',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
            required: ['name'],
            additionalProperties: false,
          },
          handler: async (args, _ctx, call) => this.mcpCall('prompts/get', {
            name: String(args.name ?? ''),
            arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {},
          }, call?.signal),
        }))
      }
      this.started = true
    } catch (error) {
      await this.disposeAll()
      await this.rpc.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.disposeAll()
    await this.rpc.stop()
    this.started = false
  }

  async health(): Promise<AdapterHealth> {
    return this.started && this.rpc.alive() ? health(true, 'running') : health(false, 'stopped')
  }

  private async disposeAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
  }

  private async mcpCall(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
      const result = await this.rpc.request(method, params, this.options.timeoutMs ?? 60_000, signal)
      return mcpResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, text: message, error: message }
    }
  }
}

function toolName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe || 'mcp_tool'
}

function mcpResult(result: unknown): ToolResult {
  const record = result !== null && typeof result === 'object' ? result as {
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  } : undefined
  const text = (record?.content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
  return {
    ok: record?.isError !== true,
    text: text || stringify(result),
    value: result,
    ...(record?.isError === true ? { error: text || 'MCP 工具返回错误' } : {}),
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}


// ─────────────────────────────────────────────────────────────────────────────
// worker
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerReady {
  type: 'ready'
  tools: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
    mutates?: boolean
    group?: string
    timeoutMs?: number
  }>
}

interface WorkerResponse {
  type: 'response'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export interface WorkerAdapterOptions {
  id: string
  source?: Omit<ProjectSource, 'kind'>
  entry: string | URL
  workerData?: unknown
  timeoutMs?: number
  supervise?: boolean
  restartDelayMs?: number
  maxRestarts?: number
  /** Worker 异常退出时回调；用于宿主遥测，不参与重启决策。 */
  onCrash?: (reason: string) => void
  unsupported?: string[]
}

/**
 * Worker 隔离后端。工具代码只跑在线程里，主线程只持有 RPC 句柄。
 * 停止后同一入口可重新启动新 Worker，实现不重启宿主的后端热替换。
 */
export class WorkerAdapter implements ProjectAdapter {
  readonly id: string
  readonly source: ProjectSource
  private readonly options: WorkerAdapterOptions
  private worker: Worker | undefined
  private tools: WorkerReady['tools'] = []
  private disposers: Array<() => void | Promise<void>> = []
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private started = false
  private restartTimer: NodeJS.Timeout | undefined
  private restartAttempts = 0

  constructor(options: WorkerAdapterOptions) {
    this.id = options.id
    this.options = options
    this.source = sourceOf(options.id, 'sidecar', options.source)
  }

  async inspect(): Promise<AdapterCapabilityReport> {
    return report(this.id, this.source, this.tools.map((tool) => tool.name), this.options.unsupported ?? [])
  }

  async start(host: AdapterHostContext): Promise<void> {
    if (this.started) return
    try {
      const ready = await this.spawnAndWait()
      this.tools = ready.tools
      const service = toolsOf(host)
      for (const tool of ready.tools) {
        this.disposers.push(service.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.mutates === undefined ? {} : { mutates: tool.mutates }),
          ...(tool.group === undefined ? {} : { group: tool.group }),
          ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
          handler: async (args, _ctx, call) => {
            try {
              const value = await this.request('call', tool.name, args, call?.signal)
              return { ok: true, text: stringify(value), value }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return { ok: false, text: message, error: message }
            }
          },
        }))
      }
      this.started = true
      this.restartAttempts = 0
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    for (const dispose of this.disposers.reverse()) await dispose()
    this.disposers = []
    this.rejectAll('worker 已停止')
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
  }

  async health(): Promise<AdapterHealth> {
    if (!this.started) return health(false, 'stopped')
    if (!this.worker) return health(false, 'restarting', 'worker 崩溃，正在重启')
    try {
      const value = await this.request('health', undefined, undefined) as AdapterHealth
      return value
    } catch (error) {
      return health(false, 'unhealthy', error instanceof Error ? error.message : String(error))
    }
  }

  private async spawnAndWait(): Promise<WorkerReady> {
    const worker = new Worker(this.options.entry, {
      ...(this.options.workerData === undefined ? {} : { workerData: this.options.workerData }),
    })
    this.worker = worker
    worker.on('message', (message: WorkerReady | WorkerResponse) => this.onMessage(message))
    worker.on('error', (error) => this.onWorkerFailure(error.message))
    worker.on('exit', (code) => this.onWorkerFailure(`worker 已退出 code=${code}`))
    return await new Promise<WorkerReady>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('worker 就绪超时')), this.options.timeoutMs ?? 30_000)
      const onReady = (message: WorkerReady) => {
        if (message.type !== 'ready') return
        clearTimeout(timer)
        worker.off('message', onReady)
        resolvePromise(message)
      }
      worker.on('message', onReady)
      worker.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  private onWorkerFailure(reason: string): void {
    const activeWorker = this.worker !== undefined
    if (activeWorker) this.worker = undefined
    if (activeWorker && this.started) {
      try { this.options.onCrash?.(reason) } catch { /* 遥测失败不能影响重启 */ }
    }
    this.rejectAll(reason)
    if (!this.started || !this.options.supervise) return
    if (this.restartAttempts >= (this.options.maxRestarts ?? 3)) return
    if (this.restartTimer) return
    this.restartAttempts++
    const delay = this.options.restartDelayMs ?? 500
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.started) return
      void this.spawnAndWait().then((ready) => {
        this.tools = ready.tools
        this.restartAttempts = 0
      }).catch(() => this.onWorkerFailure('worker 自动重启失败'))
    }, delay)
  }

  private request(type: 'call' | 'health', name?: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('worker 正在重启'))
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'))
    const id = this.nextId++
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${type} 超时`))
      }, this.options.timeoutMs ?? 60_000)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('请求已取消'))
      }, { once: true })
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      this.worker!.postMessage({ type, id, ...(name ? { name } : {}), ...(args ? { args } : {}) })
    })
  }

  private onMessage(message: WorkerReady | WorkerResponse): void {
    if (message.type !== 'response') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(message.error || 'worker 请求失败'))
  }

  private rejectAll(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }
}
