/**
 * 启动内核 —— 启动顺序的全部代码就在这里。
 *
 * 对比 Python 版: lifespan.py 里 9 行硬编码启动顺序 + 416 行启动/关闭逻辑,
 * 且顺序错了只在特定插件组合下才崩。这里顺序由清单的 inject 决定,
 * 关闭由 disposer 栈逆序展开, 代码里没有一处需要知道"谁先谁后"。
 */

import { fileURLToPath } from 'node:url'
import { createContext, StatusGraph, type Ctx, type MountedRow } from '@meng/core'
import { loadPatch } from '@meng/core/loader'
import { patch as kernelPatch, type KernelService } from '@meng/kernel'
import { patch as basePatch } from '@meng/bundle-base'
import { patch as kitPatch } from '@meng/bundle-kit'
import { patch as serverPatch } from '@meng/bundle-server'

export interface Kernel {
  ctx: Ctx
  graph: StatusGraph
  mounted: MountedRow[]
  invariants: Array<{ pkg: string; id: string; ok: boolean; message?: string; ms: number }>
  ok: boolean
  dispose(): Promise<void>
}

export interface BootOptions {
  /** 除 base 之外要装的清单文件 (绝对路径) */
  patches?: string[]
  /** 装 HTTP/WS 层。CLI 一次性对话不需要 */
  web?: boolean
  /** 数据目录, 传给 session 等本机存储模块 */
  dataDir?: string
  quiet?: boolean
}

export async function bootKernel(options: BootOptions = {}): Promise<Kernel> {
  if (options.dataDir) process.env.MENG_DATA_DIR = options.dataDir
  // quiet 要能穿透到被装载的包: 它们各自的 console.log 会污染
  // `meng graph` 的 JSON 输出, 而 JSON 里混一行日志比没有日志更难处理
  if (options.quiet) process.env.MENG_QUIET = '1'

  const graph = new StatusGraph()
  const ctx = createContext('root')
  // 状态图也是能力面: web 的 /api/boot-manifest 和调试面板都读它
  ctx.set('graph', graph)

  // 最小启动器只拉起 kernel；从这一行之后，装载与健康检查都交给 kernel。
  const mounted = await loadPatch(ctx, graph, kernelPatch)
  const kernel = ctx.get<KernelService>('kernel')
  if (!kernel) {
    await ctx.rollback(0)
    throw new Error(`kernel 未就绪:
${graph.table()}`)
  }

  // base(基础能力) → kit(能干什么活) → server(怎么接世界) → 额外插件。
  const files = [basePatch, kitPatch]
  if (options.web) files.push(serverPatch)
  files.push(...(options.patches ?? []))
  mounted.push(...await kernel.mount(files))
  const health = await kernel.check(mounted)

  if (!options.quiet) {
    console.log('梦 · base\n')
    console.log(graph.table())
    console.log('')
    // 数状态图里的 active, 不是 mounted.length: 纯前端插件 (只有 client 面、
    // 没有 apply) 不进 mounted —— 它没有副作用要回收, 但确实"起来了"
    const up = graph.snapshot().filter((n) => n.status === 'active').length
    console.log(`已装载 ${up} 行 · 能力面 ${describeCapabilities(ctx)}`)
    console.log(`不变量 ${health.checksOk ? '全部通过' : '有失败'} (${health.invariants.length} 项, ${sumMs(health.invariants)}ms)`)
    if (!health.checksOk) {
      for (const r of health.invariants.filter((r) => !r.ok)) {
        console.error(`  ✗ ${r.pkg} · ${r.id}: ${r.message}`)
      }
    }
    console.log('')
  }

  return {
    ctx,
    graph,
    mounted,
    invariants: health.invariants,
    ok: health.ok,
    dispose() {
      return kernel.dispose(mounted)
    },
  }
}

function describeCapabilities(ctx: Ctx): string {
  return ['llm', 'session', 'tools', 'prompt', 'loop', 'memory', 'fs', 'spill', 'questions', 'exec', 'jobs', 'web']
    .filter((n) => ctx.get(n))
    .join(', ') || '无'
}

function sumMs(results: Array<{ ms: number }>): number {
  return results.reduce((acc, r) => acc + r.ms, 0)
}

/** 示例插件清单。冒烟/demo 用它验证工具循环 */
export function helloPatch(): string {
  return fileURLToPath(new URL('../../../plugins/hello/meng.patch.yml', import.meta.url))
}

/**
 * 真供应商清单: DeepSeek + OpenAI 兼容**全装**。
 *
 * 为什么不按 MENG_PROVIDER 只装一家: 没装的插件不会加载, 设置页就看不到它,
 * 也就无从配置 —— 而"在设置页里配一家新供应商"正是这一层要实现的事。
 * 谁真的能用由凭据决定, 不配 key 的自动让位 (见 @meng/llm 的 resolve)。
 */
export function providersPatch(): string {
  return fileURLToPath(new URL('../providers.meng.patch.yml', import.meta.url))
}

/**
 * 只装离线 mock。**冒烟/CI 必须用它**, 不能用 providersPatch:
 * 本机若导出了真的 DEEPSEEK_API_KEY, 真 provider 会抢走默认模型,
 * 冒烟断言的是 mock 的脚本, 于是"测试失败"看起来像代码坏了。
 */
export function mockPatch(): string {
  return fileURLToPath(new URL('../../../plugins/provider-mock/meng.patch.yml', import.meta.url))
}
