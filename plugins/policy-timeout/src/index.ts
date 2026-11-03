/**
 * @meng/plugin-policy-timeout —— 给任意工具装截止时间。
 *
 * 对应 dsh 的 `dsh-tool-call-timeout-policy`（144 行）+ `dsh-timeout`（140 行）。
 * 分工照抄：**工具自己声明预算**（`ToolDef.timeoutMs`），策略包只做三件事 ——
 * 起表、把自己的中止信号塞给工具、到点改判。
 *
 * 为什么不做 `Promise.race`（这是这个包唯一需要想清楚的地方）：
 *   race 会在超时瞬间把工具的 Promise 扔掉, 但工具**还在跑**。写文件写到一半、
 *   spawn 的进程还在跑, 而我们已经在告诉模型"它超时了, 什么也没发生"。
 *   所以这里只**通知**（abort signal）, 工具自己决定什么时候停 ——
 *   代价是"不听话的工具, 超时也杀不掉", 那是工具实现的责任, 不是这一层的。
 *
 * 为什么不在这一层判 `def.timeoutMs` 合法性: 声明在哪就在哪校验。
 * 非法值在 tools.register 就抛, 装载期红在状态图里, 而不是等某次调用才发现。
 *
 * 为什么没抽 `@meng/timeout` 库（dsh 抽了）: dsh 有 5 个消费者（bash / llm /
 * subprocess / code-runtime / 这个策略）。我们目前只有这一个, 抽出来就是个空壳。
 * 出现第二个消费者时再抽, 算术部分（20 行）现在就在下面, 搬过去不难。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { ToolCall, ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-policy-timeout'
export const inject = ['tools']

/**
 * 这个包**自己**的超时码。改判时用它比对, 而不是"signal 到底 abort 了没" ——
 * 外层还有别的 deadline 时（比如将来 agent 轮次级的截止时间先到）,
 * 那个 abort 不是我们的, 必须当成普通的上游取消, 原样交回去。
 */
const TIMEOUT_CODE = 'TOOL_TIMEOUT'

/** 内部中止原因。带 code 才分得清是谁的表到点了 */
class TimeoutReason extends Error {
  code: string
  timeoutMs: number

  constructor(code: string, timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
    this.name = 'TimeoutReason'
    this.code = code
    this.timeoutMs = timeoutMs
  }
}

/** 取"我自己的"超时原因; 别人的 code 或普通取消一律 undefined */
function ownTimeout(signal: AbortSignal | undefined): TimeoutReason | undefined {
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return reason.code === TIMEOUT_CODE ? reason : undefined
}

/**
 * 超时时替换掉的工具结果。
 *
 * `ok: false` 是对的: 超时意味着**结果未知**（不是"命令返回了非零", 那是有结果）。
 * 但错误文案必须说清是"等太久"还是"做错了", 否则模型会把超时当成命令本身失败,
 * 然后去改命令, 而不是缩小范围。
 */
function timeoutResult(tool: string, timeoutMs: number): ToolResult {
  return {
    ok: false,
    text: '',
    error: `工具 ${tool} 超时: 超过 ${timeoutMs}ms 未返回, 已中止 (结果未知, 不代表操作失败)。缩小范围或换更快的做法再试。`,
  }
}

export function apply(ctx: Ctx): Disposer {
  return ctx.effect(() =>
    ctx.on('tools/execute', async (call: ToolCall, def: ToolDef, next: () => Promise<ToolResult>) => {
      const budget = def.timeoutMs
      // 没声明 = 这一层完全不介入。不是"给个默认值"——
      // 默认值会让所有工具凭空多一条失败路径, 而它们本来就没打算被限时
      if (budget === undefined) return next()

      const timer = new AbortController()
      const id = setTimeout(() => {
        timer.abort(new TimeoutReason(TIMEOUT_CODE, budget))
      }, budget)

      // 把 call.signal 临时换成"上游取消 + 我的表"的合并信号。
      // 工具读 call.signal 就能同时听到用户按 ESC 和超时两件事。
      // 直接改对象字段跟 dsh 一样, 但必须原样还回去 ——
      // 否则这一层会给后面的 post-execute / 下一次调用留一个被污染的 signal
      const upstream = call.signal
      call.signal = upstream ? AbortSignal.any([upstream, timer.signal]) : timer.signal
      try {
        const result = await next()
        // 只有自己的表到点才改判。工具听话时它已经提前返回了, 走这条路;
        // 工具不听话时它跑完才返回, 结果同样被改判成超时 —— 但它的活是真的干完了
        return ownTimeout(call.signal) ? timeoutResult(def.name, budget) : result
      } catch (err) {
        // 工具把 abort 抛成异常时也要改判, 否则模型看到的是半句 "This operation was aborted",
        // 完全看不出是超时还是自己 CTRL-C
        if (ownTimeout(call.signal)) return timeoutResult(def.name, budget)
        throw err
      } finally {
        clearTimeout(id)
        call.signal = upstream
      }
    }),
  )
}

// ── 不变量: 这套语义四条, 每条都要能被证伪 ──────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ProbeOptions {
  timeoutMs?: number
  /** 睡多久 */
  ms: number
  /** 收到 abort 时怎么办: 提前醒（像 grep）/ 抛异常（像没写好的工具）/ 完全不理会 */
  onAbort: 'wake' | 'throw' | 'ignore'
}

/** 探针工具: 一个"睡一会儿"的工具, 用来说明四种语义 */
function probe(name: string, options: ProbeOptions): ToolDef {
  return {
    name,
    description: '超时策略的不变量探针, 不进 prompt',
    parameters: { type: 'object', properties: {} },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async handler(_args, _ctx, call) {
      if (options.onAbort === 'ignore') {
        await sleep(options.ms)
        return { ok: true, text: '干完了' }
      }
      return await new Promise<ToolResult>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, text: '干完了' }), options.ms)
        call?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            if (options.onAbort === 'throw') reject(new Error('This operation was aborted'))
            else resolve({ ok: false, text: '', error: '已中止' })
          },
          { once: true },
        )
      })
    },
  }
}

export const invariant = defineInvariant('@meng/plugin-policy-timeout', [
  {
    id: 'declared-budget-flips-result',
    async run(ctx) {
      const tools = requireTools(ctx)
      // 睡 5s 的工具, 预算 60ms —— 听话的那个应当 60ms 就回来并判超时
      const off = tools.register(probe('inv-probe-wake', { timeoutMs: 60, ms: 5000, onAbort: 'wake' }))
      try {
        const at = Date.now()
        const result = await tools.call({ id: 'inv-t1', name: 'inv-probe-wake', args: {} })
        const cost = Date.now() - at
        if (result.ok) throw new Error('超时竟算成功')
        if (!String(result.error).includes('超时')) throw new Error(`错误文案没说是超时: ${result.error}`)
        if (cost > 2000) throw new Error(`没有提前收工, 等了 ${cost}ms`)
      } finally {
        off()
      }
    },
  },
  {
    id: 'abort-thrown-is-still-timeout',
    async run(ctx) {
      const tools = requireTools(ctx)
      const off = tools.register(probe('inv-probe-throw', { timeoutMs: 60, ms: 5000, onAbort: 'throw' }))
      try {
        const result = await tools.call({ id: 'inv-t2', name: 'inv-probe-throw', args: {} })
        if (result.ok) throw new Error('抛 abort 的工具被当成成功')
        if (!String(result.error).includes('超时')) {
          throw new Error(`工具抛的原始 abort 错误漏到了模型侧: ${result.error}`)
        }
      } finally {
        off()
      }
    },
  },
  {
    id: 'undeclared-tool-untouched',
    async run(ctx) {
      const tools = requireTools(ctx)
      // 没声明预算 = 这一层不介入, 睡多久就是多久, 且结果原样
      const off = tools.register(probe('inv-probe-plain', { ms: 120, onAbort: 'ignore' }))
      try {
        const at = Date.now()
        const result = await tools.call({ id: 'inv-t3', name: 'inv-probe-plain', args: {} })
        const cost = Date.now() - at
        if (!result.ok || result.text !== '干完了') throw new Error('没声明预算的工具被改写了结果')
        if (cost < 100) throw new Error(`居然提前返回了 (${cost}ms) —— 这一层不该介入手`)
      } finally {
        off()
      }
    },
  },
  {
    id: 'stubborn-tool-finishes-its-work',
    async run(ctx) {
      const tools = requireTools(ctx)
      let finished = false
      // 不理会 signal 的工具: 超时了也要让它把活干完, 我们只改判结果。
      // 这条是"不 race"的代价, 必须被显式钉住 —— 将来有人改成 race, 这里会红
      const off = tools.register({
        name: 'inv-probe-stubborn',
        description: '不理会中止信号的工具',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 40,
        async handler() {
          await sleep(180)
          finished = true
          return { ok: true, text: '干完了' }
        },
      })
      try {
        const result = await tools.call({ id: 'inv-t4', name: 'inv-probe-stubborn', args: {} })
        if (result.ok) throw new Error('超时未生效')
        if (!finished) throw new Error('工具被扔掉了 —— 副作用留在了半路, 这正是 race 的病')
      } finally {
        off()
      }
    },
  },
])

function requireTools(ctx: Ctx): ToolService {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  return tools
}
