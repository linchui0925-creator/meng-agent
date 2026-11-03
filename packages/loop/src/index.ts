/**
 * @meng/loop —— 一轮对话的循环能力面 (seam)。**零实现**。
 *
 * 为什么循环要单独成一条缝:
 *   "循环"是策略, 不是内核。ReAct 是一种, 先规划再执行是另一种,
 *   单轮问答是第三种 (不循环)。把它们都塞进内核包, 等于宣布
 *   "本项目只有一种对话方式" —— 而 dsh 那边 loop 本来就是插件。
 *
 * 这条缝和已有五条 (fs / spill / exec / jobs / net) 同一个形状:
 *   缝里只有类型 + 一条注册函数; 谁循环、循环几次、要不要重试, 全在实现包里。
 *
 * 这条缝**不含**的判断 (留在插件, 别往下塞):
 *   · 循环几次 (maxTurns) —— 策略参数, 由实现自己收
 *   · 什么时候压缩上下文 —— 那是 compaction 插件监听 turn/ended 的事
 *   · 什么时候要审批 —— 那是 policy 插件挂在 tools/pre-execute 上的事
 *   · 兼容某厂商的怪癖 —— provider 自己负责, 循环不该知道 XML 长什么样
 *
 * 一条硬语义: **run 不抛异常表示"这一轮失败了"**。LLM 报错、被中止、
 * 到达上限, 都以 LoopEvent 的 done 结束并带上 reason —— 调用方据此写
 * turn/ended, 而不是靠 catch。只有"依赖的能力面压根没装"这种基础设施
 * 问题才 throw。
 */

import type { Ctx, Disposer } from '@meng/core'
import type { ToolCall } from '@meng/tools'

/** 能力面名。与包名 @meng/loop 一致 */
export const LOOP_CAPABILITY = 'loop'

export interface RunInput {
  sessionId: string
  text: string
  model?: string
  /** 由调用方分配, 会写进每条事件的 data.runId —— 前端靠它给并发 run 分组 */
  runId?: string
  signal?: AbortSignal
}

/**
 * 循环对外吐的三件事。
 *
 * 刻意只有三种: 文本增量、工具调用结果、终态。
 * 中间过程 (reasoning / usage / 工具参数) 全部落进会话事件流, 不走这里 ——
 * 一条要发给浏览器的流每多一种类型, 前端就多一个分支, 而它未必需要。
 */
export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall; result: string }
  | { type: 'done'; reason: 'stop' | 'max-turns' | 'error' | 'aborted'; error?: string }

export interface LoopService {
  run(input: RunInput): AsyncIterable<LoopEvent>
}

/** 注册循环实现。返回 disposer —— 卸载时循环跟着消失, 不会留下半条 */
export function provideLoop(ctx: Ctx, impl: LoopService): Disposer {
  return ctx.set<LoopService>(LOOP_CAPABILITY, impl)
}

/** 取能力面。没装就返回 undefined —— 调用方自己决定报 503 还是降级 */
export function getLoop(ctx: Ctx): LoopService | undefined {
  return ctx.get<LoopService>(LOOP_CAPABILITY)
}
