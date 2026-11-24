/**
 * @meng/kernel —— 完整内核机制作为一个系统插件。
 *
 * 最小启动器只用 core 的原始机制拉起本插件；后续清单装载、健康检查与
 * 统一卸载都通过这里的 `kernel` 能力面完成。core 仍是稳定的底层契约库，
 * 不认识 session / tools / web 等任何业务模块。
 */
import { fileURLToPath } from 'node:url'
import {
  defineInvariant,
  runInvariants,
  StatusGraph,
  type CheckResult,
  type Ctx,
  type Invariant,
  type MountedRow,
  type NodeRecord,
} from '@meng/core'
import { loadPatches } from '@meng/core/loader'

export const name = 'meng-kernel'
export const inject: string[] = []
export const KERNEL_CAPABILITY = 'kernel'

/** kernel 清单的绝对路径，最小启动器只需要知道这一项。 */
export const patch = fileURLToPath(new URL('../meng.patch.yml', import.meta.url))

export interface KernelHealth {
  /** 插件状态与不变量都健康，才是真的健康。 */
  ok: boolean
  /** 仅不变量结果，便于启动器分别展示。 */
  checksOk: boolean
  invariants: CheckResult[]
  unhealthy: NodeRecord[]
}

export interface KernelService {
  readonly ctx: Ctx
  readonly graph: StatusGraph
  /** 后续所有组合清单统一进入跨清单依赖队列。 */
  mount(files: string[]): Promise<MountedRow[]>
  /** 运行已装载模块的不变量，并合并 failed / pending 状态。 */
  check(mounted: MountedRow[]): Promise<KernelHealth>
  /** 按装载逆序回收整个模块树，包括 kernel 自己。 */
  dispose(mounted: MountedRow[]): Promise<void>
}

export function apply(ctx: Ctx): void {
  // 启动器需要一张图记录 kernel 自身的 discovered/loading/active，因此允许它
  // 预先放入 graph；独立装载本插件时则由这里创建，两种入口都成立。
  const existing = ctx.get<StatusGraph>('graph')
  const graph = existing ?? new StatusGraph()
  if (!existing) ctx.set('graph', graph)

  const service: KernelService = {
    ctx,
    graph,
    mount(files) {
      return loadPatches(ctx, graph, files)
    },
    async check(mounted) {
      const invariants = await collectInvariants(mounted)
      const check = await runInvariants(ctx, invariants)
      const unhealthy = graph.snapshot().filter((n) => n.status === 'failed' || n.status === 'pending')
      return {
        ok: check.ok && unhealthy.length === 0,
        checksOk: check.ok,
        invariants: check.results,
        unhealthy,
      }
    },
    async dispose(mounted) {
      for (const row of [...mounted].reverse()) {
        await ctx.rollback(row.mark)
        graph.disposed(row.id)
      }
      await ctx.rollback(0)
    },
  }

  ctx.set(KERNEL_CAPABILITY, service)
}

/** 只让真正装上的模块参与自检，失败的模块不该继续跑 invariant。 */
async function collectInvariants(mounted: MountedRow[]): Promise<Invariant[]> {
  const out: Invariant[] = []
  for (const row of mounted) {
    try {
      const mod = (await import(row.specifier)) as { invariant?: Invariant }
      if (mod.invariant?.checks?.length) out.push(mod.invariant)
    } catch {
      // 第三方模块不导出自检是允许的；其装载状态仍由 graph 守门。
    }
  }
  return out
}

export const invariant = defineInvariant('@meng/kernel', [
  {
    id: 'capability',
    run(ctx) {
      const kernel = ctx.get<KernelService>(KERNEL_CAPABILITY)
      if (!kernel) throw new Error('能力面 kernel 未注册')
      if (!ctx.get<StatusGraph>('graph')) throw new Error('状态图 graph 未注册')
      if (typeof kernel.mount !== 'function') throw new Error('kernel.mount 缺失')
      if (typeof kernel.check !== 'function') throw new Error('kernel.check 缺失')
      if (typeof kernel.dispose !== 'function') throw new Error('kernel.dispose 缺失')
    },
  },
])
