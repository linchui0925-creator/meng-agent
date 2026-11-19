/**
 * @meng/plugin-tool-jobs —— 后台任务的控制面。对位 dsh-tool-jobs。
 *
 * 三个工具, 一个通知:
 *   job_output  读增量 (可选 wait 等落定)   ← 模型主动来取
 *   job_list    这个会话有哪些任务         ← 迷路了用它找
 *   job_kill    不要了, 停掉               ← 别让它白跑
 *   onJobDone   落定时往会话塞一条事件      ← 没人等的时候主动告诉它
 *
 * 为什么通知要做成"会话事件"而不是直接开一轮:
 *   我们没有 agent 的 idle/busy 状态机 (dsh 有, 它能在空闲时主动唤醒)。
 *   硬造一个"完成就自动说一句话"的效果, 会导致模型在用户没说话时自己开口 ——
 *   那是产品级灾难。退一步做成事件: 落定 → 落进会话流 → 下一轮模型自然看见。
 *   用户下一句话进来时, 模型已经知道"那个活完了"。
 *
 * 为什么 wait 的超时不算错误:
 *   `job_output wait:true timeout_ms:5000` 的意思是"我等 5 秒, 没完就算了"。
 *   抛异常会让模型以为任务坏了, 于是重试一次 —— 而任务其实好好的。
 *   所以超时返回一个 [status: running] 的快照, 让模型自己决定要不要继续等。
 *
 * 和 policy-timeout 的关系: 这三个工具**不声明** timeoutMs。
 *   声明了就会在 wait 期间被外层截止时间改判成"工具超时", 而真相是
 *   "任务还在跑"。等待预算归 wait 自己的 timeout_ms 参数管。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import {
  JOBS_CODE,
  JobError,
  getJobs,
  type JobService,
  type JobSnapshot,
} from '@meng/jobs'
import type { PromptService } from '@meng/prompt'
import type { SessionService } from '@meng/session'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-jobs'
export const inject = ['tools', 'jobs']

export interface Config {
  /** wait 缺省等多久 */
  waitTimeoutMs?: number
  /** wait 最多能等多久 (模型传更大的值会被压到这里) */
  maxWaitTimeoutMs?: number
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

function statusLine(job: JobSnapshot): string {
  return job.detail === undefined ? `[status: ${job.status}]` : `[status: ${job.status}, ${job.detail}]`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** JobError 是"我用错了", 别的话是环境坏了 —— 原因要说给模型听, 别吞掉 */
function explain(err: unknown): string {
  if (err instanceof JobError) {
    // 两种错都要指路: 光说"不行", 模型只会换个写法再撞一次
    if (err.code === JOBS_CODE.UNKNOWN) return `${err.message} (用 job_list 看看有哪些)`
    if (err.code === JOBS_CODE.FORBIDDEN) return `${err.message} (用 job_list 查你自己的任务)`
  }
  return errText(err)
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const jobs = getJobs(ctx)
  if (!jobs) throw new Error('能力面 jobs 未装载 —— 后台任务工具需要它')
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const session = ctx.get<SessionService>('session')
  const prompt = ctx.get<PromptService>('prompt')

  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  if (waitDefault > waitCap) {
    throw new Error(`waitTimeoutMs (${waitDefault}) 不能大于 maxWaitTimeoutMs (${waitCap})`)
  }

  const offs: Disposer[] = []

  // ── 通知: 开跑 / 落定各落一条进会话流 ──────────────────────
  // 只处理"有主"的任务: 无主任务没有会话可送 (单机 CLI 下模型自己会来读)
  //
  // 两条事件的语义差别很大, 别混:
  //   job/started   有人开始了活 —— 前端拿它画"运行中"的任务条 (之前完全没有这个信号)
  //   job/completed 已经结束了、而且没人正等着 —— 它是**结论**, 也是模型该知道的事实
  offs.push(
    ctx.effect(() =>
      jobs.onJobStart((job) => {
        if (!session) return
        const target = job.ownerSession
        if (target === undefined) return
        session.append(target, 'job/started', job)
      }),
    ),
  )

  offs.push(
    ctx.effect(() =>
      jobs.onJobDone((job) => {
        if (!session) return
        const target = job.ownerSession
        if (target === undefined) return
        session.append(target, 'job/completed', job)
      }),
    ),
  )

  // ── 提示词: 告诉模型怎么对待后台任务 ──────────────────────
  // 不写这段的话, 模型会 sleep 等它 —— 把后台任务用成前台任务,
  // 既占着轮次又浪费一次工具调用
  if (prompt) {
    offs.push(
      ctx.effect(() =>
        prompt.section({
          id: 'tool:jobs',
          order: 106,
          render: () =>
            [
              '你可以把长命令放到后台跑 (bash 的 run_in_background), 拿到一个 job_id。',
              '规则:',
              '- 记住你起的每个 job_id。别为了等它而 sleep 或空转 —— 去干下一件独立的事。',
              '- 它跑完时你会收到一条 [后台任务 ... 已结束] 的消息。不要主动去猜它是否结束。',
              '- 给用户最终答复之前, 用 job_output 把还相关的任务收一遍 (只有真的被它挡住时才 wait)。',
              '- 不再需要的任务用 job_kill 停掉, 别让它白跑。',
            ].join('\n'),
        }),
      ),
    )
  }

  // ── job_output ────────────────────────────────────────────
  const outputDef: ToolDef = {
    name: 'job_output',
    // 后台任务三件套单独一组: 没起过后台任务的会话用不上它们
    group: 'jobs',
    description:
      '读取后台任务的输出。**增量**的: 每次只返回上次读到之后的新内容。' +
      '默认不阻塞; wait:true 会等到它结束或超时 (超时返回 [status: running], 任务仍然活着)。' +
      '每次返回末尾都带 [status: ...]',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '起任务时拿到的 id (如 bash-1)' },
        wait: { type: 'boolean', description: '阻塞等到它结束 (或 timeout_ms 用完)' },
        timeout_ms: { type: 'number', description: `wait 的最长毫秒数, 默认 ${waitDefault}, 上限 ${waitCap}` },
      },
      required: ['job_id'],
    },
    async handler(args, _ctx, call): Promise<ToolResult> {
      const id = String(args.job_id ?? '').trim()
      if (!id) return fail('缺参数 job_id')
      const caller = { ...(call?.sessionId ? { sessionId: call.sessionId } : {}) }

      if (args.wait === true) {
        const raw = Number(args.timeout_ms)
        const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, waitCap) : waitDefault
        try {
          await jobs.wait(id, timeoutMs, caller, call?.signal)
        } catch (err) {
          // 用户按了 ESC: 任务没被取消, 只是"这次不等了"。这两件事必须说清楚,
          // 否则模型会以为任务死了, 去重跑一遍
          if (call?.signal?.aborted) {
            const partial = safeRead(jobs, id, caller)
            return partial === undefined
              ? ok(`等待被用户取消。任务 ${id} 仍在后台运行, 输出未知 —— 稍后用 job_output 再读。`)
              : ok(`${partial}\n[等待被用户取消; 任务仍在后台运行]`)
          }
          return fail(`job_output 失败: ${explain(err)}`)
        }
      }

      try {
        const out = jobs.read(id, caller)
        const body = out.text.length > 0 ? out.text.trimEnd() : '(无新输出)'
        const lossy = out.lossy
          ? out.spillPath
            ? `\n[中间有内容滑出了内存窗口; 全量: ${out.spillPath}]`
            : '\n[中间有内容滑出了内存窗口, 且没有落盘 —— 这段取不回来了]'
          : ''
        return ok(`${body}${lossy}\n${statusLine(out.job)}`)
      } catch (err) {
        return fail(`job_output 失败: ${explain(err)}`)
      }
    },
  }

  // ── job_list ──────────────────────────────────────────────
  const listDef: ToolDef = {
    name: 'job_list',
    // 后台任务三件套单独一组: 没起过后台任务的会话用不上它们
    group: 'jobs',
    description: '列出这个会话的后台任务 (跑着的和已结束的), 带 id、种类和状态。',
    parameters: { type: 'object', properties: {} },
    handler(_args, _ctx, call): ToolResult {
      const caller = { ...(call?.sessionId ? { sessionId: call.sessionId } : {}) }
      const all = jobs.list(caller)
      if (all.length === 0) return ok('(没有后台任务)')
      // 跑着的排前面: 模型找的是"还有哪些在跑"
      const rank = (j: JobSnapshot) => (j.status === 'running' || j.status === 'stopping' ? 0 : 1)
      const lines = [...all]
        .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)
        .map((j) => `${j.id} [${j.kind}] ${j.status}${j.detail ? ` (${j.detail})` : ''} — ${j.label}`)
      return ok(lines.join('\n'))
    },
  }

  // ── job_kill ──────────────────────────────────────────────
  const killDef: ToolDef = {
    name: 'job_kill',
    // 后台任务三件套单独一组: 没起过后台任务的会话用不上它们
    group: 'jobs',
    description:
      '请求停掉一个后台任务。立刻返回 —— 任务在真正停下之后才会变成 killed, ' +
      '期间状态是 stopping。已经结束的任务会告诉你 already-finished。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '要停的任务 id' },
        reason: { type: 'string', description: '为什么不要它了 (会记进任务状态)' },
      },
      required: ['job_id'],
    },
    mutates: true,
    handler(args, _ctx, call): ToolResult {
      const id = String(args.job_id ?? '').trim()
      if (!id) return fail('缺参数 job_id')
      const caller = { ...(call?.sessionId ? { sessionId: call.sessionId } : {}) }
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined
      try {
        const outcome = jobs.kill(id, caller, reason)
        const job = jobs.get(id, caller)
        return ok(
          outcome === 'already-finished'
            ? `${id} 早就结束了 ${statusLine(job)}`
            : `已请求停止 ${id} ${statusLine(job)}。它会在真正停下后变成 killed; 现在别重复起同样的活。`,
        )
      } catch (err) {
        return fail(`job_kill 失败: ${explain(err)}`)
      }
    },
  }

  for (const def of [outputDef, listDef, killDef]) {
    offs.push(ctx.effect(() => tools.register(def)))
  }

  return () => {
    for (const off of offs.reverse()) off()
  }
}

/** 取消等待时顺手把已经产生的输出带出去 —— 半截日志比一句话有用 */
function safeRead(
  jobs: JobService,
  id: string,
  caller: { sessionId?: string },
): string | undefined {
  try {
    const out = jobs.read(id, caller)
    if (out.text.length === 0) return undefined
    return `${out.text.trimEnd()}\n${statusLine(out.job)}`
  } catch {
    return undefined
  }
}

export const invariant = defineInvariant('@meng/plugin-tool-jobs', [
  {
    id: 'three-tools-registered',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      const names = tools.list().map((t) => t.name)
      for (const want of ['job_output', 'job_list', 'job_kill']) {
        if (!names.includes(want)) throw new Error(`缺工具 ${want}`)
      }
    },
  },
  {
    // 通知必须落进会话流, 而且只对"有主"的任务发
    id: 'completion-lands-in-session',
    async run(ctx) {
      const jobs = getJobs(ctx)
      const tools = ctx.get<ToolService>('tools')
      const session = ctx.get<SessionService>('session')
      if (!jobs || !tools || !session) throw new Error('依赖的能力面缺失')

      const sessionId = 'inv-jobs-notice'
      const events: Array<{ type: string; data: unknown }> = []
      const off = ctx.on('session/event', (e: { sessionId: string; type: string; data: unknown }) => {
        if (e.sessionId === sessionId) events.push({ type: e.type, data: e.data })
      })

      let finish: (s: { status: 'completed'; detail?: string }) => void = () => {}
      const done = new Promise<{ status: 'completed'; detail?: string }>((resolve) => {
        finish = resolve
      })
      const id = jobs.start({
        kind: 'inv',
        label: '通知用任务',
        ownerSession: sessionId,
        run: () => ({ done, readOutput: () => ({ text: 'done!\n', lossy: false }) }),
      })
      finish({ status: 'completed', detail: 'exit code: 0' })
      // 别 wait: 一 wait 就变成"有人等结果", 通知按设计就不发了
      await new Promise<void>((r) => setTimeout(r, 0))

      off()
      const notice = events.find((e) => e.type === 'job/completed')
      if (!notice) throw new Error('任务落定没有落进会话流')

      // 通知要能被投影成模型看得懂的一句话, 否则等于没发
      const projected = session.project(sessionId)
      const text = projected
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
      if (!text.includes(`后台任务 ${id}`)) throw new Error(`投影里没有这条通知: ${text.slice(0, 120)}`)
      if (!text.includes('job_output')) throw new Error('通知没告诉模型下一步怎么做')
    },
  },
  {
    // 开跑事件的三条契约: ① 一定在落定**之前**落进会话流 ② 形状与落定同构
    // (status=running, 有 startedAt, 没有 finishedAt) ③ **不投影**给模型 ——
    // 模型刚拿到 job_id, 再告诉它"你起了个活"纯属噪音
    id: 'start-event-precedes-completion',
    async run(ctx) {
      const jobs = getJobs(ctx)
      const session = ctx.get<SessionService>('session')
      if (!jobs || !session) throw new Error('依赖的能力面缺失')
      // 会话 id 必须**每次唯一**: 会话流会被 persistence 回放,
      // 固定 id 的话上一次启动留下的 job/completed 会出现在这次 project() 里,
      // 于是"开跑时还没结束"这条断言被历史数据打成假红
      const sessionId = `inv-jobs-start-${Math.random().toString(36).slice(2, 8)}`
      const seen: Array<{ type: string; data: unknown }> = []
      const off = ctx.on('session/event', (e: { sessionId: string; type: string; data: unknown }) => {
        if (e.sessionId === sessionId) seen.push({ type: e.type, data: e.data })
      })
      let finish: (s: { status: 'completed' }) => void = () => {}
      const done = new Promise<{ status: 'completed' }>((resolve) => {
        finish = resolve
      })
      try {
        const id = jobs.start({
          kind: 'inv',
          label: '开跑事件',
          ownerSession: sessionId,
          run: () => ({ done }),
        })

        const started = seen.find((e) => e.type === 'job/started')
        if (!started) throw new Error('开跑没有落进会话流 —— 界面看不到"有个命令在跑"')
        if (seen.some((e) => e.type === 'job/completed')) {
          throw new Error('断言点不对: 落定已经发生了, 这次测不出"先后"')
        }

        const snap = started.data as {
          id?: string
          status?: string
          startedAt?: number
          finishedAt?: number
        }
        if (snap.id !== id) throw new Error(`事件里的 id 不是 ${id}, 是 ${String(snap.id)}`)
        if (snap.status !== 'running') throw new Error(`开跑时 status 应当是 running, 实际 ${String(snap.status)}`)
        if (snap.finishedAt !== undefined) throw new Error('running 的任务不该有 finishedAt')
        if (typeof snap.startedAt !== 'number') throw new Error('开跑快照缺 startedAt, 前端排不了序')

        // 此刻还没落定: 消息流里不该出现"后台任务 <id>" —— 那是 completed 才有的投影
        const text = session
          .project(sessionId)
          .flatMap((m) => m.content)
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
        if (text.includes(`后台任务 ${id}`)) throw new Error(`job/started 被投影成了消息, 模型会收到噪音: ${text.slice(0, 200)}`)
      } finally {
        finish({ status: 'completed' })
        off()
      }
    },
  },
  {
    // 读过的任务不该再收到"完成"通知 —— 那会让模型以为自己漏了什么
    id: 'read-job-does-not-notify',
    async run(ctx) {
      const jobs = getJobs(ctx)
      const session = ctx.get<SessionService>('session')
      if (!jobs || !session) throw new Error('依赖的能力面缺失')
      const sessionId = 'inv-jobs-quiet'
      let notices = 0
      const off = ctx.on('session/event', (e: { sessionId: string; type: string }) => {
        if (e.sessionId === sessionId && e.type === 'job/completed') notices++
      })
      let finish: (s: { status: 'completed' }) => void = () => {}
      const done = new Promise<{ status: 'completed' }>((resolve) => {
        finish = resolve
      })
      const id = jobs.start({
        kind: 'inv',
        label: '有人等着的任务',
        ownerSession: sessionId,
        run: () => ({ done }),
      })
      // 先等再结束 = 模型一直在等它, 结果从 wait 的返回值里拿
      const waiting = jobs.wait(id, 1000, { sessionId })
      finish({ status: 'completed' })
      await waiting
      off()
      if (notices !== 0) throw new Error(`读过/等过的任务仍发了 ${notices} 条通知`)
    },
  },
  {
    // 围栏在工具层也要成立: 模型不能靠猜 id 去读别的会话的任务
    id: 'tools-respect-the-fence',
    async run(ctx) {
      const jobs = getJobs(ctx)
      const tools = ctx.get<ToolService>('tools')
      if (!jobs || !tools) throw new Error('依赖的能力面缺失')
      let finish: (s: { status: 'completed' }) => void = () => {}
      const done = new Promise<{ status: 'completed' }>((resolve) => {
        finish = resolve
      })
      const id = jobs.start({
        kind: 'inv',
        label: '别人的任务',
        ownerSession: 'sess-owner',
        run: () => ({ done }),
      })
      const stolen = await tools.call({
        id: 'inv-steal',
        name: 'job_output',
        args: { job_id: id },
        sessionId: 'sess-thief',
      })
      if (stolen.ok) throw new Error('别的会话竟读到了任务输出')
      if (!String(stolen.error).includes('job_list')) throw new Error('拒绝时没指路')
      const mine = await tools.call({
        id: 'inv-mine',
        name: 'job_output',
        args: { job_id: id },
        sessionId: 'sess-owner',
      })
      if (!mine.ok) throw new Error(`主人自己读不到: ${mine.error ?? ''}`)
      finish({ status: 'completed' })
      await jobs.wait(id, 1000, { sessionId: 'sess-owner' })
    },
  },
  {
    // wait 超时必须返回 running, 不能报错: 报错会让模型以为任务坏了去重跑
    id: 'wait-timeout-returns-running',
    async run(ctx) {
      const jobs = getJobs(ctx)
      const tools = ctx.get<ToolService>('tools')
      if (!jobs || !tools) throw new Error('依赖的能力面缺失')
      const owner = { sessionId: 'inv-wait' }
      let finish: (s: { status: 'killed' }) => void = () => {}
      const done = new Promise<{ status: 'killed' }>((resolve) => {
        finish = resolve
      })
      const id = jobs.start({
        kind: 'inv',
        label: '不会自己结束的任务',
        // 有主 + 能落定: 不然这条检查会往部署的账本里留一个永远 stopping 的记录,
        // 模型 job_list 时就会看到它
        ownerSession: owner.sessionId,
        run: () => ({
          done,
          cancel: () => {
            finish({ status: 'killed' })
            return true
          },
        }),
      })
      const at = Date.now()
      const result = await tools.call({ id: 'inv-wait', name: 'job_output', args: { job_id: id, wait: true, timeout_ms: 60 }, sessionId: owner.sessionId })
      const spent = Date.now() - at
      if (!result.ok) throw new Error(`wait 超时被当成失败: ${result.error ?? ''}`)
      if (!result.text.includes('[status: running]')) throw new Error(`没告诉模型它还在跑: ${result.text}`)
      if (spent > 1000) throw new Error(`wait 没被 timeout_ms 截住, 花了 ${spent}ms`)
      jobs.kill(id, owner)
      await jobs.wait(id, 1000, owner)
    },
  },
])
