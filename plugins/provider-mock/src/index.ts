/**
 * @meng/provider-mock — 离线验收用的假 provider。
 *
 * 存在理由: 沙箱/CI 里连不上真模型(实测 api.openai.com 走代理被拦 502),
 * 但"一句话来回"和"工具循环"必须能自动验证。
 * 它不是 stub —— 它按脚本产出**真实形态**的 delta 流(文本块 + 工具块的 delta),
 * 走的是和真 provider 完全相同的管线 (assemble 组块、agent 消费)。
 *
 * steps 按轮次消耗, 用完停在最后一步。
 * 例:
 *   steps:
 *     - { tool: { name: hello, args: { name: 梦 } } }
 *     - { blocks: [{ text: "我先看看" }, { tool: { name: glob, args: {} } }] }
 *     - { text: "工具调完了" }
 *     - { empty: true }        # 造一次"正常结束但没内容", 验 EMPTY_RESPONSE
 */

import type { Ctx, Disposer } from '@meng/core'
import {
  textOf,
  type LLMService,
  type Provider,
  type StreamChunk,
  type StreamRequest,
} from '@meng/llm'

export const name = 'provider-mock'
export const inject = ['llm']

type MockTool = { name: string; args?: Record<string, unknown> }
type MockPiece = { text: string } | { tool: MockTool }

export type MockStep =
  | { text: string }
  | { tool: MockTool }
  /** 一轮里交错产出多个块: 文本 + 工具调用共存 */
  | { blocks: MockPiece[] }
  /** 正常结束但零内容块 —— 必须被判成 EMPTY_RESPONSE, 不是"成功的空消息" */
  | { empty: true }

export interface MockConfig {
  id?: string
  models?: string[]
  steps?: MockStep[]
  /** 每个 chunk 之间的人为延迟, 让前端能看出流式效果 */
  chunkDelayMs?: number
}

export function apply(ctx: Ctx, config: MockConfig = {}): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-mock 依赖 llm')

  const id = config.id ?? 'mock'
  // steps 为空时回落成一句话: stream() 里按轮次取, **必须保证至少一步**, 否则取下标会拿 undefined
  const script: MockStep[] = config.steps?.length ? config.steps : [{ text: '(mock) 我收到了你的消息。' }]
  const delay = config.chunkDelayMs ?? 0

  let turn = 0

  const provider: Provider = {
    id,
    models: config.models ?? ['mock-1'],

    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      // script 保证非空, length-1 >= 0, 这里收窄掉索引访问的 undefined
      const step = script[Math.min(turn, script.length - 1)]!
      turn++

      // 让 mock 也能"看见"上下文 —— 否则无法验证历史是否被正确投影。
      // 注意: 工具结果也是 user 角色 (只带 tool-result 块), 所以要找
      // "最后一条**有文本**的 user 消息", 否则 echo 出来是空的
      const users = req.messages.filter((m) => m.role === 'user')
      if (users.length === 0) throw new Error('mock 收到的消息里没有 user, project() 可能坏了')
      const userText = [...users].reverse().map(textOf).find((t) => t !== '') ?? ''

      // 判别用 `in` 而不是属性真值: union 变体上没有的字段, step.tool 这种写法 TS 收不动
      const pieces: MockPiece[] =
        'empty' in step ? [] : 'blocks' in step ? step.blocks : 'tool' in step ? [{ tool: step.tool }] : [{ text: step.text }]

      if ('empty' in step) {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      let sawTool = false
      let textIndex = 0
      let nextToolIndex = 1

      for (const piece of pieces) {
        if ('text' in piece) {
          const expanded = piece.text.replace('{{echo}}', userText).replace('{{lastUser}}', userText)
          const index = textIndex++
          yield { type: 'block-start', index, blockType: 'text' }
          // 切成小片: 前端的 chunk 拼接逻辑和 assemble 的累积都要真的被跑到
          for (const part of expanded.match(/.{1,4}/gs) ?? [expanded]) {
            if (delay) await sleep(delay)
            yield { type: 'text-delta', index, text: part }
          }
          continue
        }

        sawTool = true
        const index = nextToolIndex++
        const args = JSON.stringify(piece.tool.args ?? {})
        // 模拟 wire 行为: 第一个分片带 id/name, 之后只给参数增量
        const id_ = `mock_${turn}_${index}`
        if (delay) await sleep(delay)
        yield { type: 'tool-call-delta', index, id: id_, name: piece.tool.name, argumentsDelta: args.slice(0, 4) }
        for (let i = 4; i < args.length; i += 4) {
          if (delay) await sleep(delay)
          yield { type: 'tool-call-delta', index, argumentsDelta: args.slice(i, i + 4) }
        }
      }

      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: pieces.length } }
      yield { type: 'finish', reason: sawTool ? { kind: 'tool-calls' } : { kind: 'stop' } }
    },
  }

  const off = llm.register(provider)
  if (!process.env.MENG_QUIET) {
    console.log(`[meng] provider ${id} · ${provider.models.join(', ')} · ${script.length} 步脚本`)
  }
  return off
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms))
}

export const invariant = {
  pkg: '@meng/provider-mock',
  checks: [
    {
      id: 'registered',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm?.models().includes('mock-1')) throw new Error('mock provider 未注册')
      },
    },
  ],
}
