/**
 * @meng/questions —— 问用户的 seam (对位 dsh 的 ctx.userQuestions)。
 *
 * 两条路都汇到这里:
 *   1. 模型主动问: ask_user_question 工具 (tool-ask 插件) 调 questions.ask
 *   2. 策略转审批: tools/pre-execute 返回 { allow: 'ask' } 时, tools 管线调 questions.ask
 *
 * 每个问题的一生落在事件流里 (这是"唯一真相源"的兑现):
 *   question/asked    { questionId, kind, title, body, choices, toolName, callId, runId }
 *   question/answered { questionId, outcome, answer, note, error }
 * 前端不轮询: 事件经 session/event 自动广播到 WS, 断线重放也能补回卡片。
 *
 * 回答的唯一入口是 answer() (由 questions-web 插件接到 POST /api/question.answer)。
 * 结局有四种: answered(自由回答) / approved / denied(审批) / timeout / aborted ——
 * approved|denied 只在 kind='approval' 时产生, 语义解释归 seam, 不归调用方。
 */

import { randomUUID } from 'node:crypto'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { SessionService } from '@meng/session'

export const name = 'meng-questions'
export const inject = ['session']

export interface QuestionChoice {
  key: string
  label: string
  description?: string
}

export interface Question {
  questionId: string
  kind: 'approval' | 'info'
  title: string
  body?: string
  choices?: QuestionChoice[]
  toolName?: string
  callId?: string
  sessionId: string
  runId?: string
  at: number
}

export interface QuestionResolution {
  questionId: string
  /** answered=自由回答; approved/denied=审批结论; failed=回答提交失败; timeout=超时; aborted=轮次被中止 */
  outcome: 'answered' | 'approved' | 'denied' | 'failed' | 'timeout' | 'aborted'
  /** 用户给出的 choice key 或自由文本 */
  answer?: string
  note?: string
  /** outcome=failed 时的机器可读原因，供工具以 JSON 形式交给模型 */
  error?: string
}

export interface AskInput {
  kind: 'approval' | 'info'
  title: string
  body?: string
  choices?: QuestionChoice[]
  toolName?: string
  callId?: string
  sessionId?: string
  runId?: string
  /** 轮次中止信号: 用户点"停止"时, 问题跟着取消而不是悬到超时 */
  signal?: AbortSignal
}

export interface QuestionsService {
  ask(input: AskInput): Promise<QuestionResolution>
  /** 回答一个挂起中的问题。不存在/已答/已超时 → false */
  answer(questionId: string, answer: string, note?: string): boolean
  /**
   * 回答提交失败时结算问题。它不会伪造用户答案，只把失败原因交给等待中的工具。
   * 不存在/已答/已超时 → false。
   */
  fail(questionId: string, error: string): boolean
  /** 挂起中的问题 (给 UI 恢复状态用; 断线重放才是主通道) */
  pending(): Question[]
}

export interface Config {
  /** 挂起问题的默认超时。默认 5 分钟 —— 无人应答不能让一轮永远吊着 */
  timeoutMs?: number
}

interface PendingEntry {
  question: Question
  resolve: (r: QuestionResolution) => void
  timer: ReturnType<typeof setTimeout>
  offSignal?: () => void
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const maybeSession = ctx.get<SessionService>('session')
  if (!maybeSession) throw new Error('能力面 session 未装载')
  // 同 persistence: settle/ask 都是闭包, 收窄不跨函数边界, 显式固化一次
  const session: SessionService = maybeSession

  const timeoutMs = config.timeoutMs ?? 300_000
  const pending = new Map<string, PendingEntry>()

  function settle(entry: PendingEntry, resolution: QuestionResolution): void {
    pending.delete(entry.question.questionId)
    clearTimeout(entry.timer)
    entry.offSignal?.()
    session.append(entry.question.sessionId, 'question/answered', {
      questionId: resolution.questionId,
      outcome: resolution.outcome,
      ...(resolution.answer !== undefined ? { answer: resolution.answer } : {}),
      ...(resolution.note ? { note: resolution.note } : {}),
      ...(resolution.error ? { error: resolution.error } : {}),
      ...(entry.question.runId ? { runId: entry.question.runId } : {}),
    })
    entry.resolve(resolution)
  }

  const service: QuestionsService = {
    ask(input) {
      const question: Question = {
        questionId: randomUUID().slice(0, 8),
        kind: input.kind,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(input.choices?.length ? { choices: input.choices } : {}),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.callId ? { callId: input.callId } : {}),
        sessionId: input.sessionId ?? '__detached__',
        ...(input.runId ? { runId: input.runId } : {}),
        at: Date.now(),
      }

      return new Promise<QuestionResolution>((resolve) => {
        // 事件先行: 前端收到 question/asked 时, answer op 必然已经可用
        session.append(question.sessionId, 'question/asked', {
          questionId: question.questionId,
          kind: question.kind,
          title: question.title,
          ...(question.body ? { body: question.body } : {}),
          ...(question.choices ? { choices: question.choices } : {}),
          ...(question.toolName ? { toolName: question.toolName } : {}),
          ...(question.callId ? { callId: question.callId } : {}),
          ...(question.runId ? { runId: question.runId } : {}),
        })

        const entry: PendingEntry = {
          question,
          resolve,
          timer: setTimeout(() => {
            settle(entry, { questionId: question.questionId, outcome: 'timeout' })
          }, timeoutMs),
        }

        if (input.signal) {
          const onAbort = () => settle(entry, { questionId: question.questionId, outcome: 'aborted' })
          if (input.signal.aborted) onAbort()
          else {
            input.signal.addEventListener('abort', onAbort, { once: true })
            entry.offSignal = () => input.signal!.removeEventListener('abort', onAbort)
          }
        }

        pending.set(question.questionId, entry)
      })
    },

    answer(questionId, answer, note) {
      const entry = pending.get(questionId)
      if (!entry) return false
      const outcome =
        entry.question.kind === 'approval' ? (answer === 'approve' || answer === 'approve_session' ? 'approved' : 'denied') : 'answered'
      settle(entry, {
        questionId,
        outcome,
        answer,
        ...(note ? { note } : {}),
      })
      return true
    },

    fail(questionId, error) {
      const entry = pending.get(questionId)
      if (!entry) return false
      settle(entry, { questionId, outcome: 'failed', error })
      return true
    },

    pending() {
      return [...pending.values()].map((e) => e.question)
    },
  }

  ctx.set('questions', service)

  return () => {
    // 卸载时全部按中止收尾 —— 悬着的 Promise 不许比容器活得久
    for (const entry of [...pending.values()]) {
      settle(entry, { questionId: entry.question.questionId, outcome: 'aborted' })
    }
  }
}

export const invariant = defineInvariant('@meng/questions', [
  {
    id: 'ask-answer-roundtrip',
    async run(ctx) {
      const questions = ctx.get<QuestionsService>('questions')
      const session = ctx.get<SessionService>('session')
      if (!questions) throw new Error('能力面 questions 未注册')
      if (!session) throw new Error('能力面 session 未注册')

      // 问一个, 立刻答, 不真等 WS —— 验的是状态机本身
      const asked = questions.ask({ kind: 'info', title: 'invariant 探针', sessionId: '__invariant__' })
      const q = questions.pending()[0]
      if (!q) throw new Error('ask 后 pending 里没有问题')
      if (!questions.answer(q.questionId, 'probe-answer')) throw new Error('answer 对挂起中的问题竟返回 false')
      const resolution = await asked
      if (resolution.outcome !== 'answered' || resolution.answer !== 'probe-answer') {
        throw new Error(`回答回路断了: ${JSON.stringify(resolution)}`)
      }
      // 已答的再答必须是 false —— 双击/重放不能造成第二次 settle
      if (questions.answer(q.questionId, 'again')) throw new Error('已回答的问题竟还能再答')

      // 提交失败也必须结算问题，否则模型会一直等一个永远不会来的回答
      const failed = questions.ask({ kind: 'info', title: 'invariant fail 探针', sessionId: '__invariant__' })
      const fq = questions.pending()[0]
      if (!fq) throw new Error('fail 探针没有进入 pending')
      if (!questions.fail(fq.questionId, 'probe-error')) throw new Error('fail 对挂起中的问题竟返回 false')
      const failedResolution = await failed
      if (failedResolution.outcome !== 'failed' || failedResolution.error !== 'probe-error') {
        throw new Error(`失败结算回路断了: ${JSON.stringify(failedResolution)}`)
      }

      // 事件落库检查: asked + answered 都要在流里
      const events = session.read('__invariant__').filter((e) => e.type.startsWith('question/'))
      const kinds = events.map((e) => e.type)
      if (!kinds.includes('question/asked') || !kinds.includes('question/answered')) {
        throw new Error(`问题事件没有落进会话流: ${kinds.join(',')}`)
      }
    },
  },
])
