/**
 * @meng/session — 会话事件流, 真相源。
 *
 * 一句话: **只追加, 不修改**。消息列表、工具调用历史、界面状态全部是事件流的投影。
 * Python 版把"消息"和"工具元信息"分开存, 结果是刷新页面就丢工具卡片;
 * 这里从第一天就把工具调用当一等事件。
 *
 * 事件类型是闭合枚举: 插件不能发明新 type (发明了会导致会话无法重开),
 * 需要扩展就加"data 里的字段", 不加 type —— 这条直接抄 dsh 的硬规矩。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { ContentBlock, Message, ToolCallBlock } from '@meng/llm'

export const name = 'meng-session'
export const inject: string[] = []

export type SessionEventType =
  | 'session/created'
  | 'turn/started'
  | 'llm/chunk'
  | 'llm/completed'
  | 'tool/called'
  | 'tool/completed'
  | 'tool/blocked'
  | 'question/asked'
  | 'question/answered'
  /**
   * 后台任务开跑。与 job/completed **同形状** (完整快照, status='running',
   * 没有 finishedAt) —— 前端按 id upsert 同一条任务条, 不需要两套渲染分支。
   *
   * 它存在的理由: 任务是**模型**起的, 用户和界面在此之前完全不知道有东西在跑。
   * 落定通知只解决了"结束", 中间那段 (最需要被看见的那段) 是空白。
   */
  | 'job/started'
  /**
   * 后台任务落定。**不是工具事件** —— 它发生在两次工具调用之间,
   * 而且是"没人正等着"的那一刻 (有人等着就会走 job_output 的返回值)。
   * 单独一档的理由: 前端要画任务条, 模型要知道"我起的那个活完了"
   */
  | 'job/completed'
  | 'turn/ended'

export interface SessionEvent<T = unknown> {
  seq: number
  sessionId: string
  type: SessionEventType
  at: number
  data: T
}

/**
 * 投影出的消息 = @meng/llm 的 Message, 可直接喂给 provider。
 *
 * 以前这里自己定义了一个扁平的 `{ content: string, toolCalls? }`, 和 llm 的
 * Message 是两套结构, 靠"字段刚好长得像"对齐。现在共用一套:
 * 一条 assistant 消息可以同时带文本 / 思考 / 多个工具调用, 扁平结构装不下。
 */
export type ProjectedMessage = Message

export interface SessionMeta {
  sessionId: string
  title: string
  at: number
  lastSeq: number
  turns: number
  /**
   * 这段对话最近一条**用户**消息的前 ~60 字。没有就不给 (不是空串)。
   *
   * 侧栏列表只有标题和时间时, 用户得靠标题猜"这段聊过什么", 而标题常常是
   * 自动生成的、猜不准。这是给列表第二行用的内容预览。
   *
   * 为什么截 60 字而不是整段: 它要在一行里放下, 太长了界面上只能硬截,
   * 而硬截会把"关键那句"截掉 —— 后端截的时候还能先压平空白。
   */
  preview?: string
}

export interface SessionService {
  append<T>(sessionId: string, type: SessionEventType, data: T): SessionEvent<T>
  read(sessionId: string): SessionEvent[]
  /** 全量事件(跨会话), 按 seq 升序 —— 持久化与重放用 */
  all(): SessionEvent[]
  /** 会话元数据列表, 给侧栏 */
  sessions(): SessionMeta[]
  /** 只推进 seq 不落库。下行广播的非会话事件用它拿全局单调序号 */
  nextSeq(): number
  /** 灌入历史(重启后回放)。**不发事件**, 否则持久化插件会把自己写进去无限递归 */
  hydrate(events: SessionEvent[]): void
  /** 投影: 由事件派生出"给模型看的消息列表", 不落库 */
  project(sessionId: string): ProjectedMessage[]
}

export function apply(ctx: Ctx): Disposer {
  const logs = new Map<string, SessionEvent[]>()
  let seq = 0

  const service: SessionService = {
    append<T>(sessionId: string, type: SessionEventType, data: T): SessionEvent<T> {
      const event: SessionEvent<T> = { seq: seq++, sessionId, type, at: Date.now(), data }
      const log = logs.get(sessionId) ?? []
      log.push(event)
      logs.set(sessionId, log)
      ctx.emit('session/event', event)
      return event
    },

    read(sessionId) {
      return logs.get(sessionId) ?? []
    },

    all() {
      return [...logs.values()].flat().sort((a, b) => a.seq - b.seq)
    },

    sessions() {
      const out: SessionMeta[] = []
      for (const [sessionId, log] of logs) {
        // 先取出首尾再判空: 数组下标访问在 noUncheckedIndexedAccess 下是
        // "可能不存在" 的, 直接 log[0].at 等于把一个检查跳过的事实写在脸上
        const first = log[0]
        const last = log[log.length - 1]
        if (!first || !last) continue
        const preview = previewOf(log)
        out.push({
          sessionId,
          title: titleOf(log),
          at: first.at,
          lastSeq: last.seq,
          turns: log.filter((e) => e.type === 'turn/started').length,
          ...(preview === undefined ? {} : { preview }),
        })
      }
      return out.sort((a, b) => b.at - a.at)
    },

    nextSeq() {
      return seq++
    },

    hydrate(events) {
      for (const event of events) {
        const log = logs.get(event.sessionId) ?? []
        log.push(event)
        logs.set(event.sessionId, log)
        if (event.seq >= seq) seq = event.seq + 1
      }
    },

    project(sessionId) {
      const out: ProjectedMessage[] = []
      for (const event of service.read(sessionId)) {
        if (event.type === 'turn/started') {
          const { text } = event.data as { text?: string }
          out.push({ role: 'user', content: [{ type: 'text', text: text ?? '' }] })
        }
        if (event.type === 'llm/completed') {
          const { text, toolCalls } = event.data as {
            text?: string
            toolCalls?: Array<{ id: string; name: string; args: unknown }>
          }
          const blocks: ContentBlock[] = []
          // 空 content 是非法的 —— OpenAI 系 provider 在有 tool_calls 时收到
          // content: "" 会直接 400。Python 版这里踩过: 工具轮次静默失败,
          // 表现为"模型突然不说话了"。有文本就带文本块, 没有就不带
          if (text) blocks.push({ type: 'text', text })
          for (const call of toolCalls ?? []) {
            const block: ToolCallBlock = {
              type: 'tool-call',
              id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.args ?? {}),
            }
            blocks.push(block)
          }
          out.push({ role: 'assistant', content: blocks })
        }
        if (event.type === 'tool/completed') {
          const { callId, result, ok } = event.data as {
            callId?: string
            result?: string
            ok?: boolean
          }
          const text = ok === false ? `错误: ${result ?? ''}` : (result ?? '')
          // 工具结果是**块**而不是消息上的扁平字段: 一条 user 消息可以同时装
          // 多个工具结果 (并发调用时就是这样), 也便于将来结果里带图片。
          // 归属靠 toolCallId, 和 assistant 侧的 tool-call 块配对
          out.push({
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: callId ?? '',
                content: [{ type: 'text', text }],
                ...(ok === false ? { isError: true } : {}),
              },
            ],
          })
        }
        // job/started **刻意不投影**: 模型刚拿到 job_id, 它本来就知道自己起了活。
        // 再塞一条"你起了个任务"只是往上下文里灌噪音 —— 而 job/completed 必须投影,
        // 因为"它什么时候结束的"是模型等不到、也猜不到的信息
        if (event.type === 'job/completed') {
          const job = event.data as {
            id?: string
            kind?: string
            label?: string
            status?: string
            detail?: string
          }
          const detail = job.detail ? ` — ${job.detail}` : ''
          // 投影成 user 消息而不是别的角色: 这是**环境**告诉模型的事实,
          // 既不是模型说的话, 也不是某个工具的返回值 (没有对应的 tool-call,
          // 硬塞进 tool-result 会让 provider 拒收)
          out.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `[后台任务 ${job.id ?? ''} 已结束: ${job.status ?? 'unknown'}${detail}]\n` +
                  `(${job.kind ?? ''}: ${job.label ?? ''})\n` +
                  '用 job_output 读取它的输出。这不代表你该停下来 —— 除非这个结果正是你在等的。',
              },
            ],
          })
        }
      }
      return out
    },
  }

  ctx.set('session', service)
  return () => logs.clear()
}

function titleOf(log: SessionEvent[]): string {
  const created = log.find((e) => e.type === 'session/created')
  const fromCreated = (created?.data as { title?: string } | undefined)?.title
  if (fromCreated) return fromCreated
  const first = log.find((e) => e.type === 'turn/started')
  const text = (first?.data as { text?: string } | undefined)?.text ?? ''
  return text.slice(0, 20) || '未命名会话'
}

/**
 * 最近一条用户消息的前 60 字。**没有就不给**, 不给空串。
 *
 * 找的是**最后**一条 `turn/started` —— 用户问过的最后一句最能说明这段对话
 * 现在在聊什么。从后往前扫而不是先 filter 再取尾: 会话可能有几千条事件,
 * 而这条信息只需要最后一次。
 */
function previewOf(log: SessionEvent[]): string | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (!event || event.type !== 'turn/started') continue
    const text = (event.data as { text?: string } | undefined)?.text ?? ''
    // 压平空白: 用户可能贴了一段带换行的日志, 不压的话预览第一行只剩半句
    const flat = text.replace(/\s+/g, ' ').trim()
    // 空消息 (只按了回车 / 只发附件) 不给 preview —— 给空串等于让界面
    // 渲染一行空白, 那比单行还难看
    return flat === '' ? undefined : flat.slice(0, 60)
  }
  return undefined
}

export const invariant = defineInvariant('@meng/session', [
  {
    id: 'append-only',
    run(ctx) {
      const session = ctx.get<SessionService>('session')
      if (!session) throw new Error('能力面 session 未注册')
      const probe = '__invariant_probe__'
      const a = session.append(probe, 'session/created', {})
      const b = session.append(probe, 'turn/ended', {})
      if (b.seq !== a.seq + 1) throw new Error('seq 不单调, 事件流被改写')
    },
  },
])
