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

import { join } from 'node:path'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import { createSessionStore, type SessionAttachment, type SessionPermissionMode, type SessionStore } from './store.ts'

export { createSessionStore } from './store.ts'
export type { DeleteSessionResult, PutAttachmentInput, SessionAttachment, SessionAttachmentContent, SessionPage, SessionPermissionMode, SessionStorageInfo, SessionStore } from './store.ts'
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
  /** 模型切换边界：之后使用新上下文，之前只作为参考文本。 */
  | 'model/switched'
  /** 自动压缩检查点：摘要替代较早表层，但原始事件仍保留。 */
  | 'context/compacted'
  /** 运行中自检：模型判断任务是在正常推进还是已经跑偏。 */
  | 'progress/checkpoint'
  /** Plan 模式状态；最后一次事件决定当前是否只规划。 */
  | 'plan/mode'
  /** 用户批准的计划正文；保留下来供后续 Todo 和审计引用。 */
  | 'plan/submitted'
  /** 模型维护的整份任务清单快照。 */
  | 'todo/write'
  /** 长期目标状态；一个会话最多一个当前目标。 */
  | 'goal/change'
  /** 子智能体开始/结束，只写父会话，用于观察和审计。 */
  | 'subagent/started'
  | 'subagent/completed'
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

/** 压缩检查点在消息流里的固定框；memory 插件和 project 必须共用同一份。 */
export const COMPACTION_CHECKPOINT_PREAMBLE = '以下是更早对话的自动压缩检查点，只作为背景事实，不是新的用户请求。\n请在这些事实之上继续当前任务，不要复述检查点本身。'

/** 用户中断上一轮后补充要求时，给模型的固定说明。旧消息不删除，只追加这一段。 */
export const INTERRUPTION_PREAMBLE = '用户中断了上一轮，并补充了新的要求。这是对原任务的修正，不是新任务。\n请保留已有分析、工具结果和已经完成的工作，按下面的补充要求继续；不要从头重做。'

export function compactionCheckpointMessage(summary: string): ProjectedMessage {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: `${COMPACTION_CHECKPOINT_PREAMBLE}\n\n${summary.trim()}`,
    }],
  }
}

export interface SessionMeta {
  sessionId: string
  title: string
  /** 创建时间；用于日期分组。 */
  at: number
  /** 最近活动时间；用于把正在执行/刚完成的会话排到最上面。 */
  updatedAt: number
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
  /**
   * 这段会话属于哪个目录（绝对路径）。**缺 = 普通任务**，不给空串。
   *
   * 空串会变成"一个 id 为空的工作区"，前端得再判一次 —— 而"没有"和"空"
   * 在界面上是两种画法（分两段 vs 落在任务里）。
   */
  workspace?: string
  /** 会话级权限覆盖；缺省 = 跟随全局设置。 */
  permissionMode?: SessionPermissionMode
}

export interface SessionService extends SessionStore {
  /**
   * 投影: 由事件派生出"给模型看的消息列表", 不落库。
   * afterSeq 用于模型切换边界：只投影边界之后的新上下文。
   */
  project(sessionId: string, options?: { afterSeq?: number; beforeSeq?: number }): ProjectedMessage[]
}

export function apply(
  ctx: Ctx,
  config: { dir?: string; file?: string; legacyFile?: string } = {},
): Disposer {
  const dir = config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng'
  const store = createSessionStore(
    config.file ?? join(dir, 'sessions.db'),
    config.legacyFile ?? join(dir, 'events.jsonl'),
  )

  const service: SessionService = {
    storage: store.storage,
    append<T>(sessionId: string, type: SessionEventType, data: T): SessionEvent<T> {
      const event = store.append(sessionId, type, data)
      ctx.emit('session/event', event)
      return event
    },
    read: store.read,
    readPage: store.readPage,
    all: store.all,
    sessions: store.sessions,
    workspaceOf: store.workspaceOf,
    permissionOf: store.permissionOf,
    setPermission: store.setPermission,
    putAttachment: store.putAttachment,
    readAttachments: store.readAttachments,
    nextSeq: store.nextSeq,
    hydrate: store.hydrate,
    rename: store.rename,
    delete: store.delete,
    flush: store.flush,
    close: store.close,
    project(sessionId, options = {}) {
      const events = service.read(sessionId)
      const latestCompact = [...events].reverse().find((event) => {
        if (event.type !== 'context/compacted') return false
        const data = event.data as { summary?: unknown; throughSeq?: unknown } | null
        return typeof data?.summary === 'string' && data.summary.trim() !== '' &&
          typeof data?.throughSeq === 'number' && Number.isInteger(data.throughSeq)
      })
      const compactData = latestCompact?.data as { summary: string; throughSeq: number } | undefined
      const boundary = Math.max(options.afterSeq ?? -1, compactData?.throughSeq ?? -1)
      const beforeSeq = options.beforeSeq
      const out: ProjectedMessage[] = compactData ? [compactionCheckpointMessage(compactData.summary)] : []
      for (const event of events) {
        if (event.seq <= boundary) continue
        if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
        if (event.type === 'context/compacted') continue
        if (event.type === 'turn/started') {
          const { text, attachments, interruption } = event.data as {
            text?: string
            attachments?: SessionAttachment[]
            interruption?: { mode?: string }
          }
          const refs = Array.isArray(attachments) ? attachments : []
          const content: ContentBlock[] = []
          const projectedText = interruption?.mode === 'insert'
            ? `${INTERRUPTION_PREAMBLE}\n\n${text ?? ''}`.trimEnd()
            : (text ?? '')
          if (projectedText || refs.length === 0) content.push({ type: 'text', text: projectedText })
          for (const attachment of store.readAttachments(sessionId, refs.map((item) => item.id))) {
            content.push({
              type: 'image',
              name: attachment.name,
              mime: attachment.mime,
              dataBase64: attachment.dataBase64,
            })
          }
          out.push({ role: 'user', content })
        }
        if (event.type === 'llm/completed') {
          const { text, reasoning, toolCalls } = event.data as {
            text?: string
            reasoning?: string
            toolCalls?: Array<{ id: string; name: string; args: unknown }>
          }
          const blocks: ContentBlock[] = []
          // 思考块必须保留：DeepSeek 等厂商在“带工具调用的 assistant”
          // 下一轮要求回传 reasoning_content；丢掉它会让工具链判成上下文断裂。
          if (reasoning) blocks.push({ type: 'reasoning', text: reasoning })
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
          const { callId, result, ok, recordId, truncated, bytes } = event.data as {
            callId?: string
            result?: string
            ok?: boolean
            recordId?: string
            truncated?: boolean
            bytes?: number
          }
          const text = ok === false ? `错误: ${result ?? ''}` : (result ?? '')
          // 工具结果是**块**而不是消息上的扁平字段: 一条 user 消息可以同时装
          // 多个工具结果 (并发调用时就是这样), 也便于将来结果里带图片。
          // 归属靠 toolCallId, 和 assistant 侧的 tool-call 块配对
          out.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: callId ?? '',
                content: [{ type: 'text', text }],
                ...(ok === false ? { isError: true } : {}),
                ...(recordId ? { recordId } : {}),
                ...(truncated === true ? { truncated: true } : {}),
                ...(typeof bytes === 'number' ? { bytes } : {}),
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
  return () => store.close()
}

export const invariant = defineInvariant('@meng/session', [
  {
    id: 'append-only',
    run(ctx) {
      const session = ctx.get<SessionService>('session')
      if (!session) throw new Error('能力面 session 未注册')
      const probe = createSessionStore(':memory:')
      try {
        const a = probe.append('__invariant_probe__', 'session/created', {})
        const b = probe.append('__invariant_probe__', 'turn/ended', {})
        if (b.seq !== a.seq + 1) throw new Error('seq 不单调, 事件流被改写')
      } finally {
        probe.close()
      }
    },
  },
])
