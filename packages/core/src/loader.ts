/**
 * 组合清单加载器 —— 我们的 base 只有 7 行, 所以加载器也只有 ~90 行。
 *
 * 设计取舍 (对照 dsh 的 @deepseek-ai/cordis-plugin-loader):
 * - 支持: `insert` 追加 / 单行覆盖 / `disabled` / `!!js` 求值 / 依赖缺失转 pending
 * - 暂不支持: group 嵌套、overlay 层叠、配置热更新的细粒度 diff
 *   → 这些等 P2 有第二个 bundle 时再补, 现在补等于猜需求
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'

import { type Ctx, type Disposer } from './context.ts'
import { type ClientFace, StatusGraph } from './status.ts'

export interface PatchRow {
  id: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean | string
  /** 前端面的**部署侧覆盖**。不写就只认包自己声明的那份 */
  client?: ClientFace
}

export interface MountedRow {
  id: string
  name: string
  /** 实际 import 用的标识。boot 靠它把 invariant 也拉进来 */
  specifier: string
  /** 装载前的 disposer 栈深度, 卸载时回滚到这里 */
  mark: number
}

export interface LoadResult {
  mounted: MountedRow[]
  graph: StatusGraph
}

interface PluginModule {
  apply(ctx: Ctx, config: Record<string, unknown>): void | Disposer | Promise<void | Disposer>
  inject?: string[]
  name?: string
}

/** 读一份 patch 文件并逐行装载。失败不抛出, 全部记进状态图 */
export async function loadPatch(ctx: Ctx, graph: StatusGraph, file: string): Promise<MountedRow[]> {
  const rows = await readRows(file)
  const mounted: MountedRow[] = []

  /** 已经 import 过、等着装的行。依赖要等别的行装完才有, 所以不能当场决定 */
  interface Ready {
    row: PatchRow
    mod: PluginModule
    specifier: string
    client?: ClientFace
    inject: string[]
  }

  // 第一遍: 登记 + import + 读前端面, **不装载**。
  // 拆两遍的理由在下面那段 —— 依赖是跨行的, 一遍扫到底、遇到"依赖还没齐"就
  // continue, 那一行就再也无人问津: 把 bundles/base 的行序倒过来,
  // agent / persistence / tools 会永远停在 pending (scripts/probe-order.ts 复现过)
  const queue: Ready[] = []

  for (const row of rows) {
    graph.discovered(row.id, row.name ?? row.id)

    const disabled = row.disabled === true || evalJs(row.disabled)
    if (disabled) {
      graph.disabled(row.id)
      continue
    }
    if (!row.name) {
      // 纯前端插件: 只有产物, 没有后端 apply。清单里写了 client 就登记,
      // 否则是配置写漏了 —— 不能悄悄跳过, 那会让前端永远等一个不存在的插件
      if (row.client) {
        graph.active(row.id, [], row.client)
        continue
      }
      graph.failed(row.id, '行缺少 name')
      continue
    }

    let mod: PluginModule
    const specifier = toSpecifier(row.name, file)
    try {
      mod = (await import(specifier)) as PluginModule
    } catch (err) {
      graph.failed(row.id, `import 失败: ${errorText(err)}`)
      continue
    }

    // 前端面: 包自己声明的那份 + 清单行的覆盖, 浅合并 (见 clientFaceOf)
    const client = await clientFaceOf(specifier, row.client)
    queue.push({
      row,
      mod,
      specifier,
      ...(client ? { client } : {}),
      inject: mod.inject ?? [],
    })
  }

  // 第二遍: 反复扫描, 每轮装上"依赖这次齐了"的行, 直到某一轮毫无进展。
  //
  // 不是先排拓扑序再装: 依赖不是清单里写死的边, 而是"ctx 上有没有这个能力面",
  // 插件可以在 apply 里注册任何名字 (甚至注册别人等着的名字)。所以只能边装边看。
  let remaining = queue
  while (remaining.length) {
    const deferred: Ready[] = []
    let progressed = false

    for (const item of remaining) {
      const missing = item.inject.filter((dep) => ctx.get(dep) === undefined)
      if (missing.length) {
        deferred.push(item)
        continue
      }
      if (await mountOne(ctx, graph, mounted, item)) progressed = true
    }

    // 一整轮都没装上任何东西 = 剩下的确实缺依赖, 再扫多少轮也一样。
    // 这时才报 pending, 而且报的是**此刻**真正缺的那几个 ——
    // 不是"轮到它时恰好还没装"的那几个
    if (!progressed) {
      for (const item of deferred) {
        graph.pending(item.row.id, item.inject.filter((dep) => ctx.get(dep) === undefined))
      }
      break
    }
    remaining = deferred
  }

  return mounted
}

/** 装一行。返回是否成功 —— failed 的行要出列, 不能留在队列里反复重试 */
async function mountOne(
  ctx: Ctx,
  graph: StatusGraph,
  mounted: MountedRow[],
  item: { row: PatchRow; mod: PluginModule; specifier: string; client?: ClientFace; inject: string[] },
): Promise<boolean> {
  const { row, mod, specifier, client, inject } = item
  graph.loading(row.id)
  const mark = ctx.checkpoint()
  try {
    const config = resolveConfig(row.config)
    // 关键: 装在**共享的父上下文**上, 不是装进子作用域。
    // 装进子作用域的话, 插件注册的能力面/监听器只有它自己看得见,
    // 兄弟插件会报"依赖缺失", 拦截器也永远收不到事件 ——
    // 这是"插件作用域"最容易做错的一处, 第一次跑就在这里翻车了。
    const off = await mod.apply(ctx, config)
    if (typeof off === 'function') ctx.effect(() => off)
    mounted.push({ id: row.id, name: row.name ?? row.id, specifier, mark })
    graph.active(row.id, inject, client)
    return true
  } catch (err) {
    // apply 中途失败必须回滚它已经注册的东西, 否则留下半个插件
    await ctx.rollback(mark)
    graph.failed(row.id, errorText(err))
    return false
  }
}

/** 逆序卸载: 回滚到每行装载前的 checkpoint —— 服务和监听器一起收 */
export async function unload(ctx: Ctx, mounted: MountedRow[], graph: StatusGraph): Promise<void> {
  for (const row of [...mounted].reverse()) {
    await ctx.rollback(row.mark)
    graph.disposed(row.id)
  }
  mounted.length = 0
}

async function readRows(file: string): Promise<PatchRow[]> {
  // `!!js` 不是标准 YAML tag, yaml 库会对每个出现处刷一条 warning。
  // 读进来先换成中性前缀, 我们自己的 evalJs 认它 —— 清单里几十处 !!js,
  // 不处理的话启动日志会被警告淹没, 真正的错误反而看不见
  const raw = await readFile(file, 'utf8')
  const text = raw.replace(/!!js\s/g, '__JS__ ')
  const doc = parse(text) as unknown
  if (!Array.isArray(doc)) throw new Error(`${file} 顶层必须是数组`)

  const rows: PatchRow[] = []
  for (const entry of doc as Array<PatchRow & { insert?: PatchRow[] }>) {
    if (entry && Array.isArray(entry.insert)) rows.push(...entry.insert)
    else rows.push(entry)
  }
  return rows
}

/** `!!js 'expr'` → 用 Function 求值, 拿不到宿主上下文是刻意的 */
export function evalJs(value: unknown): boolean {
  if (typeof value !== 'string') return Boolean(value)
  const expr = value.startsWith('!!js ')
    ? value.slice(5).trim()
    : value.startsWith('__JS__ ')
      ? value.slice(7).trim()
      : value
  try {
    return Boolean(new Function(`return (${expr})`)())
  } catch (err) {
    console.warn(`[meng] 表达式求值失败, 按 false 处理: ${expr}`, err)
    return false
  }
}

function resolveConfig(config?: Record<string, unknown>): Record<string, unknown> {
  if (!config) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    // 用 evalExpr 而不是 evalJs: config 里的表达式要保留**原类型**
    // (port 是数字、dir 是字符串)。evalJs 是给 disabled 用的, 一律布尔化,
    // 拿它求值 config 会把 `dir: !!js '.meng'` 变成 true, 然后在 fs 调用里炸掉
    out[key] = typeof value === 'string' && value.startsWith('__JS__ ') ? evalExpr(value) : value
  }
  return out
}

/** 求值并保留原类型。失败时返回原字符串, 由使用方去报错 —— 静默吞掉更难查 */
export function evalExpr(value: string): unknown {
  const expr = value.startsWith('!!js ')
    ? value.slice(5).trim()
    : value.startsWith('__JS__ ')
      ? value.slice(7).trim()
      : value
  try {
    return new Function(`return (${expr})`)()
  } catch (err) {
    console.warn(`[meng] 表达式求值失败, 按字符串处理: ${expr}`, err)
    return expr
  }
}

/**
 * 前端面从哪来 —— 两条来源, 清单覆盖包自述:
 *
 *   1. 包自己的 `package.json` 的 `meng.client`（主要来源）
 *   2. 清单行的 `client:` 段（部署侧覆盖, 可选）
 *
 * 为什么不从模块的 `export const client` 读: 前端插件的入口是**产物**
 * （`@meng/plugin-demo-ui` 的 main 指向 `client-entry.tsx`, 里面直接用
 * `__MENG_LOADER__`）。为了问一句"你有没有前端面"就去执行前端代码,
 * 在 node 里必然炸。dsh 把 `dsh.client` 放 package.json 就是这个理由 ——
 * **自述信息必须能在不执行代码的前提下读到**。
 *
 * 为什么清单能覆盖: 托管版可能不想把某个插件下发到移动端, 那是部署决策,
 * 不该去改别人的包
 */
async function clientFaceOf(specifier: string, override?: ClientFace): Promise<ClientFace | undefined> {
  const declared = await readPackageClient(specifier)
  if (!declared) return override
  if (!override) return declared
  return { ...declared, ...override }
}

async function readPackageClient(specifier: string): Promise<ClientFace | undefined> {
  // 裸包名 = 解析没成功, 包在别处。认了, 只认清单里显式写的那份
  if (!isAbsolute(specifier)) return undefined
  let dir = dirname(specifier)
  // 往上找 package.json。最多 4 层: src/ → 包根, 再多就是仓库根了
  for (let i = 0; i < 4; i++) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw) as { meng?: { client?: ClientFace } }
      return pkg.meng?.client
    } catch {
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return undefined
}

function toSpecifier(name: string, fromFile: string): string {
  if (name.startsWith('.') || isAbsolute(name)) {
    const abs = resolve(dirname(fromFile), name)
    return abs.endsWith('.ts') || abs.endsWith('.js') ? abs : `${abs}/src/index.ts`
  }
  // 裸包名从**清单所在目录**解析, 不从 loader.ts 的目录解析。
  // 后者等于让 bundle 声明依赖这件事形同虚设 —— 实际全靠根 node_modules
  // 里那批历史软链, 于是新加一个包就必然 "Cannot find package",
  // 而报错指向的还是 loader.ts, 完全看不出是哪一行清单的问题。
  // 解析不到就退回原样: 有些部署把包放在自己的 node_modules 下, 别替它决定
  try {
    return createRequire(fromFile).resolve(name)
  } catch {
    return name
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
