/**
 * 模块系统 · 浏览器半 —— bundle handoff 的接收端。
 *
 * 插件 bundle 由 server 从 `/plugins/<id>/client.js` 下发, bundle 自己调用
 * `__MENG_LOADER__.load({ id, factory })` 注册一个**惰性**工厂。
 *
 * 三条从 docs/08 §1/§2/§6 搬过来的硬约束, 每一条都有断言:
 *
 *   1. **执行 ≠ 装载** —— bundle 被执行时只注册 factory, 不跑任何副作用。
 *      CSS 注入、slot 注册全部锁在 factory 闭包里, 物化时才跑 →
 *      **加载顺序因此自解**, 清单里的行序不携带加载语义 (docs/02)。
 *   2. **重复注册同 id 直接 throw** —— "bundle 执行了两次却没 invalidate" 是常见事故,
 *      静默覆盖会让 HMR 后的旧闭包继续活着。
 *   3. **require 只有一条解析链** —— 共享表 → 静态模块 → 已物化 → 已注册工厂(递归) → throw。
 *      不搞 dsh 那种 `import()` 与 `require()` 两条顺序还不一致的链 (docs/08 §2)。
 *
 * **零 DOM、零 fetch 依赖**: 文本怎么来、代码怎么执行、style 怎么回收全部是注入的,
 * 所以这个文件能在 node 下直接跑断言 (test/client.ts), 浏览器侧才换真实现。
 */

import type { ModuleRow, PluginRuntime } from './index.ts'

/** 插件体里拿共享模块的唯一入口 */
export type RequireFn = (spec: string) => unknown

/**
 * bundle 注册的东西。
 *
 * 返回值即模块导出 —— UI 插件应当返回 `{ apply, inject? }`(也就是 `PluginRuntime`)。
 * 返回 undefined 也允许(纯副作用的库模块), 但那样 shell 会判它"没有 apply"而装载失败。
 */
export type PluginFactory = (require: RequireFn) => unknown

/** 挂在 `window.__MENG_LOADER__` 上的那个东西。bundle 只认这一个入口 */
export interface LoaderBridge {
  load(spec: { id: string; factory: PluginFactory }): void
}

/** style 回收面。注入式, 好让 node 侧用假实现 */
export interface StyleSink {
  /** 回收属于 id 的 style, 返回回收数量 */
  removeOwned(id: string): number
  /** 页面上此刻有多少**无主**的 style(没有 data-plugin 的) */
  unowned(): number
  warn(message: string): void
}

export interface ClientModuleOptions {
  /** 已知的行。登记后 `arrive` 可以按 id 直接找到 url */
  rows?: ModuleRow[]
  /** 共享表(冻结): 插件 require('react') 拿到的就是这个, 保证单实例 */
  shared?: Record<string, unknown>
  /** 静态模块(shell 自带、不经过网络)。也可以后面用 registerStatic 追加 */
  statics?: Record<string, unknown>
  /** 取 bundle 文本。默认 fetch */
  loadText?: (url: string) => Promise<string>
  /**
   * 执行 bundle 文本。
   *
   * **默认实现用 `new Function` 而不是插 `<script>`** —— 这是一处对 dsh 的刻意偏离:
   * 内联 `<script>` 的执行错误**不会**抛到 appendChild 的调用栈上, 只能靠 window.onerror 捞,
   * 于是"bundle 语法错 / 顶层 throw"在装载链里表现为**永远 pending** 而不是 failed。
   * `new Function` 同步执行、能直接 try/catch, node 与浏览器行为还一致。
   * 代价与 `<script>` 相同: 都需要 CSP 放开 eval。
   */
  evaluate?: (code: string, id: string, loader: LoaderBridge, require: RequireFn) => void
  /** style 回收。默认走 document */
  styles?: StyleSink
}

export interface ClientModuleLoader {
  /** 加载脚本, 使工厂注册(幂等, 并发共享同一个 in-flight) */
  arrive(row: ModuleRow): Promise<void>
  /** arrive + 同步执行工厂, 返回模块导出。给 `shell.loadModule` 用 */
  load(row: ModuleRow): Promise<PluginRuntime>
  /** 同步执行工厂并 memoize */
  materialize(id: string): { id: string; exports: unknown }
  /** 给工厂用的同步 require */
  require(spec: string): unknown
  /** HMR: 丢弃一个 id 的工厂与缓存, 并移除它注入的 <style data-plugin> */
  invalidate(id: string): void
  /** 静态模块(shell 自带的 core/slots/web-react 等) */
  registerStatic(id: string, exports: unknown): void
  /** 工厂已注册但未物化 */
  registered(id: string): boolean
  /** 已物化 */
  materialized(id: string): boolean
  /** bundle 用的那个入口对象 */
  bridge: LoaderBridge
}

/** `<id>/client` 与裸 `<id>` 是同一个东西(exports subpath ≡ 图里的行 id) */
export function stripClientSuffix(id: string): string {
  return id.replace(/\/client$/, '')
}

export function createClientModuleSystem(
  options: ClientModuleOptions = {},
): ClientModuleLoader {
  const rows = new Map<string, ModuleRow>()
  for (const row of options.rows ?? []) rows.set(stripClientSuffix(row.id), row)

  const shared = options.shared ?? {}
  const statics: Record<string, unknown> = { ...(options.statics ?? {}) }
  const loadText = options.loadText ?? defaultLoadText
  const evaluate = options.evaluate ?? defaultEvaluate
  const styles = options.styles ?? defaultStyleSink()

  /** 已注册未物化 */
  const factories = new Map<string, PluginFactory>()
  /** 已物化 */
  const cache = new Map<string, unknown>()
  /** 预取 in-flight。并发 arrive 共享同一份 */
  const inflight = new Map<string, Promise<void>>()
  /** 物化重入卫: 撞上就是循环依赖 */
  const materializing = new Set<string>()

  const key = (id: string): string => stripClientSuffix(id)

  const require = (spec: string): unknown => {
    const k = key(spec)

    // 1) 共享表 —— 冻结。插件拿不到第二份 react
    if (Object.prototype.hasOwnProperty.call(shared, k)) return shared[k]

    // 2) 静态模块 —— shell 自带
    if (Object.prototype.hasOwnProperty.call(statics, k)) return statics[k]

    // 3) 已物化
    if (cache.has(k)) return cache.get(k)

    // 4) 已注册工厂 —— 递归物化
    if (factories.has(k)) return materialize(k).exports

    // 都没有: 响亮失败。跨插件 value import 是构建期错误, 运行期绝不降级
    throw new Error(`modules: 解析不到 "${spec}"。它不在共享表里, 也没有注册 factory`)
  }

  function materialize(rawId: string): { id: string; exports: unknown } {
    const k = key(rawId)
    if (cache.has(k)) return { id: k, exports: cache.get(k) }

    const factory = factories.get(k)
    if (!factory) throw new Error(`modules: "${k}" 没有注册 factory, 无法物化`)

    // 物化重入 = 循环依赖。不做部分导出 —— 半截模块比报错难查得多
    if (materializing.has(k)) {
      throw new Error(`modules: 检测到循环依赖, "${k}" 在自己的 factory 里又被 require`)
    }

    materializing.add(k)
    try {
      const exported = factory(require)
      cache.set(k, exported)
      return { id: k, exports: exported }
    } finally {
      materializing.delete(k)
      // 物化结束后清点: 同帧注入却没有归属标记的 style, 记 warn 而不是认领
      const unowned = styles.unowned()
      if (unowned > 0) {
        styles.warn(
          `modules: 物化 ${k} 后页面上有 ${unowned} 个无主 <style>(没有 data-plugin)。` +
            `插件 CSS 必须由构建期打标, 运行时不认领 (docs/08 §6)。`,
        )
      }
    }
  }

  const bridge: LoaderBridge = {
    load(spec) {
      const k = key(spec.id)
      if (typeof spec.factory !== 'function') {
        throw new Error(`modules: ${k} 注册的 factory 不是函数`)
      }
      // 重复注册同 id 直接 throw —— 说明 bundle 被执行了两次却没 invalidate
      if (factories.has(k)) {
        throw new Error(`modules: ${k} 重复注册。先 invalidate 再重新装载 (HMR 第 2 步)`)
      }
      factories.set(k, spec.factory)
    },
  }

  function resolveUrl(row: ModuleRow): string {
    if (row.url) return row.url
    const known = rows.get(key(row.id))
    if (known?.url) return known.url
    throw new Error(`modules: ${row.id} 没有 url, 无法装载`)
  }

  function arrive(row: ModuleRow): Promise<void> {
    const k = key(row.id)

    // 幂等: 已注册就是已到达
    if (factories.has(k)) return Promise.resolve()

    const existing = inflight.get(k)
    if (existing) return existing

    const task = (async () => {
      const url = resolveUrl(row)
      const code = await loadText(url)
      evaluate(code, k, bridge, require)
      if (!factories.has(k)) {
        throw new Error(`modules: ${k} 执行完了却没有注册 factory (url=${url})`)
      }
    })()

    inflight.set(k, task)
    // ⚠️ 失败必须把 in-flight 摘掉。否则这个 rejected promise 会被永久缓存,
    // 重试 arrive 永远拿到同一个旧失败 —— 网络抖一下这个插件就再也装不上
    void task.catch(() => {}).then(() => {
      if (inflight.get(k) === task) inflight.delete(k)
    })

    return task
  }

  async function load(row: ModuleRow): Promise<PluginRuntime> {
    await arrive(row)
    return materialize(row.id).exports as PluginRuntime
  }

  function invalidate(rawId: string): void {
    const k = key(rawId)
    factories.delete(k)
    cache.delete(k)
    inflight.delete(k)
    materializing.delete(k)
    styles.removeOwned(k)
  }

  return {
    arrive,
    load,
    materialize,
    require,
    invalidate,
    registerStatic(id, exports) {
      statics[key(id)] = exports
    },
    registered(id) {
      return factories.has(key(id))
    },
    materialized(id) {
      return cache.has(key(id))
    },
    bridge,
  }
}

/* ────────────────────────── 默认实现(浏览器) ────────────────────────── */

async function defaultLoadText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`modules: 拉取 ${url} 失败 (${res.status})`)
  return await res.text()
}

/**
 * 见 ClientModuleOptions.evaluate 的注释: 用 `new Function` 是为了能捕获 bundle 的顶层错误。
 *
 * 注入**两个**标识符, 都不依赖真全局 —— 于是 node 侧能塞自己的实现:
 *   - `__MENG_LOADER__`  bundle 用它注册 factory
 *   - `__MENG_REQUIRE__` 构建期 external 掉的共享模块在产物里就落在这个调用上
 *     (vite 的 `output.globals` 把它们映射成 `__MENG_REQUIRE__("react")` 这种形式),
 *     于是**构建期 external 与运行期 require 走的是同一条解析链**, 不会出现第二张表。
 */
function defaultEvaluate(
  code: string,
  id: string,
  loader: LoaderBridge,
  require: RequireFn,
): void {
  const fn = new Function(
    '__MENG_LOADER__',
    '__MENG_REQUIRE__',
    `${code}\n//# sourceURL=${id}/client.js`,
  )
  fn(loader, require)
}

function defaultStyleSink(): StyleSink {
  const doc = typeof document === 'undefined' ? null : document
  return {
    removeOwned(id) {
      if (!doc) return 0
      const els = doc.querySelectorAll(`style[data-plugin="${cssEscape(id)}"]`)
      for (const el of [...els]) el.remove()
      return els.length
    },
    unowned() {
      if (!doc) return 0
      return doc.querySelectorAll('style:not([data-plugin])').length
    },
    warn(message) {
      console.warn(message)
    },
  }
}

/** id 里有 `.` `/` `@`, 直接拼进属性选择器会出事 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
