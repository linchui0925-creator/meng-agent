/**
 * 布局与输入框的**对外契约**。
 *
 * 为什么单独一份: `layout.root` / `composer` / `conversation.message` /
 * `conversation.tool` 都是「可被替换」的 slot, 替换者(插件)看到的 props
 * 必须是一份稳定的、与内置实现无关的类型。
 * 如果直接让插件吃 App 内部的 state, 内置实现一改字段插件就碎 ——
 * 那样「可替换」是假的。
 *
 * 用 type 而不是 interface: slot 的 props 是 `Record<string, unknown>`,
 * interface 没有隐式索引签名, 展开传参会报不可赋值。
 */

import type { MutableRefObject, ReactNode, RefObject } from 'react'

import type { ConnectionState } from '@meng/transport'
import type { createSlotRenderer } from '@meng/web-react'

import type { ComposerAttachment, FileListing } from './attachments.ts'
import type { JobRow, Message, ModifiedFile, PendingQuestion, ToolCall, WaitState } from './conversation.ts'
import type { QueuedMessage } from './queue.ts'
import type { SessionSummary } from './sessions.ts'
import type { Workspace } from './workspaces.ts'
import type { Prefs } from '../prefs.ts'
import type { ResolvedTheme } from '../theme.ts'
import type { ReasoningEffort } from '@meng/llm'
import type { MemoryStatus } from '@meng/loop'

/** `createSlotRenderer` 的返回类型, 布局自己也要能画内部的洞 */
export type SlotComponent = ReturnType<typeof createSlotRenderer>

/** 与 core/status.ts 的 PluginStatus 逐字对应。宽类型 + 运行期兜底，不到前端崩 */
export type PluginStatus =
  | 'discovered'
  | 'pending'
  | 'disabled'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'

export interface GraphNode {
  id: string
  name: string
  status: PluginStatus
  inject?: string[]
  /** 有值 = 有前端面。面板只读不下载 —— 下载是 modules 的活 */
  client?: { platforms?: string[]; immediately?: boolean; slots?: string[] }
  /** pending 专属：缺哪些依赖。这是这一行最有价值的信息 */
  missing?: string[]
  error?: string
  since?: number
}

export interface PluginGraphState {
  nodes: GraphNode[]
  /** 拉取失败的原因。必须与"零插件"区分开 */
  error?: string
  /** 上次成功拉取的时间 */
  at?: number
  loading: boolean
}

/**
 * 输入框环境栏的公共数据契约。
 *
 * 它曾经长在内置 `ComposerBar.tsx` 里，导致公开 `ComposerApi` 反向依赖内置实现。
 * 现在内置栏与替换插件都从这里拿同一份类型，谁也不再是谁的上游。
 */
/** 模型选择器里的一项。字段缺 = 不知道，不在前端补默认值。 */
export interface ComposerModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  output?: Array<'text' | 'image'>
  reasoning?: boolean
  reasoningEfforts?: ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
  description?: string
}

/** 一个供应商下的模型组。模型不能跨组混在一起选。 */
export interface ComposerModelGroup {
  id: string
  name: string
  models: ComposerModelInfo[]
  /** 清单来源：目录 / 端点 / 手动 / 失败，卡片里用来解释事实从哪来 */
  modelSource?: string
}

export interface ContextCompactResult {
  compacted: boolean
  beforeTokens?: number
  afterTokens?: number
  summarySeq?: number
  reason?: string
}

export type ComposerControls = {
  workspaces: Workspace[]
  workspaceId?: string
  setWorkspace: (id?: string) => void
  /** 这段会话还能不能换目录。新会话 true，说过话之后 false（宿主判定） */
  canPickWorkspace: boolean
  /** 创建并选中工作区；失败时 reject，由界面就地显示原因 */
  createWorkspace: (path: string) => Promise<void>
  /** 打开宿主统一的本机文件夹选择面板 */
  openWorkspacePicker: () => void
  models: string[]
  model?: string
  setModel: (model?: string) => void
  /** 本轮思考程度；缺省 = 跟随厂商/后端默认模型配置 */
  reasoningEffort?: ReasoningEffort
  /** 当前模型向厂商实时申报的档位；没有数据就是空数组，不用通用枚举猜 */
  reasoningEffortOptions: ReasoningEffort[]
  /** 模型选择器的供应商分组；没有这个字段的旧布局仍可只读 `models` */
  modelGroups?: ComposerModelGroup[]
  /** 非空 = 宿主正在等用户确认是否切换模型。 */
  modelSwitch?: ModelSwitchPrompt
  /** 当前模型向厂商申报的默认档位，仅用于展示 */
  defaultReasoningEffort?: ReasoningEffort
  setReasoningEffort: (effort?: ReasoningEffort) => void
  /** `sandbox.mode` 的当前值（ask / auto / full） */
  permission: string
  permissionOptions: Array<{ value: string; label: string }>
  setPermission: (value: string) => void
  /** 旧内核的兼容读数；新内核优先使用下面的完整状态。 */
  context?: { used: number; total?: number }
  /** `context.status` 的完整结果，是上下文面板的唯一真相。 */
  contextStatus?: MemoryStatus
  /** 新会话尚未创建，上下文入口先显示“发送后可用”。 */
  contextPending?: boolean
  /** 已有会话，正在拉 context.status。 */
  contextLoading?: boolean
  /** 主动压缩。返回后端结果，界面收到 `context/compacted` 后仍会重新拉状态。 */
  compactContext?: () => Promise<ContextCompactResult>
  /** git 状态。后端没有这个 op 时整块不画 */
  git?: { branch?: string; dirty?: boolean }
}

/**
 * 输入框契约。
 *
 * 文本的**所有权在宿主**(App), 不在组件 —— 否则换掉输入框时,
 * 草稿、发送中的禁用态、错误提示会跟着一起丢。
 * 插件替换输入框时只需按这个接口渲染, 不需要知道会话怎么建。
 */
export type ModelSwitchPrompt = {
  from?: string
  to: string
  fromLabel: string
  toLabel: string
  estimatedInputTokens: number
  warning?: string
  blocked: boolean
  busy: boolean
  error?: string
  confirm: () => void
  cancel: () => void
}

export type ComposerApi = {
  value: string
  setValue: (value: string) => void
  /** 发送当前值；agent 正在运行时由宿主自动放入等待队列。 */
  send: () => void
  /** 运行中按 Cmd/Ctrl+Enter：放入队首并在当前轮中止后立即发送。 */
  sendNow: () => void
  /** 停止当前轮；已有等待消息会随后继续发送。 */
  stop: () => void
  stopping: boolean
  busy: boolean
  /** 当前会话尚未发出的消息，按发送顺序排列。 */
  queued: readonly QueuedMessage[]
  /** 正在行内编辑的等待消息。编辑期间自动发送暂停。 */
  queuedEditingId?: string
  /** 正在等待当前轮结束、准备立即插入的消息。 */
  queuedInsertingId?: string
  beginQueuedEdit: (id: string) => void
  cancelQueuedEdit: () => void
  saveQueuedEdit: (id: string, text: string) => void
  removeQueued: (id: string) => void
  insertQueued: (id: string) => void
  /** 上一次发送失败的原因 */
  error?: string
  /** 连接状态的人话版本, 可直接渲染 */
  status: string
  online: boolean
  /**
   * 输入框底部那条环境栏（工作区 / 权限 / 模型 / 上下文 / git / ＋）。
   *
   * 状态全在宿主: 换掉输入框的插件如果自己藏这些状态, 一次替换就把
   * "我在哪个目录、用什么权限、哪一轮用哪个模型"一起丢了。
   * `undefined` = 宿主还没准备好（比如模型列表还没拉到）—— 那时整条不画。
   */
  controls?: ComposerControls
  /**
   * 非空 = agent 正在等用户批准一个危险操作。
   *
   * 这是 composer 这个座位从 single 改成 **chain** 的唯一理由:
   * 它必须能被「临时接管」—— 接管期间输入框让位但**不卸载**, 审批完原样回来。
   * 状态归宿主 (这里), 谁上台归插件的 select, 两边不互相知道。
   */
  approval?: ApprovalRequest
  /**
   * 非空 = 有一个问题正等着用户回答。
   *
   * 输入框必须让位: 那一轮是**挂起**的, 发新消息不会让它继续 (docs/06 §1.4:
   * 「回答是唯一入口」)。内置输入框在这个状态下禁用, 而不是让用户对着一个
   * 卡住的 agent 继续打字。
   */
  question?: QuestionPromptApi
  /** 当前草稿里的图片附件；上传成功后只保留附件 id，发送时不带 Base64。 */
  attachments: readonly ComposerAttachment[]
  /** 选文件 / 拖入 / 粘贴共用同一个上传入口。 */
  addFiles: (files: readonly File[]) => void
  removeAttachment: (localId: string) => void
  /** 引用文件面板：读目录并把相对路径插进消息。 */
  referenceRoot: string
  listFiles: (path: string) => Promise<FileListing>
  insertReference: (path: string) => void
  /** 演示用: 模拟一次审批请求 (只在 fixture 模式下提供) */
  simulateApproval?: () => void
  /** 用户主动发起一个后台命令。缺省 = 当前部署没有这个入口。 */
  onStartBackgroundCommand?: (command: string, description?: string) => Promise<void>
  /**
   * 输入框内部的洞。
   *
   * 为什么放在契约里而不是让内置实现自己偷偷画: 工具条是输入框布局的一部分
   * (附件按钮、模型选择、引用文件), 插件替换输入框时如果拿不到 Slot,
   * 就等于把 `composer.actions` 上挂着的所有插件一起埋了 ——
   * 和「换布局必须继续画内部洞」是同一条规矩。
   */
  Slot: SlotComponent
}

export type ApprovalRequest = {
  /** 要执行的命令, 直接展示给用户看 */
  command: string
  approve: () => void
  reject: () => void
}

/**
 * 挂起中的提问 —— 模型 (ask_user_question) 或策略 (拦截) 在等用户回答。
 *
 * 归宿主: 事件流是主通道, `question.answer` 是唯一出口。
 * 布局负责画卡片, 输入框负责让位, 两者都不碰 transport。
 */
export type QuestionAnswer = {
  questionId: string
  /** 选项的 key，或者用户自己写的文本 */
  answer: string
}

export type QuestionPromptApi = {
  /** 当前正在回答的题。 */
  question: PendingQuestion
  /** 同一会话里所有待回答的题，按到达顺序。 */
  queue: readonly PendingQuestion[]
  /** 切到指定问题；不会提交任何草稿，也不改变队列。 */
  selectQuestion: (questionId: string) => void
  /** 用户点一次“提交全部”时，把整组题一起交出去。 */
  submitAnswers: (answers: readonly QuestionAnswer[]) => void
  /** 正在提交 —— 防重复点击 */
  busy: boolean
  /** 整组提交失败的说明 */
  error?: string
}

/**
 * 整体布局契约。
 *
 * 关键一条: **`Slot` 一起传下去**。布局插件换掉整块壳之后,
 * 里面的 `sidebar.footer` / `conversation.actions` / `composer` 还得能画,
 * 否则「换布局」等于把别人的插件全埋了。
 */
export type LayoutApi = {
  view: 'chat' | 'tasks'
  onViewChange: (view: 'chat' | 'tasks') => void
  /** 定时任务页由宿主实现，布局只负责把它放进主区域。 */
  taskCenter: ReactNode
  messages: Message[]
  /**
   * 后台任务。与 messages 平级而不是挂在消息上:
   * 一个任务可能起于第 2 轮、落定于第 5 轮, 挂在某条消息上就等于把它钉死在某一轮。
   */
  jobs: JobRow[]
  sessionId?: string
  /**
   * 会话列表。空数组 = 还没拉到 / 拉失败 / 真的没有, 三种情况界面一视同仁:
   * 侧栏就是空的。列表是次要信息, 它挂了不该把主界面拖下水。
   */
  sessions: SessionSummary[]
  /**
   * 工作区列表。空数组 = 老内核没有这个 op / 拉取失败 / 确实没有。
   * 空的时候侧栏只画「任务」那一段 —— 不画一个空标题。
   */
  workspaces: Workspace[]
  /** 切会话。宿主负责: 换 id → 清空 → 用 session.read 补历史 */
  onSelectSession: (sessionId: string) => void
  /** 本机归档 id。归档只影响侧栏可见性，不删后端会话。 */
  archivedSessionIds: string[]
  onArchiveSession: (sessionId: string, archived: boolean) => void
  /** 只有布局里的二次确认完成后才调用；宿主负责后端删除与切换。 */
  onDeleteSession: (sessionId: string) => Promise<void>
  /** 双击侧栏标题后由居中卡片调用；宿主负责保存并更新列表。 */
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  theme: ResolvedTheme
  /**
   * 视觉偏好（密度 / 动效 / 气泡 / 工具卡折叠）。
   *
   * 传整份而不是拆成一个个布尔: 布局是「渲染时要用到偏好」的地方,
   * 拆开的话每加一项偏好, 这个类型和相关组件就要跟着改一次。
   * 而传整份的代价只是布局能看到几个它不用的字段 —— 没有耦合风险,
   * 因为布局**只读不写**(写入口在宿主)。
   */
  prefs: Prefs
  /** 非 null 表示跑在 fixture 上 */
  fixture: string | null
  toolCount: number
  connection: ConnectionState
  status: string
  online: boolean
  onNewSession: () => void
  /** 从指定工作区新建会话；普通新会话不会走这里。 */
  onNewWorkspaceSession: (workspace: string) => void
  onToggleTheme: () => void
  /** 打开设置页。整窗层由宿主渲染, 布局只负责给入口 */
  onOpenSettings: () => void
  /** 侧栏与输入框共用同一个新建工作区入口 */
  onNewWorkspace: () => void
  composer: ComposerApi
  /**
   * 挂起中的提问。**画在输入框正上方** —— 它挡着输入框, 注意力本来就在那儿。
   * 卡片由布局画 (和任务条同一个位置逻辑), 但状态归宿主。
   */
  question?: QuestionPromptApi
  /** 已注册的插件后台入口数；0 时侧栏不画空分组。 */
  pluginNavCount: number
  /**
   * 问题卡片已经收起、但仍需告知用户的结果。
   * 典型场景: 用户提交时问题已被别处回答，接口回 409。
   */
  questionNotice?: string
  dismissQuestionNotice: () => void
  Slot: SlotComponent
  scrollRef: RefObject<HTMLDivElement | null>
  stickToBottom: MutableRefObject<boolean>
  /**
   * 插件状态面板的状态与开关。
   *
   * 归在 LayoutApi 而不是 ComposerApi: 它是**壳**的一部分 (右侧栏 / 抽屉),
   * 输入框替换者不该被迫接管一个诊断面板。
   * 面板本身是否渲染由布局决定 —— 宽屏常驻、窄屏抽屉, 那是 container query 的事。
   */
  plugins: PluginPanelApi
  /**
   * 取一条工具记录的全文（B-27 的 `tool.record`）。
   *
   * 为什么不给整个 `invoke`: 布局要的能力只有一个 —— "把这条被截断的输出展开"。
   * 给一个万能 invoke 等于把 op 表塞进布局契约, 以后每加一个 op 这里都要多一次
   * 判断"布局能不能调它"。给一个函数, 边界就在签名上。
   *
   * 取不到（404 = 记录已被清理）时 reject, 界面自己决定怎么说。
   */
  readToolRecord: (recordId: string) => Promise<ToolRecord>
  /** 历史消息附件按 id 读回内容；只用于当前会话，失败时画文件名占位。 */
  readAttachment: (attachmentId: string) => Promise<{ id: string; mime: string; dataBase64: string }>
  /** 会话内任务托盘：读取增量输出 / 停止任务。 */
  jobActions: {
    read: (jobId: string) => Promise<{ text: string; job?: unknown }>
    stop: (jobId: string) => Promise<unknown>
  }
}

/**
 * 一条工具记录。字段都来自后端 `tool.record` 的返回, 只有 `text` 是必须的。
 *
 * `value` / `presentation` 是三层分离里的另外两层: 结构化真值 + 界面元信息。
 * 现在工具大多只填 `presentation.group` / `elapsedMs`（管线补的）, 所以这里
 * 允许它们是 undefined —— 界面不猜。
 */
export interface ToolRecord {
  text: string
  value?: unknown
  presentation?: Record<string, unknown>
  bytes?: number
}

/** `conversation.tool` 的公开 props。只换工具卡，不必接管整张消息或布局 */
export type ToolCardApi = {
  tool: ToolCall
  /** 运行步骤内使用紧凑字号与间距。 */
  compact?: boolean
  /** 来自宿主偏好；插件可以照用，也可以自行决定折叠方式 */
  autoFold: boolean
  /** 宿主没接 `tool.record` 时允许缺省，插件不能假定它一定存在 */
  readRecord?: (recordId: string) => Promise<ToolRecord>
}

/** `conversation.message` 的公开 props。状态仍归宿主，插件只替换呈现 */
export type MessageRowApi = {
  message: Message
  /** 等太久时挂在头像上的那一句；只有最后一条助手消息拿得到 */
  whisper?: WaitState | null
  whisperDelay: number
  whisperHold: number
  autoFold: boolean
  readRecord?: (recordId: string) => Promise<ToolRecord>
  readAttachment?: (attachmentId: string) => Promise<{ id: string; mime: string; dataBase64: string }>
  /** 打开右侧文件详情；缺省表示当前布局不支持文件检查器。 */
  onOpenFile?: (file: ModifiedFile) => void
  /** 替换者必须能继续画 `conversation.tool` / `conversation.actions` 等内部的洞 */
  Slot: SlotComponent
}

export type PluginPanelApi = {
  graph: PluginGraphState
  open: boolean
  toggle: () => void
  close: () => void
  refresh: () => void
}

const CONNECTION_TEXT: Record<string, string> = {
  connecting: '连接中',
  online: '已连接',
  offline: '已断开',
  reconnecting: '重连中',
}

export function connectionText(state: ConnectionState): string {
  return CONNECTION_TEXT[state] ?? state
}
