/**
 * @meng/exec —— 执行外部命令的能力面 (seam)。**零实现**。
 *
 * 为什么这一包必须一行实现都没有:
 *   一次 bash 调用要做七件事, 其中五件 (起进程、超时杀、缓冲、落盘、环境净化)
 *   和 bash 本身毫无关系 —— pwsh 要、Python 沙箱要、docker exec 也要。
 *   把这些塞进能力面, 能力面就变成"唯一的实现", 于是:
 *     · 底下插不进第二个实现 (缝填死了)
 *     · 上面的工具开始依赖具体行为, 换实现就得改工具
 *   所以这里只有类型和一条注册函数。谁执行、怎么执行, 全在实现包里。
 *
 * 和 dsh 的关系 (名字变了, 形状没变):
 *   dsh 这条缝叫 ctx.shell (@deepseek-ai/dsh-shell), 实现是 dsh-bash-local。
 *   我们的 packages/shell 已被前端启动内核 (bootShell) 占用, 不能重名,
 *   所以缝名叫 exec。ShellExecutor / run / resolve / start / readOutput
 *   与 dsh 一一对应, 语义逐条抄在下面。
 *
 * 这条缝**不含**的判断 (留在上层, 别往下塞):
 *   · 非零退出算不算失败 —— 那是工具/模型的事。grep 没匹配返回 1 是结果, 不是错误
 *   · 要不要审批、要不要沙箱升权 —— 那是 policy 插件挂在 tools/pre-execute 上的事
 *   · 结果渲染成什么文字 —— 那是工具层的 render
 * 这条缝**不含**的实现 (留在下层):
 *   · spawn、进程组、缓冲窗口、落盘、环境变量
 *
 * 不变量 (实现方必须全部满足, bash-local 的 invariant 逐条验):
 *   1. run 只在**基础设施失败**时 reject。非零退出 / 超时 / 被中断都 resolve
 *   2. run 的 abort 与 timeout 都必须把**整个进程组**收掉, 不能只杀 shell
 *   3. resolve 之后 spec 的每个字段都必须是确定的 —— run/start 不再二次缺省
 *   4. start 立刻返回; done 永不 reject, 起不来也以 killed 结算
 *   5. readOutput 是增量的, 连续两次读不重复吐同一段
 *   6. 截断保留**尾部**: 编译错误和测试结论在末尾, 开头是几百行进度
 */

import type { Ctx, Disposer } from '@meng/core'

/** 能力面名。故意和包名 @meng/exec 一致, 但和 @meng/shell (前端启动内核) 区分开 */
export const EXEC_CAPABILITY = 'exec'

/**
 * 一条流的最终形态。
 *
 * `truncated` 的含义严格限定为"因为预算被丢掉了本来拿到的内容",
 * 不是"命令本身没输出完"。两者对模型的含义完全不同。
 */
export interface ExecStream {
  /** 模型看到的那段 (保留尾部) */
  text: string
  /** 有内容因为预算被丢了 */
  truncated: boolean
  /**
   * 全量落盘的位置 —— **相对工作区**的路径, 模型可以直接 read 取回。
   * 不落盘就没有这个字段, 不要给绝对临时路径: 模型的 read 有工作区围栏,
   * 给了也读不到, 等于骗它一次
   */
  spillPath?: string
}

/** 一次前台执行的结果。非零退出 / 超时 / 中断都在这里, 都不是异常 */
export interface ExecResult {
  exitCode: number | null
  /** 被哪个信号收掉的 (SIGTERM / SIGKILL / SIGINT); 正常退出为 null */
  signal: NodeJS.Signals | string | null
  timedOut: boolean
  /** 被调用方的 AbortSignal 收掉的 (用户按了 ESC), 与 timedOut 互斥 */
  aborted: boolean
  /** 实际生效的超时值 —— 调用方要能知道"上限被压到多少了" */
  timeoutMs: number
  stdout: ExecStream
  stderr: ExecStream
}

/** 调用方给的请求。字段可以缺, resolve 负责补齐 */
export interface ExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  stdin?: string
  env?: Record<string, string>
  signal?: AbortSignal
  stdoutMaxBytes?: number
}

/** resolve 之后的完整规格。run/start 只接受这个, 不再做任何缺省 */
export interface ExecSpec {
  command: string
  /** 绝对路径 */
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  stdin?: string
  /** 调用方附加的环境变量, 已合并过净化项 */
  env: Record<string, string>
  signal?: AbortSignal
}

/** 一次增量读 */
export interface ExecRead {
  delta: string
  /** 这段 delta 之前有内容从内存窗口滑出去了, 只能去 spillPath 取 */
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

export interface ExecProcess {
  readonly status: 'running' | 'completed' | 'killed'
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | string | null
  /** 落定即 resolve, 永不 reject */
  readonly done: Promise<ExecResult>
  readOutput(): ExecRead
  /** 停掉整个进程组。已经结束返回 false */
  kill(): boolean
}

/**
 * 执行命令的能力面。
 *
 * 刻意是 interface 而不是抽象类: 我们这一层没有"基类提供的共享逻辑"这种东西 ——
 * 一旦有了, 它就成了实现的开始
 */
export interface ExecService {
  /** 部署允许的最大超时。工具拿它做 schema 的上限提示 */
  readonly maxTimeoutMs: number
  /** 补齐缺省 + 校验 + 上限裁剪。校验失败抛 ExecError('EXEC_INVALID') */
  resolve(request: ExecRequest): ExecSpec
  run(spec: ExecSpec): Promise<ExecResult>
  start(spec: ExecSpec): ExecProcess
}

/** 能力面的稳定错误码。工具据此判断"是我用错了"还是"环境坏了" */
export const EXEC_CODE = {
  /** 参数不合法 (空命令 / 非正超时 / 超上限)。调用方的 bug */
  INVALID: 'EXEC_INVALID',
  /** 进程根本没起来 (bash 不在 PATH / 权限不足)。环境的错, 可以重试 */
  SPAWN_FAILED: 'EXEC_SPAWN_FAILED',
} as const

export type ExecCode = (typeof EXEC_CODE)[keyof typeof EXEC_CODE]

export class ExecError extends Error {
  code: ExecCode
  constructor(code: ExecCode, message: string) {
    super(message)
    this.name = 'ExecError'
    this.code = code
  }
}

/**
 * 注册一个实现。整个包就这一行"实现" —— 它也只是 ctx.set 的薄封装,
 * 存在的理由是让能力面名只出现在一个地方, 而不是散在实现包和工具包里
 */
export function provideExec(ctx: Ctx, impl: ExecService): Disposer {
  return ctx.set<ExecService>(EXEC_CAPABILITY, impl)
}

/** 取能力面。工具侧统一走它, 免得每处都写字符串 */
export function getExec(ctx: Ctx): ExecService | undefined {
  return ctx.get<ExecService>(EXEC_CAPABILITY)
}

