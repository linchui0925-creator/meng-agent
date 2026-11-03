/**
 * React 渲染后端。
 *
 * 三端(web / Electron renderer / Capacitor WebView)都跑这一份 —— 这是 docs/05 §1
 * "一个内核三个外壳"能成立的前提: 三端都是 DOM 渲染, 不需要第二套组件代码。
 *
 * 本包**只有薄薄一层**: 把 slots 的快照源绑成 uSES、把 slot 名解析成组件、
 * 把 boot 的过程画成加载页。业务组件一律不在这里 —— 那属于 apps/web 与插件。
 */

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react'

import type { ShellHandle, EntryState } from '@meng/shell'
import { electChain, type RegisteredSlot, type SlotRegistry, type SlotScope } from '@meng/slots'
import type { Transport } from '@meng/transport'

import styles from './AppRoot.module.css'

/* ────────────────────────── uSES 桥 ────────────────────────── */

/** 快照选择器 hook: 组件只订阅自己用到的切片 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

export interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/**
 * 用 useSyncExternalStore 把快照源绑成选择器 hook。
 *
 * 为什么不是 useContext: 插件 store 的生命周期跟插件走, 不是跟组件树走。
 *
 * 这里必须自己做一层记忆化: `useSyncExternalStore` 要求 getSnapshot 返回**稳定引用**,
 * 而选择器常常返回新对象 (`s => ({ a: s.a })`)。不缓存就会 "getSnapshot should be cached"
 * 无限重渲染 —— 这是 uSES 最经典的坑, 也是 dsh 用 useSyncExternalStoreWithSelector 的原因。
 */
export function bindSnapshotSelector<T>(source: SnapshotSource<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => source.subscribe(fn)
  const getState = () => source.getSnapshot()

  return function useSnapshot<S>(sel: (s: T) => S, eq: (a: S, b: S) => boolean = Object.is): S {
    const selRef = useRef(sel)
    const eqRef = useRef(eq)
    selRef.current = sel
    eqRef.current = eq

    // { 源快照, 选择结果 } —— 源没变就直接还旧值; 源变了但选择结果等价也还旧值
    const cache = useRef<{ state: T; value: S } | null>(null)

    const getSnapshot = useCallback(() => {
      const state = getState()
      const prev = cache.current
      if (prev && Object.is(prev.state, state)) return prev.value

      const next = selRef.current(state)
      if (prev && eqRef.current(prev.value, next)) {
        // 选择结果没变: 只更新源快照, 保持 value 引用, 让 React 认为没变化
        cache.current = { state, value: prev.value }
        return prev.value
      }
      cache.current = { state, value: next }
      return next
    }, [])

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
}

/* ────────────────────────── Slot 渲染 ────────────────────────── */

export interface SlotProps {
  /** slot 名, 如 'sidebar' */
  name: string
  /** 传给占用者组件的 props */
  props?: Record<string, unknown>
  /** 没有占用者时渲染什么。**必须能是 null** —— 空 slot 是常态, 不是错误 */
  fallback?: ReactNode
}

export interface SlotChainProps {
  /** chain 型 slot 名 */
  name: string
  /**
   * 同时是两样东西: 传给上台组件的 props, 以及**选举函数的输入**。
   * select 拿不到别的数据 —— 这是它必须是纯函数的前提。
   */
  owner: Record<string, unknown>
  /** 全部候选都弃权时画什么。通常是内置实现 */
  fallback?: ReactNode
  /**
   * 让位期间保持 fallback 挂载 (只是 display:none)。
   * 打开之后, 输入框的草稿、焦点、DOM 状态在接管期间是活着的, 接管结束原样回来。
   * 不打开就是普通替换 —— 那样接管一次丢一次草稿, 等于没做 chain。
   */
  overlay?: boolean
}

/**
 * 渲染器句柄。**是个函数** (可直接 `<Slot name>`), 同时挂着 chain 入口
 * `<Slot.Chain name owner>` —— 保持老的调用点不用改。
 */
export type SlotRenderer = ((props: SlotProps) => ReactNode) & {
  Chain: (props: SlotChainProps) => ReactNode
}

export interface SlotRendererOptions {
  /**
   * 条目渲染崩溃 / 选举函数抛错时的上报口子。
   * 默认只 console.error —— 条目自己退休, 不炸别的条目。
   * 宿主可以接去诊断面板, **不要静默**。
   */
  onEntryError?: (err: unknown, pluginId: string, slotName: string) => void
}

/* ── 会话作用域 ── */

export interface SlotScopeValue {
  /** 当前会话。为空表示首屏 / 无会话状态 */
  sessionId?: string
}

const SlotScopeContext = createContext<SlotScopeValue>({})

/**
 * 声明「往下这一片属于哪个会话」。
 *
 * 为什么必须有: `scope: 'session'` 的 slot 在没有会话时**必须不渲染**,
 * 否则 scope 就是一句写在类型里但没人执行的注释 —— 那比不声明更坏,
 * 因为作者会以为自己声明的东西生效了。
 */
export function SlotScopeProvider(props: { sessionId?: string; children: ReactNode }): ReactNode {
  const value = useMemo(() => ({ sessionId: props.sessionId }), [props.sessionId])
  return <SlotScopeContext.Provider value={value}>{props.children}</SlotScopeContext.Provider>
}

/* ── 条目级错误边界: 崩一个不退全部 ── */

interface BoundaryProps {
  pluginId: string
  slotName: string
  onError?: SlotRendererOptions['onEntryError']
  /** 崩溃后通知座位: chain 要靠它把这个候选从下一轮选举里剔掉 */
  onCrash?: (pluginId: string) => void
  children: ReactNode
}

/**
 * 只包住**单条注册**, 不包整棵树。
 *
 * 一个第三方组件在 render 里 throw 是很常见的 (它拿到的数据形状变了)。没有这层,
 * 整个界面会一起白屏 —— 而罪魁祸首只是侧栏里一个小图标。
 * 这里让它自己退休 (画 null), 其他条目继续。dsh 把这叫 abdicate。
 */
class EntryBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: unknown): void {
    console.error(`[slot] ${this.props.slotName} 的条目 ${this.props.pluginId} 渲染崩溃, 已单独退休:`, err)
    this.props.onError?.(err, this.props.pluginId, this.props.slotName)
    this.props.onCrash?.(this.props.pluginId)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/* ── 焦点接管与归还 ── */

interface SavedFocus {
  el: HTMLElement
  start: number | null
  end: number | null
}

/**
 * 接管时把焦点交给接管者, 退出时还给原来的输入框并恢复光标。
 *
 * 没有这条, chain 在体验上是坏的: 审批条上来了, 用户继续敲键盘, 字符却进了
 * 那个被藏起来的输入框 —— 看不见, 但真写进去了。
 */
function useChainFocus(activeKey: string | null): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const prevKey = useRef<string | null>(null)
  const saved = useRef<SavedFocus | null>(null)
  /**
   * root 内最近一次聚焦过的元素。
   *
   * 为什么需要它: 审批**往往不是用户点出来的** —— 是后端推来的事件, 或者用户刚点过别处的按钮。
   * 那一刻 activeElement 可能压根不在输入框上, 但用户心里"我刚才在哪儿"是输入框。
   * 只认 activeElement 会让归还变成"什么都没有", 草稿还在但光标位置没了。
   */
  const lastInRoot = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && root.contains(target)) lastInRoot.current = target
    }
    root.addEventListener('focusin', onFocusIn)
    return () => root.removeEventListener('focusin', onFocusIn)
  }, [])

  // ⚠️ 故意在渲染期读 DOM, 这是全文件唯一一处。
  // 原因: fallback 一旦 display:none, 浏览器**立刻**让它 blur, activeElement 变 body,
  // 等到 effect 里再查就只能查到 body。唯一还能拿到「光标刚才在哪」的时机是 DOM 更新之前,
  // 也就是这次渲染里。只读不写, 所以 StrictMode 双跑无害。
  if (typeof document !== 'undefined' && activeKey !== null && prevKey.current === null) {
    const root = rootRef.current
    const active = document.activeElement as HTMLElement | null
    const candidate = active && root && root.contains(active) ? active : lastInRoot.current

    if (candidate && candidate.isConnected) {
      const field = candidate as HTMLInputElement
      saved.current = {
        el: candidate,
        start: typeof field.selectionStart === 'number' ? field.selectionStart : null,
        end: typeof field.selectionEnd === 'number' ? field.selectionEnd : null,
      }
    }
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    const was = prevKey.current
    if (was === activeKey) return
    prevKey.current = activeKey

    if (activeKey !== null) {
      if (!root) return
      // 接管者可以自己标 data-autofocus 指定落点; 没标就找第一个可聚焦元素
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')
      target?.focus()
      return
    }

    const restore = saved.current
    saved.current = null
    if (!restore || !restore.el.isConnected) return

    restore.el.focus()
    if (restore.start !== null && typeof (restore.el as HTMLInputElement).setSelectionRange === 'function') {
      try {
        ;(restore.el as HTMLInputElement).setSelectionRange(restore.start, restore.end ?? restore.start)
      } catch {
        // number / date 这类控件不支持选区, 忽略即可
      }
    }
  }, [activeKey])

  return rootRef
}

/**
 * Slot 渲染器: 把 `<Slot name="sidebar" />` 解析成当前占用者。
 *
 * 订阅注册表版本号 —— 注册/注销会让版本 +1, 于是这里重渲染。
 */
export function createSlotRenderer(
  registry: SlotRegistry,
  options: SlotRendererOptions = {},
): SlotRenderer {
  const subscribe = (fn: () => void) => registry.subscribe(fn)
  const getSnapshot = () => registry.getSnapshot()

  /**
   * 读一个 slot 的候选, 并**真的执行** scope 语义:
   *   root         —— 总是画
   *   session      —— 没有当前会话就整个不画 (不能退化成 fallback, 那会让空会话画出假界面)
   *   session-maybe—— 有没有会话都画 (首屏要能看见输入框)
   */
  function useSlotEntries(name: string): { allowed: boolean; entries: RegisteredSlot[] } {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const { sessionId } = useContext(SlotScopeContext)
    const def = registry.decl(name)
    const scope: SlotScope = def?.scope ?? 'root'
    const allowed = !(scope === 'session' && !sessionId)
    return { allowed, entries: allowed ? registry.entries(name) : [] }
  }

  function renderEntry(
    entry: RegisteredSlot,
    slotName: string,
    props: Record<string, unknown> | undefined,
    extra?: Record<string, unknown>,
    onCrash?: (pluginId: string) => void,
  ): ReactNode {
    const Impl = entry.component as ComponentType<Record<string, unknown>>
    return (
      <EntryBoundary
        key={entry.pluginId}
        pluginId={entry.pluginId}
        slotName={slotName}
        onError={options.onEntryError}
        onCrash={onCrash}
      >
        <Impl {...props} {...extra} />
      </EntryBoundary>
    )
  }

  function Slot({ name, props, fallback }: SlotProps): ReactNode {
    const { allowed, entries } = useSlotEntries(name)
    if (!allowed) return null
    if (entries.length === 0) return fallback ?? null
    return <>{entries.map((entry) => renderEntry(entry, name, props))}</>
  }

  function Chain({ name, owner, fallback, overlay }: SlotChainProps): ReactNode {
    const { allowed, entries } = useSlotEntries(name)
    /**
     * 崩过的候选。下一轮选举直接跳过 ——
     * 否则它会一直选上自己、一直渲染成空白, 把 fallback 永久挡在外面。
     * 崩溃记录活到本组件卸载为止; 插件重新注册时 pluginId 相同, 所以不会自动复健,
     * 这是刻意的: 同样的数据喂进去大概率还是崩, 静默重试只会刷屏。
     */
    const [crashed, setCrashed] = useState<ReadonlySet<string>>(() => new Set<string>())
    const onCrash = useCallback((pluginId: string) => {
      setCrashed((prev) => (prev.has(pluginId) ? prev : new Set(prev).add(pluginId)))
    }, [])

    const healthy = crashed.size === 0 ? entries : entries.filter((entry) => !crashed.has(entry.pluginId))
    const election = allowed
      ? electChain(healthy, owner, (err, pluginId) => options.onEntryError?.(err, pluginId, name))
      : null
    const activeKey = election?.entry.pluginId ?? null
    const rootRef = useChainFocus(activeKey)

    if (!allowed) return null

    /**
     * 结构必须**恒定** —— 这是 overlay 能生效的前提, 踩过一次:
     *
     *   有选举结果时临时多包一层 <div hidden>, fallback 在 children 里从 index 0 挪到 index 1,
     *   React 按位置协调, 判定类型不同 → 把整个 fallback 卸载重挂。
     *   结果: 草稿"看起来还在"(因为它在 React state 里), 而 DOM 状态、光标、滚动位置全丢,
     *   焦点还到一个 isConnected=false 的死节点上。
     *
     * 所以两个槽位永远都在, 位置固定, 只切 display 和是否挂载:
     *   mount  —— overlay 打开时, 接管期间 fallback 仍然挂着 (DOM 状态活着)
     *   show   —— 只有没人接管时才显示; 被接管时 display:none
     */
    const mountFallback = !election || overlay === true
    const showFallback = !election

    return (
      <div ref={rootRef} style={{ display: 'contents' }}>
        <div style={{ display: showFallback ? 'contents' : 'none' }}>{mountFallback ? fallback : null}</div>
        <div style={{ display: 'contents' }}>
          {election ? renderEntry(election.entry, name, owner, { matched: election.matched }, onCrash) : null}
        </div>
      </div>
    )
  }

  Slot.displayName = 'Slot'
  Chain.displayName = 'SlotChain'

  const renderer: SlotRenderer = Object.assign(Slot, { Chain })
  return renderer
}

/* ────────────────────────── Transport ────────────────────────── */

const TransportContext = createContext<Transport | null>(null)

export function TransportProvider(props: { transport: Transport; children: ReactNode }): ReactNode {
  return <TransportContext.Provider value={props.transport}>{props.children}</TransportContext.Provider>
}

export interface InvokeState {
  pending: boolean
  error?: string
}

/**
 * 调用宿主能力 (走 transport), 带 pending / error 状态。
 *
 * 与 useInvoke 一起用的是 TransportProvider —— 不把 transport 当模块级单例:
 * 桌面端可以同时连本地内核与云端内核, 单例会直接堵死这条路。
 */
export function useInvoke<T = unknown>(
  op: string,
): [(payload?: unknown) => Promise<T>, InvokeState] {
  const transport = useContext(TransportContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const call = useCallback(
    async (payload?: unknown): Promise<T> => {
      if (!transport) throw new Error(`useInvoke(${op}): 上层没有 TransportProvider`)
      setPending(true)
      setError(undefined)
      try {
        return await transport.invoke<T>(op, payload)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (alive.current) setError(message)
        throw err
      } finally {
        if (alive.current) setPending(false)
      }
    },
    [transport, op],
  )

  return [call, { pending, error }]
}

/* ────────────────────────── 应用根 ────────────────────────── */

export type BootStatus =
  | { status: 'booting'; entries: EntryState[] }
  | { status: 'ready'; handle: ShellHandle }
  | { status: 'failed'; error: string }

export interface AppRootProps {
  /**
   * 启动过程。**收一个 report 回调**而不是直接收 handle ——
   * 旧签名是 `{ handle }`, 而 handle 只有在 boot 结束之后才存在,
   * 于是 `settled=false` 那一态永远不可能出现, 两态闸门形同虚设。
   *
   * **必须幂等**: React 的 StrictMode 会挂载两次, 这里会调两次 start。
   * 由调用方把 boot 的 promise 缓存起来 (见 apps/web/src/main.tsx),
   * 而不是在这里加 "只跑一次" 的 ref —— 那种守卫配合 cleanup 会让加载页永远停住。
   */
  start: (report: (entries: EntryState[]) => void) => Promise<ShellHandle>
  /** boot 完成后画什么 */
  renderApp: (handle: ShellHandle) => ReactNode
  /** 加载页标题 */
  title?: string
}

/**
 * 应用根: 两态闸门。
 *
 * settled=false 时渲染加载页(或失败报告), settled=true 一次性切真 UI。
 * 加载页由本包自己拥有, 不依赖任何插件 —— shell 自足规则:
 * 插件全部装载失败时, 这个页也必须画得出来。所以它只用 token, 不 import 任何插件。
 */
export function AppRoot({ start, renderApp, title = '梦' }: AppRootProps): ReactNode {
  const [state, setState] = useState<BootStatus>({ status: 'booting', entries: [] })

  useEffect(() => {
    let alive = true
    start((entries) => {
      if (alive) setState({ status: 'booting', entries })
    })
      .then((handle) => {
        if (alive) setState({ status: 'ready', handle })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (alive) setState({ status: 'failed', error: message })
      })

    return () => {
      alive = false
    }
  }, [start])

  if (state.status === 'ready') return renderApp(state.handle)

  return (
    <BootScreen
      title={title}
      entries={state.status === 'booting' ? state.entries : []}
      error={state.status === 'failed' ? state.error : undefined}
    />
  )
}

const PHASE_TEXT: Record<string, string> = {
  creating: '准备',
  loading: '装载',
  pending: '等待依赖',
  active: '就绪',
  failed: '失败',
  disposed: '已卸载',
  idle: '未开始',
}

/**
 * 加载页。**故意不依赖 ui 包** —— 它要在 ui 包自己加载失败时也能画出来。
 * 代价是这里有一份很小的样式, 收益是"白屏"这个故障模式被消掉了。
 */
function BootScreen(props: { title: string; entries: EntryState[]; error?: string }): ReactNode {
  const { title, entries, error } = props
  return (
    <div className={styles.boot}>
      <div className={styles.card}>
        <div className={styles.brand}>{title}</div>
        {error ? (
          <>
            <div className={styles.failedTitle}>启动失败</div>
            <div className={styles.failedBody}>{error}</div>
            <button className={styles.retry} type="button" onClick={() => location.reload()}>
              重新加载
            </button>
          </>
        ) : (
          <>
            <div className={styles.hint}>正在装载插件…</div>
            <div className={styles.bar} aria-hidden="true">
              <span className={styles.barFill} />
            </div>
            {entries.length > 0 && (
              <ul className={styles.entries}>
                {entries.map((entry) => (
                  <li key={entry.id} className={styles.entry}>
                    <span className={styles.entryId}>{entry.id}</span>
                    <span className={entry.phase === 'failed' ? styles.phaseBad : styles.phase}>
                      {PHASE_TEXT[entry.phase] ?? entry.phase}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
