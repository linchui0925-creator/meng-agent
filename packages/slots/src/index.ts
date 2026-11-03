/**
 * Slot 契约 + 注册表 + 快照 store。
 *
 * 本包**零 React 依赖** —— 渲染后端是可替换的 (web-react 是第一个, 未来可能是 RN / TUI)。
 * 这条边界直接对应 docs/05 §6 的依赖方向: web-react → slots → core。
 *
 * kind 三个 (docs/08 §4 修订): single | list | chain。
 *   - chain 不是可选的复杂度, 是**能力缺口**: 没有它就只能表达「永久替换」,
 *     表达不了「暂时让位」。审批条顶替输入框、按住说话的波形条都属于后者,
 *     而拆掉重装会丢草稿和焦点。详见 docs/08 §4.4。
 *   - keyed 仍然不补: 那是性能问题 (按 id 分发), 不是能力问题。
 * scope 三态 (root | session | session-maybe), 且**必须真的生效** ——
 * 声明了不作为比不声明更坏。
 *
 * 保留 dsh 的一条: **single 的 priority 覆盖** —— 「替代品能替换掉原装」是 slot 系统
 * 存在的意义, 砍了就永远只能改内核。配套同 priority 冲突直接 throw, 保住一格一占。
 */

/** 占位容量: 单个占用者 / 有序列表 / 按状态选举的候选链 */
export type SlotKind = 'single' | 'list' | 'chain'

/** 数据上下文: 全局 / 绑定会话 / 可能没有会话 (如首屏) */
export type SlotScope = 'root' | 'session' | 'session-maybe'

/**
 * 端名。**只是词汇表, 不是注册字段** —— docs/08 §4 定过: 平台过滤统一收在 manifest,
 * 由 shell 在一处读 `PluginRow.platforms`。注册项再带一份必然会出现
 * 「包说支持三端、某个注册说只支持一端」的自相矛盾。
 */
export type PlatformName = 'web' | 'desktop' | 'mobile'

/**
 * Slot 契约表。宿主包通过 declare module 合并扩展:
 *
 *   declare module '@meng/slots' {
 *     interface SlotMap { 'sidebar': { kind: 'single'; scope: 'root' } }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SlotMap {}

/**
 * 合法 slot 名。
 *
 * 契约表为空时放开成 string (开发期能先声明再用); 一旦宿主用 declare module 填了
 * SlotMap, 这里立刻收窄成已知集合 —— 拼错 slot 名变成编译错误, 这就是 docs/08 §4
 * 说的「声明即占用, 把纪律交给类型系统」。
 */
export type SlotName = keyof SlotMap extends never ? string : keyof SlotMap & string

export interface SlotDef {
  kind: SlotKind
  scope: SlotScope
  /** 宿主在 renderSlot 处传入的 props 形状 */
  owner?: object
}

export type Disposer = () => void

/* ────────────────────────── 快照 store ────────────────────────── */

/**
 * 写集: 每个 action 是**纯函数** (state, ...args) => next。
 *
 * 与 dsh 的差别: 他们用 immer draft 变换, 我们不引 immer —— 纯函数写起来稍啰嗦,
 * 但少一个运行时依赖, 而且"写集是审计面"这个性质保持不变: 组件只能通过这些函数写。
 */
export type ActionsDecl<T> = Record<string, (state: T, ...args: any[]) => T>

/** 去掉 state 形参后的回调形态, 即组件 props.actions 拿到的东西 */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (state: T, ...args: infer P) => T ? (...args: P) => void : never
}

/**
 * 持久化配置 (docs/08 §5)。
 *
 * **必须带 version**: dsh 是整值 JSON.parse + try/catch, 失败就静默丢弃 ——
 * 用户升级即失忆。这里就算没有 migrate 也要版本号对得上, 对不上就明确 warn 后重置。
 */
export interface PersistSpec<T> {
  key: string
  version: number
  /** 从旧版本迁移。抛错 → 丢弃并 warn, 不许静默 */
  migrate?: (old: unknown, fromVersion: number) => T
}

export interface StoreSpec<T, A extends ActionsDecl<T>> {
  /** lambda 而非对象: 每个实例都要拿到新鲜状态 */
  init: () => T
  persist?: PersistSpec<T>
  actions: A
}

export interface StoreInstance<T, A extends ActionsDecl<T>> {
  readonly actions: BakedActions<T, A>
  readonly state: T
  getSnapshot(): T
  subscribe(fn: () => void): () => void
  /** 恢复到 init(), 并清掉持久化 (scope 死亡时调用) */
  clearPersisted(): void
}

/**
 * store 句柄。
 *
 * **永远不要在模块级导出句柄** —— dsh 的原话: 模块缓存里的句柄是"跨插件重载存活的
 * 伪单例"。register() 收的是**工厂** (createLayoutStore), 实例化由框架做。
 */
export interface StoreHandle<T, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  create(scopeKey?: string): StoreInstance<T, A>
}

/** 最小存储面: 浏览器传 localStorage, node 测试传内存实现 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function memoryStorage(): StorageLike & { readonly size: number } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    get size() {
      return map.size
    },
  }
}

function defaultStorage(): StorageLike | undefined {
  try {
    // 不要直接摸 window: node 下判断会抛 ReferenceError
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
  } catch {
    return undefined
  }
}

const STORE_PREFIX = 'meng.store.'

function persistKey(key: string, scopeKey?: string): string {
  return `${STORE_PREFIX}${key}${scopeKey ? `.${scopeKey}` : ''}`
}

/**
 * 建一个 store 实例。
 *
 * 谁在用: web-react 的 bindSnapshotSelector 把它绑成 uSES 选择器。
 * **不是** hook, 所以能在 node 里直接测。
 */
export function createStore<T, A extends ActionsDecl<T>>(
  spec: StoreSpec<T, A>,
  options: { scopeKey?: string; storage?: StorageLike } = {},
): StoreInstance<T, A> {
  const storage = options.storage ?? defaultStorage()
  const key = spec.persist ? persistKey(spec.persist.key, options.scopeKey) : undefined

  let state = loadState()
  const listeners = new Set<() => void>()

  function loadState(): T {
    if (!key || !storage) return spec.init()
    const raw = storage.getItem(key)
    if (raw === null) return spec.init()

    try {
      const parsed = JSON.parse(raw) as { v?: number; d?: unknown }
      const from = typeof parsed.v === 'number' ? parsed.v : 0
      const want = spec.persist!.version
      if (from === want) return parsed.d as T

      if (spec.persist!.migrate) {
        try {
          return spec.persist!.migrate(parsed.d, from)
        } catch (err) {
          console.warn(`[store] ${key} 从 v${from} 迁移到 v${want} 失败, 已重置:`, err)
          return spec.init()
        }
      }

      console.warn(`[store] ${key} 版本 v${from} 与当前 v${want} 不符且没有 migrate, 已重置`)
      return spec.init()
    } catch (err) {
      console.warn(`[store] ${key} 读取失败, 已重置:`, err)
      return spec.init()
    }
  }

  function save(): void {
    if (!key || !storage || !spec.persist) return
    try {
      storage.setItem(key, JSON.stringify({ v: spec.persist.version, d: state }))
    } catch (err) {
      // 配额满之类的问题不该让交互挂掉, 但必须留痕
      console.warn(`[store] ${key} 写入失败:`, err)
    }
  }

  function notify(): void {
    for (const fn of [...listeners]) fn()
  }

  const actions = {} as BakedActions<T, A>
  for (const [name, fn] of Object.entries(spec.actions) as [string, (s: T, ...a: any[]) => T][]) {
    ;(actions as Record<string, (...args: unknown[]) => void>)[name] = (...args: unknown[]) => {
      const next = fn(state, ...args)
      // 返回同一引用 = 这次写没有变化, 不通知也不落盘 (避免无意义重渲染)
      if (Object.is(next, state)) return
      state = next
      save()
      notify()
    }
  }

  return {
    actions,
    get state() {
      return state
    },
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    clearPersisted() {
      state = spec.init()
      if (key && storage) storage.removeItem(key)
      notify()
    },
  }
}

/* ────────────────────────── 注册 ────────────────────────── */

export interface SlotRegistration {
  /** slot 名, 点分命名空间 ('conversation.input.model') */
  name: string
  /** 占用者组件。类型由渲染后端决定, 这里只过路 */
  component: unknown
  /** 子 slot 声明 —— 一次注册同时贡献组件和它的扩展点 (声明即占用) */
  children?: Record<string, SlotDef>
  /** store 座位: 传工厂, 不传句柄 */
  store?: () => StoreHandle<any, any>
  /** list 型 slot 的排序键, 小的在前; 相同则按注册先后 */
  order?: number
  /**
   * 优先级。single 是覆盖权 (大的顶掉小的, 同优先级 throw);
   * chain 是**排队顺序** (大的先被问, 同优先级按注册先后 —— 不 throw, 因为候选本来并存)。
   * 缺省 0。
   */
  priority?: number
  /**
   * chain 专用选举函数: 拿到宿主传的 owner props, 返回非 null 表示「这一刻我上」,
   * 返回值会作为组件的 `matched` prop。返回 null / undefined = 弃权, 让下一个候选。
   *
   * **必须是纯函数**: 渲染期会反复调用 (每次宿主 props 变化都重选一遍)。
   * 抛错按弃权处理 —— 一个坏插件不该让整个座位消失。
   */
  select?: (owner: any) => unknown
}

export interface ShadowedEntry {
  registration: SlotRegistration
  /** 顶掉它的那个注册的 pluginId */
  by: string
  pluginId: string
}

/** registry 返回的占用者: 补上 pluginId, 渲染时当 React key 用 */
export type RegisteredSlot = SlotRegistration & { readonly pluginId: string }

export interface SlotRegistry {
  /** 宿主声明 slot 契约。重复声明覆盖旧的 (HMR 友好), 返回撤销 */
  declare(name: SlotName, def: SlotDef): Disposer
  /** 查声明。没声明过返回 undefined */
  decl(name: string): SlotDef | undefined
  /** 插件占用一个 slot。返回注销函数 (幂等) */
  register(pluginId: string, reg: SlotRegistration): Disposer
  /**
   * 等某个 slot 被声明之后再做事 (通常是之后再 register)。
   *
   * 为什么需要它: 插件加载顺序由 manifest 图决定, 不保证被依赖的 UI 插件先到。
   * 没有这条, 往别人 `children` 里插东西的插件只能自己写重试循环, 而每个人写的
   * 退避策略都不一样 —— 那是不可调试的。已声明则**同步立即执行**, 行为一致。
   *
   * 返回撤销: 取消未来的调用。已经执行过的不回滚 (调用方自己负责)。
   */
  waitFor(name: string, fn: (def: SlotDef) => void): Disposer
  /** 当前生效的占用者。single 只返回被选中那一个; chain 返回全部候选 (已排序, 选举在渲染层) */
  entries(name: string): RegisteredSlot[]
  /** 被顶掉的占用者 —— 状态面板要能显示「谁被谁顶掉了」, 不能静默 */
  shadowed(name: string): ShadowedEntry[]
  /** 所有已声明的 slot 名 (诊断用) */
  names(): string[]
  /** 变更订阅 (版本号快照, 给 useSyncExternalStore 用) */
  subscribe(fn: () => void): () => void
  getSnapshot(): number
}

export interface SlotRegistryOptions {
  /** 未声明就注册时是否报错。默认 true —— 拼错 slot 名必须当场炸, 不能静默消失 */
  strict?: boolean
}

const SLOT_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/

interface Item {
  pluginId: string
  reg: SlotRegistration
  /** 注册序号, 用于 list 的稳定排序 —— 不能靠 Array.sort 的稳定性保证语义 */
  seq: number
  alive: boolean
}

export function createSlotRegistry(options: SlotRegistryOptions = {}): SlotRegistry {
  const strict = options.strict ?? true
  const decls = new Map<string, SlotDef>()
  const items = new Map<string, Item[]>()
  /** 等声明的队列: slot 名 → 待触发回调 */
  const waiters = new Map<string, Set<(def: SlotDef) => void>>()
  const listeners = new Set<() => void>()
  let seq = 0
  let version = 0

  function bump(): void {
    version++
    for (const fn of [...listeners]) fn()
  }

  function bucket(name: string): Item[] {
    let list = items.get(name)
    if (!list) {
      list = []
      items.set(name, list)
    }
    return list
  }

  function active(name: string): Item[] {
    const list = bucket(name)
    if (list.length === 0) return []

    const def = decls.get(name)

    if (def?.kind === 'chain') {
      // chain: 候选并存, 全部返回; 大的先被问 (与 single 同向, 免得两套符号记忆),
      // 同 priority 按注册先后 —— 这条稳定排序是「选择结果可复现」的前提
      return [...list].sort((a, b) => (b.reg.priority ?? 0) - (a.reg.priority ?? 0) || a.seq - b.seq)
    }

    // 没声明时按 list 处理: strict 模式在 register 处已经拦下了, 这里只兜底
    if (def?.kind !== 'single') {
      return [...list].sort((a, b) => (a.reg.order ?? 0) - (b.reg.order ?? 0) || a.seq - b.seq)
    }

    let winner: Item | undefined
    for (const item of list) {
      if (!winner) {
        winner = item
        continue
      }
      if ((item.reg.priority ?? 0) > (winner.reg.priority ?? 0)) winner = item
    }
    return winner ? [winner] : []
  }

  /**
   * 声明一个 slot。宿主 declare 与插件 children 共用这一条路径 ——
   * 「声明能力的路径只有一条」, 否则两条路迟早给出不同的冲突行为。
   */
  function declareSlot(name: string, def: SlotDef): Disposer {
    if (!SLOT_NAME_RE.test(name)) {
      throw new Error(`slots: slot 名 "${name}" 不合法, 只允许小写点分命名 (如 conversation.input)`)
    }
    const prev = decls.get(name)
    if (prev && (prev.kind !== def.kind || prev.scope !== def.scope)) {
      throw new Error(
        `slots: slot "${name}" 已经从 ${prev.kind}/${prev.scope} 改成 ${def.kind}/${def.scope}; ` +
          '改契约要同时改所有占用者, 不允许悄悄变性',
      )
    }
    decls.set(name, def)
    bump()

    /**
     * 叫醒等这个声明的人。单个回调抛错不许连累其他回调 ——
     * 一个插件注册失败不能让别人也插不进去。
     */
    const queue = waiters.get(name)
    if (queue) {
      waiters.delete(name)
      for (const fn of [...queue]) {
        try {
          fn(def)
        } catch (err) {
          console.warn(`[slots] waitFor("${name}") 的回调抛错:`, err)
        }
      }
    }

    return () => {
      // 只在还是自己那一版时才撤, 避免后声明者被前者的 cleanup 顺手删掉
      if (decls.get(name) === def) {
        decls.delete(name)
        bump()
      }
    }
  }

  return {
    declare: declareSlot,

    decl(name) {
      return decls.get(name)
    },

    waitFor(name, fn) {
      const ready = decls.get(name)
      if (ready) {
        // 已声明: 同步执行。调用方不用区分「早来」和「晚来」两种情况
        fn(ready)
        return () => {}
      }

      let queue = waiters.get(name)
      if (!queue) {
        queue = new Set()
        waiters.set(name, queue)
      }
      queue.add(fn)
      const mine = queue

      return () => {
        mine.delete(fn)
        if (mine.size === 0) waiters.delete(name)
      }
    },

    register(pluginId, reg) {
      const def = decls.get(reg.name)
      if (!def) {
        if (strict) {
          const known = [...decls.keys()].sort().join(', ') || '(还没声明任何 slot)'
          throw new Error(`slots: "${reg.name}" 没有声明就被注册了 (plugin=${pluginId})。已声明: ${known}`)
        }
      }

      const list = bucket(reg.name)

      if (def?.kind === 'chain') {
        // chain 的语义是「候选并存、按状态选举」, 没有 select 就永远选不出来 —— 当场炸
        if (typeof reg.select !== 'function') {
          throw new Error(
            `slots: "${reg.name}" 是 chain, 注册必须带 select (plugin=${pluginId})。` +
              'chain 的意思就是「按状态决定这一刻谁上」, 没有 select 的 chain 注册是无意义的',
          )
        }
      } else if (reg.select !== undefined) {
        // 反向也拦: 给 single/list 带 select 说明作者以为它是 chain, 静默忽略会让人查半天
        throw new Error(
          `slots: "${reg.name}" 是 ${def?.kind ?? '未声明'}, 不接受 select (plugin=${pluginId})。` +
            '要按状态接管请把 slot 声明成 chain',
        )
      }

      if (def?.kind === 'single') {
        const priority = reg.priority ?? 0
        const clash = list.find((item) => (item.reg.priority ?? 0) === priority)
        if (clash) {
          // 一格一占: 同格同优先级必须炸, 否则谁胜出取决于注册顺序 —— 那是不可调试的
          throw new Error(
            `slots: "${reg.name}" 的 priority=${priority} 已被 ${clash.pluginId} 占用, ` +
              `${pluginId} 要覆盖请显式提高 priority`,
          )
        }
      }

      const item: Item = { pluginId, reg, seq: seq++, alive: true }

      /**
       * 子 slot: 「注册即声明」——
       * 插件把自己这块 UI 放进去的同时, 可以贡献**它自己的**扩展点,
       * 让别的插件往它的组件里插东西 (例如 tool 卡贡献 `tool.result.actions`)。
       * 没有这条, 插件只能用宿主预留的洞, 永远长不出自己的洞。
       */
      const childOffs: Disposer[] = []
      if (reg.children) {
        try {
          for (const [childName, childDef] of Object.entries(reg.children)) {
            childOffs.push(declareSlot(childName, childDef))
          }
        } catch (err) {
          // 一个子 slot 声明失败就整体回滚: 不许留半注册状态 (父 slot 都还没进去)
          for (const off of childOffs) off()
          throw err
        }
      }

      list.push(item)
      bump()

      let disposed = false
      return () => {
        // 幂等: 卸载路径可能被走两遍 (dispose 栈 + 超时兜底), 第二次必须无害
        if (disposed) return
        disposed = true
        for (const off of childOffs) off()
        item.alive = false
        const arr = items.get(reg.name)
        if (!arr) return
        const at = arr.indexOf(item)
        if (at >= 0) arr.splice(at, 1)
        if (arr.length === 0) items.delete(reg.name)
        bump()
      }
    },

    entries(name) {
      return active(name).map((item) => ({ ...item.reg, pluginId: item.pluginId }))
    },

    shadowed(name) {
      const def = decls.get(name)
      if (def?.kind !== 'single') return []
      const winner = active(name)[0]
      if (!winner) return []
      return bucket(name)
        .filter((item) => item !== winner)
        .map((item) => ({
          registration: item.reg,
          by: winner.pluginId,
          pluginId: item.pluginId,
        }))
    },

    names() {
      return [...decls.keys()].sort()
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    getSnapshot() {
      return version
    },
  }
}

/* ────────────────────────── chain 选举 ────────────────────────── */

export interface ChainElection<E> {
  /** 选中的那条注册 */
  entry: E
  /** 它的 select 返回的东西, 会作为组件的 `matched` prop 传下去 */
  matched: unknown
}

/**
 * 在候选链上选举。
 *
 * `entries` 必须已经排好序 (registry.entries 保证: priority 降序 + 注册先后)。
 * 第一个返回非 null 的候选上台; 全部弃权返回 null, 由渲染层落 fallback。
 *
 * 三条硬规矩:
 *   1. 抛错 = 弃权。select 在渲染期跑, 抛一次就炸整棵树是不可接受的
 *   2. null 与 undefined 都算弃权 (只判 null 会逼作者写 return undefined 时踩坑)
 *   3. 空返回值也合法 —— 作者可以用 `{}` 表示「我上, 但没有额外数据」
 */
export function electChain<E extends { pluginId: string; select?: (owner: any) => unknown }>(
  entries: readonly E[],
  owner: unknown,
  onError?: (err: unknown, pluginId: string) => void,
): ChainElection<E> | null {
  for (const entry of entries) {
    if (typeof entry.select !== 'function') continue

    let out: unknown
    try {
      out = entry.select(owner)
    } catch (err) {
      onError?.(err, entry.pluginId)
      continue
    }

    if (out !== null && out !== undefined) return { entry, matched: out }
  }
  return null
}
