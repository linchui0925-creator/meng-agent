/**
 * @meng/plugin-bash-local —— 本机 bash 执行器, 对位 dsh-bash-local。
 *
 * 它是 @meng/exec 这条缝的**实现**, 不是工具。工具包 (tool-bash) 只认缝,
 * 永远不该知道这里有 spawn、有 setTimeout、有 spill 文件。
 *
 * 职责边界 (抄 dsh 的切法):
 *   这一层管: 超时怎么算、环境怎么净化、argv 长什么样、输出怎么缓冲、溢出往哪落。
 *   这一层不管: 非零退出算不算失败、要不要审批、给模型看什么措辞。
 *
 * 三个数分开, 别混:
 *   timeoutMs       120000 (上限 600000)   超时
 *   maxOutputBytes   64000                 给模型看的窗口 —— 超出丢**头部**, 留尾部
 *   maxSpillBytes  1000000                 落盘能存多少 —— 超出就认了, 不再假装有全量
 * 为什么窗口留尾部: 编译错误、测试结论、最终报错都在末尾, 开头是几百行进度。
 * dsh 的 description 里那句 "truncated to its tail" 说的就是这件事。
 *
 * 为什么不在这层 import @meng/spill: 和 tool-bash 认 spill 是同一套办法 ——
 * 结构性匹配 (有 dir/relDir/locator 就当它是落盘仓库)。想要个裸执行器的人,
 * 不该被迫连落盘仓库一起装。没装 spill 就如实报"截断了且全量已丢"。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { sandboxRoot } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import {
  ExecError,
  EXEC_CODE,
  getExec,
  provideExec,
  type ExecProcess,
  type ExecRead,
  type ExecRequest,
  type ExecResult,
  type ExecService,
  type ExecSpec,
  type ExecStream,
} from '@meng/exec'

export const name = 'meng-plugin-bash-local'
export const inject: string[] = []

export interface Config {
  /**
   * 显式覆盖缺省工作目录。不写就用工作区根 (`@meng/config` 的 sandbox.root) ——
   * 所以正常情况下不需要配它, 它是给测试和特殊部署留的出口。
   *
   * 允许传函数: 工作区可以在设置页里改, 缺省目录得跟着走。传字符串意味着
   * "启动那一刻的工作区"被绑死在这个执行器实例上。
   */
  cwd?: string | (() => string)
  timeoutMs?: number
  maxTimeoutMs?: number
  /** 给模型看的窗口 (字节, 保留尾部) */
  maxOutputBytes?: number
  /** 落盘上限 (字节)。0 = 不落盘, 只截断 */
  maxSpillBytes?: number
  /** SIGTERM 到 SIGKILL 之间给多久清理 (抄 dsh / OpenCode 的 3s) */
  graceMs?: number
  /** 附加环境变量, 优先级高于净化项 */
  env?: Record<string, string>
}

/**
 * 模型友好的环境净化 (dsh 与 Codex 硬编码的同一组):
 * 颜色转义码、分页器、交互式终端特性会把工具输出弄花。
 * 大多数 CLI 检测到非 TTY 就自己关了, 但这依赖对方实现 ——
 * dsh 是显式钉死而不是赌, 这里照做。
 */
const ENV_OVERRIDES: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/**
 * 落盘仓库的结构类型。只用三个成员, 因为只需要这三个:
 * 往哪写、路径怎么拼、那句取回说明怎么写
 */
interface SpillSink {
  readonly dir: string
  readonly relDir: string
  locator(ref: { id: string; rel: string; path: string; bytes: number; createdAt: number }): string
}

/** 一次读的结果。text 是增量, nextOffset 是下次该从哪读 */
interface StreamRead {
  text: string
  lossy: boolean
  nextOffset: number
  /** 整条流的全量落盘位置 (相对工作区) */
  spillRel?: string
}

/**
 * 一条流的缓冲: 内存里留**尾部窗口**, 溢出后同步落盘。
 *
 * 为什么溢出要同步写文件而不是攒到最后再落:
 *   攒着 = 内存里放着全量。一个 `yes` 或者 `find /` 就能把进程撑死。
 *   dsh 在 subprocess 层也是这个做法 (openSync + writeSync), 溢出即写。
 *
 * 为什么淘汰的是头部: 结论在末尾。淘汰按字节剔, 单块超预算就切这块的头部。
 */
class StreamCollector {
  total = 0

  private maxBytes: number
  private maxSpillBytes: number
  private spill: SpillSink | undefined
  private tool: string
  private chunks: Buffer[] = []
  private bytes = 0
  private spillFd: number | undefined
  private spillRel: string | undefined
  private spillDropped = false

  constructor(options: {
    maxBytes: number
    maxSpillBytes: number
    spill: SpillSink | undefined
    /** 落盘文件名里的工具段: 'bash' / 'bash-err'。要和 spill 的解析规则一致 */
    tool: string
  }) {
    this.maxBytes = Math.max(1, options.maxBytes)
    this.maxSpillBytes = options.maxSpillBytes
    this.spill = options.spill
    this.tool = options.tool
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    // 一旦开了头就一直写: 输出是连续的, 不能"这段写那段不写"
    if (this.spill && !this.spillDropped && (overflows || this.spillFd !== undefined)) {
      this.writeSpill(chunk)
    }

    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      if (!head) break
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
    }
  }

  /**
   * 从整个流的字节坐标读增量。fromByte 已滑出窗口 = lossy,
   * 这时返回整个保留窗口, 缺的那段只能去落盘文件里找
   */
  read(fromByte: number): StreamRead {
    const windowStart = this.total - this.bytes
    const lossy = fromByte < windowStart
    let buf: Buffer
    if (lossy) {
      // 窗口头部那条边界多半切在多字节字符中间, 不修就吐出半个字
      buf = trimLeadingPartial(Buffer.concat(this.chunks))
    } else {
      const skip = fromByte - windowStart
      const whole = Buffer.concat(this.chunks)
      buf = skip >= whole.length ? Buffer.alloc(0) : whole.subarray(skip)
    }
    return {
      text: buf.toString('utf8'),
      lossy,
      nextOffset: this.total,
      ...(this.spillRel ? { spillRel: this.spillRel } : {}),
    }
  }

  /** 进程结束后调用: 关句柄, 但**不删文件** —— 模型还要去读 */
  seal(): void {
    if (this.spillFd === undefined) return
    const fd = this.spillFd
    this.spillFd = undefined
    try {
      closeSync(fd)
    } catch {
      // 关不掉就当它没写全: 不再对外声称有全量, 免得给模型一个半截文件
      this.spillRel = undefined
    }
  }

  private writeSpill(chunk: Buffer): void {
    const sink = this.spill
    if (!sink) return
    // 全量超过落盘上限: 删掉半截文件, 之后不再声称有全量。
    // 留一个"只有前 1MB"的文件比没有文件更糟 —— 模型会当成完整输出用
    if (this.maxSpillBytes > 0 && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      const opened = openSpillFile(sink, this.tool)
      if (!opened) {
        this.spillDropped = true
        return
      }
      this.spillFd = opened.fd
      this.spillRel = opened.rel
      // 开文件那一刻把已经攒下的补写进去, 否则文件缺开头
      for (const prior of this.chunks) writeSync(opened.fd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  private discardSpill(): void {
    const fd = this.spillFd
    const rel = this.spillRel
    this.spillFd = undefined
    this.spillRel = undefined
    this.spillDropped = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 已关 */
      }
    }
    if (rel && this.spill) {
      try {
        unlinkSync(join(this.spill.dir, rel.slice(this.spill.relDir.length + 1)))
      } catch {
        /* 已被清理 */
      }
    }
  }
}

/** 去掉开头的 UTF-8 续字节 (0b10xxxxxx) —— 头部被切断时留下的半个字符 */
function trimLeadingPartial(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    i++
  }
  return i === 0 ? buf : buf.subarray(i)
}

/**
 * 文件名要和 @meng/spill 的解析规则对齐 (`YYYYMMDD-<tool>-<id>.txt`),
 * 否则它的 list() 会把 tool 报错, prune 也跟着错
 */
function openSpillFile(sink: SpillSink, tool: string): { fd: number; rel: string } | undefined {
  try {
    mkdirSync(sink.dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10).split('-').join('')
    const id = randomUUID().slice(0, 8)
    const file = `${stamp}-${tool}-${id}.txt`
    const fd = openSync(join(sink.dir, file), 'wx', 0o600)
    return { fd, rel: `${sink.relDir}/${file}`.split('\\').join('/') }
  } catch {
    return undefined
  }
}

/** 落盘位置 → 给模型看的那一行。措辞统一走 spill 的 locator */
function locatorOf(rel: string, bytes: number, sink: SpillSink | undefined): string | undefined {
  if (!sink) return undefined
  const file = rel.slice(sink.relDir.length + 1)
  const id = file.replace(/\.txt$/, '').split('-').pop() ?? 'out'
  return sink.locator({ id, rel, path: join(sink.dir, file), bytes, createdAt: Date.now() })
}

/** 一条落定的流 → 结果里的 ExecStream */
function toStream(read: StreamRead, sink: SpillSink | undefined): ExecStream {
  const spillPath = read.spillRel ? locatorOf(read.spillRel, read.nextOffset, sink) : undefined
  return {
    text: read.text,
    truncated: read.lossy,
    ...(spillPath ? { spillPath } : {}),
  }
}

/** 一次 spawn 的句柄: 三个方法够用, 不多包一层抽象 */
interface Spawned {
  child: ChildProcess
  stdout: StreamCollector
  stderr: StreamCollector
  /** 收掉**整个进程组**。只杀 shell 会留下子孙进程 (npm 起的 node 就是典型) */
  terminate(signal: NodeJS.Signals): void
  /** 永不 reject: 起不来也以 error 字段结算, 让调用方自己决定怎么算 */
  settled: Promise<{ code: number | null; signal: string | null; error?: Error }>
}

class LocalBashExecutor implements ExecService {
  readonly maxTimeoutMs: number

  private cwdOf: () => string
  private timeoutMs: number
  private maxOutputBytes: number
  private maxSpillBytes: number
  private graceMs: number
  private env: Record<string, string>
  private spill: SpillSink | undefined
  private running = new Set<Spawned>()

  constructor(config: Config, spill: SpillSink | undefined) {
    this.spill = spill
    // cwd 由外部传进来 (apply 里用 sandboxRoot 取), 这里不再自己读 env ——
    // "工作区在哪"是全进程一个事实, 而这个事实可以中途变 (设置页里改),
    // 所以存成函数, 每次 resolve 请求现算
    const cwd = config.cwd
    this.cwdOf = typeof cwd === 'function' ? () => resolve(cwd()) : () => resolve(cwd ?? process.cwd())
    this.timeoutMs = config.timeoutMs ?? 120_000
    this.maxOutputBytes = config.maxOutputBytes ?? 64_000
    this.maxSpillBytes = config.maxSpillBytes ?? 1_000_000
    this.graceMs = config.graceMs ?? 3000
    this.env = config.env ?? {}
    this.maxTimeoutMs = config.maxTimeoutMs ?? 600_000
    if (!(this.timeoutMs > 0)) throw new Error('bash-local: timeoutMs 必须是正数')
    if (!(this.maxTimeoutMs >= this.timeoutMs)) throw new Error('bash-local: maxTimeoutMs 不能小于 timeoutMs')
  }

  resolve(request: ExecRequest): ExecSpec {
    if (typeof request.command !== 'string' || request.command.trim().length === 0) {
      throw new ExecError(EXEC_CODE.INVALID, 'command 不能为空')
    }
    const timeoutMs = request.timeoutMs ?? this.timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ExecError(EXEC_CODE.INVALID, `timeoutMs 必须是正数, 收到 ${String(request.timeoutMs)}`)
    }
    // 超上限是**压到上限**, 不是报错: 模型写 99999999 是想"尽量久", 不是想失败
    return {
      command: request.command,
      workdir: request.workdir ? resolve(this.cwdOf(), request.workdir) : this.cwdOf(),
      timeoutMs: Math.min(timeoutMs, this.maxTimeoutMs),
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.maxOutputBytes,
      env: { ...ENV_OVERRIDES, ...this.env, ...request.env },
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    }
  }

  async run(spec: ExecSpec): Promise<ExecResult> {
    return await this.runArgv(spec, ['bash', '-c', spec.command])
  }

  start(spec: ExecSpec): ExecProcess {
    const spawned = this.spawnArgv(spec, ['bash', '-c', spec.command])
    // 必须记账。不记的话 dispose() 遍历不到它 —— 后台进程不随轮次结束,
    // 会话关了它还在跑, 最后靠进程退出兜底也没有人收, 留下一堆孤儿
    this.running.add(spawned)
    return new BackgroundProc(spawned, spec, this.spill, () => this.running.delete(spawned))
  }

  /** 卸载时不留孤儿: 还在跑的进程组全部收掉 */
  dispose(): void {
    for (const spawned of this.running) spawned.terminate('SIGKILL')
    this.running.clear()
  }

  private async runArgv(spec: ExecSpec, argv: string[]): Promise<ExecResult> {
    if (spec.signal?.aborted) {
      // 还没起就被取消: 不 spawn, 直接给一个干净的中断结果
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      }
    }

    const spawned = this.spawnArgv(spec, argv)
    this.running.add(spawned)

    let timedOut = false
    let aborted = false
    const graceTimers: NodeJS.Timeout[] = []

    // 协作式超时: 先 TERM 给清理机会, grace 后再 KILL (抄 dsh / OpenCode)
    const stop = (): void => {
      spawned.terminate('SIGTERM')
      const t = setTimeout(() => spawned.terminate('SIGKILL'), this.graceMs)
      t.unref()
      graceTimers.push(t)
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, spec.timeoutMs)

    const onAbort = (): void => {
      aborted = true
      stop()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const outcome = await spawned.settled
      // 起不来是**基础设施失败**, 这里才 reject。非零退出不是
      if (outcome.error) {
        throw new ExecError(EXEC_CODE.SPAWN_FAILED, `启动失败: ${outcome.error.message}`)
      }
      return {
        exitCode: outcome.code,
        signal: outcome.signal,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: toStream(spawned.stdout.read(0), this.spill),
        stderr: toStream(spawned.stderr.read(0), this.spill),
      }
    } finally {
      clearTimeout(timer)
      for (const t of graceTimers) clearTimeout(t)
      spec.signal?.removeEventListener('abort', onAbort)
      this.running.delete(spawned)
      spawned.stdout.seal()
      spawned.stderr.seal()
    }
  }

  private spawnArgv(spec: ExecSpec, argv: string[]): Spawned {
    const shared = {
      maxBytes: spec.stdoutMaxBytes,
      maxSpillBytes: this.maxSpillBytes,
      spill: this.spill,
    }
    const stdout = new StreamCollector({ ...shared, tool: 'bash' })
    // stderr 的文件名带 -err: spill 的 parseName 按 '-' 切, 'bash-err' 仍是合法 tool
    const stderr = new StreamCollector({ ...shared, tool: 'bash-err' })

    // detached = 新进程组, 这样才能 kill(-pid) 一锅端。
    // Windows 上没有 POSIX 进程组语义, 留给将来的 pwsh 执行器处理
    const groupKill = process.platform !== 'win32'
    const wantsStdin = spec.stdin !== undefined

    const child = spawn(argv[0] ?? 'bash', argv.slice(1), {
      cwd: spec.workdir,
      env: { ...process.env, ...spec.env },
      detached: groupKill,
      // 不写 stdin 就 ignore: 继承一个永不关闭的管道会让 `cat` 这类命令
      // 一直等到超时 —— 这是"bash 工具莫名卡 30 秒"最常见的来源
      stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    if (wantsStdin && child.stdin) {
      child.stdin.end(spec.stdin)
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    const terminate = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (groupKill) process.kill(-pid, signal)
        else child.kill(signal)
      } catch {
        // 进程组已经没了 (或从没建起来), 退回只杀 shell
        try {
          child.kill(signal)
        } catch {
          /* 已退出 */
        }
      }
    }

    const settled = new Promise<{ code: number | null; signal: string | null; error?: Error }>((done) => {
      let finished = false
      const finish = (value: { code: number | null; signal: string | null; error?: Error }): void => {
        if (finished) return
        finished = true
        done(value)
      }
      child.on('error', (err: Error) => finish({ code: null, signal: null, error: err }))
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({ code, signal })
      })
    })

    return { child, stdout, stderr, terminate, settled }
  }
}

/** stdout/stderr 合成一次 ExecRead；增量读和尾部快照共用同一套格式。 */
function toExecRead(out: StreamRead, err: StreamRead): ExecRead {
  const sep = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
  return {
    delta: err.text.length > 0 ? `${out.text}${sep}[stderr]\n${err.text}` : out.text,
    lossy: out.lossy || err.lossy,
    ...(out.spillRel ? { stdoutSpillPath: out.spillRel } : {}),
    ...(err.spillRel ? { stderrSpillPath: err.spillRel } : {}),
  }
}

/**
 * 后台进程句柄。@meng/jobs 的实现把它当生产者交出去 ——
 * 这一层只负责"一个后台进程怎么读怎么写怎么杀", 不负责编号、围栏和通知
 */
class BackgroundProc implements ExecProcess {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | string | null = null

  readonly done: Promise<ExecResult>

  private spawned: Spawned
  private spill: SpillSink | undefined
  private onSettle: () => void
  private outOffset = 0
  private errOffset = 0

  constructor(spawned: Spawned, _spec: ExecSpec, spill: SpillSink | undefined, onSettle: () => void) {
    this.spawned = spawned
    this.spill = spill
    this.onSettle = onSettle
    // 后台进程没有超时 —— 它存在的理由就是"比超时更久"
    this.done = spawned.settled.then((outcome) => {
      if (this.status === 'running') {
        this.status = outcome.signal !== null || outcome.error !== undefined ? 'killed' : 'completed'
      }
      this.exitCode = outcome.code
      this.signal = outcome.signal
      const stdout = toStream(this.spawned.stdout.read(0), this.spill)
      const stderr = toStream(this.spawned.stderr.read(0), this.spill)
      this.spawned.stdout.seal()
      this.spawned.stderr.seal()
      this.onSettle()
      return {
        exitCode: outcome.code,
        signal: outcome.signal,
        timedOut: false,
        aborted: false,
        timeoutMs: 0,
        stdout,
        stderr,
      }
    })
  }

  readOutput(): ExecRead {
    const out = this.spawned.stdout.read(this.outOffset)
    const err = this.spawned.stderr.read(this.errOffset)
    this.outOffset = out.nextOffset
    this.errOffset = err.nextOffset
    return toExecRead(out, err)
  }

  peekOutput(): ExecRead {
    // offset 0 = 从当前保留窗口的头部读，不推进游标。后台输出本来就保留尾部窗口，
    // 所以这里拿到的就是“现在能给人看的最新内容”，不会抢走模型的增量。
    return toExecRead(this.spawned.stdout.read(0), this.spawned.stderr.read(0))
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.status = 'killed'
    this.spawned.terminate('SIGTERM')
    const t = setTimeout(() => this.spawned.terminate('SIGKILL'), 3000)
    t.unref()
    return true
  }
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  // 落盘仓库可选: 有就用, 没有就只截断。不在这一层写死 @meng/spill
  const spill = ctx.get<SpillSink>('spill')
  // 缺省 cwd 就是工作区根 —— 走统一入口取, 不在这里读 env。
  // 传函数而不是值: 工作区可以在设置页里改, 执行器的缺省目录得跟着走
  const executor = new LocalBashExecutor(
    { ...config, cwd: config.cwd ?? (() => sandboxRoot(ctx)) },
    spill,
  )
  const off = provideExec(ctx, executor)
  return () => {
    executor.dispose()
    off()
  }
}

export const invariant = defineInvariant('@meng/plugin-bash-local', [
  {
    id: 'seam-registered',
    run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      if (typeof exec.run !== 'function' || typeof exec.start !== 'function') throw new Error('exec 缺方法')
      if (!(exec.maxTimeoutMs > 0)) throw new Error('maxTimeoutMs 应为正数')
    },
  },
  {
    // 缝本身是通的: 子作用域注册/注销一轮。@meng/exec 是库不是插件, 挂不进清单,
    // 所以这条只能由挂得上来的实现包替它验
    id: 'seam-registers-and-disposes',
    run(ctx) {
      const scope = ctx.scope('exec-invariant')
      const stub: ExecService = {
        maxTimeoutMs: 1,
        resolve: () => {
          throw new Error('桩不该被调用')
        },
        run: () => {
          throw new Error('桩不该被调用')
        },
        start: () => {
          throw new Error('桩不该被调用')
        },
      }
      const parent = getExec(ctx)
      const off = provideExec(scope, stub)
      if (getExec(scope) !== stub) throw new Error('注册后取不到实现')
      if (parent === stub) throw new Error('子作用域的注册泄漏到了父级')
      off()
      // 注销后不是"变 undefined", 而是**回落到父级** —— scope 的 get 沿链上溯。
      // 写成 !== undefined 就错了: 那等于要求子作用域断掉继承
      if (getExec(scope) === stub) throw new Error('注销后桩还在')
      if (getExec(scope) !== parent) throw new Error('注销后没回落到父级实现')
    },
  },
  {
    // 超上限要压到上限, 而不是报错; 非法值要报错, 而不是悄悄换成默认值
    id: 'resolve-clamps-and-rejects',
    run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const spec = exec.resolve({ command: 'true', timeoutMs: 99_999_999 })
      if (spec.timeoutMs !== exec.maxTimeoutMs) {
        throw new Error(`超上限应压到 ${exec.maxTimeoutMs}, 实际 ${spec.timeoutMs}`)
      }
      const abs = exec.resolve({ command: 'true', workdir: 'sub/dir' })
      if (!abs.workdir.startsWith('/')) throw new Error('workdir 应解析成绝对路径')
      for (const bad of [{ command: '  ' }, { command: 'true', timeoutMs: 0 }, { command: 'true', timeoutMs: -5 }]) {
        try {
          exec.resolve(bad)
          throw new Error(`非法入参竟被接受: ${JSON.stringify(bad)}`)
        } catch (err) {
          if (!(err instanceof ExecError) || err.code !== EXEC_CODE.INVALID) throw err
        }
      }
    },
  },
  {
    // 非零退出是结果, 不是基础设施失败 —— 这是 ExecResult 与 ToolResult 的分界线
    id: 'exit-code-is-a-result',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const result = await exec.run(exec.resolve({ command: 'echo out; echo err >&2; exit 7', timeoutMs: 10_000 }))
      if (result.exitCode !== 7) throw new Error(`exitCode 应为 7, 实际 ${String(result.exitCode)}`)
      if (!result.stdout.text.includes('out')) throw new Error('stdout 丢了')
      if (!result.stderr.text.includes('err')) throw new Error('stderr 没分开收')
      if (result.timedOut || result.aborted) throw new Error('既没超时也没中断, 标记却置位了')
    },
  },
  {
    // stdin 不 ignore 的话 `cat` 会一直等到超时 —— "bash 莫名卡 30 秒"的常见来源
    id: 'stdin-is-ignored',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const started = Date.now()
      const result = await exec.run(exec.resolve({ command: 'cat', timeoutMs: 5000 }))
      if (result.timedOut) throw new Error(`cat 卡住了 ${Date.now() - started}ms: stdin 没有关掉`)
      if (result.exitCode !== 0) throw new Error(`cat 应正常退出, 实际 ${String(result.exitCode)}`)
    },
  },
  {
    id: 'env-is-sanitised',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const result = await exec.run(
        exec.resolve({ command: 'printf "%s|%s|%s" "$TERM" "$NO_COLOR" "$PAGER"', timeoutMs: 5000 }),
      )
      if (result.stdout.text !== 'dumb|1|cat') throw new Error(`环境净化没生效: ${result.stdout.text}`)
    },
  },
  {
    // 截断留尾部: 结论在末尾, 开头是进度
    id: 'truncation-keeps-tail',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const result = await exec.run(
        exec.resolve({ command: 'seq 1 20000', timeoutMs: 20_000, stdoutMaxBytes: 8000 }),
      )
      const out = result.stdout
      if (!out.truncated) throw new Error('10 万字节的输出竟没判截断 (窗口 8000)')
      if (!out.text.trimEnd().endsWith('20000')) throw new Error('尾部丢了 —— 保留了错误的一端')
      if (out.text.startsWith('1\n')) throw new Error('头部没被淘汰, 窗口没起作用')
      if (out.text.includes('\uFFFD')) throw new Error('截断边界切坏了多字节字符')
      if (ctx.get('spill') && !out.spillPath) throw new Error('装了 spill 却没给取回路径')
    },
  },
  {
    id: 'timeout-kills-the-group',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const started = Date.now()
      const result = await exec.run(exec.resolve({ command: 'sleep 5', timeoutMs: 300 }))
      const spent = Date.now() - started
      if (!result.timedOut) throw new Error('超时没被标记')
      if (spent > 3000) throw new Error(`超时后 ${spent}ms 才落定, 进程没被收掉`)
      if (result.exitCode === 0) throw new Error('被杀的进程不该报 exit 0')
    },
  },
  {
    id: 'abort-kills-the-group',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      const result = await exec.run(
        exec.resolve({ command: 'sleep 5', timeoutMs: 30_000, signal: controller.signal }),
      )
      if (!result.aborted) throw new Error('中断没被标记 —— 用户按 ESC 杀不掉子进程')
      if (result.timedOut) throw new Error('中断被误判成超时')
      if (result.exitCode === 0) throw new Error('被中断的进程不该报 exit 0')
    },
  },
  {
    // 后台句柄: 立刻返回 + 增量读 + 不重复
    id: 'start-is-incremental',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const proc = exec.start(
        exec.resolve({ command: 'echo first; sleep 0.3; echo second', timeoutMs: 10_000 }),
      )
      if (proc.status !== 'running') throw new Error('start 应先返回 running')
      await new Promise((r) => setTimeout(r, 600))
      const first = proc.readOutput()
      if (!first.delta.includes('first') || !first.delta.includes('second')) {
        throw new Error(`增量读没拿到输出: ${JSON.stringify(first.delta)}`)
      }
      const again = proc.readOutput()
      if (again.delta !== '') throw new Error(`重复读吐了旧内容: ${JSON.stringify(again.delta)}`)
      const result = await proc.done
      if (result.exitCode !== 0) throw new Error(`后台进程应正常退出, 实际 ${String(result.exitCode)}`)
    },
  },
  {
    // 后台进程必须被 dispose 收掉。少了这一步, 卸载之后它还在跑,
    // 而"任务注册表已经没了", 谁也不知道它存在
    id: 'dispose-kills-background',
    async run(ctx) {
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未注册')
      const scope = ctx.scope('bash-dispose-invariant')
      const off = apply(scope, { cwd: process.cwd() })
      const own = getExec(scope)
      if (!own) throw new Error('子作用域没拿到自己的执行器')
      // 写一个文件当信标: 进程真被杀了, 后半句就不会执行
      const beacon = `/tmp/meng-bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const proc = own.start(own.resolve({ command: `sleep 2; echo alive > ${beacon}`, timeoutMs: 10_000 }))
      if (proc.status !== 'running') throw new Error('后台进程没起来')
      off()
      // 杀是异步的: 等到 done 落定再判状态。用状态字段当"立刻生效"的标志
      // 会误判 —— 它要等 close 事件回来才更新
      await proc.done
      // String() 是为了绕过类型收窄: 上面判过 status === 'running', TS 就
      // 认为它一直是字面量 'running' —— 但 close 事件已经把它改了
      if (String(proc.status) !== 'killed') throw new Error('卸载后后台进程没被标记成 killed')
      await new Promise((r) => setTimeout(r, 2200))
      const { existsSync } = await import('node:fs')
      if (existsSync(beacon)) {
        const { unlinkSync } = await import('node:fs')
        try {
          unlinkSync(beacon)
        } catch {
          /* 尽力清理 */
        }
        throw new Error('卸载时后台进程没被杀掉 —— 它还在后台跑')
      }
    },
  },
])
