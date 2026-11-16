/**
 * @meng/plugin-tool-bash —— bash 的**薄壳**。对位 dsh-tool-bash。
 *
 * 它只做三件事: 参数 schema、申报完整性校验、把 ExecResult 渲染成模型看到的话。
 * 执行一行都不在这里 —— spawn / 超时 / 缓冲 / 落盘 / 环境净化全在 @meng/exec
 * 的实现包里 (本机是 plugin-bash-local)。这一层不知道命令是怎么跑起来的,
 * 换 pwsh、换沙箱、换容器执行器, 这个文件一行都不用改。
 *
 * 参数原样抄 dsh (连它 camelCase 的 quirk 也抄):
 *   command              必填
 *   description          必填, 5-10 个词 —— 不是走形式, 是让模型在执行前
 *                        把意图说出来, 策略/审批/日志都有东西可看
 *   timeoutMs            默认 30000, 上限取 exec.maxTimeoutMs
 *   workdir              相对工作区, 围栏内
 *   sandbox_permissions  'workspace-write' | 'danger-full-access'
 *   justification        与 sandbox_permissions 成对: 申报越权必须写理由,
 *                        缺一即校验错 —— 这是"让模型自己申报"取代"猜命令"
 *
 * ── 什么算失败 (抄 dsh, 这条最容易写反) ──
 *   非零退出      不算。grep 没匹配返回 1、git diff --quiet 发现改动返回 1,
 *                 都是**结果**。渲染成 `[exit code: 1]` 让模型自己判断
 *   超时          不算。渲染成一行标记, 但输出照给 —— 三十秒的构建日志
 *                 比"超时了"这三个字有用得多
 *   被用户中止    算。命令是被人叫停的, 不是自己跑完的
 *   spawn 失败    算。bash 不在 PATH / 权限不足, 基础设施的错
 *   参数不合法    算。这是模型用错了工具, 明说是让它改参数
 *
 * 默认注册 (和 dsh 一致, 不再像旧 terminal 那样 opt-in)。
 * 危险控制不在工具里, 在 policy-bash —— 工具只校验申报的完整性。
 *
 * run_in_background 只在装了 jobs 能力面时**才出现在 schema 里**。
 * 参数存在但用不了比参数不存在更糟: 模型会试一次, 拿到一个失败, 然后
 * 开始猜是不是别的写法。dsh 也是这么处理的 (enableRunInBackground: false 就移除参数)。
 *
 * 后台分支有一处必须写对: **不把轮次的中止信号带进执行器**。
 * 前台命令跟着 ESC 走是对的 (用户就是不想等它了); 后台任务跟着走是反的 ——
 * 它存在的理由就是跨轮次活着。带了信号, 用户按一次 ESC 就把它杀了。
 */

import { resolve } from 'node:path'
import { sandboxRoot } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import {
  ExecError,
  EXEC_CODE,
  getExec,
  type ExecResult,
  type ExecService,
  type ExecSpec,
  type ExecStream,
} from '@meng/exec'
import { getJobs, type JobService } from '@meng/jobs'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-bash'
/** 认缝不认实现: 没有 executor 就装不上来, 装上来就一定是能跑的 */
export const inject = ['tools', 'exec']

export interface Config {
  // 工作区根 (workdir 的围栏基准) 由 @meng/config 统一给, 见 sandboxRoot()
  /** 缺省超时。上限不在这里配 —— 那是 executor 的事, 问它要 */
  timeoutMs?: number
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

/**
 * 一次执行 → 模型看到的那段话。顺序和措辞抄 dsh 的 renderResult:
 * stdout → [stderr] → 超时/信号 → 退出码 → 截断取回。
 *
 * 为什么截断说明放在最后: 模型先看到内容, 再看到"还有更多在哪"。
 * 反过来它会先去找文件, 而多数时候保留的尾部已经够用了
 */
function render(result: ExecResult): string {
  const parts: string[] = [result.stdout.text.trimEnd()]

  if (result.stderr.text.trim().length > 0) {
    parts.push(`[stderr]\n${result.stderr.text.trimEnd()}`)
  }

  if (result.timedOut) parts.push(`[命令在 ${result.timeoutMs}ms 后被中断]`)
  if (result.aborted) parts.push('[已被用户中止]')
  if (result.signal) parts.push(`[被信号 ${result.signal} 终止]`)

  // 非零退出是**结果**, 不是失败。这一行是模型唯一的判断依据, 别省
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
    parts.push(`[exit code: ${result.exitCode}]`)
  }

  parts.push(...marker(result.stdout, 'stdout'), ...marker(result.stderr, 'stderr'))

  return parts.filter((p) => p.length > 0).join('\n') || '(无输出)'
}

function marker(stream: ExecStream, label: string): string[] {
  if (!stream.truncated) return []
  // 落盘位置由 executor 给 —— 这一层不知道文件在哪, 也不该知道
  return stream.spillPath
    ? [`[${label} 已截断, 保留的是尾部; 全量: ${stream.spillPath}]`]
    : [`[${label} 已截断, 保留的是尾部; 全量无法取回]`]
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const exec = getExec(ctx)
  if (!exec) throw new Error('能力面 exec 未装载 —— bash 需要一个执行器')

  const defaultTimeoutMs = config.timeoutMs ?? 30_000
  // 上限问 executor 要, 不在这里再配一份。两处都写迟早漂移,
  // 而且"工具说能 600s、执行器只给 60s"是最难查的一类问题
  const maxTimeoutMs = exec.maxTimeoutMs
  // jobs 可有可无: 没有它 bash 只是不能进后台, 前台照常能用
  const jobs = getJobs(ctx)

  function startBackground(service: JobService, executor: ExecService, command: string, spec: ExecSpec, sessionId: string | undefined): ToolResult {
    try {
      const id = service.start({
        kind: 'bash',
        label: labelOf(command),
        ...(sessionId ? { ownerSession: sessionId } : {}),
        run() {
          const proc = executor.start(spec)
          return {
            done: proc.done.then((result) => ({
              // 后台任务的"失败"只有一种: 被信号收掉。非零退出和超时都是结果
              status: result.signal !== null ? ('killed' as const) : ('completed' as const),
              detail: exitDetail(result),
            })),
            readOutput() {
              const chunk = proc.readOutput()
              return {
                text: chunk.delta,
                lossy: chunk.lossy,
                ...(chunk.stdoutSpillPath ? { spillPath: chunk.stdoutSpillPath } : {}),
              }
            },
            cancel() {
              return proc.kill()
            },
          }
        },
      })
      return ok(
        `已在后台启动: ${id}\n命令: ${command}\n` +
          '它不随这一轮结束而停止。用 job_output 读增量输出, job_kill 停掉它。' +
          '不要 sleep 等它 —— 去干别的事, 它结束时会有一条消息。',
      )
    } catch (err) {
      return fail(`启动后台任务失败: ${errText(err)}`)
    }
  }

  function fenceWorkdir(input: unknown): string {
    // **每次调用现读根**: 工作区在设置页里改了, 下一条命令就按新根跑。
    // 抓成常量的话, 改完工作区命令还在旧目录里跑, 而界面上只有"工作区已保存"
    const root = sandboxRoot(ctx)
    const raw = String(input ?? '')
    if (!raw) return root
    const abs = resolveRoot(raw, root)
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      throw new Error(`workdir 越界: ${raw} 不在工作区内`)
    }
    return abs
  }

  const properties: Record<string, unknown> = {
    command: { type: 'string', description: '要执行的命令' },
    description: { type: 'string', description: '这条命令做什么 (5-10 个词, 必填)' },
    timeoutMs: { type: 'number', description: `超时毫秒数, 默认 ${defaultTimeoutMs}, 上限 ${maxTimeoutMs}` },
    workdir: { type: 'string', description: '相对工作区的执行目录, 缺省为工作区根' },
    sandbox_permissions: {
      type: 'string',
      enum: ['workspace-write', 'danger-full-access'],
      description: '权限申报。默认 workspace-write; 申报 danger-full-access 必须搭配 justification',
    },
    justification: { type: 'string', description: '越权理由, 与 sandbox_permissions 成对出现' },
  }
  // 参数只在真能用的时候才露出来 —— 见文件头
  if (jobs) {
    properties.run_in_background = {
      type: 'boolean',
      description:
        '放到后台跑, 立刻返回一个 job_id (如 bash-1)。用于构建 / 测试 / 安装这类要几分钟的命令。' +
        '它不随这一轮结束而停止, timeoutMs 对后台无效 —— 用 job_output / job_kill 管它',
    }
  }

  const def: ToolDef = {
    name: 'bash',
    description:
      `在工作区内执行 shell 命令, 默认 ${defaultTimeoutMs / 1000}s 超时。` +
      'description 必填 (5-10 个词, 说清楚这条命令做什么); 需要越过工作区写权限时, ' +
      'sandbox_permissions 与 justification 必须成对申报。非零退出是正常结果 (会标 [exit code: N]), ' +
      '不是失败 —— 只有命令起不来或被中止才算失败' +
      (jobs ? '。需要几分钟的命令用 run_in_background, 别占着这一轮等' : ''),
    parameters: {
      type: 'object',
      properties,
      required: ['command', 'description'],
    },
    mutates: true,

    async handler(args, _ctx, call): Promise<ToolResult> {
      // ── 申报完整性校验: 成对规则缺一即错 ──
      const command = String(args.command ?? '')
      if (!command) return fail('缺参数 command')
      const description = String(args.description ?? '').trim()
      const words = description.split(/\s+/).filter(Boolean)
      if (!words.length) return fail('缺参数 description —— 先说清楚这条命令做什么')
      if (words.length < 2) return fail(`description 太短 ("${description}"): 用 5-10 个词说明意图`)

      const perm = args.sandbox_permissions
      if (perm !== undefined && perm !== 'workspace-write' && perm !== 'danger-full-access') {
        return fail(`非法 sandbox_permissions: ${String(perm)} (只能是 workspace-write / danger-full-access)`)
      }
      const justification = String(args.justification ?? '').trim()
      if (perm === 'danger-full-access' && !justification) {
        return fail('申报 danger-full-access 必须搭配 justification (为什么需要越权)')
      }
      if (justification && !perm) {
        return fail('justification 必须搭配 sandbox_permissions 一起申报')
      }

      let workdir: string
      try {
        workdir = fenceWorkdir(args.workdir)
      } catch (err) {
        return fail(`bash 失败: ${errText(err)}`)
      }

      const raw = Number(args.timeoutMs)
      const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, maxTimeoutMs) : defaultTimeoutMs

      const background = args.run_in_background === true
      if (background && !jobs) {
        return fail('这个部署没有后台任务能力 —— 去掉 run_in_background, 当前台命令跑')
      }

      let spec
      try {
        spec = exec.resolve({
          command,
          workdir,
          // 后台任务不设超时 —— 它存在的理由就是比超时更久。给个上限只是为了让
          // resolve 的校验过去, BackgroundProc 拿到之后根本不看它
          timeoutMs: background ? maxTimeoutMs : timeoutMs,
          // 把轮次的中止信号接进执行器 —— 不接的话用户按 ESC, 子进程还在跑。
          // **后台任务例外**: 它要跨轮次活着, 带上信号会被一次 ESC 一起收走
          ...(!background && call?.signal ? { signal: call.signal } : {}),
        })
      } catch (err) {
        return fail(`bash 参数不合法: ${errText(err)}`)
      }

      if (background && jobs) {
        return startBackground(jobs, exec, command, spec, call?.sessionId)
      }

      try {
        const result = await exec.run(spec)
        // 只有"命令没跑起来 / 被人叫停"才判失败。非零退出与超时都进 render。
        // 中止也要把已产生的输出带出去: 半截构建日志是模型重试的唯一依据
        if (result.aborted) {
          return { ok: false, text: render(result), error: '命令已被中止' }
        }
        return ok(render(result))
      } catch (err) {
        if (err instanceof ExecError && err.code === EXEC_CODE.SPAWN_FAILED) {
          return fail(`bash 起不来: ${err.message}`)
        }
        return fail(`bash 执行失败: ${errText(err)}`)
      }
    },
  }

  const off = ctx.effect(() => tools.register(def))
  return () => {
    off()
  }
}

/**
 * 把模型给的一个路径解析到工作区内 —— **注意这个和 `@meng/config` 的
 * `resolveRoot(scope)` 不是一回事**, 只是名字撞了:
 * 那个回答"工作区在哪", 这个回答"这条相对路径落在工作区的哪"。
 * 前者本文件用的是 `sandboxRoot(ctx)`。
 */
function resolveRoot(input: string, base?: string): string {
  return posix(resolve(base ?? '.', input))
}

/** 后台任务的标签: 命令压成一行再截断。模型和用户都靠它认任务 */
function labelOf(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
}

/** 终态说明。语义和前台一致: 非零退出是**结果**, 不是失败 */
function exitDetail(result: ExecResult): string {
  if (result.aborted) return '已中止'
  if (result.signal) return `被信号 ${result.signal} 终止`
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return `exit code: ${result.exitCode}`
  return 'exit code: 0'
}

function posix(p: string): string {
  return p.split('\\').join('/')
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const invariant = defineInvariant('@meng/plugin-tool-bash', [
  {
    id: 'tool-registered',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      if (!tools.list().some((t) => t.name === 'bash')) throw new Error('bash 工具未注册')
    },
  },
  {
    // 薄壳不认实现: 工具层零 spawn。这条是"壳有没有被写胖"的守门员 ——
    // 哪天有人在 tool-bash 里 import node:child_process, 这里立刻红
    id: 'shell-is-thin',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      const bash = tools?.list().find((t) => t.name === 'bash')
      if (!bash) throw new Error('bash 工具未注册')
      const src = String(bash.description ?? '')
      if (!src.includes('非零退出')) throw new Error('description 没说清非零退出的语义')
      const exec = getExec(ctx)
      if (!exec) throw new Error('能力面 exec 未装载')
      if (!(exec.maxTimeoutMs > 0)) throw new Error('executor 没给出超时上限')
    },
  },
  {
    // 非零退出必须是**成功结果**, 只是正文里带 [exit code: N]。
    // 这条写反了, 模型会把"grep 没匹配"当成工具坏了
    id: 'nonzero-exit-is-not-an-error',
    async run(ctx) {
      const result = await callBash(ctx, {
        command: 'echo found; echo warn >&2; exit 7',
        description: 'verify nonzero exit renders as result',
      })
      if (!result.ok) throw new Error(`非零退出被当成失败了: ${result.error ?? ''}`)
      if (!result.text.includes('found')) throw new Error('stdout 丢了')
      if (!result.text.includes('warn')) throw new Error('stderr 段丢了')
      if (!result.text.includes('[exit code: 7]')) throw new Error('退出码标记没渲染')
    },
  },
  {
    id: 'success-has-no-error-marker',
    async run(ctx) {
      const result = await callBash(ctx, { command: 'echo hello', description: 'verify clean exit' })
      if (!result.ok) throw new Error(`干净退出竟失败: ${result.error ?? ''}`)
      if (result.text.trim() !== 'hello') throw new Error(`正文不干净: ${JSON.stringify(result.text)}`)
      if (result.text.includes('[exit code:')) throw new Error('exit 0 不该打退出码标记')
    },
  },
  {
    // 超时也算结果: 输出照给。三十秒构建日志比"超时了"有用
    id: 'timeout-is-reported-not-failed',
    async run(ctx) {
      const result = await callBash(ctx, {
        command: 'echo partial; sleep 5',
        description: 'verify timeout keeps partial output',
        timeoutMs: 400,
      })
      if (!result.ok) throw new Error(`超时被当成失败: ${result.error ?? ''}`)
      if (!result.text.includes('partial')) throw new Error('超时后已产生的输出丢了')
      if (!result.text.includes('被中断')) throw new Error('超时标记没渲染')
    },
  },
  {
    // 用户按 ESC 必须能杀掉子进程。这是"壳认缝"的收益: 信号直接透给 executor
    id: 'abort-reaches-the-child',
    async run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      const result = await tools.call({
        id: 'inv-abort',
        name: 'bash',
        args: { command: 'sleep 5', description: 'verify abort kills child' },
        signal: controller.signal,
      })
      if (result.ok) throw new Error('被中止竟算成功')
      if (!result.text.includes('已被用户中止')) throw new Error('中止标记没渲染')
    },
  },
  {
    // 尾部保留: 这条是上一版最大的错 —— 保留开头=丢掉编译结论
    id: 'truncation-keeps-the-tail',
    async run(ctx) {
      const result = await callBash(ctx, {
        command: 'seq 1 20000',
        description: 'verify tail is kept on truncation',
        timeoutMs: 30_000,
      })
      if (!result.ok) throw new Error(`截断竟失败: ${result.error ?? ''}`)
      const at = result.text.indexOf('已截断')
      if (at < 0) throw new Error('大输出没标截断')
      // 尾部必须在**正文里**活着。标记排在正文之后, 所以不能拿 endsWith 判
      const tailAt = result.text.indexOf('19999\n20000')
      if (tailAt < 0) throw new Error('尾部丢了 —— 保留了错误的一端')
      if (at < tailAt) throw new Error('截断标记竟排在正文前面')
      if (result.text.includes('全量无法取回')) throw new Error('装了 spill, 却说取不回全量')
      if (!result.text.includes('全量:')) throw new Error('没给取回路径')
    },
  },
  {
    // 环境净化在 executor 里做, 但要能从工具这一侧看见
    id: 'env-is-sanitised',
    async run(ctx) {
      const result = await callBash(ctx, {
        command: 'printf "%s|%s" "$TERM" "$NO_COLOR"',
        description: 'verify sanitised env',
      })
      if (!result.ok) throw new Error(`失败: ${result.error ?? ''}`)
      if (result.text.trim() !== 'dumb|1') throw new Error(`环境没净化: ${result.text}`)
    },
  },
  {
    // 申报完整性: 缺一即错, 与 dsh 的 validateEscalationArgs 同一套判断
    id: 'escalation-declaration-is-paired',
    async run(ctx) {
      const bad = [
        { command: 'true', description: 'verify pairing', sandbox_permissions: 'danger-full-access' },
        { command: 'true', description: 'verify pairing', justification: '因为没有理由' },
        { command: 'true', description: 'verify pairing', sandbox_permissions: 'root' },
        { command: '', description: 'verify pairing' },
        { command: 'true', description: '' },
        { command: 'true', description: 'short' },
      ]
      for (const args of bad) {
        const result = await callBash(ctx, args)
        if (result.ok) throw new Error(`非法申报竟被接受: ${JSON.stringify(args)}`)
        if (!result.error) throw new Error('失败却没给原因')
      }
    },
  },
  {
    // 工作区围栏: 相对路径可以, 逃出去不行
    id: 'workdir-is-fenced',
    async run(ctx) {
      const outside = await callBash(ctx, {
        command: 'pwd',
        description: 'verify workdir escape is blocked',
        workdir: '/etc',
      })
      if (outside.ok) throw new Error('越界 workdir 竟被接受')
      const inside = await callBash(ctx, { command: 'true', description: 'verify relative workdir', workdir: 'packages' })
      if (!inside.ok) throw new Error(`工作区内的相对 workdir 被拒: ${inside.error ?? ''}`)
    },
  },
  {
    // 后台任务: 立刻返回 id, 输出能通过 job_output 增量读到, 终态是 completed
    id: 'background-job-is-readable',
    async run(ctx) {
      const owner = { sessionId: 'inv-bash' }
      const started = await callBash(ctx, {
        command: 'echo started; sleep 0.25; echo finished',
        description: 'verify background job runs to completion',
        run_in_background: true,
      }, owner.sessionId)
      if (!started.ok) throw new Error(`起不来: ${started.error ?? ''}`)
      const id = /(bash-\d+)/.exec(started.text)?.[1]
      if (!id) throw new Error(`没在正文里给出 job_id: ${started.text.slice(0, 120)}`)

      const jobs = getJobs(ctx)
      if (!jobs) throw new Error('能力面 jobs 未装载')
      const before = jobs.read(id, owner)
      const snap = await jobs.wait(id, 5000, owner)
      const after = jobs.read(id, owner)

      if (snap.status !== 'completed') throw new Error(`应正常结束, 实际 ${snap.status} (${snap.detail ?? ''})`)
      const all = `${before.text}${after.text}`
      if (!all.includes('started') || !all.includes('finished')) {
        throw new Error(`后台输出丢了内容: ${JSON.stringify(all)}`)
      }
      if (all.includes('bash: ') && all.includes('command not found')) throw new Error('命令没跑起来')
    },
  },
  {
    // 后台任务**不跟轮次的中止信号**: 它就是要跨轮次活着。
    // 这条写反了, 用户按一次 ESC 就把跑了一半的构建杀掉了
    id: 'background-ignores-turn-abort',
    async run(ctx) {
      const controller = new AbortController()
      controller.abort()
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      const owner = { sessionId: 'inv-bash-abort' }
      const result = await tools.call({
        id: `inv-bg-abort-${randomId()}`,
        name: 'bash',
        args: { command: 'echo alive', description: 'verify background ignores abort', run_in_background: true },
        signal: controller.signal,
        sessionId: owner.sessionId,
      })
      if (!result.ok) throw new Error(`后台任务被轮次的取消信号干掉了: ${result.error ?? ''}`)
      const id = /(bash-\d+)/.exec(result.text)?.[1]
      if (!id) throw new Error('没返回 job_id')
      const jobs = getJobs(ctx)
      const snap = await jobs?.wait(id, 5000, owner)
      if (snap && snap.status === 'killed') throw new Error('后台任务被中止了')
    },
  },
])

/** 不变量里走工具管线, 而不是直接调 exec —— 验的是"模型实际拿到的那个结果" */
async function callBash(
  ctx: Ctx,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<ToolResult> {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  // 自检起的后台任务要挂在一个专属会话上: 无主的任务会出现在**每个**会话的
  // job_list 里, 模型会把它当成自己的活
  return await tools.call({
    id: `inv-${randomId()}`,
    name: 'bash',
    args,
    ...(sessionId ? { sessionId } : {}),
  })
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}
