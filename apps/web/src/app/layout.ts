/**
 * 布局与输入框的**对外契约**。
 *
 * 为什么单独一份: `layout.root` 与 `composer` 是「可被替换」的两个 slot,
 * 替换者(插件)看到的 props 必须是一份稳定的、与内置实现无关的类型。
 * 如果直接让插件吃 App 内部的 state, 内置实现一改字段插件就碎 ——
 * 那样「可替换」是假的。
 *
 * 用 type 而不是 interface: slot 的 props 是 `Record<string, unknown>`,
 * interface 没有隐式索引签名, 展开传参会报不可赋值。
 */

import type { MutableRefObject, RefObject } from 'react'

import type { ConnectionState } from '@meng/transport'
import type { createSlotRenderer } from '@meng/web-react'

import type { Message } from './conversation.ts'
import type { JobRow } from './conversation.ts'
import type { PluginGraphState } from './PluginPanel.tsx'
import type { SessionSummary } from './sessions.ts'
import type { ResolvedTheme } from '../theme.ts'

/** `createSlotRenderer` 的返回类型, 布局自己也要能画内部的洞 */
export type SlotComponent = ReturnType<typeof createSlotRenderer>

/**
 * 输入框契约。
 *
 * 文本的**所有权在宿主**(App), 不在组件 —— 否则换掉输入框时,
 * 草稿、发送中的禁用态、错误提示会跟着一起丢。
 * 插件替换输入框时只需按这个接口渲染, 不需要知道会话怎么建。
 */
export type ComposerApi = {
  value: string
  setValue: (value: string) => void
  /** 发送当前值。空串 / 发送中由宿主自己忽略 */
  send: () => void
  busy: boolean
  /** 上一次发送失败的原因 */
  error?: string
  /** 连接状态的人话版本, 可直接渲染 */
  status: string
  online: boolean
  /**
   * 非空 = agent 正在等用户批准一个危险操作。
   *
   * 这是 composer 这个座位从 single 改成 **chain** 的唯一理由:
   * 它必须能被「临时接管」—— 接管期间输入框让位但**不卸载**, 审批完原样回来。
   * 状态归宿主 (这里), 谁上台归插件的 select, 两边不互相知道。
   */
  approval?: ApprovalRequest
  /** 演示用: 模拟一次审批请求 (只在 fixture 模式下提供) */
  simulateApproval?: () => void
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
 * 整体布局契约。
 *
 * 关键一条: **`Slot` 一起传下去**。布局插件换掉整块壳之后,
 * 里面的 `sidebar.footer` / `conversation.actions` / `composer` 还得能画,
 * 否则「换布局」等于把别人的插件全埋了。
 */
export type LayoutApi = {
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
  /** 切会话。宿主负责: 换 id → 清空 → 用 session.read 补历史 */
  onSelectSession: (sessionId: string) => void
  theme: ResolvedTheme
  /** 非 null 表示跑在 fixture 上 */
  fixture: string | null
  toolCount: number
  connection: ConnectionState
  status: string
  online: boolean
  onNewSession: () => void
  onToggleTheme: () => void
  /** 打开设置页。整窗层由宿主渲染, 布局只负责给入口 */
  onOpenSettings: () => void
  composer: ComposerApi
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
