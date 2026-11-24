/**
 * 通信契约 (docs/05 §4 定稿)。
 *
 * 抄 dsh 的 **上行 HTTP / 下行 WebSocket 双流**, 但抽象成能力面, 因为我们有三种内核位置:
 *   web / mobile → 远端内核, 走 ws
 *   desktop      → 本地内核(主进程 Node), 走 ipc
 *   测试         → 进程内直连, 走 inproc
 *
 * 为什么要分双流而不是合成一条: 上行是命令, 需要请求-响应语义和幂等重试;
 * 下行是事件流(token delta / 工具进度 / 状态变更), 需要推和断线重放。
 * 合成一条会在重连时丢掉"哪些命令已确认"的信息。
 *
 * 业务插件只认 invoke/subscribe, 不知道内核在本地还是云端 —— 这是桌面端能
 * "本地跑也能连云端"的前提。
 */

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'reconnecting'

/**
 * 下行事件。**字段以 docs/06 §2.1 为唯一真相**, 这里曾经少三个字段:
 *
 * | 字段 | 为什么必须有 |
 * |---|---|
 * | `seq` | 断线重连靠它算 `lastSeq`; 可选的话前端每次都得判空, 判漏就重放全量 |
 * | `at` | 消息时间线要显示时刻, 缺了只能拿到达时间冒充, 重放时全变成"刚刚" |
 * | `sessionId` / `runId` | 多会话并发时靠它分组; 缺了只能从 payload 里摸, 每个插件各摸一套 |
 *
 * `hello` 帧的 `seq` 是 -1 (握手不占真实序号), 所以这里是 number 不是正整数。
 */
export interface StreamEvent {
  type: string
  seq: number
  at: number
  sessionId?: string
  runId?: string
  payload?: unknown
}

/** 握手帧的 seq 哨兵。前端算 lastSeq 时必须跳过它, 否则重连会过滤掉全部历史 */
export const HELLO_SEQ = -1

export interface Transport {
  /** 上行: 命令。返回 Promise, 失败要可重试 */
  invoke<T = unknown>(op: string, payload?: unknown): Promise<T>
  /** 下行: 事件流。返回退订函数 */
  subscribe(fn: (event: StreamEvent) => void): () => void
  state(): ConnectionState
  onStateChange(fn: (state: ConnectionState) => void): () => void
  /** 服务端进程换代，旧事件序号已失效；界面应清空后接收全量重放。 */
  onReset?(fn: () => void): () => void
  dispose(): void
}

/** 能力面名: ctx.get('transport') */
export const TRANSPORT_SERVICE = 'transport'
