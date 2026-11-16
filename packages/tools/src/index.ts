/**
 * @meng/tools — 工具注册 + 执行管线。
 *
 * 这一包是整个重写的**核心理由**。Python 版有 17 个 hook 调用点全部丢弃返回值,
 * 于是"PreToolUse 返回非空就阻断"写在文档里、代码里从来没生效过,
 * 插件只能在旁边记账, 拦不住任何东西。
 *
 * 这里把控制权做成**唯一的执行路径**: 想跑工具必须经过 call(),
 * 而 call() 的第一件事就是 waterfall —— 短路即拒绝。没有第二条路可以绕过。
 *
 * 四段 (对位 dsh 的 pre/execute/post/result):
 *   tools/pre-execute  → 允许 / 拒绝 / 转人工审批
 *   tools/execute      → 包超时、重试、计量
 *   tools/post-execute → 改写结果 (脱敏 / 截断 / 附证据)
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { SessionService } from '@meng/session'
import type { ToolSpec } from '@meng/llm'

export const name = 'meng-tools'
export const inject = ['session', 'llm']

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** 事件归属。不传则落到游离会话, 前端收不到 —— 调用方应当总是传 */
  sessionId?: string
  runId?: string
  /** 轮次的中止信号。工具可在长等待 (如审批) 时监听它提前退出 */
  signal?: AbortSignal
  /**
   * 本次调用的**授权凭据**。由 `tools/pre-execute` 上的策略写入, 工具读它。
   *
   * 为什么需要这个东西: 审批发生在**工具执行之前** (pre-execute), 而围栏在
   * **更下面** (fs seam)。批准了越界读, 底下那道围栏并不知道刚才有人点过"允许",
   * 于是照拒 —— 用户看到"我明明点了允许, 它还是说越界"。
   *
   * 传凭据而不是"临时改全局模式": 全局开关会让一次批准顺带放开别的并发调用,
   * 而批准是**针对这一次**的。`call` 是策略层和工具之间唯一的共同对象,
   * 所以凭据挂在它上面 —— 一次调用一份, 用完即弃。
   */
  grants?: {
    /** 允许越过工作区围栏 (读写工作区外) */
    outside?: boolean
    /** 允许写敏感路径 (.git / .env / .ssh …) —— 用户批准过这一次 */
    sensitive?: boolean
  }
}

export type PreDecision =
  | { allow: true }
  | { allow: false; reason: string }
  | { allow: 'ask'; reason: string }

export interface ToolResult {
  ok: boolean
  text: string
  error?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** mutates 是声明, 不是权限系统: 审批 / 沙箱插件据此决定是否拦 */
  mutates?: boolean
  /**
   * 这个工具最多跑多久 (ms)。**不是模型能填的参数**, 是工具作者声明的,
   * 所以不进 LLM 的 tool schema。
   *
   * 声明了就得同时遵守 `call.signal` —— 策略层只会"通知"不会"掐断":
   * 到点后它把结果改判成超时, 但工具若不听信号, 它会继续跑完。
   * 不写 = 不设限, 策略层完全不介入。
   */
  timeoutMs?: number
  /**
   * 第三参 call 是完整调用上下文 (含 sessionId/runId/signal)。
   * 大多数工具只需要 args; 要把事件归属到会话的工具 (如 ask_user_question)
   * 靠它拿 sessionId —— 这就是 handler 签名带它的全部理由
   */
  handler(
    args: Record<string, unknown>,
    ctx: Ctx,
    call?: ToolCall,
  ): Promise<ToolResult> | ToolResult
}

/**
 * 审批能力面的**结构类型** —— 刻意不 import @meng/questions:
 * tools 在 base, questions 在 kit, 包依赖边不能从 base 指向 kit。
 * 结构匹配即兼容, 和"工具只认 ctx.fs"是同一套哲学
 */
export interface ApprovalService {
  ask(input: {
    kind: 'approval'
    title: string
    body?: string
    choices?: Array<{ key: string; label: string }>
    sessionId?: string
    runId?: string
    toolName?: string
    callId?: string
    signal?: AbortSignal
  }): Promise<{ outcome: string }>
}

export interface ToolService {
  register(def: ToolDef): Disposer
  list(): ToolSpec[]
  call(call: ToolCall): Promise<ToolResult>
}

/** Node 的 setTimeout 超过这个值会被静默压成 1ms, 所以声明得更大没有意义 */
export const MAX_TOOL_TIMEOUT_MS = 2_147_483_647

/**
 * 在校验**声明的地方**校验, 不在使用它的地方校验。
 * 写在策略里的话, 没装那个策略时非法值就悄悄无效了;
 * 写在这里, 插件装载期就红在状态图上
 */
function assertTimeout(toolName: string, timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TOOL_TIMEOUT_MS) {
    throw new Error(
      `工具 ${toolName} 的 timeoutMs 非法: ${timeoutMs} (要求 0 < timeoutMs <= ${MAX_TOOL_TIMEOUT_MS})`,
    )
  }
}

export function apply(ctx: Ctx): Disposer {
  const defs = new Map<string, ToolDef>()

  const service: ToolService = {
    register(def) {
      if (defs.has(def.name)) throw new Error(`工具 ${def.name} 重复注册`)
      if (def.timeoutMs !== undefined) assertTimeout(def.name, def.timeoutMs)
      defs.set(def.name, def)
      ctx.emit('tools/registered', def.name)
      return () => {
        defs.delete(def.name)
        ctx.emit('tools/unregistered', def.name)
      }
    },

    list() {
      return [...defs.values()].map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters,
      }))
    },

    async call(call) {
      const session = ctx.get<SessionService>('session')
      // sessionId 是事件归属, 不是 call.id —— 这两个混用过一次,
      // 结果是工具事件全落到"名为 call_1 的会话"里, 前端一条都收不到
      const at = call.sessionId ?? '__detached__'
      const meta = { tool: call.name, callId: call.id, ...(call.runId ? { runId: call.runId } : {}) }
      const def = defs.get(call.name)
      if (!def) {
        // 未知工具也要留事件: 模型调了个不存在的工具, 界面上必须看得见。
        // 否则表现为"模型突然沉默", 而真相只是工具名拼错或插件没装
        session?.append(at, 'tool/blocked', { ...meta, reason: `未知工具 ${call.name}` })
        return { ok: false, text: '', error: `未知工具 ${call.name}` }
      }

      const decision = await ctx.waterfall<PreDecision>('tools/pre-execute', [call, def], () => ({
        allow: true,
      }))

      // ask 不是终态: 有审批通道就去问用户, 没有才退化为拒绝。
      // "需要审批"和"被拒绝"在事件流里必须是两种不同的故事 ——
      // 前端要为前者弹卡片, 为后者显示拦截条
      let allowed = decision.allow === true
      // 拒绝理由必须当场取出来存好。decision 是判别联合, 走完下面的 if 之后
      // TS 已经不知道"当时是哪个分支", 事后再去读 decision.reason 会变成
      // "allow:true 那一支根本没有 reason" —— 这不是绕类型, 而是把一个
      // 只在这里成立的事实 (谁拒绝的 / 为什么) 固化成变量
      let denyReason = decision.allow === false ? decision.reason : ''

      if (decision.allow === 'ask') {
        const approval = ctx.get<ApprovalService>('questions')
        if (approval) {
          const verdict = await approval.ask({
            kind: 'approval',
            title: `允许执行 ${call.name}?`,
            body: decision.reason,
            choices: [
              { key: 'approve', label: '允许' },
              { key: 'deny', label: '拒绝' },
            ],
            sessionId: call.sessionId,
            runId: call.runId,
            toolName: call.name,
            callId: call.id,
            signal: call.signal,
          })
          allowed = verdict.outcome === 'approved'
          denyReason = `用户未批准: ${decision.reason}`
        } else {
          // 无审批通道 (纯 CLI / 未装 questions) —— 退化为拒绝并说明原因
          session?.append(at, 'tool/blocked', {
            ...meta,
            reason: `需要审批但无审批通道, 已拒绝: ${decision.reason}`,
          })
          return { ok: false, text: '', error: `需要审批 (无通道, 已拒绝): ${decision.reason}` }
        }
      }

      if (!allowed) {
        const reason = denyReason || `工具 ${call.name} 被拦截`
        session?.append(at, 'tool/blocked', { ...meta, reason })
        return { ok: false, text: '', error: reason }
      }

      session?.append(at, 'tool/called', { ...meta, args: call.args })

      const raw = await ctx.waterfall<ToolResult>('tools/execute', [call, def], () =>
        def.handler(call.args, ctx, call),
      )
      const result = await ctx.waterfall<ToolResult>('tools/post-execute', [call, raw], () => raw)

      session?.append(at, 'tool/completed', {
        ...meta,
        // 事件是给人看的回显, 不是数据仓库 —— 两侧都封顶 2000,
        // 否则一个失败的 bash 能把 200KB stderr 灌进事件流, 每条 WS 帧都背着它
        result: (result.ok ? result.text : (result.error ?? '')).slice(0, 2000),
        ok: result.ok,
      })
      return result
    },
  }

  ctx.set('tools', service)
  return () => defs.clear()
}

export const invariant = defineInvariant('@meng/tools', [
  {
    id: 'pipeline-has-owner',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未注册')
      // 管线必须存在监听器, 否则"可拦截"只是设计文档里的字
      if (typeof tools.call !== 'function') throw new Error('tools.call 缺失, 工具无法经由管线执行')
    },
  },
])

/** 转出去给插件用: 工具作者不该为了拿 schema 类型去依赖 @meng/llm。
 *  这个类型本来就住在 llm (provider 要按它拼请求), 这里只是转发, 不重新定义 */
export type { ToolSpec }
