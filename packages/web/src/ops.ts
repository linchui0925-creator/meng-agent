/**
 * 内置 op —— 契约 docs/06 §1。
 *
 * 这里只放"内核必然要提供"的 op。业务 op 应该由插件用 `web.op()` 自己注册,
 * 不要往这个文件里塞 —— 塞进来就等于把业务钉回内核, 又变成 36 个 include_router。
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Ctx, Disposer } from '@meng/core'
import { getCredentials, sandboxRoot, type ConfigService, type ConfigWriteResult, type CredentialService } from '@meng/config'
import type { RecordStore } from '@meng/records'
import { normalizePath, readGitStatus, type WorkspaceStore } from '@meng/workspaces'
import type { SessionAttachment, SessionEvent, SessionService } from '@meng/session'
import { LlmError, type LLMService, type ReasoningEffort } from '@meng/llm'
import { PROTOCOLS } from '@meng/pi'
import type { ToolService } from '@meng/tools'
import type { LoopService, MemoryService, RunInterruption } from '@meng/loop'
import { getJobs, JOBS_CODE, JobError } from '@meng/jobs'
import { FsError, type FsService } from '@meng/fs'
import { HttpError, type OpHandler, type WebService } from './index.ts'
import { catalogOf } from './catalog.ts'

const execFileAsync = promisify(execFile)
const REASONING_EFFORTS = new Set<ReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 自检/冒烟/后台测试用的会话不是用户对话，不进入侧栏。 */
function isInternalSessionId(sessionId: string): boolean {
  return sessionId === 'demo' || sessionId === 'cli'
    || sessionId === '__detached__' || sessionId === '__invariant__'
    || sessionId.startsWith('inv-') || sessionId.startsWith('sess-')
}

/** 粗估输入 token：中文按 1 字 1 token，其他字符按 4 字符 1 token。 */
function estimateTextTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk++
  }
  return Math.ceil(cjk + Math.max(0, text.length - cjk) / 4)
}

/** 切换模型的参考稿只保留用户/助手最终文字，不带工具日志。 */
function modelReferenceUntil(events: readonly SessionEvent[], throughSeq: number): string {
  const parts: string[] = []
  for (const event of events) {
    if (event.seq > throughSeq) break
    if (event.type === 'turn/started') {
      const text = String((event.data as { text?: unknown }).text ?? '').trim()
      if (text) parts.push(`[用户]\n${text}`)
    } else if (event.type === 'llm/completed') {
      const text = String((event.data as { text?: unknown }).text ?? '').trim()
      if (text) parts.push(`[助手]\n${text}`)
    }
  }
  return parts.join('\n\n')
}

function latestModelSwitch(events: readonly SessionEvent[]): SessionEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'model/switched') return events[i]
  }
  return undefined
}

interface RunRegistry {
  runs: Map<string, AbortController>
}

export function registerBuiltinOps(
  ctx: Ctx,
  web: WebService,
  registry: RunRegistry,
): Disposer {
  const offs: Disposer[] = []
  const op = (name: string, handler: OpHandler) => offs.push(web.op(name, handler))

  const session = () => need<SessionService>(ctx, 'session')
  const llm = () => need<LLMService>(ctx, 'llm')
  const tools = () => need<ToolService>(ctx, 'tools')
  const jobs = () => {
    const service = getJobs(ctx)
    if (!service) throw new HttpError('no-capability', '后台任务能力未装载', 503)
    return service
  }
  const loop = () => need<LoopService>(ctx, 'loop')
  const memory = () => need<MemoryService>(ctx, 'memory')
  const config = () => ctx.get<ConfigService>('config')
  const credentials = () => ctx.get<CredentialService>('credentials')
  const runSessions = new Map<string, string>()

  // ── 内核 ──────────────────────────────────────────────
  // 与 ws hello 帧同一份 manifest, 给"用不了长连接"的环境 (HTTP 轮询) 兜底
  op('kernel.hello', () => web.manifest())

  op('kernel.status', () => ({
    capabilities: ['llm', 'session', 'tools', 'prompt', 'loop', 'memory', 'questions', 'web'].filter((n) => ctx.get(n)),
    ops: web.ops(),
    connections: web.connections,
    uptimeMs: Math.round(process.uptime() * 1000),
  }))

  op('system.notify', async (payload) => {
    const title = String(payload.title ?? '').trim()
    const body = String(payload.body ?? '').trim()
    if (!title) throw new HttpError('bad-request', '缺 title')
    const platform = ctx.get<{ notify?: { send(title: string, body: string): Promise<void> } }>('platform')
    if (!platform?.notify) throw new HttpError('no-capability', '当前端没有系统通知能力', 503)
    await platform.notify.send(title, body)
    return { ok: true }
  })

  // ── 会话 ──────────────────────────────────────────────
  op('session.create', (payload) => {
    const title = String(payload.title ?? '新会话')
    /**
     * 工作区 = **目录的绝对路径**（不是 uuid，见 §1.16 第 1 条）。
     *
     * 缺省 / 空串 = 普通任务 —— **不写空串进去**：空串会变成一个 id 为空的
     * 工作区，前端还得再判一次，而"没有"和"空"在界面上是两种画法。
     */
    const rawWorkspace = payload.workspace
    const requested = rawWorkspace !== undefined && rawWorkspace !== null && String(rawWorkspace).trim() !== ''
      ? String(rawWorkspace)
      : (process.env['MENG_DEFAULT_WORKSPACE']?.trim() || process.cwd())
    let workspace: string | undefined
    if (requested.trim() !== '') {
      workspace = normalizePath(requested)
      // 目录没了就明确拒掉：让它"创建成功但所有工具都跑不动"是更坏的失败
      if (!existsSync(workspace)) throw new HttpError('bad-request', `工作区不存在: ${workspace}`)
      if (!statSync(workspace).isDirectory()) throw new HttpError('bad-request', `不是目录: ${workspace}`)
    }
    const sessionId = randomUUID().slice(0, 8)
    session().append(sessionId, 'session/created', { title, ...(workspace ? { workspace } : {}) })
    return { sessionId, at: Date.now(), ...(workspace ? { workspace } : {}) }
  })

  op('session.list', () => session().sessions().filter((item) => !isInternalSessionId(item.sessionId)))

  /**
   * 工作区列表。**两份来源合起来**:
   *
   *   1. 用户主动加过的（`workspaces.json`）—— 里面还没有会话的那些也要在,
   *      否则"在这个目录里开一个"就没有入口
   *   2. 会话里出现过的（`session/created.workspace`）—— 用户没加过、但开过会话
   *
   * 目录已经不存在的**不给**（§1.16 第 4 条允许两种做法，选"不给"）:
   * 前端拿到一个已删除的目录只会多一次失败点击。
   *
   * 排序按名字 —— 侧栏和选择器都按它画，顺序乱跳会让人以为列表变了。
   */
  op('workspace.list', () => {
    const store = ctx.get<WorkspaceStore>('workspaces')
    const seen = new Map<string, { id: string; name: string; path: string }>()
    for (const w of store?.list() ?? []) {
      if (w.missing) continue
      seen.set(w.path, { id: w.path, name: w.name, path: w.path })
    }
    for (const s of session().sessions().filter((item) => !isInternalSessionId(item.sessionId))) {
      const path = s.workspace
      if (!path || seen.has(path) || !existsSync(path)) continue
      seen.set(path, { id: path, name: basename(path) || path, path })
    }
    return { workspaces: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
  })

  /**
   * 打开这台电脑自带的文件夹选择窗口。浏览器只拿到最终绝对路径，
   * 不需要网页目录树，也不需要用户手填路径。取消选择是正常结果，不是错误。
   */
  op('workspace.pick', async () => {
    if (process.platform !== 'darwin') {
      throw new HttpError('no-capability', '当前系统还没有接入系统文件夹选择窗口', 503)
    }
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript',
        ['-e', 'POSIX path of (choose folder with prompt "选择要作为工作区的文件夹")'],
        { windowsHide: true, maxBuffer: 64 * 1024 },
      )
      const path = normalizePath(stdout.trim())
      if (!statSync(path).isDirectory()) throw new Error('选择的不是文件夹')
      return { path }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('-128')) return { cancelled: true }
      throw new HttpError('bad-request', `系统文件夹选择失败: ${message}`)
    }
  })

  /**
   * 新建工作区 = **建目录 + 记住它**。浏览器建不了目录，所以这一步必须在后端。
   */
  op('workspace.create', (payload) => {
    const store = ctx.get<WorkspaceStore>('workspaces')
    if (!store) throw new HttpError('no-capability', '工作区清单未装载 (缺 @meng/workspaces)', 503)
    const raw = String(payload.path ?? '').trim()
    if (!raw) throw new HttpError('bad-request', '缺 path')
    try {
      const w = store.add(raw)
      return { id: w.path, name: w.name, path: w.path }
    } catch (err) {
      // 建不出来（权限 / 路径已是一个文件）时说人话，别把 fs 的错误码丢出去
      throw new HttpError('bad-request', (err as Error).message)
    }
  })

  /**
   * 本机目录浏览。只读目录项，不读文件内容，也不上传或复制任何东西。
   * 与模型工具共用 fs 能力面和路径围栏；这是用户选目录的入口，不是越权后门。
   */
  op('fs.list', async (payload) => {
    const raw = String(payload.path ?? '').trim()
    if (!raw) throw new HttpError('bad-request', '缺 path')
    const fs = need<FsService>(ctx, 'fs')
    const path = normalizePath(raw)
    try {
      const info = await fs.stat(path)
      if (!info.exists) throw new HttpError('bad-request', `目录不存在: ${path}`)
      if (!info.isDir) throw new HttpError('bad-request', `不是目录: ${path}`)
      const entries = (await fs.listDir(path))
        .map(({ name, dir }) => ({ name, dir }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      const parent = dirname(path)
      return { path, ...(parent === path ? {} : { parent }), entries }
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (err instanceof FsError && err.code === 'FS_OUT_OF_ROOT') {
        throw new HttpError('forbidden', err.message, 403)
      }
      throw new HttpError('bad-request', `目录读取失败: ${(err as Error).message}`)
    }
  })

  op('git.status', async (payload) => {
    const raw = typeof payload.path === 'string' && payload.path.trim() ? payload.path : sandboxRoot(ctx)
    return readGitStatus(normalizePath(raw))
  })

  op('session.read', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')

    // 老调用仍拿数组，前端与导出不用改；显式传 before/limit 才启用分页信封。
    if (payload.before !== undefined || payload.limit !== undefined) {
      const before = payload.before === undefined ? undefined : Number(payload.before)
      const limit = payload.limit === undefined ? undefined : Number(payload.limit)
      if (before !== undefined && !Number.isSafeInteger(before)) {
        throw new HttpError('bad-request', 'before 必须是整数事件序号')
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new HttpError('bad-request', 'limit 必须是正整数')
      }
      return session().readPage(sessionId, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) })
    }

    const since = Number(payload.since ?? 0)
    const events = session().read(sessionId)
    return since > 0 ? events.filter((e) => e.seq > since) : events
  })

  op('session.rename', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const title = String(payload.title ?? '').trim()
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    if (!title) throw new HttpError('bad-request', '会话标题不能为空')
    if (title.length > 200) throw new HttpError('bad-request', '会话标题不能超过 200 字')
    try {
      return { ok: true as const, session: session().rename(sessionId, title) }
    } catch (err) {
      throw new HttpError('not-found', (err as Error).message, 404)
    }
  })

  op('session.setPermission', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const raw = payload.mode ?? 'inherit'
    if (raw !== 'inherit' && raw !== 'ask' && raw !== 'auto' && raw !== 'full') {
      throw new HttpError('bad-request', 'mode 必须是 inherit / ask / auto / full')
    }
    try {
      return {
        ok: true as const,
        session: session().setPermission(sessionId, raw === 'inherit' ? undefined : raw),
      }
    } catch (err) {
      throw new HttpError('not-found', (err as Error).message, 404)
    }
  })

  op('session.delete', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    let result
    try {
      result = session().delete(sessionId)
    } catch (err) {
      throw new HttpError('not-found', (err as Error).message, 404)
    }
    // 先删库再取消，同一同步调用里不会插入新事件；普通 append 也无法复活已删会话。
    for (const [runId, owner] of runSessions) {
      if (owner !== sessionId) continue
      registry.runs.get(runId)?.abort()
      registry.runs.delete(runId)
      runSessions.delete(runId)
    }
    return result
  })

  op('attachment.put', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    try {
      const saved = session().putAttachment({
        sessionId,
        name: String(payload.name ?? ''),
        mime: String(payload.mime ?? ''),
        dataBase64: String(payload.dataBase64 ?? ''),
      })
      return { id: saved.id }
    } catch (err) {
      const message = (err as Error).message
      const missing = /^会话 .* 不存在$/.test(message)
      throw new HttpError(missing ? 'not-found' : 'bad-request', message, missing ? 404 : 400)
    }
  })

  /**
   * 不等待结果 —— 一轮 agent 可能跑几十秒、调十几个工具。
   * 返回 runId 后所有进展走 WS, 前端靠 runId 分组。
   */
  /**
   * 会话历史里的图片内容。事件流只存附件元数据；刷新后要画真缩略图时按 id
   * 回到这里读。session 存储会再次校验附件属于当前会话。
   */
  op('attachment.read', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const attachmentId = String(payload.attachmentId ?? '')
    if (!sessionId || !attachmentId) throw new HttpError('bad-request', '缺 sessionId 或 attachmentId')
    try {
      const found = session().readAttachments(sessionId, [attachmentId])[0]
      if (!found) throw new HttpError('not-found', `附件不存在: ${attachmentId}`, 404)
      return found
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError('not-found', (err as Error).message, 404)
    }
  })

  /**
   * 切模型 = 建立新的逻辑上下文，不新增侧栏会话。
   * 旧对话只在后续请求里作为参考文字再次发送，因此会额外消耗 input tokens。
   */
  op('session.switchModel', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const from = payload.from === undefined ? undefined : String(payload.from)
    const to = String(payload.to ?? '').trim()
    if (!to) throw new HttpError('bad-request', '缺 to 模型')
    const events = session().read(sessionId)
    if (events.length === 0) throw new HttpError('not-found', `会话不存在: ${sessionId}`, 404)
    const referenceThroughSeq = events.at(-1)?.seq ?? 0
    const reference = modelReferenceUntil(events, referenceThroughSeq)
    const event = session().append(sessionId, 'model/switched', {
      ...(from === undefined ? {} : { from }),
      to,
      referenceThroughSeq,
      estimatedInputTokens: estimateTextTokens(reference),
      at: Date.now(),
    })
    return { ok: true, sessionId, seq: event.seq }
  })

  op('session.send', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const text = String(payload.text ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const rawAttachments = payload.attachments
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
      throw new HttpError('bad-request', 'attachments 必须是附件 id 数组')
    }
    const attachmentIds = (rawAttachments ?? []) as unknown[]
    if (attachmentIds.some((id) => typeof id !== 'string' || !id)) {
      throw new HttpError('bad-request', 'attachments 必须只含非空附件 id')
    }
    if (!text && attachmentIds.length === 0) throw new HttpError('bad-request', '缺 text 或 attachments')

    const rawReasoningEffort = payload.reasoningEffort
    if (rawReasoningEffort !== undefined
      && (typeof rawReasoningEffort !== 'string' || !REASONING_EFFORTS.has(rawReasoningEffort as ReasoningEffort))) {
      throw new HttpError('bad-request', 'reasoningEffort 必须是 minimal / low / medium / high / xhigh / max')
    }
    const reasoningEffort = rawReasoningEffort as ReasoningEffort | undefined

    let interruption: RunInterruption | undefined
    if (payload.interruption !== undefined) {
      const raw = payload.interruption
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new HttpError('bad-request', 'interruption 必须是对象')
      }
      const record = raw as Record<string, unknown>
      if (record.mode !== 'insert') {
        throw new HttpError('bad-request', 'interruption.mode 必须是 insert')
      }
      if (record.sourceRunId !== undefined && (typeof record.sourceRunId !== 'string' || !record.sourceRunId)) {
        throw new HttpError('bad-request', 'interruption.sourceRunId 必须是非空字符串')
      }
      interruption = {
        mode: 'insert',
        ...(typeof record.sourceRunId === 'string' ? { sourceRunId: record.sourceRunId } : {}),
      }
    }

    let attachments: SessionAttachment[] = []
    try {
      attachments = session().readAttachments(sessionId, attachmentIds as string[]).map((attachment) => {
        const { dataBase64: _dataBase64, ...metadata } = attachment
        return metadata
      })
    } catch (err) {
      throw new HttpError('bad-request', (err as Error).message)
    }

    const runId = randomUUID().slice(0, 8)
    const ctrl = new AbortController()
    registry.runs.set(runId, ctrl)
    runSessions.set(runId, sessionId)

    const model = payload.model ? String(payload.model) : undefined
    const events = session().read(sessionId)
    const switchEvent = latestModelSwitch(events)
    const switchData = switchEvent?.data as {
      referenceThroughSeq?: unknown
      estimatedInputTokens?: unknown
    } | undefined
    const referenceThroughSeq = typeof switchData?.referenceThroughSeq === 'number'
      ? switchData.referenceThroughSeq
      : undefined
    const contextReset = switchEvent !== undefined && referenceThroughSeq !== undefined
      ? {
          afterSeq: switchEvent.seq,
          reference: modelReferenceUntil(events, referenceThroughSeq),
          ...(typeof switchData?.estimatedInputTokens === 'number'
            ? { estimatedInputTokens: switchData.estimatedInputTokens }
            : {}),
        }
      : undefined

    void (async () => {
      let doneReason: 'stop' | 'max-turns' | 'error' | 'aborted' | undefined
      let runError: string | undefined
      let runCode: string | undefined
      try {
        for await (const ev of loop().run({
          sessionId,
          text,
          attachments,
          model,
          reasoningEffort,
          runId,
          signal: ctrl.signal,
          ...(contextReset === undefined ? {} : { contextReset }),
          ...(interruption === undefined ? {} : { interruption }),
        })) {
          if (ev.type === 'text') {
            // chunk 不落库: 一轮几千个, 落进去事件流会爆炸。
            // 代价是断线重放没有 chunk, 前端用 llm/completed 的整段补齐
            web.broadcast('llm/chunk', { delta: ev.text, runId }, { sessionId, runId })
          }
          if (ev.type === 'reasoning') {
            // 同一个事件类型走 channel 分流，避免扩充下行事件闭集；
            // 前端只把 reasoning 放进当前 step，不拼进最终回复正文。
            web.broadcast('llm/chunk', { delta: ev.text, runId, channel: 'reasoning' }, { sessionId, runId })
          }
          if (ev.type === 'done') {
            doneReason = ev.reason
            if (ev.error !== undefined) runError = ev.error
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        runError = message
        runCode = err instanceof Error && 'code' in err ? String(err.code) : 'INTERNAL'
        web.broadcast('error', { code: 'internal', message, runId }, { sessionId, runId })
      } finally {
        // 插件实现可能漏写终态，或者工具异常直接把生成器打断。前端队列靠
        // turn/ended 才能继续发送，所以内核必须兜底：每个 run 有且只有一个终态。
        try {
          const ended = session().read(sessionId).some((event) => {
            if (event.type !== 'turn/ended') return false
            return (event.data as { runId?: unknown } | undefined)?.runId === runId
          })
          if (!ended) {
            const reason = ctrl.signal.aborted ? 'aborted' : (doneReason ?? 'error')
            session().append(sessionId, 'turn/ended', {
              runId,
              reason,
              ...(runError === undefined ? {} : { error: runError }),
              ...(runCode === undefined ? {} : { code: runCode }),
            })
          }
        } catch {
          // 会话被删除是合法竞态；这时没有可写的终态。
        }
        registry.runs.delete(runId)
        runSessions.delete(runId)
      }
    })()

    return { runId, accepted: true }
  })

  op('session.abort', (payload) => {
    const runId = String(payload.runId ?? '')
    const ctrl = registry.runs.get(runId)
    if (!ctrl) throw new HttpError('aborted', `run ${runId} 不存在或已结束`, 409)
    ctrl.abort()
    return { ok: true }
  })

  // ── 模型 / 工具 ───────────────────────────────────────
  // 只给**能用**的模型: 这个 op 喂的是"选模型", 列出没配 key 的那家的模型
  // 等于给用户一个点了就报错的选项
  op('llm.models', async () => {
    await llm().refreshModels({ force: true })
    return llm().models()
  })

  /**
   * 供应商目录 —— 设置页「模型」分区的唯一数据源。
   *
   * 三个问题一次答完: 装了谁 (含**没配好的**)、各自要填什么 (schema + 当前值)、
   * 为什么现在不能用 (missing)。所以前端不需要自己拼 llm 和 config 两份数据,
   * 也不需要认识任何 provider 插件。
   */
  op('llm.catalog', async () => {
    await llm().refreshModels({ force: true })
    return catalogOf(llm().listProviders(), config()?.list() ?? [], llm().listConfigurableProviders())
  })

  // ── 上下文与记忆 ───────────────────────────────────────
  op('context.status', async (payload) => {
    const sessionId = String(payload.sessionId ?? '').trim()
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const model = typeof payload.model === 'string' && payload.model ? payload.model : undefined
    return memory().status({ sessionId, ...(model ? { model } : {}) })
  })

  op('context.compact', async (payload) => {
    const sessionId = String(payload.sessionId ?? '').trim()
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    const model = typeof payload.model === 'string' && payload.model ? payload.model : undefined
    const result = await memory().compactNow({ sessionId, ...(model ? { model } : {}) })
    return {
      compacted: result.compacted,
      ...(result.beforeTokens === undefined ? {} : { beforeTokens: result.beforeTokens }),
      ...(result.afterTokens === undefined ? {} : { afterTokens: result.afterTokens }),
      ...(result.summarySeq === undefined ? {} : { summarySeq: result.summarySeq }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    }
  })

  /**
   * 可选的 wire 协议（9 种）。
   *
   * 为什么要单独一个 op：设置页"新建自定义 API"要画一个协议选择框，而**能选
   * 哪些**是后端的能力，不是前端的常量。硬编码在前端的话，后端加一种协议，
   * 界面上永远选不到 —— 而且不会有任何报错。
   *
   * 为什么从 `@meng/pi` 拿而不是从 config 的 schema 里挖：schema 里的 enum
   * 只有 id，没有"这条协议还需不需要 AWS 凭据"这类要说给用户听的话。
   * 这里一起给。
   */
  op('llm.protocols', () => PROTOCOLS)

  /**
   * 模型发现 —— 设置页的「获取可用模型」。
   *
   * payload 是**草稿**: 编辑一条已有路由时给 `provider`; 新建一条时给
   * `baseURL` / `protocol` / `apiKeyEnv`（此时它还没有路由 id）。
   * `scope` 用来找"谁负责探测这类供应商"—— 探测器由插件按 scope 注册,
   * 出口层不认识任何厂商。
   */
  op('llm.discoverModels', async (payload) => {
    const scope = typeof payload.scope === 'string' ? payload.scope.trim() : ''
    if (!scope) throw new HttpError('bad-request', '缺 scope（这些供应商属于哪个插件）')
    try {
      return await llm().discoverModels(scope, {
        ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
        ...(typeof payload.baseURL === 'string' ? { baseURL: payload.baseURL } : {}),
        ...(typeof payload.protocol === 'string' ? { protocol: payload.protocol } : {}),
        ...(typeof payload.apiKeyEnv === 'string' ? { apiKeyEnv: payload.apiKeyEnv } : {}),
        // 只在明确要说"别翻目录、去问端点"时透传。默认值留在缝里，
        // 这里再写一遍 `: 'catalog'` 就等于同一个默认值有两份
        ...(payload.source === 'endpoint' ? { source: 'endpoint' as const } : {}),
      })
    } catch (err) {
      // 这条链路最需要的是"为什么没拉到": 401 / 连不上 / 不是模型清单。
      // 原样冒会变成 500 的通用壳, 那句话就丢了
      if (err instanceof LlmError) throw new HttpError(err.failure.code.toLowerCase(), err.message, 400)
      throw err
    }
  })

  // ── 后台任务网页控制面 ─────────────────────────────────
  // 工具侧给模型用；这几条给界面用。围栏仍由 jobs 的 ownerSession 决定。
  op('job.list', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    return jobs().list({ sessionId })
  })

  op('job.output', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const jobId = String(payload.jobId ?? '')
    if (!sessionId || !jobId) throw new HttpError('bad-request', '缺 sessionId 或 jobId')
    try {
      const maxChars = Number(payload.maxChars)
      return jobs().read(jobId, { sessionId }, payload.full === true
        ? {
            mode: 'tail' as const,
            ...(Number.isFinite(maxChars) && maxChars > 0 ? { maxChars } : {}),
          }
        : undefined)
    } catch (err) {
      throw jobHttpError(err)
    }
  })

  op('job.kill', (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const jobId = String(payload.jobId ?? '')
    if (!sessionId || !jobId) throw new HttpError('bad-request', '缺 sessionId 或 jobId')
    try {
      const outcome = jobs().kill(jobId, { sessionId }, String(payload.reason ?? '用户从界面停止'))
      return { ok: true, outcome, job: jobs().get(jobId, { sessionId }) }
    } catch (err) {
      throw jobHttpError(err)
    }
  })

  op('job.startCommand', async (payload) => {
    const sessionId = String(payload.sessionId ?? '')
    const command = String(payload.command ?? '').trim()
    if (!sessionId) throw new HttpError('bad-request', '缺 sessionId')
    if (!command) throw new HttpError('bad-request', '缺命令')
    if (session().read(sessionId).length === 0) throw new HttpError('not-found', `会话不存在: ${sessionId}`, 404)
    const description = String(payload.description ?? '').trim() || command.slice(0, 80)
    const result = await tools().call({
      id: `web-job-${randomUUID().slice(0, 8)}`,
      name: 'bash',
      args: { command, description, run_in_background: true },
      sessionId,
    })
    if (!result.ok) throw new HttpError('bad-request', result.error ?? result.text)
    return { ok: true, text: result.text }
  })

  op('tools.list', () => tools().list())

  /**
   * 工具分组 + 开关状态。设置页那张"哪些组进 prompt"的表就靠它。
   *
   * 为什么要一个单独的 op 而不是让前端从 `tools.list()` 自己分组:
   * 组的**名单**是后端的事实 (插件注册时声明), 前端只该知道"有哪些组、
   * 现在开没开", 不该自己猜 core 之外还有什么。
   */
  op('tools.groups', () => tools().groups())

  /**
   * 取一次工具调用的**完整记录**（三层 + 全文）。
   *
   * 事件流里的 `tool/completed.result` 截到 2000 字, 全文在这里。界面点
   * "查看完整输出"就走这一条 —— 不带这个 op 的话, 那 2000 字就是用户能看到的全部。
   */
  op('tool.record', (payload) => {
    const recordId = String(payload.recordId ?? '')
    if (!recordId) throw new HttpError('bad-request', '缺 recordId')
    const records = ctx.get<RecordStore>('records')
    if (!records) throw new HttpError('no-capability', '记录库未装载 (缺 @meng/records)', 503)
    const rec = records.get(recordId)
    // 记录是**可丢的**附属数据 (可能被清理): 找不到就是 404, 不是 500
    if (!rec) throw new HttpError('not-found', `记录 ${recordId} 不存在 (可能已被清理)`, 404)
    return rec
  })

  op('tool.recent', (payload) => {
    const records = ctx.get<RecordStore>('records')
    if (!records) throw new HttpError('no-capability', '记录库未装载 (缺 @meng/records)', 503)
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
    const tool = typeof payload.tool === 'string' ? payload.tool : undefined
    const limit = Number(payload.limit ?? 50)
    return records.list({
      ...(sessionId ? { sessionId } : {}),
      ...(tool ? { tool } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    })
  })

  op('tool.stats', () => {
    const records = ctx.get<RecordStore>('records')
    if (!records) throw new HttpError('no-capability', '记录库未装载 (缺 @meng/records)', 503)
    return records.stats()
  })

  // ── 配置读写 ──────────────────────────────────────────
  // 设置页跨进程生效的值必须走后端 (localStorage 只管纯视觉偏好)。
  // 这两个 op 是 packages/config 那道缝的出口, 语义全在缝里, 这里只做
  // 「全名 → (scope, name)」的翻译 —— 因为 scope 名本身带点 (`llm.deepseek`),
  // 按第一个点切会把 `llm.deepseek.apiKey` 切成 `llm` / `deepseek.apiKey`。
  op('config.list', () => needConfig(ctx).list())

  op('config.set', async (payload) => {
    const svc = needConfig(ctx)
    const entry = declared(svc, payload.key)
    // 形状由声明里的 schema 判定, 这里只挡"没给值"——
    // 在这里再列一遍允许的类型, 就是第二份规则, 而两份规则必然漂移
    if (!('value' in payload)) throw new HttpError('bad-request', '缺 value')
    // 带了 path = 只改组合配置里的那一格 (从磁盘上的当前值出发)。
    // 不带 = 写整值, 与以前完全一样
    return shape(await svc.set(entry.scope, entry.name, payload.value, pathOf(payload.path)))
  })

  op('config.unset', async (payload) => {
    const svc = needConfig(ctx)
    const entry = declared(svc, payload.key)
    return shape(await svc.unset(entry.scope, entry.name))
  })

  // ── 本机 API Key ─────────────────────────────────────
  // 只收发“引用名 + 是否存在”，永远不把已保存的明文回传给浏览器。
  op('credential.status', (payload) => {
    const svc = needCredentials(ctx)
    const ref = typeof payload.ref === 'string' ? payload.ref.trim() : ''
    if (!ref) return { refs: svc.list() }
    return { ref, present: svc.has(ref) }
  })

  op('credential.set', async (payload) => {
    const svc = needCredentials(ctx)
    const ref = String(payload.ref ?? '').trim()
    const value = String(payload.value ?? '')
    if (!ref) throw new HttpError('bad-request', '缺 ref')
    if (!value.trim()) throw new HttpError('bad-request', 'API Key 不能为空')
    await svc.set(ref, value)
    return { ref, present: true }
  })

  op('credential.unset', async (payload) => {
    const svc = needCredentials(ctx)
    const ref = String(payload.ref ?? '').trim()
    if (!ref) throw new HttpError('bad-request', '缺 ref')
    await svc.unset(ref)
    return { ref, present: false }
  })

  // ── 插件状态图 ────────────────────────────────────────
  op('plugin.graph', () => {
    const graph = ctx.get<{ toJSON(): unknown }>('graph')
    if (!graph) throw new HttpError('no-capability', '状态图未挂载', 503)
    return graph.toJSON()
  })

  return () => {
    for (const off of offs.reverse()) off()
  }
}

function jobHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof JobError) {
    const status = err.code === JOBS_CODE.UNKNOWN ? 404 : err.code === JOBS_CODE.FORBIDDEN ? 403 : err.code === JOBS_CODE.LIMIT ? 409 : 400
    return new HttpError(status === 404 ? 'not-found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'bad-request', err.message, status)
  }
  return new HttpError('bad-request', err instanceof Error ? err.message : String(err))
}

function need<T>(ctx: Ctx, name: string): T {
  const service = ctx.get<T>(name)
  if (!service) throw new HttpError('no-capability', `能力面 ${name} 未装载`, 503)
  return service
}

/** 配置层是**可选**的: 没有它设置页只是没得改, 不该让整页 500 */
function needConfig(ctx: Ctx): ConfigService {
  const service = ctx.get<ConfigService>('config')
  if (!service) throw new HttpError('no-capability', '配置层未装载 (缺 plugins/config-local)', 503)
  return service
}

function needCredentials(ctx: Ctx): CredentialService {
  const service = getCredentials(ctx)
  if (!service) throw new HttpError('no-capability', '本机凭据库未装载 (缺 plugins/config-local)', 503)
  return service
}

/** 按**全名**找已声明的项, 拿它拆出来的 (scope, name) —— 不猜点号怎么切 */
function declared(svc: ConfigService, raw: unknown) {
  const key = String(raw ?? '')
  if (!key) throw new HttpError('bad-request', '缺 key')
  const entry = svc.list().find((e) => e.key === key)
  if (!entry) throw new HttpError('bad-request', `${key} 不是已声明的配置项`, 400)
  return entry
}

function shape(result: ConfigWriteResult) {
  return { entry: result.entry, scopeEntries: result.scopeEntries }
}

/**
 * `config.set` 的 `path`: 只改组合配置里的一格。
 *
 * 为什么要在这一层挡而不是交给下面: 下面只认 `(scope, key, value, path)` 四件,
 * 一个 `path: 'zai.baseURL'` (字符串) 传下去会被当成"没有 path" —— 于是
 * **整张路由表被这一格的值替换掉**。那是静默的数据删除, 比 400 难查一万倍。
 *
 * 数组下标也允许 (改列表里的第 n 项), 但每一段必须是字符串或数字:
 * 数字字符串 `'0'` 按对象键处理, JS 里对数组也成立。
 */
function pathOf(raw: unknown): Array<string | number> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError('bad-request', 'path 必须是非空数组, 如 ["zai", "baseURL"]')
  }
  return raw.map((seg: unknown) => {
    if (typeof seg === 'number' && Number.isFinite(seg)) return seg
    if (typeof seg === 'string' && seg !== '') return seg
    throw new HttpError('bad-request', 'path 的每一段必须是非空字符串或数字')
  })
}
