/**
 * @meng/plugin-jobs-local —— @meng/jobs 的进程内实现。对位 dsh-jobs-local。
 *
 * 它只做四件事: 编号、记账、围栏、收尾。**不执行任何东西** ——
 * 活是生产者在 run() 里起的 (bash 转身去调 exec.start)。
 *
 * 和 dsh 差在哪 (都是有意的):
 *   · dsh 有 attachController / servesOwner, 因为一个进程里跑多个 agent 组合,
 *     要让"这个组合有没有装任务控制器"可查。我们单进程单组合, 换成一条更硬的
 *     规则: 工具侧先 getJobs(), 没有能力面就**不暴露** run_in_background 参数。
 *     效果一样 (不会出现"起了没人收"的任务), 少一层可配置的错误空间
 *   · dsh 的 owner 是 agent 对象 (带 ctx 做 scope 分层), 我们的 agent 是
 *     无状态的 run() 生成器。所以 owner 退化成 sessionId 字符串 —— 围栏仍然成立,
 *     因为会话就是我们的隔离单位
 *   · dsh 有 wakeup (空闲则开一轮), 我们没有"空闲"这个状态。所以这里只维护
 *     onJobDone 监听, 怎么送到模型由 tool-jobs 决定 (它往会话追加一条事件)
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import {
  JOBS_CODE,
  JobError,
  isTerminal,
  provideJobs,
  type JobCaller,
  type JobHooks,
  type JobOutput,
  type JobService,
  type JobSnapshot,
  type JobStartSpec,
  type JobStatus,
} from '@meng/jobs'

export const name = 'meng-plugin-jobs-local'
export const inject: string[] = []

export interface Config {
  /** 单个会话同时活着的任务上限。抄 dsh 的默认值 */
  maxConcurrentJobsPerOwner?: number
}

/** 内部记录 = 快照 + 生产者句柄 + 等待者。**从不外传**, 外面只拿快照 */
interface JobRecord {
  id: string
  kind: string
  label: string
  ownerSession: string | undefined
  status: JobStatus
  detail: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** 已经有人读过终态 (或亲手杀过) —— 落定时不再发通知 */
  reported: boolean
  hooks: JobHooks
  settled: Promise<void>
  markSettled: () => void
  /** 等落定的挂起点。落定时一次性全部放行 */
  waiters: Set<() => void>
}

const DEFAULT_MAX_PER_OWNER = 10

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const maxPerOwner = config.maxConcurrentJobsPerOwner ?? DEFAULT_MAX_PER_OWNER
  if (!Number.isSafeInteger(maxPerOwner) || maxPerOwner < 1) {
    throw new Error(`maxConcurrentJobsPerOwner 非法: ${maxPerOwner} (要求 >= 1 的整数)`)
  }

  const store = new Map<string, JobRecord>()
  const counters = new Map<string, number>()
  const listeners = new Set<(job: JobSnapshot) => void>()
  /** 开跑监听。与落定监听分开两个集合: 它们的语义不同, 混在一起就只能靠 type 区分 */
  const startListeners = new Set<(job: JobSnapshot) => void>()
  let closed = false

  function snapshot(job: JobRecord): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      ...(job.ownerSession !== undefined ? { ownerSession: job.ownerSession } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    }
  }

  /**
   * 围栏。规则只有一条, 但要写准:
   *   无主任务 (ownerSession 缺失) 谁都能碰 —— 单机 CLI 场景没有会话这回事
   *   有主任务只有**同一个 sessionId** 能碰。`caller?.sessionId` 是 undefined
   *   时永远不匹配有主任务 —— 否则一个不带身份的调用方就能读别人的任务
   */
  function expect(id: string, caller?: JobCaller): JobRecord {
    const job = store.get(id)
    if (!job) throw new JobError(JOBS_CODE.UNKNOWN, `没有这个任务: ${id}`)
    if (job.ownerSession !== undefined && job.ownerSession !== caller?.sessionId) {
      throw new JobError(JOBS_CODE.FORBIDDEN, `任务 ${id} 属于别的会话`)
    }
    return job
  }

  function countLive(ownerSession: string | undefined): number {
    let n = 0
    for (const job of store.values()) {
      if (job.ownerSession === ownerSession && (job.status === 'running' || job.status === 'stopping')) n++
    }
    return n
  }

  function notify(job: JobRecord): void {
    if (closed) return
    const snap = snapshot(job)
    // 监听器是**隔离**的: 一个插件抛错不能弄坏已经提交的落定
    for (const listener of listeners) {
      try {
        listener(snap)
      } catch (err) {
        console.warn(`[meng] jobs: onJobDone 监听器抛错 (${job.id}): ${String(err)}`)
      }
    }
  }

  /**
   * 开跑通知。在记录**已经进 store、done 已经挂好**之后才发 ——
   * 监听器里第一件事往往是回读 get(id), 早一毫秒发就是查不到。
   *
   * 监听器抛错同样隔离: 起来一个任务不该因为某个界面回调写错而失败
   * (任务本身已经在跑了, 此时抛错只会让调用方以为没起来, 然后重复起一次)
   */
  function notifyStart(job: JobRecord): void {
    if (closed) return
    const snap = snapshot(job)
    for (const listener of startListeners) {
      try {
        listener(snap)
      } catch (err) {
        console.warn(`[meng] jobs: onJobStart 监听器抛错 (${job.id}): ${String(err)}`)
      }
    }
  }

  function settle(job: JobRecord, outcome: { status: JobStatus; detail?: string }): void {
    // first-wins: 迟到的生产者结果不能把 killed 改回 completed。
    // 少了这一条, 卸载时被杀的任务会在两秒后"复活"成成功
    if (isTerminal(job.status)) return
    job.status = outcome.status
    job.detail = outcome.detail
    job.finishedAt = Date.now()
    // 有 waiter 在等 = 已经有人要读结果了, 落定不需要再发通知。
    // 这个标记必须在放行 waiter **之前**打上, 否则 waiter 醒来读到终态
    // 再置 reported 时, 通知已经发出去了 —— 模型会收到"任务完成"的重复消息
    if (job.waiters.size > 0) job.reported = true
    const waiters = [...job.waiters]
    job.waiters.clear()
    job.markSettled()
    for (const wake of waiters) wake()
    if (!job.reported) notify(job)
  }

  const service: JobService = {
    start(spec: JobStartSpec) {
      if (closed) throw new JobError(JOBS_CODE.INVALID, '任务注册表已关闭')
      if (!spec.kind || /\s/.test(spec.kind)) {
        throw new JobError(JOBS_CODE.INVALID, `kind 非法: ${JSON.stringify(spec.kind)}`)
      }
      if (!spec.label) throw new JobError(JOBS_CODE.INVALID, 'label 不能为空')

      if (countLive(spec.ownerSession) >= maxPerOwner) {
        throw new JobError(
          JOBS_CODE.LIMIT,
          `这个会话的后台任务已达上限 (${maxPerOwner}); 先用 job_kill 停掉不再需要的, 或等它跑完`,
        )
      }

      // run() 同步抛错 = 起不来。此时还没有记录, 抛出去让调用方看见原因
      let hooks: JobHooks
      try {
        hooks = spec.run()
      } catch (err) {
        throw new JobError(JOBS_CODE.INVALID, `任务起不来: ${errText(err)}`)
      }

      const ordinal = (counters.get(spec.kind) ?? 0) + 1
      counters.set(spec.kind, ordinal)
      const id = `${spec.kind}-${ordinal}`

      let markSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => {
        markSettled = resolve
      })

      const job: JobRecord = {
        id,
        kind: spec.kind,
        label: spec.label,
        ownerSession: spec.ownerSession,
        status: 'running',
        detail: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        reported: false,
        hooks,
        settled,
        markSettled,
        waiters: new Set(),
      }
      store.set(id, job)

      // done 契约是"永不 reject", 但生产者写错时不能让记录永远 running ——
      // 一个永远 running 的任务会占住上限, 而且列表里看着像还活着
      hooks.done.then(
        (outcome) => settle(job, outcome),
        (err: unknown) => {
          console.warn(`[meng] jobs: ${id} 的 done reject 了 (生产者违约): ${errText(err)}`)
          settle(job, { status: 'failed', detail: `生产者违约: ${errText(err)}` })
        },
      )

      // 通知放在最后: 此刻 id / 快照 / done 监听全部就位, 监听器里
      // 立刻 get(id) 或 kill(id) 都是安全的
      notifyStart(job)

      return id
    },

    list(caller?: JobCaller) {
      const out: JobSnapshot[] = []
      for (const job of store.values()) {
        if (job.ownerSession !== undefined && job.ownerSession !== caller?.sessionId) continue
        out.push(snapshot(job))
      }
      return out.sort((a, b) => a.startedAt - b.startedAt)
    },

    get(id, caller) {
      return snapshot(expect(id, caller))
    },

    read(id, caller): JobOutput {
      const job = expect(id, caller)
      const chunk = job.hooks.readOutput?.() ?? { text: '', lossy: false }
      // 读到终态才算"上报过"。读中间过程的增量不该压掉完成通知 ——
      // 模型读了一眼进度就去干别的了, 它仍然需要知道"后来跑完了"
      if (isTerminal(job.status)) job.reported = true
      return { ...chunk, job: snapshot(job) }
    },

    kill(id, caller, reason) {
      const job = expect(id, caller)
      if (isTerminal(job.status)) {
        job.reported = true
        return 'already-finished'
      }
      // 亲手杀的不用再通知 —— 它知道自己在杀什么
      job.reported = true
      let cancelled = false
      try {
        cancelled = job.hooks.cancel?.(reason) ?? false
      } catch (err) {
        console.warn(`[meng] jobs: ${id} 的 cancel 抛错: ${errText(err)}`)
      }
      // cancel 返回 false 说明生产者已经自己停了, 但 done 还没落定。
      // 仍然切到 stopping: 此刻的事实是"正在停", 不是"还在跑"
      void cancelled
      job.status = 'stopping'
      return 'requested'
    },

    async wait(id, timeoutMs, caller, signal) {
      const job = expect(id, caller)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new JobError(JOBS_CODE.BAD_WAIT, `等待时长非法: ${timeoutMs} (要求 > 0 毫秒)`)
      }
      if (isTerminal(job.status)) {
        job.reported = true
        return snapshot(job)
      }
      if (signal?.aborted) throw new JobError(JOBS_CODE.BAD_WAIT, '等待已被取消')

      await new Promise<void>((resolve, reject) => {
        let done = false
        const cleanup = () => {
          clearTimeout(timer)
          job.waiters.delete(wake)
          signal?.removeEventListener('abort', onAbort)
        }
        const wake = () => {
          if (done) return
          done = true
          cleanup()
          resolve()
        }
        // 超时**不是错误**: 返回一个还是 running 的快照。
        // 抛异常的话模型会以为任务坏了, 而事实只是"还没跑完"
        //
        // **不能 unref**: unref 的 timer 不保证事件循环为它活着。部署里没有别的
        // 活动 handle 时 (纯 CLI、刚启动), 进程会认定"没事干了"直接退出,
        // 于是这个等待永远不结束 —— 表现为一次 job_output 把内核挂死,
        // 而且没有任何报错。等待本来就是"我要占住时间", 不是背景杂活
        const timer = setTimeout(() => wake(), timeoutMs)
        const onAbort = () => {
          if (done) return
          done = true
          cleanup()
          reject(new JobError(JOBS_CODE.BAD_WAIT, '等待已被取消'))
        }
        job.waiters.add(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })

      if (isTerminal(job.status)) job.reported = true
      return snapshot(job)
    },

    onJobStart(listener) {
      startListeners.add(listener)
      return () => {
        startListeners.delete(listener)
      }
    },

    onJobDone(listener) {
      listeners.add(listener)
      // 不能直接 `return () => listeners.delete(listener)` —— Set.delete 返回
      // boolean, 而 Disposer 的契约是 void。多出来的返回值会被调用方当成
      // "注销成功了没有", 于是同一处代码有两种解读
      return () => {
        listeners.delete(listener)
      }
    },
  }

  const off = provideJobs(ctx, service)

  return () => {
    // 先关通知: 卸载过程中落定的任务不该再往会话里塞消息
    closed = true
    // **同步**取消全部活任务。等落定属于"让记录好看", 而杀进程是"别留孤儿" ——
    // disposer 可能正赶上进程序列化退出, 不能 await
    for (const job of store.values()) {
      if (isTerminal(job.status)) continue
      job.reported = true
      job.status = 'stopping'
      try {
        job.hooks.cancel?.('任务注册表卸载')
      } catch (err) {
        console.warn(`[meng] jobs: 卸载时取消 ${job.id} 失败: ${errText(err)}`)
        job.status = 'failed'
        job.detail = '卸载时取消失败; 可能留下孤儿进程'
      }
    }
    listeners.clear()
    startListeners.clear()
    store.clear()
    counters.clear()
    off()
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 每条检查都用**一份独立的注册表**，而不是部署里那一个。
 *
 * 理由不是洁癖：自检会往账本里写记录，而模型调 job_list 时读的是同一份账本。
 * 之前用部署那个，`job_list` 的第一行是 "inv-13 [inv] stopping — 永远不结束的任务" ——
 * 模型会把它当成自己的任务，前端会画一条永远转圈的任务条。
 * 自检的痕迹不该出现在用户和模型看得见的地方。
 *
 * 实现注册在子作用域上，内核关闭时随作用域一起收；这里不单独 dispose ——
 * 检查跑完就没人再引用它，而作用域的 disposer 会在卸载时跑到
 */
function ownRegistry(ctx: Ctx): JobService {
  const scope = ctx.scope(`jobs-inv-${Math.random().toString(36).slice(2, 8)}`)
  apply(scope)
  const jobs = scope.get<JobService>('jobs')
  if (!jobs) throw new Error('子作用域没拿到 jobs 实现')
  return jobs
}

/**
 * 造一个手动落定的生产者, 不变量用它验记账逻辑本身。
 *
 * cancel 里也要落定: 真的生产者被停之后会走完 done (bash 是进程真死了)。
 * 如果桩不落定, 记录会永远停在 stopping —— 而 stopping 是算进"活着"的,
 * 几条用例下来就把上限吃满了, 后面的用例会莫名其妙撞 LIMIT
 */
function manualJob(): {
  hooks: JobHooks
  finish: (status: 'completed' | 'killed' | 'failed', detail?: string) => void
} {
  let settle: (status: 'completed' | 'killed' | 'failed', detail?: string) => void = () => {}
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((resolve) => {
    settle = (status, detail) => resolve(detail === undefined ? { status } : { status, detail })
  })
  const hooks: JobHooks = {
    done,
    cancel: (reason) => {
      settle('killed', reason ?? '被取消')
      return true
    },
  }
  return { hooks, finish: (status, detail) => settle(status, detail) }
}

export const invariant = defineInvariant('@meng/plugin-jobs-local', [
  {
    id: 'seam-registered',
    run(ctx) {
      // 这条验的恰恰是**部署里那个**: 别的检查都用独立注册表, 见 ownRegistry
      const jobs = ctx.get<JobService>('jobs')
      if (!jobs) throw new Error('能力面 jobs 未装载')
      for (const method of ['start', 'list', 'get', 'read', 'kill', 'wait', 'onJobDone'] as const) {
        if (typeof jobs[method] !== 'function') throw new Error(`jobs 缺方法 ${method}`)
      }
    },
  },
  {
    // 编号必须可读且单调: 模型要靠它在下一条消息里回指任务
    id: 'ids-are-numbered-per-kind',
    run(ctx) {
      const jobs = ownRegistry(ctx)
      const a = manualJob()
      const b = manualJob()
      const c = manualJob()
      const idA = jobs.start({ kind: 'inv', label: '第一个', run: () => a.hooks })
      const idB = jobs.start({ kind: 'inv', label: '第二个', run: () => b.hooks })
      const idC = jobs.start({ kind: 'other', label: '另一个种类', run: () => c.hooks })
      const ord = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1))
      if (!/^inv-\d+$/.test(idA)) throw new Error(`id 形态不对: ${idA}`)
      if (ord(idB) !== ord(idA) + 1) throw new Error(`同类编号不连续: ${idA} → ${idB}`)
      if (!/^other-\d+$/.test(idC) || ord(idC) !== 1) throw new Error(`不同 kind 应各自从 1 开始: ${idC}`)
      a.finish('completed')
      b.finish('completed')
      c.finish('completed')
    },
  },
  {
    // start 必须立刻返回。等它跑完才返回的话, "后台"就没有意义了
    id: 'start-returns-immediately',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const job = manualJob()
      const at = Date.now()
      const id = jobs.start({ kind: 'inv', label: '不会马上结束', run: () => job.hooks })
      const spent = Date.now() - at
      if (spent > 50) throw new Error(`start 卡了 ${spent}ms`)
      if (jobs.get(id).status !== 'running') throw new Error('刚起的任务不是 running')
      job.finish('completed')
      await jobs.wait(id, 1000)
    },
  },
  {
    // done reject = 生产者违约。记录不能因此永远 running (那会占住上限)
    id: 'rejected-done-settles-as-failed',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const id = jobs.start({
        kind: 'inv',
        label: '生产者违约',
        run: () => ({ done: Promise.reject(new Error('我裂开了')) }),
      })
      const snap = await jobs.wait(id, 1000)
      if (snap.status !== 'failed') throw new Error(`应结算成 failed, 实际 ${snap.status}`)
      if (!String(snap.detail).includes('我裂开了')) throw new Error('失败原因没记下来')
    },
  },
  {
    // 终态是吸收态。dsh 叫 first-wins, 防的是同一件事:
    // "已经结束"这个事实一旦落下, 后来的任何输入都不能改写它 ——
    // 尤其是卸载时被杀的任务, 不能被两秒后到达的"我成功了"翻案
    id: 'terminal-state-is-absorbing',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const job = manualJob()
      const id = jobs.start({ kind: 'inv', label: '先杀后收尾', run: () => job.hooks })
      if (jobs.kill(id, undefined, '不想要了') !== 'requested') throw new Error('kill 没被受理')
      // 杀进程是异步的 (TERM → 宽限 → KILL), 这期间既不是 running 也不能算 killed
      if (jobs.get(id).status !== 'stopping') throw new Error(`kill 之后应是 stopping, 实际 ${jobs.get(id).status}`)
      job.finish('killed', '被叫停')
      const settled = await jobs.wait(id, 1000)
      if (settled.status !== 'killed') throw new Error(`应结算成 killed, 实际 ${settled.status}`)
      // 终态吸收
      if (jobs.kill(id) !== 'already-finished') throw new Error('已结束的任务竟能被再杀一次')
      const after = jobs.get(id)
      if (after.status !== 'killed' || after.finishedAt !== settled.finishedAt) {
        throw new Error('终态被后来的调用改写了')
      }
    },
  },
  {
    // 围栏: id 是可预测的 (bash-1), 所以边界只能是授权
    id: 'other-sessions-cannot-touch-owned-jobs',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const job = manualJob()
      const id = jobs.start({ kind: 'inv', label: '有主的任务', ownerSession: 'sess-a', run: () => job.hooks })
      for (const attempt of [
        () => jobs.get(id, { sessionId: 'sess-b' }),
        () => jobs.read(id, { sessionId: 'sess-b' }),
        () => jobs.kill(id, { sessionId: 'sess-b' }),
        () => jobs.get(id),
      ]) {
        let blocked = false
        try {
          attempt()
        } catch (err) {
          blocked = err instanceof JobError && err.code === JOBS_CODE.FORBIDDEN
        }
        if (!blocked) throw new Error('别的会话竟能碰有主任务')
      }
      // 自己的会话必须能碰
      if (jobs.get(id, { sessionId: 'sess-a' }).id !== id) throw new Error('主人自己读不到')
      if (jobs.list({ sessionId: 'sess-b' }).some((j) => j.id === id)) throw new Error('列表泄漏了别人的任务')
      if (!jobs.list({ sessionId: 'sess-a' }).some((j) => j.id === id)) throw new Error('列表里没有自己的任务')
      job.finish('completed')
      await jobs.wait(id, 1000, { sessionId: 'sess-a' })
    },
  },
  {
    // read 是增量的 —— 重复吐同一段会让模型把同一批日志读两遍
    id: 'read-is-incremental',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const chunks: string[] = []
      let finish: (s: { status: 'killed' }) => void = () => {}
      const done = new Promise<{ status: 'killed' }>((resolve) => {
        finish = resolve
      })
      const hooks: JobHooks = {
        done,
        readOutput: () => ({ text: chunks.shift() ?? '', lossy: false }),
        cancel: () => {
          finish({ status: 'killed' })
          return true
        },
      }
      const id = jobs.start({ kind: 'inv', label: '分两次吐', run: () => hooks })
      chunks.push('第一段\n', '第二段\n')
      const first = jobs.read(id)
      const second = jobs.read(id)
      const third = jobs.read(id)
      if (first.text !== '第一段\n') throw new Error(`第一次读: ${JSON.stringify(first.text)}`)
      if (second.text !== '第二段\n') throw new Error(`第二次读: ${JSON.stringify(second.text)}`)
      if (third.text !== '') throw new Error('第三次读不该有内容')
      jobs.kill(id)
      await jobs.wait(id, 1000)
    },
  },
  {
    // 落定时"没人读过"才发通知。读过的再嚷嚷 = 重复消息
    id: 'completion-notifies-only-unreported',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const seen: string[] = []
      const off = jobs.onJobDone((job) => seen.push(job.id))

      const quiet = manualJob()
      const quietId = jobs.start({ kind: 'inv', label: '先读后结束', run: () => quiet.hooks })
      // wait 会置 reported —— 相当于模型一直在等它
      const waiting = jobs.wait(quietId, 1000)
      quiet.finish('completed')
      await waiting

      const loud = manualJob()
      const loudId = jobs.start({ kind: 'inv', label: '没人管它', run: () => loud.hooks })
      loud.finish('completed')
      // 不能在这里 wait 一下再断言: wait 会注册 waiter, 于是 settle 认定
      // "已经有人要结果了", 通知就不发了 —— 用例反而把自己要验的东西关掉了。
      // 等一个 tick 让 settle 的 then 跑完就够了
      await new Promise<void>((r) => setTimeout(r, 0))

      off()
      if (seen.includes(quietId)) throw new Error('有人等着的任务落定时不该再发通知')
      if (!seen.includes(loudId)) throw new Error('没人读过的任务落定时必须发通知')
    },
  },
  {
    // 上限: 不然一个模型循环就能把机器拖死
    id: 'limit-is-enforced',
    async run(ctx) {
      const jobs = ownRegistry(ctx)
      const owner = { sessionId: 'sess-cap' }
      const ids: string[] = []
      let limitHit = false
      try {
        for (let i = 0; i < 11; i++) {
          const job = manualJob()
          try {
            // 上限按 **owner** 算, 不是全局限额: 一个会话起满了不该影响别的会话
            ids.push(jobs.start({ kind: 'capped', label: `第 ${i + 1} 个`, ownerSession: owner.sessionId, run: () => job.hooks }))
          } catch (err) {
            if (err instanceof JobError && err.code === JOBS_CODE.LIMIT) {
              limitHit = true
              break
            }
            throw err
          }
        }
        if (!limitHit) throw new Error('上限没被守住: 第 11 个也起来了')
        if (ids.length !== 10) throw new Error(`应在第 11 个被挡住, 实际起了 ${ids.length} 个`)
      } finally {
        for (const id of ids) {
          try {
            jobs.kill(id, owner)
          } catch {
            /* 已结束 */
          }
        }
      }
    },
  },
  {
    // 卸载必须把活任务停掉。留着孤儿进程比丢一条记录严重得多
    id: 'dispose-cancels-live-jobs',
    async run(ctx) {
      const scope = ctx.scope('jobs-dispose-invariant')
      const base = ctx.get<JobService>('jobs')
      if (!base) throw new Error('能力面 jobs 未装载')
      // 在子作用域里装一份自己的实现, 卸载它不影响部署里那个
      const off = apply(scope)
      const own = scope.get<JobService>('jobs')
      if (!own || own === base) throw new Error('子作用域没拿到自己的实现')
      const job = manualJob()
      let cancelled = 0
      own.start({
        kind: 'inv',
        label: '卸载时还活着',
        run: () => ({
          done: job.hooks.done,
          cancel: () => {
            cancelled++
            job.finish('killed', '卸载取消')
            return true
          },
          readOutput: () => ({ text: '', lossy: false }),
        }),
      })
      off()
      if (cancelled !== 1) throw new Error(`卸载时没取消活任务 (cancel 调用 ${cancelled} 次)`)
    },
  },
])
