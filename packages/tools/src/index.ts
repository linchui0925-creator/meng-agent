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
import { getConfig } from '@meng/config'
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

/**
 * 一次工具调用的结果。**三层, 三个消费者**:
 *
 *   · `text`         —— 给**模型**看的（render 层）。进 prompt 的就是它
 *   · `value`        —— 结构化**真值**（canonical）。给代码用, 不进 prompt
 *   · `presentation` —— 给**界面**渲染用的元信息（摘要 / 耗时 / 可折叠）
 *
 * 为什么不是只有一个字符串: 界面想显示"读了多少行"就只能去正则解析那段文本,
 * 而文字一改就静默失效。结构写在结构里, 文案怎么写都不影响它。
 *
 * 后两层都是可选的 —— 不给就是没有, 不是"空对象"。
 */
export interface ToolResult {
  ok: boolean
  text: string
  error?: string
  /** 层 2: 结构化真值。比如 bash 的 `{ exitCode, stdout, stderr }` */
  value?: unknown
  /** 层 3: 界面元信息。**不进 wire 的 prompt**, 只进记录库与工具卡 */
  presentation?: Record<string, unknown>
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** mutates 是声明, 不是权限系统: 审批 / 沙箱插件据此决定是否拦 */
  mutates?: boolean
  /**
   * 分组。缺省 `core`。
   *
   * 用途只有一个: **要不要把这一组放进 prompt**。工具一多, 全量进 prompt 会
   * 吃掉上下文、也让模型更容易选错; 而"这一轮大概用不上 web_fetch"是能提前
   * 判断的。分组的名单由 `tools.groups` 报给界面, 开关落在配置里。
   */
  group?: string
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
  }): Promise<{ outcome: string; answer?: string; error?: string }>
}

export interface ToolService {
  register(def: ToolDef): Disposer
  /** 全部已注册的工具。清单 / 调试 / 断言用 —— **不代表会进 prompt** */
  list(): ToolSpec[]
  /** 会进 prompt 的那些（按 `tools.disabled` 过滤） */
  active(): ToolSpec[]
  /** 分组清单 + 每组有哪些工具 + 现在开没开。设置页那张表的数据源 */
  groups(): Array<{ id: string; tools: string[]; enabled: boolean }>
  call(call: ToolCall): Promise<ToolResult>
}

/**
 * 记录能力面的**结构类型** —— 刻意不 import @meng/records:
 * tools 在 base 的更下层, 记录库是可选的附属设施。
 * 结构匹配即兼容, 和 ApprovalService 同一套办法。
 */
export interface RecordWriter {
  put(input: {
    sessionId?: string
    runId?: string
    callId: string
    tool: string
    args?: unknown
    ok: boolean
    error?: string
    text: string
    value?: unknown
    presentation?: Record<string, unknown>
    startedAt: number
    finishedAt: number
  }): string
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

const specOf = (d: ToolDef): ToolSpec => ({
  name: d.name,
  description: d.description,
  parameters: d.parameters,
  ...(d.group ? { group: d.group } : {}),
})


export function apply(ctx: Ctx): Disposer {
  const defs = new Map<string, ToolDef>()

  /**
   * 被关掉的工具组。**每次现读**: 设置页改完下一轮就生效。
   *
   * 配置层是**可选**的 (测试 / demo 不装它), 所以取不到就当"一组都没关" ——
   * 而不是"全关"。前者行为与没有这个功能时一致, 后者会让工具凭空消失。
   */
  const disabledGroups = (): Set<string> => {
    const svc = getConfig(ctx)
    const raw = svc ? svc.scope('tools').get('disabled') : undefined
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  }


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
      return [...defs.values()].map(specOf)
    },

    /**
     * 会进 prompt 的那些。**按组过滤**, 组名单来自配置 `tools.disabled`。
     *
     * 为什么在这里过滤而不是在 loop 里: "哪些工具该给模型看"是工具层的事实,
     * 而 loop 只是使用者。换一种循环策略 (规划式 / 单轮) 不该各自再实现一遍。
     *
     * 每次调用现读配置 —— 在设置页关掉一组, 下一轮就生效, 不需要重启。
     */
    active() {
      const off = disabledGroups()
      return [...defs.values()].filter((d) => !off.has(d.group ?? 'core')).map(specOf)
    },

    groups() {
      const off = disabledGroups()
      const buckets = new Map<string, string[]>()
      for (const d of defs.values()) {
        const g = d.group ?? 'core'
        const list = buckets.get(g)
        if (list) list.push(d.name)
        else buckets.set(g, [d.name])
      }
      return [...buckets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, names]) => ({ id, tools: names.sort(), enabled: !off.has(id) }))
    },

    async call(call) {
      const session = ctx.get<SessionService>('session')
      // sessionId 是事件归属, 不是 call.id —— 这两个混用过一次,
      // 结果是工具事件全落到"名为 call_1 的会话"里, 前端一条都收不到
      const at = call.sessionId ?? '__detached__'
      const meta = { tool: call.name, callId: call.id, ...(call.runId ? { runId: call.runId } : {}) }
      const startedAt = Date.now()
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
              ...(call.sessionId ? [{ key: 'approve_session', label: '本会话都允许' }] : []),
              { key: 'deny', label: '拒绝' },
            ],
            sessionId: call.sessionId,
            runId: call.runId,
            toolName: call.name,
            callId: call.id,
            signal: call.signal,
          })
          allowed = verdict.outcome === 'approved'
          if (allowed && verdict.answer === 'approve_session' && call.sessionId) {
            session?.setPermission(call.sessionId, 'full')
          }
          denyReason =
            verdict.outcome === 'failed'
              ? `审批提交失败: ${JSON.stringify({ ok: false, error: verdict.error ?? '用户回答提交失败' })}`
              : `用户未批准: ${decision.reason}`
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

      let result: ToolResult
      try {
        const raw = await ctx.waterfall<ToolResult>('tools/execute', [call, def], () =>
          def.handler(call.args, ctx, call),
        )
        result = await ctx.waterfall<ToolResult>('tools/post-execute', [call, raw], () => raw)
      } catch (err) {
        // tool/called 已经写出去了；异常也不能留下没有配对的 tool-call。
        // 照旧把异常向上抛，让本轮按原逻辑失败，同时补一个可投影的失败结果。
        const message = err instanceof Error ? err.message : String(err)
        session?.append(at, 'tool/completed', {
          ...meta,
          result: message.slice(0, 2000),
          ok: false,
          bytes: Buffer.byteLength(message),
          truncated: message.length > 2000,
          ...(call.signal?.aborted ? { interrupted: true } : {}),
        })
        throw err
      }
      const finishedAt = Date.now()

      // 事件里那份是**回显**, 不是数据。全文落记录库, 事件只带一个 id。
      // 这不是优化, 是分工: 事件流要能被完整回放, 而回放不该读几 MB 的 stdout
      const text = result.ok ? result.text : (result.error ?? '')
      /**
       * **没有 sessionId 的调用不落记录。**
       *
       * 自检 (invariant) 和 demo 探针就是这类: 它们跑工具验行为, 但没有会话。
       * 落进去的话, 用户在设置页看到的"最近用过 14 次 bash"其实是启动自检刷出来的,
       * 而那个数字正是他判断"要不要关掉这组工具"的依据 —— 假数据会让他关错东西。
       */
      // 只在**有会话**时落记录。自检 (invariant) 与 demo 探针跑工具时没有会话,
      // 它们落进来的话, 用户在设置页看到的"最近用过 14 次 bash"其实是启动自检
      // 刷出来的 —— 而那个数字正是他判断"要不要关掉这组工具"的依据
      const writer = call.sessionId ? ctx.get<RecordWriter>('records') : undefined
      const recordId = writer?.put({
        ...(call.sessionId ? { sessionId: call.sessionId } : {}),
        ...(call.runId ? { runId: call.runId } : {}),
        callId: call.id,
        tool: call.name,
        args: call.args,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        text,
        ...(result.value === undefined ? {} : { value: result.value }),
        // 界面元信息: 工具自己给的 + 管线补的耗时。组名让界面能按组归类
        presentation: {
          group: def.group ?? 'core',
          elapsedMs: finishedAt - startedAt,
          ...(result.presentation ?? {}),
        },
        startedAt,
        finishedAt,
      })

      session?.append(at, 'tool/completed', {
        ...meta,
        // 事件是给人看的回显, 不是数据仓库 —— 两侧都封顶 2000,
        // 否则一个失败的 bash 能把 200KB stderr 灌进事件流, 每条 WS 帧都背着它
        result: text.slice(0, 2000),
        ok: result.ok,
        // 全文的真实大小 + 取全文的钥匙。`truncated` 让界面不必自己数长度
        bytes: Buffer.byteLength(text),
        truncated: text.length > 2000,
        ...(recordId ? { recordId } : {}),
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
