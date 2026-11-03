/**
 * 界面入口 —— **编排者, 不是布局**。
 *
 * 它做的只有三件事: 持有会话状态 / 订阅下行事件 / 把一份 `LayoutApi` 交给 `layout.root`。
 * 侧栏、会话区、输入框全在 fallback(内置实现)里, 也就是**全部可被插件替换**。
 *
 * 为什么状态在这里而不是在布局里: 布局是可替换的, 会话状态不是。
 * 状态上移之后, 换一个布局插件, 消息、会话 id、连接状态一条都不会丢。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { ConnectionState, StreamEvent, Transport } from '@meng/transport'
import type { SlotRegistry } from '@meng/slots'
import { TooltipProvider } from '@meng/ui'
import { bindSnapshotSelector, createSlotRenderer, SlotScopeProvider } from '@meng/web-react'

import { BuiltinLayout } from './BuiltinLayout.tsx'
import { countTools, project, projectJobs } from './conversation.ts'
import type { GraphNode, PluginGraphState } from './PluginPanel.tsx'
import { connectionText, type ComposerApi, type LayoutApi } from './layout.ts'
import { listSessions, type SessionSummary } from './sessions.ts'
import { createConversationStore } from './store.ts'
import { applyTheme, saveThemeMode, toggleTheme, type ResolvedTheme } from '../theme.ts'

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

  // 自动贴底, 但用户往上翻的时候不许把他拽回来
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

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

  function switchTheme() {
    const next = toggleTheme(theme)
    applyTheme(next)
    saveThemeMode(next)
    setTheme(next)
  }

  const status = connectionText(connection)
  const online = connection === 'online'

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
    fixture,
    toolCount,
    connection,
    status,
    online,
    onNewSession: () => void newSession(),
    onToggleTheme: switchTheme,
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
          整体布局也是一个洞: 空着用内置实现, 有插件占用就整块换掉。
          fallback 不经注册表 —— 注册表炸了(或插件全挂), 界面照样画得出来。
        */}
        <Slot name="layout.root" props={api} fallback={<BuiltinLayout {...api} />} />
      </SlotScopeProvider>
    </TooltipProvider>
  )
}
