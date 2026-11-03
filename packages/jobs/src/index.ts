/**
 * @meng/jobs —— 后台任务的能力面 (seam)。**零实现**。
 *
 * 为什么后台任务需要一条缝, 而不是在 bash 里加个 `if (background)`:
 *   一次前台 bash 调用是有界的 —— 它结束, 工具就返回。后台任务没有尽头:
 *   它跨轮次活着, 模型下一轮还在别处干活, 会话可能早就换了话题。
 *   于是四件和"怎么执行命令"毫无关系的事冒出来:
 *     1. 身份   —— 模型下一条消息只能带一个字符串 (job_id), 不是内存对象
 *     2. 围栏   —— A 会话不能读 B 会话的后台任务。id 是可预测的 (bash-1),
 *                  所以边界是**授权**, 不是保密
 *     3. 通知   —— 它跑完时没人正等着它, 得有一条消息回到会话里
 *     4. 收尾   —— 会话关了、进程要退了, 不能留下一堆孤儿进程
 *   这四件事 pwsh 也要、`web_fetch` 的后台下载也要、将来的子 agent 也要。
 *   塞进 tool-bash 就等于只有 bash 有后台任务, 而且换执行器还得再写一遍。
 *
 * 和 @meng/exec 的分工 (这两条缝最容易混):
 *   exec  管**一个进程**怎么跑起来、怎么杀、输出怎么缓冲
 *   jobs  管**一个任务**怎么被记住、被谁看见、跑完了通知谁
 *   所以 jobs.start 的 run() 里转身去调 exec.start, 而不是自己 spawn。
 *   jobs 不知道 bash 的存在, exec 不知道 job 的存在。
 *
 * 这条缝**不含**的判断 (留在上层):
 *   · 什么算"完成" —— 非零退出对 bash 是结果不是失败, 但让谁去定义?
 *     生产者 (tool-bash) 定义, 它把 ExecResult 翻成 completed/killed/failed
 *   · 要不要后台 —— 模型的意图, 由工具的参数决定
 *   · 输出渲染成什么文字 —— 工具层的 render
 *
 * 不变量 (实现方必须全部满足, jobs-local 的 invariant 逐条验):
 *   1. start 立刻返回 id, 不等人; run() 同步抛错才算起不来
 *   2. done 永不 reject —— 起来之后怎么死都以终态结算, 否则记录会永远 running
 *   3. 落定 first-wins —— 迟到的生产者结果不能把 killed 改回 completed
 *   4. 有 ownerSession 的任务只有同一个 sessionId 能读/杀; 别的会话一律拒
 *   5. read 是增量的, 连续两次读不重复吐同一段
 *   6. 落定时没被读过的任务, 要有一条通知回到会话; 读过的不要再嚷嚷
 */

import type { Ctx, Disposer } from '@meng/core'

/** 能力面名 */
export const JOBS_CAPABILITY = 'jobs'

/**
 * 任务状态。`stopping` 是单独一档而不是布尔: 杀进程是**异步**的
 * (SIGTERM → 宽限 → SIGKILL), 这期间它既不是 running 也不能算 killed。
 * 混成两档就会出现"已经告诉模型杀掉了, 它还在写文件"
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

const TERMINAL: readonly JobStatus[] = ['completed', 'killed', 'failed']

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status)
}

/** 读/杀时的调用方身份。只带 sessionId —— 我们没有比"哪个会话"更强的身份 */
export interface JobCaller {
  sessionId?: string
}

/**
 * 任务对外的一瞥。**永远是快照**, 不是活对象:
 * 调用方拿到之后自己那份不会因为任务继续跑而变化
 */
export interface JobSnapshot {
  /** `<kind>-<n>`, 进程内单调递增。可预测 —— 所以围栏靠授权不靠保密 */
  id: string
  /** 谁家的 ('bash' | 'fetch' | ...)。工具据此决定怎么渲染 */
  kind: string
  /** 人类可读的一句话 (命令前 80 字 / URL), 给列表和通知用 */
  label: string
  status: JobStatus
  /** 终态的补充说明: 'exit code: 1' / '被用户中止' / 失败原因 */
  detail?: string
  /** 归属会话。**没有**这个字段 = 谁都能看见 (单机 CLI 场景) */
  ownerSession?: string
  startedAt: number
  finishedAt?: number
}

/** 一次增量读。字段语义和 ExecRead 一致 —— 但这里不许出现 ExecRead 这个名字 */
export interface JobOutput {
  text: string
  /** 这段之前有内容从内存窗口滑出去了, 只能去 spillPath 取 */
  lossy: boolean
  /** 全量落盘位置 (相对工作区), 模型可以直接 read */
  spillPath?: string
  job: JobSnapshot
}

/**
 * 生产者交出来的东西。三个方法里只有 `done` 是必填 ——
 * 一个 fire-and-forget 的任务 (比如"发个通知") 没有输出也没有可停的东西
 */
export interface JobHooks {
  /** 落定。**永不 reject**: 起不来也要以 failed 结算 */
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
  /** 增量读。不给 = 这个任务没有输出 */
  readOutput?(): { text: string; lossy: boolean; spillPath?: string }
  /** 停。返回 false = 已经停了 / 停不了 */
  cancel?(reason?: string): boolean
}

export interface JobStartSpec {
  /** 非空, 会进 id */
  kind: string
  /** 非空, 给人和模型看 */
  label: string
  /** 有值 = 只有这个会话能读/杀 */
  ownerSession?: string
  /** 起活并交出句柄。**同步抛错才算起不来** */
  run(): JobHooks
}

export interface JobService {
  start(spec: JobStartSpec): string
  /** 当前会话能看见的全部任务 (含已结束的)。不给 caller = 只要无主的 */
  list(caller?: JobCaller): JobSnapshot[]
  get(id: string, caller?: JobCaller): JobSnapshot
  /** 增量读。读到终态 = 视为"已上报", 落定时不再发通知 */
  read(id: string, caller?: JobCaller): JobOutput
  kill(id: string, caller?: JobCaller, reason?: string): 'requested' | 'already-finished'
  /**
   * 等它落定。**超时不是错误** —— 返回一个还是 running 的快照。
   * 这条抄 dsh: `job_output wait:true` 等超时要告诉模型"还在跑", 而不是
   * 抛一个异常让模型以为任务坏了
   */
  wait(id: string, timeoutMs: number, caller?: JobCaller, signal?: AbortSignal): Promise<JobSnapshot>
  /**
   * 开跑监听。**只在 start() 成功之后触发一次**, payload 与落定同形状
   * (status 恒为 'running', 没有 finishedAt)。
   *
   * 为什么要它: 任务是谁起的? 是**模型** (bash 的 run_in_background)。
   * 于是"有个命令已经在跑了"这件事, 用户和界面完全不知情 —— 直到它落定
   * 才有一条通知, 中间那段时间是空白。started 补的就是这段空白。
   *
   * 放注册表而不是放生产者: 注册表知道**所有**任务的诞生 (将来 web_fetch
   * 也能进后台), 生产者各报一次的话, 迟早有人忘了报。
   */
  onJobStart(listener: (job: JobSnapshot) => void): Disposer
  /** 落定监听。返回值是注销函数 —— 不是"订阅 id" */
  onJobDone(listener: (job: JobSnapshot) => void): Disposer
}

/** 稳定的错误码。调用方据此区分"我用错了"和"环境不允许" */
export const JOBS_CODE = {
  /** 任务不存在 (id 拼错 / 重启后记录没了) */
  UNKNOWN: 'JOB_UNKNOWN',
  /** 任务属于别的会话 */
  FORBIDDEN: 'JOB_FORBIDDEN',
  /** 这个会话的后台任务数到上限了 */
  LIMIT: 'JOB_LIMIT',
  /** start 的参数不合法 (空 kind / 空 label / run 同步抛错) */
  INVALID: 'JOB_INVALID',
  /** wait 的超时值不合法 */
  BAD_WAIT: 'JOB_BAD_WAIT',
} as const

export type JobCode = (typeof JOBS_CODE)[keyof typeof JOBS_CODE]

export class JobError extends Error {
  code: JobCode
  constructor(code: JobCode, message: string) {
    super(message)
    this.name = 'JobError'
    this.code = code
  }
}

export function provideJobs(ctx: Ctx, impl: JobService): Disposer {
  return ctx.set<JobService>(JOBS_CAPABILITY, impl)
}

export function getJobs(ctx: Ctx): JobService | undefined {
  return ctx.get<JobService>(JOBS_CAPABILITY)
}
