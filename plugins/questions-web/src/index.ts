/**
 * @meng/plugin-questions-web —— questions seam 的 HTTP 桥。
 *
 * 把"回答一个问题"和"回答提交失败"分别桥成 question.answer / question.fail。
 * 下行 (question/asked 卡片) 完全不需要它 —— 事件流是唯一真相源,
 * web 包对 session/event 的订阅会自动广播, 断线重放也免费。
 *
 * 刻意放在 server bundle 而不是 kit: 不接 HTTP 的桌面端 (Electron inproc)
 * 换一个桥 (ipc) 就行, seam 不动。这是 transport 可插拔的最小证据。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { QuestionsService } from '@meng/questions'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-questions-web'
export const inject = ['questions', 'web']

export function apply(ctx: Ctx): Disposer {
  const questions = ctx.get<QuestionsService>('questions')
  if (!questions) throw new Error('能力面 questions 未装载')
  const web = ctx.get<WebService>('web')
  if (!web) throw new Error('能力面 web 未装载')

  const offAnswer = web.op('question.answer', (payload) => {
    const questionId = String(payload.questionId ?? '')
    if (!questionId) throw new HttpError('bad-request', '缺 questionId')
    const answer = String(payload.answer ?? '')
    if (!answer) throw new HttpError('bad-request', '缺 answer')
    const note = payload.note === undefined ? undefined : String(payload.note)
    if (!questions.answer(questionId, answer, note)) {
      // 双击 / 重放 / 迟到的回答都落到这里 —— 409 而不是 500
      throw new HttpError('conflict', `问题不存在或已结束: ${questionId}`, 409)
    }
    return { ok: true, questionId }
  })

  /**
   * 回答提交失败的结算入口。
   *
   * 它不伪造用户答案，只让等待中的工具知道“这次提交没成功”，然后把
   * { error } 作为工具结果交给模型，避免模型一直傻等。
   */
  const offFail = web.op('question.fail', (payload) => {
    const questionId = String(payload.questionId ?? '')
    if (!questionId) throw new HttpError('bad-request', '缺 questionId')
    const error = String(payload.error ?? '').trim()
    if (!error) throw new HttpError('bad-request', '缺 error')
    if (!questions.fail(questionId, error)) {
      throw new HttpError('conflict', `问题不存在或已结束: ${questionId}`, 409)
    }
    return { ok: true, questionId }
  })

  // UI 状态自愈用: 刷新后重放之外, 主动拉一次挂起中的问题
  const offList = web.op('question.list', () => questions.pending())

  return () => {
    offList()
    offFail()
    offAnswer()
  }
}

export const invariant = defineInvariant('@meng/plugin-questions-web', [
  {
    id: 'ops-registered',
    run(ctx) {
      const web = ctx.get<WebService>('web')
      if (!web) throw new Error('能力面 web 未装载')
      const ops = web.ops()
      if (!ops.includes('question.answer')) throw new Error('question.answer op 未注册')
      if (!ops.includes('question.fail')) throw new Error('question.fail op 未注册')
      if (!ops.includes('question.list')) throw new Error('question.list op 未注册')
    },
  },
])
