/**
 * 启动内核 —— 三段: 装载 / 静默 / 扫描。
 *
 * **零 DOM 依赖**: 这里只管插件生命周期, 渲染由 web-react 订阅 `settled` 信号。
 * 这样 boot 逻辑可以在 node 下直接测 (见 docs/05 §7 的验收要求)。
 *
 * 抄 dsh 的两条原则:
 *   1. shell self-sufficiency —— 加载页必须在插件全挂时也能渲染, shell 不 value-import 插件
 *   2. fail-loud sweep —— 容器 inject 等待没有超时, 所以启动后必须全量扫一遍,
 *      把 "谁在等哪个 service" 直接报出来, 而不是无限挂起
 *
 * 比 dsh 多一条, 是对 core 现状的补偿:
 *   3. **定点迭代** —— `Ctx` 契约里没有 "依赖到达时唤醒 pending" 这个语义
 *      (docs/07 §1.2 实测: `loadPatch` 单趟遍历, 同一份清单倒过来就有 3 行掉 pending)。
 *      缺这个语义, 行序就会携带加载语义。shell 不去改 loader, 而是在自己这段补一圈重扫,
 *      **直到某一轮一个都没动为止** —— 收敛即停, 不预设扫描次数。
 */

import type { Ctx } from '@meng/core'
import { clientUrlOf, type BootManifest, type PluginRuntime, type PluginRow } from '@meng/modules'

/** 整体推进到哪一步。给加载页显示阶段。 */
export type ShellPhase = 'loading' | 'settling' | 'settled' | 'failed'

/**
 * 单个插件的一生。
 *
 * 以前 ShellPhase 把这两种东西混在一个联合类型里, 于是 `onEntry(id, 'settling')`
 * 这种没意义的值在类型上是合法的。拆开之后错不了。
 */
export type EntryPhase = 'idle' | 'creating' | 'loading' | 'pending' | 'active' | 'failed' | 'disposed'

export type RuntimePlatform = PluginRow['platforms'][number]

export interface EntryState {
  id: string
  phase: EntryPhase
  /** pending 时: 缺哪些能力面 */
  missing?: string[]
  /** failed 时: 为什么 */
  error?: string
}

export interface ShellBootOptions {
  manifest: BootManifest
  /** 插件 apply 的宿主上下文 (core 的 Ctx) */
  ctx: Ctx
  /**
   * 拿到一个 bundle 的模块对象。
   *
   * 这是**依赖倒置的接缝**: shell 不知道代码从 HTTP 来、从 import() 来还是从 fixture 来。
   * 也因此本文件能在 node 下直接跑 —— 塞一个返回假 apply 的函数就行。
   */
  loadModule: (id: string, url: string) => Promise<PluginRuntime>
  /** 一个 entry 状态变化时回调 (给加载页显示进度) */
  onEntry?: (id: string, phase: EntryPhase) => void
  /** 当前端。用来过滤 manifest.platforms —— 平台过滤只此一处, 不散落到各插件里 */
  platform?: RuntimePlatform
  /** boot 总预算 (ms)。超时裁判必须在插件之外, 原因见 docs/08 §7 */
  timeout?: number
  /** 定点迭代的轮数上限。防御值, 正常情况第一轮就收敛 */
  maxSweeps?: number
  /** 按插件 id 索引的配置 */
  config?: Record<string, Record<string, unknown>>
}

export interface ShellHandle {
  phase: ShellPhase
  /** 未激活的 entry 及原因 —— sweep 的产物 */
  failures: { id: string; reason: string }[]
  /** 全量可见性: 调试面板 / `meng graph` / 加载页共用一份 */
  entries: EntryState[]
  dispose(): Promise<void>
}

interface Item {
  row: PluginRow
  state: EntryState
  /** 装载前的 disposer 栈深度。逆序回滚用它 */
  mark?: number
  /** 已加载的 bundle。缓存起来, 重扫时不重复下载 */
  loaded?: PluginRuntime
}

const ALL_PLATFORMS: RuntimePlatform[] = ['web', 'desktop', 'mobile']

/**
 * 跑完整个 boot 链。
 *
 * 注意: **不抛异常**。boot 失败也要让调用方拿到 failures 去渲染错误页,
 * 这与 dsh "loading page must work while plugins fail" 是同一条规则。
 */
export async function bootShell(options: ShellBootOptions): Promise<ShellHandle> {
  const {
    manifest,
    ctx,
    loadModule,
    onEntry,
    platform = platformOf(manifest),
    timeout = 3000,
    maxSweeps = 16,
    config = {},
  } = options

  const rows = manifest.plugins.filter((row) => row.platforms.includes(platform))
  const list: Item[] = rows.map((row) => ({ row, state: { id: row.id, phase: 'idle' } }))

  const emit = (item: Item, phase: EntryPhase, extra?: Partial<EntryState>): void => {
    item.state = { ...item.state, phase, ...extra }
    onEntry?.(item.row.id, phase)
  }

  const deadline = Date.now() + timeout

  async function tryMount(item: Item): Promise<boolean> {
    const { row } = item
    if (item.state.phase === 'active') return false

    emit(item, 'creating')

    if (Date.now() > deadline) {
      emit(item, 'failed', { error: `超出 boot 预算 ${timeout}ms` })
      return false
    }

    const missing = row.inject.filter((dep) => ctx.get(dep) === undefined)
    if (missing.length) {
      // 依赖没齐不是错误 —— pending 等着被下一轮重扫唤醒
      emit(item, 'pending', { missing })
      return false
    }

    emit(item, 'loading')
    let loaded = item.loaded
    try {
      // url 可能缺失 (后端不下发, 见 PluginRow.url 注释): 按约定从 id 推
      loaded ??= await loadModule(row.id, row.url ?? clientUrlOf(row.id))
      item.loaded = loaded // 缓存: 下一轮重扫不该再下一次同一个 bundle
    } catch (err) {
      emit(item, 'failed', { error: `加载失败: ${text(err)}` })
      return false
    }
    if (!loaded || typeof loaded.apply !== 'function') {
      emit(item, 'failed', { error: 'bundle 出口没有 apply' })
      return false
    }

    // bundle 自己又声明了一组依赖 —— 取并集。
    // manifest 可能过期 (它是 server 装载期快照), .inject 是 bundle 自述的事,
    // 两边都不信任单一一方: 谁多就听谁的。
    const declared = new Set([...row.inject, ...(loaded.inject ?? [])])
    const missingAtRuntime = [...declared].filter((dep) => ctx.get(dep) === undefined)
    if (missingAtRuntime.length) {
      emit(item, 'pending', { missing: missingAtRuntime })
      return false
    }

    // 与 core.loader 一致: apply 挂在**共享的父上下文**上, 不是子作用域。
    // 挂子作用域的话兄弟插件看不见它注册的能力面 (core/context.ts 里有这个坑的记录)。
    const mark = ctx.checkpoint()
    item.mark = mark
    try {
      const off = await loaded.apply(ctx, config[row.id] ?? {})
      if (typeof off === 'function') ctx.effect(() => off)
      emit(item, 'active', { missing: undefined, error: undefined })
      return true
    } catch (err) {
      // apply 中途失败要回滚它**已经注册**的部分, 否则留下半截插件:
      // service 还在、事件监听还在、下一步重装必定撞 "能力面已被占用"
      await ctx.rollback(mark)
      item.mark = undefined
      emit(item, 'failed', { error: text(err) })
      return false
    }
  }

  // ── 段 1 · 装载 ──────────────────────────────────────────────
  // 立即层串行: 它提供的是同步 require 边, inject 保护不到, 必须整个注册完才能创建别人
  const immediate = list.filter((item) => item.row.immediately)
  const deferred = list.filter((item) => !item.row.immediately)
  for (const item of immediate) await tryMount(item)

  // ── 段 2 · 静默(实为定点迭代) ─────────────────────────────────
  // 重复扫描 pending 直到某一轮零进展 —— 收敛即停。
  // 这一圈让 "行序不携带加载语义" 从注释变成事实: 依赖晚到也能被唤醒。
  let sweeps = 0
  for (; sweeps < maxSweeps; sweeps++) {
    let progressed = false
    for (const item of deferred) {
      if (item.state.phase === 'active') continue
      if (await tryMount(item)) progressed = true
    }
    if (!progressed) break
  }

  // ── 段 3 · 扫描 ──────────────────────────────────────────────
  // 还没起来的必须说清楚它在等什么, 而不是无限挂起
  const failures: ShellHandle['failures'] = []
  for (const item of list) {
    const state = item.state
    if (state.phase === 'active') continue
    const reason =
      state.phase === 'pending'
        ? `等待能力面: ${state.missing?.join(', ') ?? '未知'}`
        : (state.error ?? `未激活 (${state.phase})`)
    failures.push({ id: item.row.id, reason })
    if (state.phase !== 'failed') emit(item, 'failed', { error: reason })
  }

  const mounted = list.filter((item) => item.state.phase === 'active' && item.mark !== undefined)
  const phase: ShellPhase =
    list.length > 0 && mounted.length === 0 ? 'failed' : 'settled'

  return {
    phase,
    failures,
    entries: list.map((item) => item.state),
    async dispose() {
      // 逆序回滚到各自装载前的 checkpoint; rollback 本身一路 pop 到 mark,
      // 所以最后一个作出的最先收。
      for (const item of [...mounted].reverse()) {
        if (item.mark === undefined) continue
        await ctx.rollback(item.mark)
        item.state = { ...item.state, phase: 'disposed' }
      }
      mounted.length = 0
    },
  }
}

/** 平台探测。真实的三端判定在 platform 包里 (docs/09 §4); 这里先给个能跑的值。 */
function platformOf(_manifest: BootManifest): RuntimePlatform {
  return 'web'
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { ALL_PLATFORMS }
