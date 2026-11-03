/**
 * @meng/plugin-tool-ask —— ask_user_question, 对位 dsh-tool-ask-user。
 *
 * 模型中途需要人给信息时用它: 问一句, 挂起等回答, 回答作为工具结果回到上下文。
 * 真活在 @meng/questions seam 里 —— 这里只是薄壳:
 * schema + 把 call.sessionId 透传给 seam (事件归属, 靠 handler 第三参)。
 *
 * 为什么这个工具格外重要: 没有 it, agent 遇到"信息不足只能猜"的场景
 * 只能瞎编。Python 版的"追问"是前端拦截用户输入硬做的, 和工具循环完全脱节;
 * 这里追问就是一次普通的工具调用, 重放/审计/压缩全都免费获得。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { QuestionChoice, QuestionsService } from '@meng/questions'
import type { ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-ask'
export const inject = ['tools', 'questions']

export function apply(ctx: Ctx): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const questions = ctx.get<QuestionsService>('questions')
  if (!questions) throw new Error('能力面 questions 未装载')

  const def: ToolDef = {
    name: 'ask_user_question',
    description:
      '向用户提问并等待回答。信息不足、有多种做法需要用户选择时用 —— ' +
      '不要替用户猜。给出 choices 时用户可以点选; 问题要具体、一次只问一件事',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题, 具体且一次只问一件' },
        choices: {
          type: 'array',
          description: '可选项 (建议 2-4 个)。不给则用户自由输入',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '选项标识, 回答里返回它' },
              label: { type: 'string', description: '给用户看的选项文字' },
              description: { type: 'string', description: '选项的补充说明' },
            },
            required: ['key', 'label'],
          },
        },
      },
      required: ['question'],
    },

    async handler(args, _ctx, call) {
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, text: '', error: '缺参数 question' }

      const rawChoices = Array.isArray(args.choices) ? args.choices : []
      const choices: QuestionChoice[] = []
      for (const item of rawChoices) {
        if (!item || typeof item !== 'object') continue
        const c = item as { key?: unknown; label?: unknown; description?: unknown }
        const key = String(c.key ?? '').trim()
        const label = String(c.label ?? '').trim()
        if (key && label) {
          choices.push({ key, label, ...(c.description ? { description: String(c.description) } : {}) })
        }
      }

      const resolution = await questions.ask({
        kind: 'info',
        title: question,
        ...(choices.length ? { choices } : {}),
        toolName: 'ask_user_question',
        callId: call?.id,
        sessionId: call?.sessionId,
        runId: call?.runId,
        signal: call?.signal,
      })

      if (resolution.outcome === 'timeout') {
        return { ok: false, text: '', error: '提问超时, 用户没有回答 —— 按自己的最佳判断继续, 并说明这是未确认的' }
      }
      if (resolution.outcome === 'aborted') {
        return { ok: false, text: '', error: '轮次已被用户中止' }
      }
      if (resolution.answer === undefined) {
        return { ok: false, text: '', error: `用户未给出回答 (${resolution.outcome})` }
      }
      // 把 key 翻译回 label, 模型看到的回答和用户看到的选择是同一份语言
      const picked = choices.find((c) => c.key === resolution.answer)
      const text = picked
        ? `用户选择了: ${picked.label}${picked.description ? ` (${picked.description})` : ''}`
        : `用户回答: ${resolution.answer}`
      return { ok: true, text: resolution.note ? `${text}\n附注: ${resolution.note}` : text }
    },
  }

  const off = ctx.effect(() => tools.register(def))
  return () => {
    off()
  }
}

export const invariant = defineInvariant('@meng/plugin-tool-ask', [
  {
    id: 'tool-registered',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      if (!tools.list().some((t) => t.name === 'ask_user_question')) {
        throw new Error('ask_user_question 工具未注册')
      }
    },
  },
])
