/**
 * 梦的最小上下文契约。
 *
 * 这里**故意不 import cordis**。理由写在 docs/02-our-base.md §0:
 * 容器实现是可替换的, 插件只认这份契约。cordis / 其他容器通过
 * adapter 实现 Ctx, 所以我们既能复用 dsh 生态, 又不会被它的隐喻锁死。
 */

export type Disposer = () => void | Promise<void>

export type Handler = (...args: any[]) => any

export interface Ctx {
  /** 当前 scope 的标识, 根为 "root", 插件作用域为 row id */
  readonly id: string
  readonly parent: Ctx | null

  /** 取一个能力面 (service)。沿 scope 链上溯, 找不到返回 undefined */
  get<T = unknown>(name: string): T | undefined

  /** 注册能力面。返回 disposer, 调用即注销 */
  set<T>(name: string, value: T): Disposer

  /** 订阅事件。返回 disposer */
  on(event: string, handler: Handler, options?: OnOptions): Disposer

  /** 广播, 不等结果, 不影响控制流 */
  emit(event: string, ...args: any[]): void

  /**
   * 中间件链。listener 收到 (...args, next), 调用 next() 委托下游,
   * 不调用直接 return 即为**短路** —— 这是"钩子能拦截工具"的唯一实现路径。
   */
  waterfall<R = unknown>(event: string, args: any[], fallback: () => Promise<R> | R): Promise<R>

  /** 注册一个副作用, 卸载时逆序展开。所有注册都必须走这里 */
  effect(fn: () => Disposer): Disposer

  /** 子作用域: 继承父级查找, 自己的注册独立回收 */
  scope(id: string): Ctx

  /** 打点: 记录当前 disposer 栈深度, 用于失败回滚 */
  checkpoint(): number

  /** 回滚到某个 checkpoint (插件 apply 抛异常时用) */
  rollback(mark: number): Promise<void>
}

export interface OnOptions {
  /** 越大越先执行。同值按注册顺序 */
  priority?: number
}

interface Entry {
  event: string
  handler: Handler
  priority: number
  seq: number
}

const MISSING = Symbol('missing')

export function createContext(id = 'root', parent: Ctx | null = null): Ctx {
  const services = new Map<string, unknown>()
  const entries: Entry[] = []
  const disposers: Disposer[] = []
  let seq = 0

  const ctx: Ctx = {
    id,
    parent,

    get<T>(name: string): T | undefined {
      if (services.has(name)) return services.get(name) as T
      return parent?.get<T>(name)
    },

    set<T>(name: string, value: T): Disposer {
      if (services.has(name) && services.get(name) !== value) {
        throw new Error(`能力面 ${name} 已被占用 (作用域 ${id})`)
      }
      services.set(name, value)
      // 能力面也进 disposer 栈: 卸载 llm 包时 ctx.llm 必须跟着消失,
      // 否则重装会撞"已被占用", 直接死在第二次装载上 (这个坑 Python 版踩过)
      const off: Disposer = () => {
        if (services.get(name) === value) services.delete(name)
      }
      disposers.push(off)
      return off
    },

    on(event: string, handler: Handler, options?: OnOptions): Disposer {
      const entry: Entry = { event, handler, priority: options?.priority ?? 0, seq: seq++ }
      entries.push(entry)
      const off: Disposer = () => {
        const at = entries.indexOf(entry)
        if (at >= 0) entries.splice(at, 1)
      }
      disposers.push(off)
      return off
    },

    emit(event: string, ...args: any[]): void {
      for (const entry of collect(event)) {
        try {
          entry.handler(...args)
        } catch (err) {
          // 通知型事件不允许一个监听器打断其他监听器
          console.error(`[meng] listener ${entry.event} 抛错:`, err)
        }
      }
    },

    async waterfall<R>(event: string, args: any[], fallback: () => Promise<R> | R): Promise<R> {
      const chain = collect(event)
      let i = 0
      const next = async (): Promise<R> => {
        const entry = chain[i++]
        if (!entry) return await fallback()
        return await entry.handler(...args, next)
      }
      return next()
    },

    effect(fn: () => Disposer): Disposer {
      const off = fn()
      disposers.push(off)
      return off
    },

    scope(childId: string): Ctx {
      return createContext(childId, ctx)
    },

    checkpoint(): number {
      return disposers.length
    },

    async rollback(mark: number): Promise<void> {
      await disposeFrom(disposers, mark)
    },
  }

  function collect(event: string): Entry[] {
    const own = entries.filter((e) => e.event === event)
    const inherited = parent ? (parent as unknown as { __collect?: (e: string) => Entry[] }).__collect?.(event) ?? [] : []
    const merged = [...own, ...inherited]
    merged.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    return merged
  }

  // 让子 scope 能看到父级监听器
  ;(ctx as any).__collect = collect

  return ctx
}

/** 逆序展开 disposer 栈, 单个失败不阻塞其余 */
export async function disposeFrom(stack: Disposer[], mark = 0): Promise<void> {
  while (stack.length > mark) {
    const off = stack.pop()
    if (!off) break
    try {
      await off()
    } catch (err) {
      console.error('[meng] disposer 抛错 (已跳过):', err)
    }
  }
}

export { MISSING }
