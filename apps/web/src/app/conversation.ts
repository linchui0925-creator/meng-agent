/**
 * 事件流 → 消息列表 的投影。
 *
 * **本文件不存消息数组。** 真相只有一条: 事件序列。消息是它的纯函数投影。
 * 这条纪律来自 dsh 最贵的一次教训 —— 另存一份消息数组之后, 任何一次丢事件、
 * 重放、乱序都会让两份状态分叉, 而且分叉之后无法判断谁是对的。投影再算一遍即可。
 *
 * 因为是纯函数, 它能在 node 里直接跑: `pnpm test:projection` 就是用 fixture 的真实
 * 事件喂它。不需要浏览器, 也不需要 React。
 */

import type { StreamEvent } from '@meng/transport'

export type MessageRole = 'user' | 'assistant' | 'system'

export type ToolStatus = 'running' | 'blocked' | 'done'

export interface ToolCall {
  callId: string
  tool: string
  args?: unknown
  status: ToolStatus
  /** status=blocked 时: 为什么被拒 */
  reason?: string
  /** status=done 时: 工具产出。长输出由界面折叠, 投影层不做截断 */
  output?: unknown
  /**
   * 工具**开跑**的时刻 (来自 tool/called 事件自己带的 at)。
   * running 态要显示"跑了多久"就得有它 —— 界面自己 Date.now() 记的话,
   * 断线重放时会从"重放那一刻"开始算, 一个跑了 40 秒的命令会显示 1 秒。
   */
  startedAt?: number
  /**
   * 完整输出在本地记录里的 id（B-27 三层分离）。
   *
   * 事件里的 `output` 只带前 2000 字 —— 事件流要能被完整回放，而回放不该读几 MB 的
   * stdout。想看全的得拿这个 id 去 `tool.record` 取。
   * 缺 = 这条没落记录（没有 sessionId 的调用不落），不是"记录丢了"。
   */
  recordId?: string
  /** 截断**之前**的字节数。界面上写"13.6 KB"用 */
  bytes?: number
  /** 事件里的文本被截过。为 true 且 recordId 在，才给"查看完整输出"那个入口 */
  truncated?: boolean
}

/**
 * done 态的一行摘要。
 *
 * `text` 是那句话; `warn` 是说"这次结果看着不对劲" —— 界面拿它决定颜色,
 * 决定权留在界面, 投影层只做判断不出样式。
 */
export interface ToolSummary {
  text: string
  /** 非零退出 / 带 stderr: 工具跑完了, 但结果大概率不是想要的 */
  warn: boolean
}

export interface MessageAttachment {
  id: string
  name: string
  mime: string
  size?: number
  createdAt?: number
  /** 老事件/未来事件若直接带了内容，消息层可以显示真缩略图。 */
  dataBase64?: string
}

export interface ModelSwitchInfo {
  from?: string
  to: string
  estimatedInputTokens?: number
  at: number
}

export type RunStepStatus = 'streaming' | 'waiting' | 'done' | 'blocked' | 'error'

export interface RunStep {
  kind: 'step'
  id: string
  index: number
  text: string
  status: RunStepStatus
  tools: ToolCall[]
  startedAt: number
  endedAt?: number
}

export interface RunMarker {
  kind: 'marker'
  id: string
  at: number
  label: string
  detail?: string
  tone: 'compact' | 'check' | 'error'
}

export type RunPart = RunStep | RunMarker

export interface ModifiedFile {
  path: string
  tool: 'write' | 'edit'
  callId: string
  at?: number
  content?: string
  oldText?: string
  newText?: string
}

export interface Message {
  id: string
  role: MessageRole
  text: string
  modelSwitch?: ModelSwitchInfo
  attachments?: MessageAttachment[]
  /** 首条事件的时间, 用于时间线 */
  at: number
  status: 'streaming' | 'done' | 'error'
  tools: ToolCall[]
  /** 运行时按“模型想法 + 本轮工具”交错展示；旧消息可以没有。 */
  steps?: RunPart[]
  /** turn/ended 的时刻；没有表示仍在运行或旧数据没记。 */
  finishedAt?: number
  /**
   * 这一轮的 token 用量（`llm/completed` 的 `usage`）。
   * 缺 = 内核没报（不是 0）。输入框那格上下文用量用它, 缺就不画那一格。
   */
  usage?: { in: number; out?: number }
  /** status=error 时给人看的说明 */
  error?: string
  /** 机器可读的错误码。界面显示 error, 日志与排查看这个 */
  errorCode?: string
}

/** 从 payload 里读字段, 不做 any 断言 —— 内核与前端是两次独立部署, 字段可能真的缺 */
function field<T>(payload: unknown, key: string): T | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, T>)[key]
}

function textOf(payload: unknown, key: string): string {
  const v = field<unknown>(payload, key)
  return typeof v === 'string' ? v : ''
}

/**
 * 切换模型时的参考稿：只取用户与助手的最终文字，不带工具调用、系统分割线或附件本体。
 * 这与后端 `session.switchModel` 的统计口径保持一致。
 */
export function modelReferenceText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => message.text.trim())
    .filter((text) => text !== '')
    .join('\n\n')
}

/** 粗估 token：中文 1 字约 1 token，其他字符约 4 字 1 token。 */
export function estimateTokenCount(text: string): number {
  let cjk = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++
  }
  return Math.ceil(cjk + Math.max(0, text.length - cjk) / 4)
}

/** 时间戳容错: 缺失/非数字一律回落到 fallback, 不产生 NaN (NaN 会一路传染到排序) */
function numberOr(payload: unknown, key: string, fallback: number): number {
  const v = field<unknown>(payload, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function attachmentsOf(payload: unknown): MessageAttachment[] {
  const raw = field<unknown>(payload, 'attachments')
  if (!Array.isArray(raw)) return []
  const out: MessageAttachment[] = []
  for (const item of raw) {
    const id = textOf(item, 'id')
    const name = textOf(item, 'name')
    const mime = textOf(item, 'mime')
    if (!id || !name || !mime) continue
    const size = numberOr(item, 'size', 0)
    const createdAt = numberOr(item, 'createdAt', 0)
    const dataBase64 = textOf(item, 'dataBase64')
    out.push({
      id, name, mime,
      ...(size > 0 ? { size } : {}),
      ...(createdAt > 0 ? { createdAt } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
    })
  }
  return out
}

/**
 * 把事件序列投成消息列表。
 *
 * 分组键是 `runId`: 一个 turn 里的用户消息、助手回复、工具调用共享一个 runId。
 * 没有 runId 的事件 (session/created 之类) 直接跳过 —— 它们不是对话内容。
 */
function assistantStep(target: Message, at: number): RunStep {
  const steps = target.steps ??= []
  let last = [...steps].reverse().find((part): part is RunStep => part.kind === 'step')
  if (!last || last.status !== 'streaming') {
    const index = steps.filter((part) => part.kind === 'step').length + 1
    last = {
      kind: 'step',
      id: `${target.id}:step:${index}`,
      index,
      text: '',
      status: 'streaming',
      tools: [],
      startedAt: at,
    }
    steps.push(last)
  }
  return last
}

function lastStep(target: Message): RunStep | undefined {
  return [...(target.steps ?? [])].reverse().find((part): part is RunStep => part.kind === 'step')
}

function settleStep(step: RunStep | undefined, at: number): void {
  if (!step) return
  const running = step.tools.some((tool) => tool.status === 'running')
  if (!running) {
    step.status = step.tools.some((tool) => tool.status === 'blocked') ? 'blocked' : 'done'
    step.endedAt = at
  }
}

function toolOfStep(target: Message, callId: string): { tool: ToolCall; step: RunStep } | undefined {
  for (const part of [...(target.steps ?? [])].reverse()) {
    if (part.kind !== 'step') continue
    const tool = part.tools.find((item) => item.callId === callId) ?? part.tools[part.tools.length - 1]
    if (tool) return { tool, step: part }
  }
  return undefined
}

export function modifiedFilesOf(message: Message): ModifiedFile[] {
  const out: ModifiedFile[] = []
  for (const part of message.steps ?? []) {
    if (part.kind !== 'step') continue
    for (const tool of part.tools) {
      if (tool.tool !== 'write' && tool.tool !== 'edit') continue
      const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
      const path = typeof args.file_path === 'string' ? args.file_path : ''
      if (!path) continue
      out.push({
        path,
        tool: tool.tool,
        callId: tool.callId,
        ...(tool.startedAt === undefined ? {} : { at: tool.startedAt }),
        ...(typeof args.content === 'string' ? { content: args.content } : {}),
        ...(typeof args.old_string === 'string' ? { oldText: args.old_string } : {}),
        ...(typeof args.new_string === 'string' ? { newText: args.new_string } : {}),
      })
    }
  }
  return out
}

export function project(events: readonly StreamEvent[]): Message[] {
  const messages: Message[] = []
  /** runId → 助手消息在 messages 里的下标 */
  const byRun = new Map<string, number>()

  // 乱序按 seq 排好再投。重连重放与实时流会**重叠**一段, 顺序不保证,
  // 而"分片拼接"这件事对顺序是敏感的 —— 先排一遍, 投影就不用到处判顺序。
  // Array.prototype.sort 在现代引擎里是稳定的, 同 seq 保持原序。
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  for (const event of ordered) {
    const runId = event.runId
    const payload = event.payload

    switch (event.type) {
      case 'turn/started': {
        if (!runId) break
        const first = messages.length
        messages.push({
          id: `${runId}:user`,
          role: 'user',
          text: textOf(payload, 'text'),
          attachments: attachmentsOf(payload),
          at: event.at,
          status: 'done',
          tools: [],
        })
        messages.push({
          id: `${runId}:assistant`,
          role: 'assistant',
          text: '',
          attachments: [],
          at: event.at,
          status: 'streaming',
          tools: [],
          steps: [],
        })
        byRun.set(runId, first + 1)
        break
      }

      case 'model/switched': {
        const from = textOf(payload, 'from')
        const to = textOf(payload, 'to')
        if (!to) break
        const estimatedInputTokens = numberOr(payload, 'estimatedInputTokens', 0)
        messages.push({
          id: `model-switch:${event.seq}`,
          role: 'system',
          text: '',
          modelSwitch: {
            ...(from ? { from } : {}),
            to,
            ...(estimatedInputTokens > 0 ? { estimatedInputTokens } : {}),
            at: numberOr(payload, 'at', event.at),
          },
          at: event.at,
          status: 'done',
          tools: [],
        })
        break
      }

      case 'llm/chunk': {
        if (!runId) break
        const at = byRun.get(runId)
        if (at === undefined) break
        const target = messages[at]
        if (!target) break
        const delta = textOf(payload, 'delta')
        const step = assistantStep(target, event.at)
        step.text += delta
        target.text += delta
        break
      }

      case 'llm/completed': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        // 收尾文本以 completed 为准: 分片可能因为网络丢了几片, completed 是完整版
        const full = textOf(payload, 'text')
        if (full) target.text = full
        const step = assistantStep(target, event.at)
        step.text = full
        const calls = field<unknown>(payload, 'toolCalls')
        step.status = Array.isArray(calls) && calls.length > 0 ? 'waiting' : 'done'
        if (step.status === 'done') step.endedAt = event.at
        /*
         * 用量。**只有内核真的报了才记** —— 输入框那格"用了多少 token"就靠它,
         * 编一个默认值会让用户拿它判断"还能不能再塞一段长代码"。
         */
        const usage = field<{ in?: unknown; out?: unknown }>(payload, 'usage')
        if (usage !== undefined && typeof usage.in === 'number' && Number.isFinite(usage.in)) {
          target.usage = { in: usage.in, ...(typeof usage.out === 'number' ? { out: usage.out } : {}) }
        }
        break
      }

      case 'tool/called': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        const callId = textOf(payload, 'callId') || `${runId}:tool:${target.tools.length}`
        const tool: ToolCall = {
          callId,
          tool: textOf(payload, 'tool'),
          args: field(payload, 'args'),
          status: 'running',
          // 开跑时刻取**事件自带的 at**, 不是"投影跑到的那一刻":
          // 断线重放 / 切会话读历史时, 后者会把一个跑了 40 秒的命令显示成 1 秒
          startedAt: event.at,
        }
        target.tools.push(tool)
        const step = lastStep(target)
        if (step) {
          step.tools.push(tool)
          step.status = 'waiting'
        }
        break
      }

      case 'tool/completed': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        const callId = textOf(payload, 'callId')
        const found = toolOfStep(target, callId)
        const call = found?.tool ?? target.tools.find((t) => t.callId === callId) ?? target.tools[target.tools.length - 1]
        if (call) {
          call.status = 'done'
          // 真后端契约使用 result；output 只作为旧事件和早期 fixture 的兼容回退。
          call.output = field(payload, 'result') ?? field(payload, 'output')
          /*
           * 三层分离之后，`output` 是**给模型看的那一版**（截到 2000 字），
           * 全文在本地记录里。三个字段一起读：缺 recordId 就是没记录（老内核 /
           * 无会话的调用），那时候不给入口 —— 点开必然 404。
           */
          const recordId = textOf(payload, 'recordId')
          if (recordId !== '') call.recordId = recordId
          const bytes = field(payload, 'bytes')
          if (typeof bytes === 'number' && Number.isFinite(bytes)) call.bytes = bytes
          if (field<unknown>(payload, 'truncated') === true) call.truncated = true
          settleStep(found?.step, event.at)
        }
        break
      }

      case 'tool/blocked': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        const callId = textOf(payload, 'callId')
        const found = toolOfStep(target, callId)
        const call = found?.tool ?? target.tools.find((t) => t.callId === callId) ?? target.tools[target.tools.length - 1]
        if (call) {
          call.status = 'blocked'
          call.reason = textOf(payload, 'reason')
          settleStep(found?.step, event.at)
        }
        break
      }

      case 'context/compacted': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        const before = field<unknown>(payload, 'beforeTokens')
        const after = field<unknown>(payload, 'afterTokens')
        const detail = typeof before === 'number' && typeof after === 'number'
          ? `${Math.round(before / 100) / 10}k → ${Math.round(after / 100) / 10}k`
          : undefined
        target.steps ??= []
        target.steps.push({
          kind: 'marker',
          id: `compact:${event.seq}`,
          at: event.at,
          label: '上下文已压缩',
          ...(detail ? { detail } : {}),
          tone: 'compact',
        })
        break
      }

      case 'progress/checkpoint': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        const decision = textOf(payload, 'decision')
        const reason = textOf(payload, 'reason')
        const nextFocus = textOf(payload, 'nextFocus')
        target.steps ??= []
        target.steps.push({
          kind: 'marker',
          id: `checkpoint:${event.seq}`,
          at: event.at,
          label: decision === 'stop' ? '自检中止' : '自检通过',
          ...(reason || nextFocus ? { detail: nextFocus && decision !== 'stop' ? `${reason} · 继续关注 ${nextFocus}` : reason } : {}),
          tone: decision === 'stop' ? 'error' : 'check',
        })
        break
      }

      case 'error': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        target.status = 'error'
        const step = lastStep(target)
        if (step) step.status = 'error'
        target.error = textOf(payload, 'message') || textOf(payload, 'code')
        target.errorCode = textOf(payload, 'code') || undefined
        break
      }

      case 'turn/ended': {
        if (!runId) break
        const at = byRun.get(runId)
        const target = at === undefined ? undefined : messages[at]
        if (!target) break
        target.finishedAt = event.at
        // 真实后端失败时只写 turn/ended，不一定另有 error 事件；不能留下一个空白成功气泡。
        if (textOf(payload, 'reason') === 'error') {
          target.status = 'error'
          target.error = target.error || textOf(payload, 'error') || textOf(payload, 'message') || '本轮未能完成'
          target.errorCode = target.errorCode ?? (textOf(payload, 'code') || undefined)
          const step = lastStep(target)
          if (step) step.status = 'error'
        } else if (target.status !== 'error') {
          target.status = 'done'
          const step = lastStep(target)
          if (step && step.status === 'streaming') step.status = 'done'
          if (step && step.endedAt === undefined) step.endedAt = event.at
        }
        break
      }

      default:
        // 未知 type 直接忽略 —— docs/06 是闭集, 但前后端是两次独立部署,
        // 旧前端遇到新事件不该崩。丢事件比崩界面便宜。
        break
    }
  }

  return messages
}

/**
 * 后台任务的投影。
 *
 * 与消息投影分开的原因: 消息是"线性的对话", 任务条是"横切的一层状态" ——
 * 一个任务可能跨越多轮对话 (起于第 2 轮, 落定于第 5 轮), 塞进某条消息里就等于
 * 把它钉死在某一轮上。所以它独立投影, 由壳统一渲染在输入框上方。
 *
 * `job/completed` 的 payload 是**完整快照** (docs/06 §2.1), 不是增量 ——
 * 所以这里用 upsert 而不是 patch: 前端可能因为断线重放只看到 completed 没看到 started,
 * 也可能的确没有 started 事件 (后端目前只发终态)。两种情况都能正确出条。
 *
 * 但**终态是 first-wins**: 一旦落定就不许被后来的事件改写 (docs/08 §9)。
 * 「快照 upsert」和「终态不可改写」两条一起才是对的 —— 前者解决"没看到开始",
 * 后者解决"用户中止了却看到它又完成了"。
 */
export type JobStatusValue = 'running' | 'completed' | 'killed' | 'failed'

export interface JobRow {
  id: string
  kind: string
  label: string
  status: JobStatusValue
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** 任务条最多留几条。多到六七条时它就不再是"提示"而是噪音了 */
const MAX_JOBS = 6

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'killed', 'failed'])

export function projectJobs(events: readonly StreamEvent[]): JobRow[] {
  const byId = new Map<string, JobRow>()

  for (const event of events) {
    // job/started 现在后端还不发; 先接上, 等它加了这个 case 就直接生效
    if (event.type !== 'job/completed' && event.type !== 'job/started') continue
    const payload = event.payload
    const id = field<string>(payload, 'id')
    if (typeof id !== 'string' || id === '') continue

    const prev = byId.get(id)
    /**
     * 终态 **first-wins** (docs/08 §9, 后端 B-03 明确): `killed` 不会被迟到的
     * `completed` 改写。所以已落定的 id 后来的事件一律忽略 —— 包括迟到的 running。
     * 不这么做的话, 用户点了"中止"之后条会自己变回"完成", 那是界面在撒谎。
     */
    if (prev && TERMINAL.has(prev.status)) continue

    const status = textOf(payload, 'status') as JobStatusValue
    // 未知 status 一律当 running: 把"没见过"画成"已完成"会让用户以为活干完了
    const safeStatus: JobStatusValue = TERMINAL.has(status) || status === 'running' ? status : 'running'

    byId.set(id, {
      id,
      kind: textOf(payload, 'kind') || 'job',
      label: textOf(payload, 'label') || id,
      status: safeStatus,
      ...(textOf(payload, 'detail') ? { detail: textOf(payload, 'detail') } : {}),
      startedAt: numberOr(payload, 'startedAt', event.at),
      ...(numberOr(payload, 'finishedAt', 0) ? { finishedAt: numberOr(payload, 'finishedAt', 0) } : {}),
    })
  }

  // 在跑的排前面 —— 任务条的价值就是"还有活没完"; 已落定的只是收尾通知
  const rows = [...byId.values()]
  rows.sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1
    const br = b.status === 'running' ? 0 : 1
    if (ar !== br) return ar - br
    return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)
  })
  return rows.slice(0, MAX_JOBS)
}


/** 单行输出直接当摘要时最多显示多少字符。// 你来定: 再长摘要就变成第二堵墙了 */
const SUMMARY_INLINE_MAX = 80

/**
 * 工具 output → 可显示文本。
 *
 * **真实形状是 string**: agent 在 yield 给上层之前已经把 ToolResult 拍平成
 * `result.ok ? result.text : result.error` (packages/agent/src/index.ts:151)。
 * 也就是说 bash 的 stdout / stderr / exit code 到这里时已经是一段渲染好的话。
 * 下面的对象分支纯粹是兜底 —— 后端哪天改成结构化输出, 界面也不至于白屏。
 */
export function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  if (typeof output === 'object') {
    try {
      return JSON.stringify(output, null, 2)
    } catch {
      // 循环引用会让 stringify 抛。不能因为一段工具输出把整屏带走
      return String(output)
    }
  }
  return String(output)
}

/**
 * done 之后的那一行摘要。
 *
 * 规则**照真实工具的 render 格式写**, 不是凭空设计的 —— 格式来源写进注释,
 * 那边改了渲染, 这里要跟着改:
 *
 *   - `tool-bash` 把非零退出渲染成 `[exit code: N]`, 而且此时 **`ok` 依然是 true**
 *     (plugins/tool-bash 的 render() 注释: 非零退出是结果, 不是失败)。
 *     所以退出码必须进摘要 —— 否则"命令跑挂了"和"跑成了"在界面上长得一模一样。
 *   - `tool-bash` 有 stderr 时插入一段 `[stderr]`, 同样算"结果不对劲"。
 *   - `tool-fs` read 的首行是 `文件名 (共 N 行)`, 但实际显示的行数可能因为
 *     50KB 字节上限更少 —— 摘要报**实际输出行数**, 不报"共 N 行", 那个数是给模型看的。
 *
 * 单行短输出**直接显示它自己**: 折叠对它没意义(折起来的和摘要一样长),
 * 而 `已更新 foo.ts (1234 字节)` 这种话比"1 行"有用得多。
 */
export function toolSummary(tool: ToolCall): ToolSummary {
  if (tool.status !== 'done') return { text: '', warn: false }

  const text = toolOutputText(tool.output).trim()
  if (!text) return { text: '无输出', warn: false }

  const exit = /\[exit code: (-?\d+)\]/.exec(text)
  const hasStderr = text.includes('[stderr]')
  const truncated = text.includes('已截断')
  const warn = (exit !== null && exit[1] !== '0') || hasStderr

  if (!text.includes('\n') && text.length <= SUMMARY_INLINE_MAX) {
    return { text, warn }
  }

  const parts: string[] = []
  if (exit) parts.push(`exit ${exit[1]}`)
  parts.push(`${text.split('\n').length} 行`)
  if (truncated) parts.push('已截断')
  return { text: parts.join(' · '), warn }
}

/**
 * 工具调用 → 人话标题。
 *
 * `{"file_path": "packages/session/src/index.ts"}` 是给模型看的 JSON;
 * 用户认的是「读取 …/src/index.ts」。这是同一件事的两种语言, 界面选后者,
 * 原始 JSON 不删 —— 展开后仍能看到, 想查技术细节的人不损失任何东西。
 *
 * 两个映射表都**故意保持小**:
 *   - VERBS 覆盖内置的 6 个工具; 外置插件先回落到 `工具名 对象` / `工具名`,
 *     等 plugin manifest 哪天带上「动词」声明, 再从那边读 —— 界面不替插件猜话。
 *   - ARG_KEYS 是"一次调用的主角"候选键。命中第一个就停, 不做智能拼接 ——
 *     标题的价值在扫一眼知道干了什么, 不在完整。
 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  bash: '执行',
  fetch: '抓取',
  search: '搜索',
  ask: '询问',
}

const TITLE_ARG_KEYS = [
  'file_path',
  'path',
  'command',
  'query',
  'url',
  'pattern',
  'question',
  'prompt',
  'topic',
] as const

/** 标题里的路径只留末两段: 用户认的是文件名, 不是目录学 */
function shortenTitleObject(raw: string): string {
  let s = raw.trim()
  if (s.includes('/')) {
    const parts = s.split('/').filter((p) => p !== '')
    if (parts.length > 2) s = `…/${parts.slice(-2).join('/')}`
  }
  // 一条命令超过这个长度, 标题就变成了第二行正文。截断是诚实: 后面还有
  if (s.length > 48) return `${s.slice(0, 47)}…`
  return s
}

function titleObject(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const rec = args as Record<string, unknown>
  for (const key of TITLE_ARG_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim() !== '') return shortenTitleObject(v)
  }
  return ''
}

export function toolTitle(tool: ToolCall): string {
  const obj = titleObject(tool.args)
  const verb = TOOL_VERBS[tool.tool]
  if (obj !== '') return verb !== undefined ? `${verb} ${obj}` : `${tool.tool} ${obj}`
  return verb ?? tool.tool
}

/**
 * 输出段的类型。
 *
 * `meta` 是**标记行**(`[stderr]` / `[exit code: 1]` / 截断提示) —— 它们不是工具产出,
 * 是工具在跟人说话, 所以单独一段、单独一个颜色。
 */
export type OutputKind = 'stdout' | 'stderr' | 'meta'

export interface OutputSegment {
  kind: OutputKind
  text: string
}

/**
 * 把工具输出按语义切成段, 供界面分色渲染。
 *
 * 为什么是**切段**而不是**逐行**渲染: 逐行能给每行加行号 gutter, 好看, 但 2000 行的
 * read 就是 2000 个节点 —— 而段数恒定的代价是 O(输出里的标记数), 通常 3~5 个。
 * 着色要的是"这段不对劲", 不是"这行是第几行", 段级够了。
 *
 * 标记行的判定用 **`/^\[.*\]$/` (整行就是一对方括号)**, 不逐个枚举文案:
 * tool-bash 的 render() 现在产出 `[stderr]` / `[exit code: N]` / `[命令在 Xms 后被中断]` /
 * `[已被用户中止]` / `[被信号 X 终止]` / `[stdout 已截断…]`, 将来加新标记这里自动认得。
 * 反过来逐个写死文案, 那边加一个标记这边就静默失效 —— 是最难查的一类坏法。
 */
export function segmentOutput(text: string): OutputSegment[] {
  // 空输出不该产生一个空段。注意**只挡这里** —— 输出内部的空行要保留, 那是人家的格式
  if (text === '') return []
  const segments: OutputSegment[] = []
  let kind: OutputKind = 'stdout'
  let buf: string[] = []

  const flush = (): void => {
    if (buf.length > 0) segments.push({ kind, text: buf.join('\n') })
    buf = []
  }

  for (const line of text.split('\n')) {
    // [stderr] 不只是个标记: 它宣告"下面这段是 stderr", 所以还要切换后续段的 kind
    if (line === '[stderr]') {
      flush()
      segments.push({ kind: 'meta', text: line })
      kind = 'stderr'
      continue
    }
    if (/^\[.*\]$/.test(line)) {
      flush()
      segments.push({ kind: 'meta', text: line })
      continue
    }
    buf.push(line)
  }
  flush()
  return segments
}

/**
 * 跑了多久 → 人话。`3s` / `1m20s`。
 *
 * 没有 startedAt 就返回空串, **不猜一个 0** —— 显示"0s"和显示"不知道"是两回事,
 * 前者是在撒一个具体的谎。
 */
export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(now)) return ''
  const total = Math.max(0, Math.round((now - startedAt) / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

/**
 * 输出要不要折叠。
 *
 * 只有一行的不折 —— 摘要已经把它整个显示出来了, 再给一个"展开"按钮
 * 就是纯粹多一次点击。多行一律折: 工具输出的价值在"想看时能看",
 * 不在"每次都摊在会话里把助手说的话顶走"。
 */
/** 执行态保留现场；完成后是否展开由偏好和用户手动选择决定。 */
export function toolCardExpanded(
  status: ToolStatus,
  toggled: boolean | null,
  autoFold: boolean,
): boolean {
  if (status !== 'done') return true
  return toggled ?? !autoFold
}

export function shouldFold(text: string): boolean {
  return text.includes('\n')
}

export function countTools(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + m.tools.length, 0)
}

/**
 * 「现在在等什么」的投影。
 *
 * 界面要显示的等待态只有两种, 而它们都**已经在消息里了** —— 不需要新增状态:
 *   - 有工具在跑 → 等工具 (since 取 tool.startedAt, 断线重放才不会把 40 秒说成 1 秒)
 *   - 助手消息还在 streaming 且没有工具在跑 → 等模型说第一句/下一句
 *   - 其它 → 没在等 (done / error / 空会话)
 *
 * 只看**最后一条助手消息**: 上一轮 if 有残留的 running 工具(极端情况: 丢事件),
 * 不该让已经结束的这一轮永远显示"在等"。宁可漏一次, 不可永远挂着。
 *
 * `key` 是"这一次等待"的身份 —— 气泡靠它判断"同一次等待只出一条",
 * 换工具/换轮次就是新的一次, 允许重新出。
 */
export type WaitScene = 'thinking' | 'tool'

export interface WaitState {
  scene: WaitScene
  /** 这次等待开始的时刻 (毫秒) */
  since: number
  /** 这一次等待的身份 */
  key: string
}

export function waitingState(messages: readonly Message[]): WaitState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue

    const running = message.tools.find((t) => t.status === 'running')
    if (running) {
      return { scene: 'tool', since: running.startedAt ?? message.at, key: `tool:${running.callId}` }
    }
    if (message.status === 'streaming') {
      return { scene: 'thinking', since: message.at, key: `turn:${message.id}` }
    }
    return null
  }
  return null
}

/**
 * 消息窗口: 只渲染最近 `size` 条, 更早的折叠成"显示更早"入口。
 *
 * 为什么**不是**虚拟化 (docs/07 F7 的验收项, 这是有意降级):
 *   - 消息高度不可预估 —— 流式正文每帧都在长, 工具卡折叠/展开跳变, 虚拟化必须
 *     给每一项维护高度缓存, 否则滚动条抖得没法用;
 *   - 虚拟化会破坏浏览器原生的 Ctrl+F、跨消息选区复制、读屏的线性阅读 ——
 *     这三条在"查历史聊天"场景里全都会被用到;
 *   - 性能预算 (docs/05) 要对付的是 DOM 节点数, 窗口化把节点数从 O(会话长度)
 *     压到常数, 60 条 ≈ 500 节点, 手机上绰绰有余。真到几千条的那天,
 *     该做的是会话归档/搜索, 而不是在聊天流上硬扛虚拟化。
 *
 * 纯函数放在投影层而不是组件里: 窗口边界、hidden 计数这些边界值值得被单测钉住。
 */
export function windowMessages<T>(list: readonly T[], size: number): { visible: readonly T[]; hidden: number } {
  if (!Number.isFinite(size) || size <= 0) return { visible: [], hidden: list.length }
  const hidden = Math.max(0, list.length - size)
  return { visible: hidden > 0 ? list.slice(hidden) : list, hidden }
}

/* ─────────────────────────── 提问（question/*） ─────────────────────────── */

/**
 * 一个可选项。形状抄 packages/questions 的 QuestionChoice ——
 * 内核与前端是两次独立部署, 这里按「缺就少画」处理, 不假设字段一定在。
 */
export interface QuestionChoice {
  key: string
  label: string
  description?: string
}

/**
 * 挂起中的问题。
 *
 * **它不是消息**: 消息进时间线, 问题进输入框上方。
 * 两者混在一起会出现「问题沉到历史里, 用户翻聊天记录才找到该回哪」。
 *
 * `kind` 只有两种: approval (策略拦截, 要你批准) 与 info (模型提问)。
 * 两种走同一套卡片, 只是标题和选项措辞不同 —— docs/06 §1.4 说的就是这件事。
 */
export interface PendingQuestion {
  questionId: string
  kind: 'approval' | 'info'
  title: string
  body?: string
  choices?: QuestionChoice[]
  toolName?: string
  callId?: string
  sessionId?: string
  runId?: string
  at: number
}

/**
 * 解析 question/asked 的 payload。
 *
 * 字段缺了就少画, 不猜: 问 Id 缺了这条问题就无从回答, 直接丢掉;
 * 标题缺了给一句兜底, 但选项与正文缺了就是缺了 (画一个空选项比不画更糟)。
 */
export function parseQuestion(payload: unknown, fallbackAt: number): PendingQuestion | undefined {
  const questionId = textOf(payload, 'questionId')
  if (!questionId) return undefined
  const kind: PendingQuestion['kind'] = textOf(payload, 'kind') === 'approval' ? 'approval' : 'info'
  const title = textOf(payload, 'title')
  const body = textOf(payload, 'body')
  const toolName = textOf(payload, 'toolName')
  const callId = textOf(payload, 'callId')
  const sessionId = textOf(payload, 'sessionId')
  const runId = textOf(payload, 'runId')
  const rawChoices = field<unknown>(payload, 'choices')
  const choices: QuestionChoice[] = []
  if (Array.isArray(rawChoices)) {
    for (const raw of rawChoices) {
      const key = textOf(raw, 'key')
      const label = textOf(raw, 'label')
      if (!key || !label) continue
      const description = textOf(raw, 'description')
      choices.push({ key, label, ...(description ? { description } : {}) })
    }
  }
  return {
    questionId,
    kind,
    title: title || (kind === 'approval' ? '需要你批准' : '模型需要你回答'),
    ...(body ? { body } : {}),
    ...(choices.length ? { choices } : {}),
    ...(toolName ? { toolName } : {}),
    ...(callId ? { callId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    at: numberOr(payload, 'at', fallbackAt),
  }
}

/**
 * 当前挂起的问题 —— **从事件流现算**, 不另存一份状态。
 *
 * 事件流是主通道: question/asked 来了就挂起, question/answered 来了就收起。
 * 用 map 存而不是单个变量: 迟到的 answered 可能对应一个早已回答过的 id,
 * 单变量会把新挂起的问题误收掉。
 *
 * 多个同时挂起时取**最近**的那个 —— 用户一次只可能回答一个。
 */
export function projectQuestions(events: readonly StreamEvent[]): PendingQuestion[] {
  const pending = new Map<string, PendingQuestion>()
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  for (const event of ordered) {
    if (event.type === 'question/asked') {
      const question = parseQuestion(event.payload, event.at)
      if (question) pending.set(question.questionId, question)
    } else if (event.type === 'question/answered') {
      const questionId = textOf(event.payload, 'questionId')
      if (questionId) pending.delete(questionId)
    }
  }
  return [...pending.values()].sort((a, b) => a.at - b.at)
}

/**
 * 合并两批挂起问题。
 *
 * 事件流与 `question.list` 会重叠：同一条 asked 既可能来自实时事件, 也可能来自
 * 刷新自愈。按 questionId upsert; 新快照覆盖旧快照, 但顺序仍按最早到达时间,
 * 这样队列不会因为一次刷新突然倒序。
 */
export function mergeQuestions(
  current: readonly PendingQuestion[],
  incoming: readonly PendingQuestion[],
): PendingQuestion[] {
  const merged = new Map<string, PendingQuestion>()
  for (const question of current) merged.set(question.questionId, question)
  for (const question of incoming) merged.set(question.questionId, question)
  return [...merged.values()].sort((a, b) => a.at - b.at)
}

/** 兼容旧调用：只取队列里最近到达的一条。 */
export function projectQuestion(events: readonly StreamEvent[]): PendingQuestion | undefined {
  const pending = projectQuestions(events)
  return pending[pending.length - 1]
}

/** 从 question/answered 的 payload 里取 questionId。缺了就返回空串。 */
export function questionIdOf(payload: unknown): string {
  return textOf(payload, 'questionId')
}
