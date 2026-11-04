/**
 * 界面入口 —— **编排者, 不是布局**。
 *
 * 它做的只有三件事: 持有会话状态 / 订阅下行事件 / 把一份 `LayoutApi` 交给 `layout.root`。
 * 侧栏、会话区、输入框全在 fallback(内置实现)里, 也就是**全部可被插件替换**。
 *
 * 为什么状态在这里而不是在布局里: 布局是可替换的, 会话状态不是。
 * 状态上移之后, 换一个布局插件, 消息、会话 id、连接状态一条都不会丢。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'

import type { ConnectionState, StreamEvent, Transport } from '@meng/transport'
import type { SlotRegistry } from '@meng/slots'
import { TooltipProvider } from '@meng/ui'
import { bindSnapshotSelector, createSlotRenderer, SlotScopeProvider } from '@meng/web-react'

import { BuiltinLayout } from './BuiltinLayout.tsx'
import { countTools, project, projectJobs } from './conversation.ts'
import type { GraphNode, PluginGraphState } from './PluginPanel.tsx'
import { connectionText, type ComposerApi, type LayoutApi } from './layout.ts'
import type { SectionEntry, SettingsViewApi } from './settings/api.ts'
import { listSessions, type SessionSummary } from './sessions.ts'
import { createConversationStore } from './store.ts'
import { applyTheme, toggleTheme, type ResolvedTheme } from '../theme.ts'
import { readPrefs, updatePrefs, type Prefs } from '../prefs.ts'
import { applyPresentation } from '../presentation.ts'

export interface AppProps {
  transport: Transport
  slots: SlotRegistry
  /** 非空表示当前跑在 fixture 上 —— 界面上必须显式标出来, 免得把假数据当真 */
  fixture: string | null
  /** 非空时加载完成后自动发送这句话 (?auto=...), 给演示与截图用 */
  auto?: string
}

export function App({ transport, slots, fixture, auto }: AppProps) {
  const store = useRef(createConversationStore()).current
  const useStore = useMemo(() => bindSnapshotSelector(store), [store])
  const messages = useStore((s) => project(s.events))
  const jobs = useStore((s) => projectJobs(s.events))
  const toolCount = countTools(messages)

  const Slot = useMemo(() => createSlotRenderer(slots), [slots])

  const [connection, setConnection] = useState<ConnectionState>(transport.state())
  const [sessionId, setSessionId] = useState<string>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  /**
   * 当前会话 id 的 ref 镜像。
   *
   * 订阅回调是**一次性注册**的闭包, 拿不到最新的 sessionId; 而切会话时必须立刻让
   * 过滤生效 —— 用 useEffect 同步 ref 会慢一帧, 那一帧里旧会话的事件会灌进新会话。
   * 所以切会话时手动先写 ref, effect 只做兜底同步。
   */
  const sessionIdRef = useRef<string>()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string>()
  /**
   * 「agent 在等用户批准」。这是 **owner 状态**, 归宿主;
   * 谁在座位上把它画出来, 由 composer 这个 chain 的候选自己 select。
   */
  const [approval, setApproval] = useState<{ command: string } | null>(null)
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )
  /**
   * 视觉偏好的**唯一真相镜像**。
   *
   * 真相在 localStorage（prefs.ts），这里是它的 React 镜像 —— 组件要重渲染就必须有 state。
   * 所有写入口都走 `changePrefs`（标题栏那个开关也一样），所以不存在
   * "一处写了存储、另一处 state 没跟上"的窗口。
   *
   * 为什么不再单独留一个 themeMode: 主题本来就是 Prefs 的一个字段,
   * 单独提出来就有了两处真相, 而它们迟早会在某次切换里不同步。
   */
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs())
  /**
   * 设置页开没开。**归宿主**（view 状态）, 设置页壳只负责把「用户点了返回」抛上来。
   * 打开时 `settings.view` 的 chain 选举上台, 会话流被 display:none 盖住但**不卸载**
   * （B 方案: 返回时滚动位置原样）。
   */
  const [settingsOpen, setSettingsOpen] = useState(
    () => new URLSearchParams(location.search).get('settings') === '1',
  )
  /**
   * 插件状态面板。默认关 —— 它是诊断工具, 不是主界面的一部分。
   * `?panel=1` 可默认打开, 给演示与截图用。
   */
  const [panelOpen, setPanelOpen] = useState(
    () => new URLSearchParams(location.search).get('panel') === '1',
  )
  const [graph, setGraph] = useState<PluginGraphState>({ nodes: [], loading: false })
  /**
   * 手动刷新计数。用 state 而不是直接调函数, 是为了让"拉取"这件事
   * 只有一条路径 —— 定时器和按钮都走这里, 否则两处逻辑迟早会漂。
   */
  const [graphTick, setGraphTick] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // 下行事件 → store。**唯一的写入口**
  //
  // 过滤是必须的: 订阅是全局的, 一个进程里可能开着好几个会话, 不过滤的话
  // 别的会话的事件会灌进当前这条流 —— 表现是"切到 A, 却看见 B 的回复"。
  // 没有 sessionId 的事件放行 (那是内核级的, 不属于任何会话)。
  useEffect(() => {
    const offEvent = transport.subscribe((event) => {
      const sid = event.sessionId
      if (sid && sid !== sessionIdRef.current) return
      store.actions.ingest(event)
    })
    const offState = transport.onStateChange(setConnection)
    return () => {
      offEvent()
      offState()
    }
  }, [transport, store])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  /**
   * 「跟随系统」不是启动时算一次就完事的东西 ——
   * 用户在系统设置里切深浅(或到点自动切换), 界面要**当场**跟着变。
   *
   * 为什么判断用 readPrefs 而不是某个 state: 真相只有一份, 就在存储里。
   * 再引一个 themeMode state 就有了第二处真相, 迟早不同步。
   * 手动选过深浅的人不该被系统改回来 —— 所以偏好不是 system 时直接忽略这个事件。
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (readPrefs().theme !== 'system') return
      setTheme(applyTheme('system'))
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 进页面就建会话: 事件流需要 sessionId 才能归组
  useEffect(() => {
    let alive = true
    transport
      .invoke<{ sessionId: string }>('session.create', {})
      .then((r) => {
        if (alive) setSessionId(r.sessionId)
      })
      .catch((err: unknown) => {
        if (alive) setSendError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [transport])

  // 自动贴底, 但用户往上翻的时候不许把他拽回来。
  // 设置页盖住时**必须停手**: display:none 下 scrollHeight 是 0, 这时候写 scrollTop
  // 会把用户翻到的位置清零 —— 返回时落点就丢了, 那正是 B 方案要保的东西。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || settingsOpen || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, settingsOpen])

  /**
   * 插件状态图。
   *
   * 为什么是轮询而不是订阅: 内核**没有**推送插件状态的事件 (docs/06 的事件表里就没有),
   * 硬造一个等于让前端依赖一个还不存在的协议。这里退一步用轮询, 但加了两个约束:
   *   1. **面板不开就不拉** —— 诊断工具不该在后台烧请求;
   *   2. 开着的时候 4s 一次 —— 插件状态在运行期几乎不变, 比这更密纯属浪费。
   * 等后端真的加了 `plugin/status` 事件, 把这段换掉即可, 组件侧一行不用改。
   */
  useEffect(() => {
    if (!panelOpen) return
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined

    const load = async () => {
      setGraph((prev) => ({ ...prev, loading: true }))
      try {
        const raw = await transport.invoke<{ nodes?: GraphNode[] }>('plugin.graph')
        if (!alive) return
        setGraph({ nodes: Array.isArray(raw?.nodes) ? raw.nodes : [], at: Date.now(), loading: false })
      } catch (err) {
        if (!alive) return
        // 失败时保留上一次的 nodes: 读到过的东西不能因为一次抖动就从屏幕上消失
        setGraph((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }))
      }
    }

    void load()
    timer = setInterval(() => void load(), 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [panelOpen, transport, graphTick])

  // 演示/截图用: 会话建好之后自动发一句
  const autoSent = useRef(false)
  useEffect(() => {
    if (!auto || !sessionId || autoSent.current) return
    autoSent.current = true
    void send(auto)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send 闭包里只有 sessionId/input, auto 演示参数不会中途变
  }, [auto, sessionId])

  async function send(text: string) {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setSendError(undefined)
    try {
      let sid = sessionId
      if (!sid) {
        const created = await transport.invoke<{ sessionId: string }>('session.create', {})
        sid = created.sessionId
        setSessionId(sid)
      }
      await transport.invoke('session.send', { sessionId: sid, text: body })
      setInput('')
      stickToBottom.current = true
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 会话列表: 与当前会话绑定刷新 —— 新建、切换、首屏都走这一条路径,
  // 不另设"手动刷新"入口, 否则迟早会出现"列表和实际不一致"的窗口
  useEffect(() => {
    let alive = true
    void listSessions(transport).then((list) => {
      if (alive) setSessions(list)
    })
    return () => {
      alive = false
    }
  }, [transport, sessionId])

  /**
   * 切会话。
   *
   * 顺序很讲究: 先 reset 再换 id, 否则新会话的第一批历史事件会被
   * "seq 比 lastSeq 小" 的判断丢掉。ref 也要在发请求之前写好 ——
   * 否则 read 回来的事件会被旧会话的过滤条件拦掉。
   */
  async function selectSession(id: string) {
    if (id === sessionId) return
    store.actions.reset()
    setSessionId(id)
    sessionIdRef.current = id
    setInput('')
    setSendError(undefined)
    stickToBottom.current = true
    try {
      const history = await transport.invoke<StreamEvent[]>('session.read', { sessionId: id })
      if (Array.isArray(history)) for (const ev of history) store.actions.ingest(ev)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  async function newSession() {
    store.actions.reset()
    setInput('')
    setSendError(undefined)
    try {
      const created = await transport.invoke<{ sessionId: string }>('session.create', {})
      setSessionId(created.sessionId)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 改任意一项偏好 —— **唯一的写入口**。
   *
   * 顺序: 先落 DOM, 再更新 state。反过来的话会有一帧是
   * 「state 说紧凑、页面还没紧」, 视觉上是一次多余的跳。
   *
   * 标题栏那个开关和设置页走的是同一条路 —— 两个入口各写各的, 是这类
   * 界面最常见的"设置不生效"来源。
   */
  function changePrefs(patch: Partial<Prefs>) {
    const next = updatePrefs(patch)
    setPrefs(next)
    applyPresentation(next)
    // 只有主题要额外落一次: 它还要算出 resolve 后的深浅给 React 用
    if (patch.theme !== undefined) setTheme(applyTheme(next.theme))
  }

  /** 标题栏那个日/月按钮。它只该在浅深之间来回, 所以先 resolve 成具体值再写 */
  function switchTheme() {
    changePrefs({ theme: toggleTheme(theme) })
  }

  const status = connectionText(connection)
  const online = connection === 'online'

  /**
   * 设置分区列表 —— 从注册表投影成壳能直接画的东西。
   *
   * `slots.getSnapshot()` 被读一次是刻意的: 分区插件可能晚于 App 挂载注册
   * （运行时装进来的插件）, 不订阅的话壳会永远停在「没有任何分区」。
   */
  const slotVersion = useSyncExternalStore(
    (fn) => slots.subscribe(fn),
    () => slots.getSnapshot(),
  )
  const settingsSections: SectionEntry[] = useMemo(
    () =>
      slots.entries('settings.section').map((entry) => {
        const meta = (entry.meta ?? {}) as {
          label?: string
          group?: string
          origin?: 'local' | 'kernel'
        }
        return {
          id: entry.pluginId,
          label: meta.label ?? entry.pluginId,
          group: meta.group ?? '其他',
          origin: meta.origin === 'kernel' ? 'kernel' : 'local',
          Component: entry.component as ComponentType<Record<string, unknown>>,
        }
      }),
    // slotVersion 不在函数体里用 —— 它是「注册表变了」的触发器
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots, slotVersion],
  )

  /** `settings.view` 的 owner: 开不开归宿主, 关的动作也从这里给 */
  const settingsView: SettingsViewApi = {
    open: settingsOpen,
    close: () => setSettingsOpen(false),
    sections: settingsSections,
    prefs,
    setPrefs: changePrefs,
  }

  const composer: ComposerApi = {
    value: input,
    setValue: setInput,
    send: () => void send(input),
    busy,
    error: sendError,
    status,
    online,
    approval: approval
      ? {
          command: approval.command,
          approve: () => setApproval(null),
          reject: () => setApproval(null),
        }
      : undefined,
    // 只有 fixture 模式才给这个按钮 —— 真内核下审批来自后端的 `approval/request` 事件
    simulateApproval: fixture ? () => setApproval({ command: 'rm -rf ./build' }) : undefined,
    Slot,
  }

  const api: LayoutApi = {
    messages,
    jobs,
    sessionId,
    sessions,
    onSelectSession: (id: string) => void selectSession(id),
    theme,
    /**
     * 布局也要读偏好: 等待气泡冒不冒、工具卡折没折, 都是**布局渲染时**要用到的,
     * 不是设置页自己的事。传整份 prefs 而不是拆成两个布尔 ——
     * 拆开的话每加一项布局相关的偏好, layout.ts 的契约就要跟着改一次。
     */
    prefs,
    fixture,
    toolCount,
    connection,
    status,
    online,
    onNewSession: () => void newSession(),
    onToggleTheme: switchTheme,
    /** 打开设置页。入口在标题栏（齿轮）, 但「开了」这个状态归宿主 */
    onOpenSettings: () => setSettingsOpen(true),
    composer,
    Slot,
    scrollRef,
    stickToBottom,
    plugins: {
      graph,
      open: panelOpen,
      toggle: () => setPanelOpen((v) => !v),
      close: () => setPanelOpen(false),
      refresh: () => setGraphTick((n) => n + 1),
    },
  }

  return (
    <TooltipProvider delayDuration={400}>
      {/*
        会话作用域: `scope: 'session'` 的洞在没有 sessionId 时**真的不渲染**,
        而不是"声明了但不生效"。首屏那些毫秒里, 消息操作条就不该出现。
      */}
      <SlotScopeProvider sessionId={sessionId}>
        {/*
          ﹝1﹞设置页: 整窗层, 走 chain 选举。

          - `overlay` 是 B 方案的全部实现: 设置页上台时 fallback **仍然挂载**,
            只是 display:none —— 会话流的 DOM、滚动位置、草稿全活着, 返回即原样。
            (不用 overlay 的话 fallback 会被卸载, 落点就丢了。)
          - 为什么不做成 layout.root 的一个候选: layout.root 是 single, 被顶掉 =
            内置布局卸载, 会话流跟着死, 正是上面要避免的事。
          - fallback 不经注册表: 注册表炸了 / 设置插件全挂, 界面照样画得出来。
        */}
        <Slot.Chain
          name="settings.view"
          owner={settingsView}
          overlay
          fallback={
            <Slot name="layout.root" props={api} fallback={<BuiltinLayout {...api} />} />
          }
        />
      </SlotScopeProvider>
    </TooltipProvider>
  )
}
