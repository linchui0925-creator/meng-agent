/**
 * 界面入口 —— **编排者, 不是布局**。
 *
 * 它做的只有三件事: 持有会话状态 / 订阅下行事件 / 把一份 `LayoutApi` 交给 `layout.root`。
 * 侧栏、会话区、输入框全在 fallback(内置实现)里, 也就是**全部可被插件替换**。
 *
 * 为什么状态在这里而不是在布局里: 布局是可替换的, 会话状态不是。
 * 状态上移之后, 换一个布局插件, 消息、会话 id、连接状态一条都不会丢。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'

import type { ConnectionState, StreamEvent, Transport } from '@meng/transport'
import type { ReasoningEffort } from '@meng/llm'
import type { MemoryStatus } from '@meng/loop'
import type { SlotRegistry } from '@meng/slots'
import { TooltipProvider } from '@meng/ui'
import { bindSnapshotSelector, createSlotRenderer, SlotScopeProvider } from '@meng/web-react'

import { appendReference, attachmentProblem, fileToBase64, type ComposerAttachment, type FileListing } from './attachments.ts'
import { BuiltinLayout } from './BuiltinLayout.tsx'
import { TaskCenter } from './TaskCenter.tsx'
import styles from './App.module.css'
import { countTools, estimateTokenCount, mergeQuestions, modelReferenceText, parseQuestion, project, projectJobs, questionIdOf, type PendingQuestion } from './conversation.ts'
import { addQueued as addQueuedState, editQueued as editQueuedState, insertQueued as insertQueuedState, isEditingQueued, nextQueued, queueOf, removeQueued as removeQueuedState, type QueuedAttachment, type QueuedMessage, type QueueBySession, type QueueEditing } from './queue.ts'
import {
  connectionText,
  type ComposerApi,
  type ModelSwitchPrompt,
  type QuestionAnswer,
  type QuestionPromptApi,
  type ComposerControls,
  type ContextCompactResult,
  type GraphNode,
  type LayoutApi,
  type PluginGraphState,
} from './layout.ts'
import { MODE_FALLBACK, MODE_IDS, enumOf, permissionOptionsOf } from './permissions.ts'
import type { SectionEntry, SettingsViewApi } from './settings/api.ts'
import { modelGroupsOf, type CatalogProvider } from './settings/model.ts'
import {
  listSessions,
  readArchivedSessions,
  sessionTitleFromInput,
  sortSessionsByActivity,
  writeArchivedSessions,
  type SessionSummary,
} from './sessions.ts'
import { normalizeWorkspaces, type Workspace } from './workspaces.ts'
import { createConversationStore } from './store.ts'
import { createStreamBatcher } from './stream-batcher.ts'
import { applyTheme, toggleTheme, type ResolvedTheme } from '../theme.ts'
import { readPrefs, updatePrefs, type Prefs, type ThemeMode } from '../prefs.ts'
import { applyPresentation } from '../presentation.ts'

type EffortCapability = {
  options: ReasoningEffort[]
  defaultEffort?: ReasoningEffort
}

type ComposerDraft = {
  text: string
  attachments: QueuedAttachment[]
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

export interface AppProps {
  transport: Transport
  slots: SlotRegistry
  /** 非空表示当前跑在 fixture 上 —— 界面上必须显式标出来, 免得把假数据当真 */
  fixture: string | null
  /** 非空时加载完成后自动发送这句话 (?auto=...), 给演示与截图用 */
  auto?: string
  /** 任务完成/失败时由宿主决定如何提醒（桌面是系统通知）。 */
  notify?: (title: string, body: string) => void | Promise<void>
}

export function App({ transport, slots, fixture, auto, notify }: AppProps) {
  const store = useRef(createConversationStore()).current
  const streamBatcher = useMemo(
    () => createStreamBatcher((events) => store.actions.ingestMany(events)),
    [store],
  )
  const useStore = useMemo(() => bindSnapshotSelector(store), [store])
  const messages = useStore((s) => project(s.events))
  const jobs = useStore((s) => projectJobs(s.events))
  const toolCount = countTools(messages)

  const Slot = useMemo(() => createSlotRenderer(slots), [slots])

  const [connection, setConnection] = useState<ConnectionState>(transport.state())
  const [view, setView] = useState<'chat' | 'tasks'>('chat')
  const [sessionId, setSessionId] = useState<string>()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const sessionsRef = useRef<SessionSummary[]>([])
  const notifyRef = useRef(notify)
  /** 归档是前端视图偏好；刷新后由 localStorage 恢复，后端会话保持原样。 */
  const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>(() => readArchivedSessions())


  // ── 输入框那条环境栏的四个来源 ────────────────────────────────────────────
  /**
   * 工作区列表。**拉不到就当没有**（老内核没有 `workspace.list` 这个 op）
   * —— 那时侧栏只画「任务」那一段，输入框那个选择器只说
   * "不指定目录"。整块不报错: 这是锦上添花的信息，不该拖垮主界面。
   */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspacePickError, setWorkspacePickError] = useState<string>()
  const workspacePickBusy = useRef(false)
  /** 下一条消息落进哪个工作区。只有工作区会话草稿才会设置。 */
  const [workspaceId, setWorkspaceId] = useState<string>()
  /** 当前是不是“从工作区新建”的会话草稿；普通新会话始终 false。 */
  const [workspaceDraft, setWorkspaceDraft] = useState(false)
  /** `llm.catalog` 的供应商行；模型选择器按这里分层，不用扁平的 `llm.models` 猜归属。 */
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([])
  /** `llm.models` 的最终可用名单：catalog 分组后还要按它过滤，不能列点了必错的模型。 */
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([])
  /** 设置页关闭时重新拉一次目录；新增供应商后不用刷新整页。 */
  const [catalogTick, setCatalogTick] = useState(0)
  /** 这一轮用哪个模型。空 = 让内核按默认路由挑 */
  const [model, setModel] = useState<string | undefined>(() => readPrefs().model)
  const [modelSwitchRequest, setModelSwitchRequest] = useState<{
    next?: string
    to: string
    fromLabel: string
    toLabel: string
    estimatedInputTokens: number
    warning?: string
    blocked: boolean
  }>()
  const [modelSwitchBusy, setModelSwitchBusy] = useState(false)
  const [modelSwitchError, setModelSwitchError] = useState<string>()
  const modelSwitchBusyRef = useRef(false)
  /** 随每条消息发送的思考程度；缺省由厂商/后端默认模型配置决定 */
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>()
  /** 模型 id → 厂商实时申报的思考档位。缺失时只保留默认，不展示通用全集 */
  const [effortCapabilities, setEffortCapabilities] = useState<Record<string, EffortCapability>>({})
  /** `sandbox.mode` 的当前值与选项（选项来自 `schema.enum`） */
  const [permission, setPermission] = useState('auto')
  const [permissionOptions, setPermissionOptions] = useState<Array<{ value: string; label: string }>>([])
  /** git 状态。后端没有这个 op 时保持 undefined —— 那一格不画 */
  const [git, setGit] = useState<{ branch?: string; dirty?: boolean }>()
  /** 模型 id → 上下文窗口。用来给旧内核的 usage 兜底配分母 */
  const [windows, setWindows] = useState<Record<string, number>>({})
  /** `context.status` 的完整快照。上下文面板只读这一份，不用前端估算硬改。 */
  const [contextStatus, setContextStatus] = useState<MemoryStatus>()
  const [contextLoading, setContextLoading] = useState(false)
  /** turn/ended、context/compacted 和手动压缩共用的一次状态刷新信号。 */
  const [contextTick, setContextTick] = useState(0)
  /**
   * 当前会话 id 的 ref 镜像。
   *
   * 订阅回调是**一次性注册**的闭包, 拿不到最新的 sessionId; 而切会话时必须立刻让
   * 过滤生效 —— 用 useEffect 同步 ref 会慢一帧, 那一帧里旧会话的事件会灌进新会话。
   * 所以切会话时手动先写 ref, effect 只做兜底同步。
   */
  const sessionIdRef = useRef<string | undefined>(undefined)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const attachmentEpoch = useRef(0)
  const sessionCreateRef = useRef<Promise<string> | null>(null)
  /** agent 正在跑的 run，按 sessionId 分开；HTTP 返回不代表一轮结束。 */
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({})
  const activeRunsRef = useRef<Record<string, string>>({})
  /** 极快结束的 run 可能在 HTTP 返回前就先到 turn/ended。 */
  const endedRunsRef = useRef(new Set<string>())
  /** session.send 已发出但 turn/started 还没到的短暂窗口。 */
  const [startingSessions, setStartingSessions] = useState<Record<string, boolean>>({})
  const startingSessionsRef = useRef<Record<string, boolean>>({})
  /** 尚未发送的消息；真正发出去之前绝不进入会话事件流。 */
  const [queueBySession, setQueueBySession] = useState<QueueBySession>({})
  const queueBySessionRef = useRef<QueueBySession>({})
  const [queuedEditing, setQueuedEditing] = useState<QueueEditing>()
  const queuedEditingRef = useRef<QueueEditing | undefined>(undefined)
  const [queuedInserting, setQueuedInserting] = useState<{ sessionId: string; id: string }>()
  const queuedInsertingRef = useRef<{ sessionId: string; id: string } | undefined>(undefined)
  /** 自动发送失败后先停住，等用户编辑/取消/立即插入再重试，避免死循环重发。 */
  const [queueBlocked, setQueueBlocked] = useState<Record<string, boolean>>({})
  const queueBlockedRef = useRef<Record<string, boolean>>({})
  const dispatchingRef = useRef(new Set<string>())
  const [stopping, setStopping] = useState(false)
  const stoppingRef = useRef(false)
  const [sendError, setSendError] = useState<string>()
  /**
   * 「agent 在等用户批准」。这是 **owner 状态**, 归宿主;
   * 谁在座位上把它画出来, 由 composer 这个 chain 的候选自己 select。
   */
  const [approval, setApproval] = useState<{ command: string } | null>(null)
  /**
   * 挂起中的问题 (模型提问 / 策略拦截)。**归宿主**。
   *
   * 事件流是主通道: `question/asked` 挂起, `question/answered` 收起;
   * `question.list` 只做刷新自愈 (重进会话时把没答完的问捞回来)。
   */
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([])
  /** 用户当前正在回答哪一条；缺省/失效时自动落到队列第一条。 */
  const [activeQuestionId, setActiveQuestionId] = useState<string>()
  /** 正在提交回答 —— 防重复点击 */
  const [questionBusy, setQuestionBusy] = useState(false)
  /** 整组提交失败的说明。切题时清掉，避免提示串到别的题。 */
  const [questionError, setQuestionError] = useState<string>()
  /** 卡片已经收起、但用户仍需要知道的结果（例如迟到回答的 409）。 */
  const [questionNotice, setQuestionNotice] = useState<string>()
  /**
   * 提交锁。**用 ref 而不是 state**: state 更新要等下一次渲染, 那个窗口里
   * 连点两下会发出两次 `question.answer` —— 后端回 409, 界面自己吓自己。
   */
  const questionBusyRef = useRef(false)

  const queued = queueOf(queueBySession, sessionId)
  const queuedEditingId = isEditingQueued(queuedEditing, sessionId ?? '') ? queuedEditing?.id : undefined
  const queuedInsertingId = queuedInserting !== undefined && queuedInserting.sessionId === sessionId ? queuedInserting.id : undefined
  const busy = sessionId === undefined
    ? Boolean(startingSessions.__new__)
    : Boolean(activeRuns[sessionId] || startingSessions[sessionId])
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

  /**
   * 模型选择器的最终视图：已启用供应商 + 该家当前模型清单。
   * 这里是**唯一**把 disabledProviders / manualModels 落到模型选择器的地方。
   */
  const modelGroups = useMemo(
    () => modelGroupsOf(catalogProviders, prefs.disabledProviders, prefs.manualModels, availableModelIds),
    [catalogProviders, prefs.disabledProviders, prefs.manualModels, availableModelIds],
  )
  const models = useMemo(() => modelGroups.flatMap((group) => group.models.map((m) => m.id)), [modelGroups])

  /** 当前模型被停用 / 被手动删掉时，别让旧模型名继续挂在输入框上。 */
  useEffect(() => {
    if (models.length === 0 || model === undefined || models.includes(model)) return
    setModel(undefined)
    updatePrefs({ model: undefined })
  }, [model, models])

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  function replaceQueue(next: QueueBySession): void {
    queueBySessionRef.current = next
    setQueueBySession(next)
  }

  function markStarting(session: string, active: boolean): void {
    const next = { ...startingSessionsRef.current }
    if (active) next[session] = true
    else delete next[session]
    startingSessionsRef.current = next
    setStartingSessions(next)
  }

  function markRunStarted(session: string, runId: string): void {
    if (endedRunsRef.current.delete(runId)) {
      markStarting(session, false)
      return
    }
    const runs = { ...activeRunsRef.current, [session]: runId }
    activeRunsRef.current = runs
    setActiveRuns(runs)
    markStarting(session, false)
  }

  function markRunEnded(session: string, runId: string | undefined): void {
    if (runId !== undefined) endedRunsRef.current.add(runId)
    if (runId !== undefined && activeRunsRef.current[session] !== runId) return
    const runs = { ...activeRunsRef.current }
    delete runs[session]
    activeRunsRef.current = runs
    setActiveRuns(runs)
  }

  function markQueueBlocked(session: string, blocked: boolean): void {
    const next = { ...queueBlockedRef.current }
    if (blocked) next[session] = true
    else delete next[session]
    queueBlockedRef.current = next
    setQueueBlocked(next)
  }

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    notifyRef.current = notify
  }, [notify])

  function touchSessionActivity(sessionId: string, seq: number, at: number): void {
    setSessions((current) => {
      if (!current.some((item) => item.sessionId === sessionId)) return current
      return sortSessionsByActivity(current.map((item) => item.sessionId === sessionId
        ? { ...item, lastSeq: Math.max(item.lastSeq, seq), updatedAt: Math.max(item.updatedAt ?? item.at, at) }
        : item))
    })
  }

  // 下行事件 → store。**唯一的写入口**
  //
  // 过滤是必须的: 订阅是全局的, 一个进程里可能开着好几个会话, 不过滤的话
  // 别的会话的事件会灌进当前这条流 —— 表现是"切到 A, 却看见 B 的回复"。
  // 没有 sessionId 的事件放行 (那是内核级的, 不属于任何会话)。
  useEffect(() => {
    const offEvent = transport.subscribe((event) => {
      const sid = event.sessionId
      if (sid && (event.type === 'turn/started' || event.type === 'turn/ended')) {
        touchSessionActivity(sid, event.seq, event.at)
      }
      if (sid && event.type === 'turn/started' && event.runId) markRunStarted(sid, event.runId)
      if (sid && event.type === 'turn/ended') {
        const endedRunWasActive = event.runId !== undefined && activeRunsRef.current[sid] === event.runId
        markRunEnded(sid, event.runId)
        if (endedRunWasActive) {
          const payload = event.payload as { reason?: unknown; error?: unknown } | undefined
          const reason = typeof payload?.reason === 'string' ? payload.reason : 'stop'
          if (reason !== 'aborted') {
            const background = sid !== sessionIdRef.current || document.visibilityState !== 'visible' || !document.hasFocus()
            if (background) {
              const title = reason === 'error' ? '任务失败' : reason === 'max-turns' ? '任务已暂停' : '任务完成'
              const sessionTitle = sessionsRef.current.find((item) => item.sessionId === sid)?.title ?? sid
              const detail = reason === 'error' && typeof payload?.error === 'string'
                ? `${sessionTitle}
${payload.error.slice(0, 160)}`
                : sessionTitle
              void notifyRef.current?.(title, detail)
            }
          }
        }
      }
      if (sid && sid !== sessionIdRef.current) return
      // chunk 走合帧器（对齐 dsh 的 animation-frame publication）；完成、工具和错误事件
      // 会先把前面的 chunk 一并冲出，再立即提交，不会拖慢状态切换。
      streamBatcher.push(event)
      if (event.type === 'context/compacted' || event.type === 'turn/ended') {
        setContextTick((n) => n + 1)
      }
      /*
       * 提问事件不进消息流, 但**要留在事件流里** —— 断线重放时靠它把卡片找回来
       * (`question.list` 只是自愈通道)。会话过滤在上面已经做过: 别的会话的
       * 问题不会挂到当前这一屏上。
       */
      if (event.type === 'question/asked') {
        const question = parseQuestion(event.payload, event.at)
        if (question) {
          setPendingQuestions((current) => mergeQuestions(current, [question]))
          setQuestionError(undefined)
          setQuestionNotice(undefined)
        }
        return
      }
      if (event.type === 'question/answered') {
        const questionId = questionIdOf(event.payload)
        if (questionId) {
          setPendingQuestions((current) => current.filter((question) => question.questionId !== questionId))
          setQuestionError(undefined)
        }
        return
      }
    })
    const offState = transport.onStateChange(setConnection)
    // 后端换代后 transport 会从零重放；旧 lastSeq 也必须清掉，否则重放仍被 store 挡住。
    const offReset = transport.onReset?.(() => {
      streamBatcher.cancel()
      store.actions.reset()
    })
    return () => {
      streamBatcher.cancel()
      offEvent()
      offState()
      offReset?.()
    }
  }, [transport, store, streamBatcher])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  /**
   * 上下文状态只有一个来源：后端 `context.status`。
   * `context/compacted` 到达时只负责触发重拉，绝不根据事件摘要猜 usedTokens。
   */
  useEffect(() => {
    const sid = sessionIdRef.current
    if (sid === undefined) {
      setContextStatus(undefined)
      setContextLoading(false)
      return
    }
    let alive = true
    setContextLoading(true)
    setContextStatus((current) => current?.sessionId === sid ? current : undefined)
    void transport.invoke<MemoryStatus>('context.status', {
      sessionId: sid,
      ...(model === undefined ? {} : { model }),
    }).then((status) => {
      if (!alive || sessionIdRef.current !== sid) return
      setContextStatus(status)
      setContextLoading(false)
    }).catch(() => {
      // 老内核没有这个 op 时退回消息 usage 的旧读数，不把上下文格弄坏。
      if (alive && sessionIdRef.current === sid) {
        setContextStatus(undefined)
        setContextLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [transport, sessionId, model, contextTick])

  const compactContext = useCallback(async (): Promise<ContextCompactResult> => {
    const sid = sessionIdRef.current
    if (sid === undefined) throw new Error('当前没有会话')
    const result = await transport.invoke<ContextCompactResult>('context.compact', {
      sessionId: sid,
      ...(model === undefined ? {} : { model }),
    })
    // 不等事件也可以立刻刷新；随后 context/compacted 再触发一次，结果以新状态为准。
    setContextTick((n) => n + 1)
    return result
  }, [model, transport])

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

  // 只有演示模式需要进页面就建会话，以便自动播放脚本。
  // 真实模式保持“第一句话才建会话”：每次刷新都写一条空会话会污染侧栏。
  useEffect(() => {
    if (fixture === null) return
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
  }, [fixture, transport])

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

  /**
   * 刷新自愈: 把当前会话还挂着的问捞回来。
   *
   * 事件流是主通道, 但**重进会话**时那些事件是在 `session.read` 的历史里补回来的,
   * 那条路不经过事件订阅 —— 所以再问一次 `question.list`。
   * 老内核没有这个 op → 拉不到就当没有, 不报错 (卡片不画而已)。
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    void transport
      .invoke<unknown[]>('question.list')
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const found = list
          .map((item) => parseQuestion(item, Date.now()))
          .filter((item): item is PendingQuestion => item !== undefined && item.sessionId === sessionId)
        // 事件流可能和 question.list 重叠：按 id 合并，不把同一题排两遍。
        if (found.length > 0) setPendingQuestions((current) => mergeQuestions(current, found))
      })
      .catch(() => {
        // 没有这个 op (老内核) —— 不画卡片, 不报错
      })
    return () => {
      alive = false
    }
  }, [sessionId, transport])

  /**
   * 整组提交。用户先把每道题选好，最终只按一次按钮，这里再逐题调用
   * `question.answer`（后端协议仍是一题一个 op，前端负责把这一组一次性发完）。
   *
   * 409 = 该题已经在别处结束：从队列移除，并在卡片外提示。
   * 其它错误 = 不重试答案；调用 `question.fail` 把失败原因交给等待中的工具，
   * 让模型收到 JSON `{ ok: false, error }`，知道这题没有成功提交。
   */
  const activeQuestion =
    pendingQuestions.find((question) => question.questionId === activeQuestionId) ?? pendingQuestions[0]

  async function answerQuestions(items: readonly QuestionAnswer[]): Promise<void> {
    const answers = items
      .map((item) => ({ questionId: item.questionId, answer: item.answer.trim() }))
      .filter((item) => item.questionId !== '' && item.answer !== '')
    if (answers.length === 0) return
    // 提交锁: 连点两下不能把同一组回答发两遍
    if (questionBusyRef.current) return
    questionBusyRef.current = true
    setQuestionBusy(true)
    setQuestionError(undefined)
    try {
      const results = await Promise.allSettled(
        answers.map((item) =>
          transport.invoke('question.answer', { questionId: item.questionId, answer: item.answer }),
        ),
      )
      const done = new Set<string>()
      const failed: Array<{ questionId: string; error: string }> = []
      let ended = 0
      let firstError: string | undefined
      results.forEach((result, index) => {
        const questionId = answers[index]?.questionId
        if (questionId === undefined) return
        if (result.status === 'fulfilled') {
          done.add(questionId)
          return
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        if (/\b409\b/.test(message)) {
          done.add(questionId)
          ended += 1
        } else {
          failed.push({ questionId, error: message })
        }
      })

      // 不重试用户答案。把失败原因单独结算给问题，让等待中的工具能返回给模型。
      let informed = 0
      if (failed.length > 0) {
        const notices = await Promise.allSettled(
          failed.map((item) =>
            transport.invoke('question.fail', { questionId: item.questionId, error: item.error }),
          ),
        )
        notices.forEach((result, index) => {
          const item = failed[index]
          if (item === undefined) return
          if (result.status === 'fulfilled') {
            done.add(item.questionId)
            informed += 1
            return
          }
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
          if (/\b409\b/.test(message)) {
            // 服务端已经结束这题；模型此前已经拿到了该题的结局。
            done.add(item.questionId)
            informed += 1
          } else {
            firstError ??= `回答提交失败，且未能通知模型: ${message}`
          }
        })
      }

      if (done.size > 0) {
        setPendingQuestions((current) => current.filter((item) => !done.has(item.questionId)))
      }
      const notices: string[] = []
      if (ended > 0) notices.push(ended === 1 ? '有 1 个问题已经结束了' : `有 ${ended} 个问题已经结束了`)
      if (informed > 0) notices.push(`${informed} 个回答提交失败，模型已知晓`)
      if (firstError !== undefined) setQuestionError(firstError)
      else if (notices.length > 0) setQuestionNotice(notices.join('；'))
    } finally {
      questionBusyRef.current = false
      setQuestionBusy(false)
    }
  }

  /**
   * 卡片与输入框共用的一份对象。宿主持有状态, 布局画卡片, 输入框让位 ——
   * 谁都不碰 transport。
   */
  const questionPrompt: QuestionPromptApi | undefined = activeQuestion
    ? {
        question: activeQuestion,
        queue: pendingQuestions,
        selectQuestion: (questionId: string) => {
          if (!pendingQuestions.some((question) => question.questionId === questionId)) return
          setActiveQuestionId(questionId)
          setQuestionError(undefined)
        },
        submitAnswers: (answers: readonly QuestionAnswer[]) => void answerQuestions(answers),
        busy: questionBusy,
        ...(questionError !== undefined ? { error: questionError } : {}),
      }
    : undefined

  function replaceAttachments(next: ComposerAttachment[]): void {
    attachmentsRef.current = next
    setAttachments(next)
  }

  function clearAttachments(): void {
    attachmentEpoch.current += 1
    for (const item of attachmentsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
    replaceAttachments([])
  }

  useEffect(() => {
    return () => {
      for (const item of attachmentsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      }
    }
  }, [])

  /**
   * 附件上传和首条消息都可能创建会话；共用一条 Promise，避免双击时建出两个会话。
   */
  async function ensureSession(title: string): Promise<string> {
    const existing = sessionIdRef.current
    if (existing !== undefined) return existing
    if (sessionCreateRef.current !== null) return sessionCreateRef.current
    const creating = transport
      .invoke<{ sessionId: string }>('session.create', {
        title: sessionTitleFromInput(title),
        ...(workspaceId === undefined ? {} : { workspace: workspaceId }),
      })
      .then((created) => {
        setSessionId(created.sessionId)
        sessionIdRef.current = created.sessionId
        return created.sessionId
      })
    sessionCreateRef.current = creating
    try {
      return await creating
    } finally {
      if (sessionCreateRef.current === creating) sessionCreateRef.current = null
    }
  }

  function addFiles(files: readonly File[]): void {
    if (files.length === 0) return
    const epoch = attachmentEpoch.current
    const selected = files.map((file) => {
      const localId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `att-${Date.now()}-${Math.random()}`
      const problem = attachmentProblem({ name: file.name, mime: file.type, size: file.size })
      return {
        localId,
        file,
        draft: {
          localId,
          name: file.name || '粘贴的图片',
          mime: file.type,
          size: file.size,
          previewUrl: URL.createObjectURL(file),
          status: problem === undefined ? ('uploading' as const) : ('error' as const),
          ...(problem === undefined ? {} : { error: problem }),
        } satisfies ComposerAttachment,
      }
    })
    replaceAttachments([...attachmentsRef.current, ...selected.map((item) => item.draft)])

    const valid = selected.filter((item) => item.draft.status === 'uploading')
    if (valid.length === 0) return
    void (async () => {
      let sid: string
      try {
        sid = await ensureSession(valid[0]?.draft.name ?? '图片附件')
      } catch (err) {
        if (epoch !== attachmentEpoch.current) return
        const message = err instanceof Error ? err.message : String(err)
        replaceAttachments(attachmentsRef.current.map((item) =>
          valid.some((entry) => entry.localId === item.localId)
            ? { ...item, status: 'error', error: message }
            : item,
        ))
        return
      }
      for (const item of valid) {
        try {
          const dataBase64 = await fileToBase64(item.file)
          const saved = await transport.invoke<{ id: string }>('attachment.put', {
            sessionId: sid,
            name: item.file.name || 'pasted-image.png',
            mime: item.file.type,
            dataBase64,
          })
          if (epoch !== attachmentEpoch.current) return
          replaceAttachments(attachmentsRef.current.map((entry) =>
            entry.localId === item.localId
              ? { ...entry, status: 'ready', attachmentId: saved.id }
              : entry,
          ))
        } catch (err) {
          if (epoch !== attachmentEpoch.current) return
          const message = err instanceof Error ? err.message : String(err)
          replaceAttachments(attachmentsRef.current.map((entry) =>
            entry.localId === item.localId ? { ...entry, status: 'error', error: message } : entry,
          ))
        }
      }
    })()
  }

  function removeAttachment(localId: string): void {
    const target = attachmentsRef.current.find((item) => item.localId === localId)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    replaceAttachments(attachmentsRef.current.filter((item) => item.localId !== localId))
  }

  const referenceRoot = workspaceId === undefined
    ? '.'
    : (workspaces.find((workspace) => workspace.id === workspaceId)?.path ?? '.')

  async function listFiles(path: string): Promise<FileListing> {
    const raw = await transport.invoke<unknown>('fs.list', { path })
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const entries = Array.isArray(record.entries)
      ? record.entries
          .filter((entry): entry is { name: string; dir: boolean } =>
            typeof entry === 'object' && entry !== null &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { dir?: unknown }).dir === 'boolean',
          )
          .map((entry) => ({ name: entry.name, dir: entry.dir }))
      : []
    return {
      path: typeof record.path === 'string' ? record.path : path,
      ...(typeof record.parent === 'string' ? { parent: record.parent } : {}),
      entries,
    }
  }

  // 演示/截图用: 会话建好之后自动发一句
  const autoSent = useRef(false)
  useEffect(() => {
    if (!auto || !sessionId || autoSent.current) return
    autoSent.current = true
    void send(auto)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send 闭包里只有 sessionId/input, auto 演示参数不会中途变
  }, [auto, sessionId])

  function replaceQueuedEditing(next: QueueEditing | undefined): void {
    queuedEditingRef.current = next
    setQueuedEditing(next)
  }

  function replaceQueuedInserting(next: { sessionId: string; id: string } | undefined): void {
    queuedInsertingRef.current = next
    setQueuedInserting(next)
  }

  function composerDraft(text: string): ComposerDraft | undefined {
    const body = text.trim()
    const ready = attachmentsRef.current.filter((item): item is ComposerAttachment & { attachmentId: string } =>
      item.status === 'ready' && item.attachmentId !== undefined,
    )
    if (!body && ready.length === 0) return undefined
    return {
      text: body,
      attachments: ready.map((item) => ({ id: item.attachmentId, name: item.name })),
    }
  }

  function clearComposer(): void {
    setInput('')
    clearAttachments()
  }

  function queuedMessageOf(session: string, draft: ComposerDraft, interruptRunId?: string): QueuedMessage {
    return {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `queued-${Date.now()}-${Math.random()}`,
      sessionId: session,
      text: draft.text,
      attachments: draft.attachments,
      createdAt: Date.now(),
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(interruptRunId === undefined ? {} : { interruptRunId }),
    }
  }

  function queueDraft(session: string, draft: ComposerDraft, front = false, interruptRunId?: string): QueuedMessage {
    const message = queuedMessageOf(session, draft, interruptRunId)
    replaceQueue(addQueuedState(queueBySessionRef.current, message, front))
    markQueueBlocked(session, false)
    clearComposer()
    return message
  }

  async function dispatchComposer(draft: ComposerDraft): Promise<void> {
    markStarting('__new__', true)
    let sid: string | undefined
    try {
      const title = draft.text || draft.attachments[0]?.name || '图片'
      sid = await ensureSession(title)
      markStarting(sid, true)
      const accepted = await transport.invoke<{ runId?: string; accepted?: boolean }>('session.send', {
        sessionId: sid,
        text: draft.text,
        ...(draft.attachments.length > 0 ? { attachments: draft.attachments.map((item) => item.id) } : {}),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      if (accepted?.runId) markRunStarted(sid, accepted.runId)
      clearComposer()
      stickToBottom.current = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (draft.attachments.length > 0) {
        clearAttachments()
        setSendError(`${message}；图片附件已移除，可以继续发送文字`)
      } else {
        setSendError(message)
      }
    } finally {
      markStarting('__new__', false)
      if (sid !== undefined) markStarting(sid, false)
    }
  }

  async function send(text: string) {
    const draft = composerDraft(text)
    if (draft === undefined) return
    if (attachmentsRef.current.some((item) => item.status === 'uploading')) {
      setSendError('图片还在上传，请稍候')
      return
    }
    const sid = sessionIdRef.current
    if (sid === undefined) {
      if (startingSessionsRef.current.__new__) {
        setSendError('会话正在创建，稍后再排队')
        return
      }
      setSendError(undefined)
      await dispatchComposer(draft)
      return
    }
    if (activeRunsRef.current[sid] || startingSessionsRef.current[sid] || queueOf(queueBySessionRef.current, sid).length > 0) {
      queueDraft(sid, draft)
      return
    }
    setSendError(undefined)
    await dispatchComposer(draft)
  }

  async function abortRun(runId: string, session: string, queuedId?: string): Promise<void> {
    if (stoppingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    if (queuedId !== undefined) replaceQueuedInserting({ sessionId: session, id: queuedId })
    try {
      await transport.invoke('session.abort', { runId })
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }

  function sendNow(text: string): void {
    const draft = composerDraft(text)
    if (draft === undefined) return
    if (attachmentsRef.current.some((item) => item.status === 'uploading')) {
      setSendError('图片还在上传，请稍候')
      return
    }
    const sid = sessionIdRef.current
    if (sid === undefined) {
      void send(text)
      return
    }
    const runId = activeRunsRef.current[sid]
    const message = queueDraft(sid, draft, true, runId)
    if (runId) void abortRun(runId, sid, message.id)
  }

  function stopCurrent(): void {
    const sid = sessionIdRef.current
    const runId = sid === undefined ? undefined : activeRunsRef.current[sid]
    if (runId && sid !== undefined) void abortRun(runId, sid)
  }

  async function dispatchQueued(session: string): Promise<void> {
    if (dispatchingRef.current.has(session)) return
    if (activeRunsRef.current[session] || startingSessionsRef.current[session]) return
    if (queueBlockedRef.current[session]) return
    if (queuedEditingRef.current?.sessionId === session) return
    const message = nextQueued(queueBySessionRef.current, session)
    if (message === undefined) return

    dispatchingRef.current.add(session)
    markStarting(session, true)
    try {
      const accepted = await transport.invoke<{ runId?: string; accepted?: boolean }>('session.send', {
        sessionId: session,
        text: message.text,
        ...(message.attachments.length > 0 ? { attachments: message.attachments.map((item) => item.id) } : {}),
        ...(message.model === undefined ? {} : { model: message.model }),
        ...(message.reasoningEffort === undefined ? {} : { reasoningEffort: message.reasoningEffort }),
        ...(message.interruptRunId === undefined
          ? {}
          : { interruption: { sourceRunId: message.interruptRunId, mode: 'insert' } }),
      })
      replaceQueue(removeQueuedState(queueBySessionRef.current, session, message.id))
      if (queuedInsertingRef.current?.sessionId === session && queuedInsertingRef.current.id === message.id) {
        replaceQueuedInserting(undefined)
      }
      markQueueBlocked(session, false)
      if (accepted?.runId) markRunStarted(session, accepted.runId)
      if (session === sessionIdRef.current) stickToBottom.current = true
    } catch (err) {
      markQueueBlocked(session, true)
      if (session === sessionIdRef.current) {
        setSendError(`等待消息发送失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      dispatchingRef.current.delete(session)
      markStarting(session, false)
    }
  }

  function beginQueuedEdit(id: string): void {
    const sid = sessionIdRef.current
    if (sid === undefined) return
    if (queuedInsertingRef.current?.sessionId === sid && queuedInsertingRef.current.id === id) return
    if (!queueOf(queueBySessionRef.current, sid).some((message) => message.id === id)) return
    replaceQueuedEditing({ sessionId: sid, id })
    setSendError(undefined)
  }

  function cancelQueuedEdit(): void {
    replaceQueuedEditing(undefined)
  }

  function saveQueuedEdit(id: string, text: string): void {
    const sid = sessionIdRef.current
    if (sid === undefined) return
    const body = text.trim()
    if (!body) {
      setSendError('等待消息不能为空')
      return
    }
    replaceQueue(editQueuedState(queueBySessionRef.current, sid, id, body))
    replaceQueuedEditing(undefined)
    markQueueBlocked(sid, false)
    setSendError(undefined)
  }

  function removeQueuedMessage(id: string): void {
    const sid = sessionIdRef.current
    if (sid === undefined) return
    replaceQueue(removeQueuedState(queueBySessionRef.current, sid, id))
    if (queuedEditingRef.current?.sessionId === sid && queuedEditingRef.current.id === id) replaceQueuedEditing(undefined)
    if (queuedInsertingRef.current?.sessionId === sid && queuedInsertingRef.current.id === id) replaceQueuedInserting(undefined)
    markQueueBlocked(sid, false)
  }

  function insertQueuedMessage(id: string): void {
    const sid = sessionIdRef.current
    if (sid === undefined) return
    if (queuedInsertingRef.current !== undefined && queuedInsertingRef.current.id !== id) return
    const found = queueOf(queueBySessionRef.current, sid).find((message) => message.id === id)
    if (found === undefined) return
    if (queuedEditingRef.current?.sessionId === sid && queuedEditingRef.current.id !== id) return
    const runId = activeRunsRef.current[sid]
    replaceQueue(insertQueuedState(queueBySessionRef.current, sid, id, runId))
    if (queuedEditingRef.current?.sessionId === sid && queuedEditingRef.current.id === id) replaceQueuedEditing(undefined)
    markQueueBlocked(sid, false)
    if (runId) void abortRun(runId, sid, id)
  }

  useEffect(() => {
    for (const [session, messages] of Object.entries(queueBySession)) {
      if (messages.length === 0) continue
      if (activeRuns[session] || startingSessions[session]) continue
      if (queueBlocked[session] || dispatchingRef.current.has(session)) continue
      if (queuedEditing?.sessionId === session) continue
      if (
        session === sessionId &&
        (pendingQuestions.length > 0 || questionBusyRef.current || approval !== null)
      ) continue
      void dispatchQueued(session)
    }
  }, [queueBySession, activeRuns, startingSessions, queueBlocked, queuedEditing, pendingQuestions, approval, sessionId])

  // 会话列表: 与当前会话绑定刷新 —— 新建、切换、首屏都走这一条路径,
  // 不另设"手动刷新"入口, 否则迟早会出现"列表和实际不一致"的窗口
  useEffect(() => {
    let alive = true
    void listSessions(transport).then((list) => {
      if (alive) setSessions(sortSessionsByActivity(list))
    })
    return () => {
      alive = false
    }
  }, [transport, sessionId])

  /**
   * 环境栏的四份数据。**全部"拉不到就当没有"**。
   *
   * 老内核可能缺其中几项（`workspace.list` / `git.status` / 模型窗口在
   * `llm.catalog` 里）。所以这里一次并发全试，各自 catch ——
   * 一个 op 不存在不该让整条环境栏消失，更不该让页面报错。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const [ws, ms, cfg, catalog, gs] = await Promise.all([
        transport.invoke('workspace.list').catch(() => undefined),
        transport.invoke('llm.models').catch(() => undefined),
        transport.invoke('config.list').catch(() => undefined),
        transport.invoke('llm.catalog').catch(() => undefined),
        transport.invoke('git.status').catch(() => undefined),
      ])
      if (!alive) return

      setWorkspaces(normalizeWorkspaces(ws))
      setAvailableModelIds(
        Array.isArray(ms) ? ms.filter((m): m is string => typeof m === 'string' && m !== '') : [],
      )

      // 旧内核没有 catalog 时，至少把 `llm.models` 当成一组兜底展示。
      // 新内核优先走带供应商归属的 catalog。
      if (!Array.isArray(catalog) && Array.isArray(ms)) {
        const ids = ms.filter((m): m is string => typeof m === 'string' && m !== '')
        setCatalogProviders(ids.length === 0 ? [] : [{
          id: 'default',
          name: '可用模型',
          models: ids.map((id) => ({ id })),
          available: true,
          config: [],
          missing: [],
        }])
      }

      // 权限: 选项从 `schema.enum` 读（后端加第四档这里自动多一项）
      const entry = Array.isArray(cfg)
        ? (cfg as Array<{ key?: unknown; value?: unknown; schema?: unknown }>).find(
            (e) => e.key === 'sandbox.mode',
          )
        : undefined
      if (entry !== undefined) {
        setPermission(typeof entry.value === 'string' && entry.value !== '' ? entry.value : MODE_FALLBACK)
        setPermissionOptions(permissionOptionsOf(enumOf(entry.schema) ?? [...MODE_IDS]))
      }

      // 模型 id → 上下文窗口与实时思考能力。厂商没报的字段保持未知，不在前端补全集。
      if (Array.isArray(catalog)) {
        const rows = catalog as CatalogProvider[]
        setCatalogProviders(rows)
        const map: Record<string, number> = {}
        const capabilities: Record<string, EffortCapability> = {}
        for (const p of rows) {
          for (const m of p.models ?? []) {
            if (typeof m.id !== 'string') continue
            if (typeof m.contextWindow === 'number') map[m.id] = m.contextWindow
            if (Array.isArray(m.reasoningEfforts)) {
              capabilities[m.id] = {
                options: m.reasoningEfforts.filter(isReasoningEffort),
                ...(isReasoningEffort(m.defaultReasoningEffort)
                  ? { defaultEffort: m.defaultReasoningEffort }
                  : {}),
              }
            }
          }
        }
        setWindows(map)
        setEffortCapabilities(capabilities)
      }

      // git: 只有给了 branch 才算有数据 —— `{}` 也当没有，别画一个空壳
      if (gs !== null && typeof gs === 'object') {
        const rec = gs as { branch?: unknown; dirty?: unknown }
        if (typeof rec.branch === 'string' && rec.branch !== '') {
          setGit({ branch: rec.branch, ...(typeof rec.dirty === 'boolean' ? { dirty: rec.dirty } : {}) })
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [transport, catalogTick])

  useEffect(() => {
    setReasoningEffort((current) => {
      if (current === undefined || model === undefined) return current
      const options = effortCapabilities[model]?.options ?? []
      return options.includes(current) ? current : undefined
    })
  }, [model, effortCapabilities])

  /** 切到一个有工作区的会话时, 输入框那个选择器跟着它走 —— 否则"我在哪儿"是错的 */
  useEffect(() => {
    if (sessionId === undefined) return
    const found = sessions.find((s) => s.sessionId === sessionId)
    if (found === undefined) return
    setWorkspaceId(found.workspace)
    setWorkspaceDraft(found.workspace !== undefined)
  }, [sessionId, sessions])

  /**
   * 切会话。
   *
   * 顺序很讲究: 先 reset 再换 id, 否则新会话的第一批历史事件会被
   * "seq 比 lastSeq 小" 的判断丢掉。ref 也要在发请求之前写好 ——
   * 否则 read 回来的事件会被旧会话的过滤条件拦掉。
   */
  async function selectSession(id: string) {
    setView('chat')
    if (id === sessionId) return
    const targetSession = sessions.find((item) => item.sessionId === id)
    setWorkspaceId(targetSession?.workspace)
    setWorkspaceDraft(targetSession?.workspace !== undefined)
    streamBatcher.cancel()
    store.actions.reset()
    // 上一组问题属于上一个会话 —— 不清的话, 新会话还没捞到问题时它还杵在这儿
    setPendingQuestions([])
    setActiveQuestionId(undefined)
    setQuestionError(undefined)
    setQuestionNotice(undefined)
    setModelSwitchRequest(undefined)
    setModelSwitchError(undefined)
    replaceQueuedEditing(undefined)
    setSessionId(id)
    sessionIdRef.current = id
    setInput('')
    setSendError(undefined)
    clearAttachments()
    stickToBottom.current = true
    try {
      const history = await transport.invoke<Array<StreamEvent & { data?: { runId?: string } }>>('session.read', { sessionId: id })
      if (Array.isArray(history)) {
        // HTTP 历史把载荷和 runId 放在 data，实时 WS 使用顶层字段；进入投影前统一。
        const normalized = history.map((ev) => ({
          ...ev,
          runId: ev.runId ?? ev.data?.runId,
          payload: ev.payload ?? ev.data,
        }))
        // 一次写入整页历史：重放几百条事件也只通知 React 一次。
        store.actions.ingestMany(normalized)
        for (const ev of normalized) {
          if (ev.type === 'turn/started' && ev.runId) markRunStarted(id, ev.runId)
          if (ev.type === 'turn/ended') markRunEnded(id, ev.runId)
        }
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 新会话 = **先把台面清空，会话等第一句话再建**。
   *
   * 顶栏“新会话”只创建普通任务，不带目录归属。工作区会话必须从侧栏某个
   * 工作区的 `＋` 进入，目录从创建那一刻就是确定的；只有尚未发出第一条消息时
   * 还能在该工作区列表里确认选择。两类会话不再共用一个“先选目录”的入口。
   */
  function resetConversation(workspace?: string) {
    setView('chat')
    streamBatcher.cancel()
    store.actions.reset()
    setPendingQuestions([])
    setActiveQuestionId(undefined)
    setQuestionError(undefined)
    setQuestionNotice(undefined)
    setModelSwitchRequest(undefined)
    setModelSwitchError(undefined)
    replaceQueuedEditing(undefined)
    setInput('')
    setSendError(undefined)
    clearAttachments()
    setWorkspaceId(workspace)
    setWorkspaceDraft(workspace !== undefined)
    sessionIdRef.current = undefined
    setSessionId(undefined)
  }

  /** 顶栏的“新会话”永远是普通任务，不带目录归属。 */
  function newSession() {
    resetConversation()
  }

  /** 从某个工作区新建会话；目录归属只在这样进入时出现。 */
  function newWorkspaceSession(workspace: string) {
    resetConversation(workspace)
  }

  function archiveSession(id: string, archived: boolean) {
    setArchivedSessionIds((current) => {
      const next = archived ? [...new Set([...current, id])] : current.filter((item) => item !== id)
      writeArchivedSessions(next)
      return next
    })
  }

  async function renameSession(id: string, title: string) {
    const nextTitle = title.trim()
    if (!nextTitle) throw new Error('会话名称不能为空')
    try {
      await transport.invoke('session.rename', { sessionId: id, title: nextTitle })
      setSessions((current) =>
        current.map((session) => (session.sessionId === id ? { ...session, title: nextTitle } : session)),
      )
      setSendError(undefined)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async function deleteSession(id: string) {
    try {
      const result = await transport.invoke<{ ok?: boolean; nextSessionId?: unknown }>('session.delete', {
        sessionId: id,
      })
      setSessions((current) => current.filter((session) => session.sessionId !== id))
      setArchivedSessionIds((current) => {
        if (!current.includes(id)) return current
        const next = current.filter((item) => item !== id)
        writeArchivedSessions(next)
        return next
      })
      if (id === sessionId) {
        const next = typeof result.nextSessionId === 'string' && result.nextSessionId !== id ? result.nextSessionId : undefined
        if (next === undefined) newSession()
        else await selectSession(next)
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
      throw err
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

  /**
   * 侧栏主题导航的写入口。
   *
   * 它和标题栏那个按钮、设置页那三张卡走的是**同一条路** (changePrefs) ——
   * 三个入口各写各的, 是这类界面最常见的"设置不生效"来源。
   */
  function setThemeMode(mode: ThemeMode) {
    changePrefs({ theme: mode })
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
  const pluginNavCount = useMemo(
    () => slots.entries('sidebar.nav').length,
    // slotVersion 是注册表变化的触发器；entries 本身不是响应式对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots, slotVersion],
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

  /**
   * 设置分区的 invoke。**必须稳定** —— 分区用 `useEffect(..., [invoke])` 拉数据,
   * 每次渲染换一个新函数就等于每次重渲染都重新拉一遍。而 App 是会因为
   * 会话流每来一片 token 就重渲染一次的 —— 那会变成一条消息几十次 `llm.catalog`。
   */
  const settingsInvoke = useCallback(
    <T,>(op: string, payload?: unknown) => transport.invoke<T>(op, payload),
    [transport],
  )

  /** `settings.view` 的 owner: 开不开归宿主, 关的动作也从这里给 */
  const settingsView: SettingsViewApi = {
    open: settingsOpen,
    close: () => {
      setSettingsOpen(false)
      // 设置页里可能刚加了供应商；返回时重拉一次目录，模型选择器不用刷新整页。
      setCatalogTick((n) => n + 1)
    },
    sections: settingsSections,
    prefs,
    setPrefs: changePrefs,
    // 分区要用内核能力（读供应商目录 / 写配置）时走这里。
    // 只转一个 invoke: 分区拿不到 transport, 也就拿不到事件流订阅。
    invoke: settingsInvoke,
  }

  /**
   * 环境栏。**没有数据的那几格由 `ComposerBar` 自己决定画不画** ——
   * 这里只如实传"知道多少"：`models` 空 = 没有可选模型；`git` 缺 = 读不到；
   * `context` 缺 = 这一轮还没跑过（或内核没报 usage）。
   */
  const lastUsage = [...messages].reverse().find((m) => m.usage !== undefined)?.usage
  const context = contextStatus !== undefined
    ? {
        used: contextStatus.usedTokens,
        ...(contextStatus.contextWindow === undefined ? {} : { total: contextStatus.contextWindow }),
      }
    : lastUsage === undefined
      ? undefined
      : {
          used: lastUsage.in,
          ...(model !== undefined && windows[model] !== undefined ? { total: windows[model] } : {}),
        }

  /** 后端返回的工作区是唯一真相；同一目录重复选择时不叠两行。 */
  const createWorkspace = useCallback(async (path: string) => {
    const raw = await transport.invoke('workspace.create', { path })
    const created = normalizeWorkspaces([raw])[0]
    if (created === undefined) throw new Error('内核没有返回有效的工作区')
    setWorkspaces((current) => [...current.filter((item) => item.id !== created.id), created])
    resetConversation(created.id)
  }, [transport])

  /** 两个入口共用：直接调电脑自带的选择窗口，取消就安静返回。 */
  const openWorkspacePicker = useCallback(async () => {
    if (workspacePickBusy.current) return
    workspacePickBusy.current = true
    setWorkspacePickError(undefined)
    try {
      const picked = await settingsInvoke<{ path?: string; cancelled?: boolean }>('workspace.pick')
      if (picked.cancelled || !picked.path) return
      await createWorkspace(picked.path)
    } catch (err) {
      setWorkspacePickError(err instanceof Error ? err.message : String(err))
    } finally {
      workspacePickBusy.current = false
    }
  }, [createWorkspace, settingsInvoke])

  function applyModelSelection(next: string | undefined): void {
    setModel(next)
    setReasoningEffort((current) => {
      if (current === undefined || next === undefined) return current
      return (effortCapabilities[next]?.options ?? []).includes(current) ? current : undefined
    })
    updatePrefs({ model: next })
  }

  function modelLabelOf(id: string | undefined): string {
    if (id === undefined) return '默认模型'
    const found = modelGroups.flatMap((group) => group.models).find((item) => item.id === id)
    return found?.name ?? id
  }

  function requestModelSwitch(next: string | undefined): void {
    if (next === model) return
    if (busy) {
      setSendError('当前回复生成中，完成后再切换模型')
      return
    }
    // 还没开始聊：切换只是改变下一轮选择，不需要新上下文，也不额外计费。
    if (sessionIdRef.current === undefined || messages.length === 0) {
      applyModelSelection(next)
      return
    }

    const reference = modelReferenceText(messages)
    const estimatedInputTokens = estimateTokenCount(reference)
    const target = next === undefined
      ? undefined
      : modelGroups.flatMap((group) => group.models).find((item) => item.id === next)
    const messagesToWarn: string[] = []
    let blocked = false
    if (
      target?.input !== undefined &&
      !target.input.includes('image') &&
      attachmentsRef.current.some((item) => item.status === 'ready' && item.attachmentId !== undefined)
    ) {
      blocked = true
      messagesToWarn.push('当前图片附件不受新模型支持，请先移除图片或换一个支持视觉的模型。')
    }
    if (target?.contextWindow !== undefined) {
      if (estimatedInputTokens > target.contextWindow) {
        blocked = true
        messagesToWarn.push(`参考对话约 ${estimatedInputTokens} tokens，超过新模型 ${target.contextWindow} 的上下文窗口。`)
      } else if (estimatedInputTokens > target.contextWindow * 0.85) {
        messagesToWarn.push(`参考对话已接近新模型上下文窗口（约 ${estimatedInputTokens} tokens）。`)
      }
    }
    setModelSwitchError(undefined)
    setModelSwitchRequest({
      ...(next === undefined ? {} : { next }),
      to: next ?? '默认模型',
      fromLabel: modelLabelOf(model),
      toLabel: modelLabelOf(next),
      estimatedInputTokens,
      ...(messagesToWarn.length > 0 ? { warning: messagesToWarn.join('；') } : {}),
      blocked,
    })
  }

  async function confirmModelSwitch(): Promise<void> {
    const request = modelSwitchRequest
    if (request === undefined || request.blocked || modelSwitchBusyRef.current) return
    const sid = sessionIdRef.current
    if (sid === undefined) {
      applyModelSelection(request.next)
      setModelSwitchRequest(undefined)
      return
    }
    modelSwitchBusyRef.current = true
    setModelSwitchBusy(true)
    setModelSwitchError(undefined)
    try {
      await transport.invoke('session.switchModel', {
        sessionId: sid,
        ...(model === undefined ? {} : { from: model }),
        to: request.to,
      })
      applyModelSelection(request.next)
      setModelSwitchRequest(undefined)
    } catch (err) {
      setModelSwitchError(err instanceof Error ? err.message : String(err))
    } finally {
      modelSwitchBusyRef.current = false
      setModelSwitchBusy(false)
    }
  }

  const modelSwitchPrompt: ModelSwitchPrompt | undefined = modelSwitchRequest
    ? {
        ...(model === undefined ? {} : { from: model }),
        to: modelSwitchRequest.to,
        fromLabel: modelSwitchRequest.fromLabel,
        toLabel: modelSwitchRequest.toLabel,
        estimatedInputTokens: modelSwitchRequest.estimatedInputTokens,
        ...(modelSwitchRequest.warning ? { warning: modelSwitchRequest.warning } : {}),
        blocked: modelSwitchRequest.blocked,
        busy: modelSwitchBusy,
        ...(modelSwitchError ? { error: modelSwitchError } : {}),
        confirm: () => void confirmModelSwitch(),
        cancel: () => {
          if (modelSwitchBusyRef.current) return
          setModelSwitchRequest(undefined)
          setModelSwitchError(undefined)
        },
      }
    : undefined

  const controls: ComposerControls = {
    workspaces,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    setWorkspace: setWorkspaceId,
    openWorkspacePicker,
    createWorkspace,
    /*
     * 目录只在**还没开始聊**时能选。
     *
     * 判据是"有没有消息"而不是"有没有 sessionId": 新会话在第一句话之前还没建，
     * 那时用户显然还要能改目录。反过来，切到一条有历史的会话时这一格必须消失
     * —— 那个目录已经在用了。
     */
    canPickWorkspace: workspaceDraft && messages.length === 0,
    models,
    modelGroups,
    ...(model === undefined ? {} : { model }),
    setModel: requestModelSwitch,
    modelSwitch: modelSwitchPrompt,
    reasoningEffort,
    reasoningEffortOptions: model === undefined ? [] : effortCapabilities[model]?.options ?? [],
    ...(model !== undefined && effortCapabilities[model]?.defaultEffort !== undefined
      ? { defaultReasoningEffort: effortCapabilities[model].defaultEffort }
      : {}),
    setReasoningEffort,
    permission,
    permissionOptions,
    setPermission: (value) => {
      // 先落 UI 再写内核: 写失败时至少界面不会停在"点了没反应"，
      // 而 `config.set` 的错误会从下一次 `config.list` 里体现出来
      setPermission(value)
      void transport.invoke('config.set', { key: 'sandbox.mode', value }).catch(() => {
        setSendError('权限模式没写进配置，稍后再试')
      })
    },
    ...(context === undefined ? {} : { context }),
    ...(contextStatus === undefined ? {} : { contextStatus }),
    contextPending: sessionId === undefined,
    contextLoading,
    compactContext,
    ...(git === undefined ? {} : { git }),
  }

  const composer: ComposerApi = {
    ...(sessionId === undefined ? {} : { sessionId }),
    ensureSession: (title?: string) => ensureSession(title ?? '新会话'),
    value: input,
    setValue: setInput,
    send: () => void send(input),
    sendNow: () => sendNow(input),
    stop: stopCurrent,
    stopping,
    busy,
    queued,
    ...(queuedEditingId === undefined ? {} : { queuedEditingId }),
    ...(queuedInsertingId === undefined ? {} : { queuedInsertingId }),
    beginQueuedEdit,
    cancelQueuedEdit,
    saveQueuedEdit,
    removeQueued: removeQueuedMessage,
    insertQueued: insertQueuedMessage,
    error: sendError,
    status,
    online,
    controls,
    attachments,
    addFiles,
    removeAttachment,
    referenceRoot,
    listFiles,
    insertReference: (path: string) => setInput((current) => appendReference(current, path)),
    approval: approval
      ? {
          command: approval.command,
          approve: () => setApproval(null),
          reject: () => setApproval(null),
        }
      : undefined,
    // 有问题挂着时输入框让位 —— 那一轮在等回答, 不是在等新消息
    question: questionPrompt,
    // 只有 fixture 模式才给这个按钮 —— 真内核下审批来自后端的 `approval/request` 事件
    simulateApproval: fixture ? () => setApproval({ command: 'rm -rf ./build' }) : undefined,
    onStartBackgroundCommand: async (command, description) => {
      const sid = sessionIdRef.current
      if (!sid) throw new Error('先在当前会话里发一句话，再启动后台任务')
      await transport.invoke('job.startCommand', {
        sessionId: sid,
        command,
        ...(description === undefined ? {} : { description }),
      })
    },
    Slot,
  }

  const api: LayoutApi = {
    view,
    onViewChange: (next) => setView(next),
    taskCenter: (
      <TaskCenter
        invoke={(op, payload) => transport.invoke(op, payload)}
        workspaces={workspaces}
        model={model}
        modelGroups={modelGroups}
        onOpenSession={(id) => {
          setView('chat')
          void selectSession(id)
        }}
      />
    ),
    messages,
    jobs,
    sessionId,
    sessions,
    workspaces,
    onSelectSession: (id: string) => void selectSession(id),
    archivedSessionIds,
    onArchiveSession: archiveSession,
    onDeleteSession: deleteSession,
    onRenameSession: renameSession,
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
    onNewWorkspaceSession: newWorkspaceSession,
    onToggleTheme: switchTheme,
    /** 侧栏主题导航: 给的是**模式**, 所以「跟随系统」这一档也能被选中 */
    themeMode: prefs.theme,
    onThemeChange: setThemeMode,
    /** 打开设置页。入口在标题栏（齿轮）, 但「开了」这个状态归宿主 */
    onOpenSettings: () => setSettingsOpen(true),
    onNewWorkspace: openWorkspacePicker,
    composer,
    // 卡片画在输入框正上方 (布局负责画, 状态在宿主)
    question: questionPrompt,
    pluginNavCount,
    ...(questionNotice ? { questionNotice } : {}),
    dismissQuestionNotice: () => setQuestionNotice(undefined),
    Slot,
    scrollRef,
    stickToBottom,
    /*
     * 工具记录全文。**只在这一处调 `tool.record`** —— 记录是附属数据,
     * 取不到就 404, 界面按"已被清理"处理, 不弹错。
     */
    readAttachment: async (attachmentId: string) => {
      const sid = sessionIdRef.current
      if (sid === undefined) throw new Error('当前没有会话')
      return transport.invoke<{ id: string; mime: string; dataBase64: string }>('attachment.read', {
        sessionId: sid,
        attachmentId,
      })
    },
    readToolRecord: async (recordId: string) => {
      const rec = await transport.invoke<{ text?: unknown; value?: unknown; presentation?: unknown; bytes?: unknown }>(
        'tool.record',
        { recordId },
      )
      return {
        text: typeof rec?.text === 'string' ? rec.text : '',
        ...(rec?.value === undefined ? {} : { value: rec.value }),
        ...(typeof rec?.presentation === 'object' && rec.presentation !== null
          ? { presentation: rec.presentation as Record<string, unknown> }
          : {}),
        ...(typeof rec?.bytes === 'number' ? { bytes: rec.bytes } : {}),
      }
    },
    jobActions: {
      read: async (jobId, full = false) => {
        const sid = sessionIdRef.current
        if (!sid) throw new Error('当前没有会话')
        return transport.invoke<{
          text: string
          lossy?: boolean
          spillPath?: string
          tailTruncated?: boolean
          job?: unknown
        }>('job.output', { sessionId: sid, jobId, full })
      },
      stop: async (jobId) => {
        const sid = sessionIdRef.current
        if (!sid) throw new Error('当前没有会话')
        return transport.invoke('job.kill', { sessionId: sid, jobId })
      },
    },
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

        {workspacePickError && (
          <div className={styles.workspacePickError} role="alert">
            <span>选择文件夹失败：{workspacePickError}</span>
            <button type="button" onClick={() => setWorkspacePickError(undefined)}>知道了</button>
          </div>
        )}
      </SlotScopeProvider>
    </TooltipProvider>
  )
}
