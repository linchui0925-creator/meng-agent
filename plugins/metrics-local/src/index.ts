import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Ctx, Disposer } from '@meng/core'
import type { SessionEvent, SessionService } from '@meng/session'
import { HttpError, type WebService } from '@meng/web'

export const name = 'meng-plugin-metrics-local'
export const inject = ['session']

export interface Config {
  dir?: string
  file?: string
}

export interface RunMetric {
  runId: string
  sessionId: string
  mode: string
  model?: string
  status: string
  startedAt: number
  finishedAt: number
  durationMs: number
  ttftMs?: number
  modelTurns: number
  toolCalls: number
  blockedCalls: number
  failedCalls: number
  duplicateReads: number
  noProgressCalls: number
  noProgressRatio: number
  completed: number
}

export function deriveRunMetric(events: readonly SessionEvent[], sessionId: string, runId: string): RunMetric | undefined {
  const turn = events.find((event) => {
    if (event.sessionId !== sessionId || event.type !== 'turn/started') return false
    return (event.data as { runId?: unknown }).runId === runId
  })
  const ended = events.find((event) => {
    if (event.sessionId !== sessionId || event.type !== 'turn/ended') return false
    return (event.data as { runId?: unknown }).runId === runId
  })
  if (!turn || !ended) return undefined
  const runEvents = events.filter((event) => {
    if (event.sessionId !== sessionId) return false
    const id = (event.data as { runId?: unknown } | undefined)?.runId
    return id === runId
  })
  const turnData = turn.data as { taskRoute?: { mode?: unknown }; model?: unknown }
  const mode = typeof turnData.taskRoute?.mode === 'string' ? turnData.taskRoute.mode : 'unknown'
  const llm = runEvents.filter((event) => event.type === 'llm/completed')
  const firstTextAt = llm
    .map((event) => (event.data as { firstTextAt?: unknown }).firstTextAt)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const model = [...llm].reverse()
    .map((event) => (event.data as { model?: unknown }).model)
    .find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const calls = runEvents.filter((event) => event.type === 'tool/called')
  const blockedCalls = runEvents.filter((event) => event.type === 'tool/blocked').length
  const failedCalls = runEvents.filter((event) =>
    event.type === 'tool/completed' && (event.data as { ok?: unknown }).ok === false
  ).length
  const readCounts = new Map<string, number>()
  for (const event of calls) {
    const data = event.data as { tool?: unknown; args?: unknown }
    if (data.tool !== 'read' || !data.args || typeof data.args !== 'object') continue
    const file = (data.args as { file_path?: unknown }).file_path
    if (typeof file !== 'string' || !file.trim()) continue
    readCounts.set(file, (readCounts.get(file) ?? 0) + 1)
  }
  const duplicateReads = [...readCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const noProgressCalls = blockedCalls + failedCalls + duplicateReads
  const status = String((ended.data as { reason?: unknown }).reason ?? 'unknown')
  const durationMs = Math.max(0, ended.at - turn.at)
  const ttftMs = firstTextAt === undefined ? undefined : Math.max(0, firstTextAt - turn.at)
  return {
    runId,
    sessionId,
    mode,
    ...(model ? { model } : {}),
    status,
    startedAt: turn.at,
    finishedAt: ended.at,
    durationMs,
    ...(ttftMs === undefined ? {} : { ttftMs }),
    modelTurns: llm.length,
    toolCalls: calls.length,
    blockedCalls,
    failedCalls,
    duplicateReads,
    noProgressCalls,
    noProgressRatio: calls.length === 0 ? 0 : noProgressCalls / calls.length,
    completed: status === 'stop' ? 1 : 0,
  }
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  if (!session) throw new Error('metrics-local 需要 session')
  const file = config.file ?? join(config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng', 'metrics.db')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists run_metrics (
      run_id text primary key,
      session_id text not null,
      mode text not null,
      model text,
      status text not null,
      started_at integer not null,
      finished_at integer not null,
      duration_ms integer not null,
      ttft_ms integer,
      model_turns integer not null,
      tool_calls integer not null,
      blocked_calls integer not null,
      failed_calls integer not null,
      duplicate_reads integer not null,
      no_progress_calls integer not null,
      no_progress_ratio real not null,
      completed integer not null
    );
    create index if not exists run_metrics_finished on run_metrics(finished_at desc);
  `)
  const insert = db.prepare(`
    insert or replace into run_metrics (
      run_id, session_id, mode, model, status, started_at, finished_at, duration_ms,
      ttft_ms, model_turns, tool_calls, blocked_calls, failed_calls, duplicate_reads,
      no_progress_calls, no_progress_ratio, completed
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const offEvent = ctx.on('session/event', (event: SessionEvent) => {
    if (event.type !== 'turn/ended') return
    const runId = (event.data as { runId?: unknown }).runId
    if (typeof runId !== 'string' || !runId) return
    const metric = deriveRunMetric(session.read(event.sessionId), event.sessionId, runId)
    if (!metric) return
    insert.run(
      metric.runId,
      metric.sessionId,
      metric.mode,
      metric.model ?? null,
      metric.status,
      metric.startedAt,
      metric.finishedAt,
      metric.durationMs,
      metric.ttftMs ?? null,
      metric.modelTurns,
      metric.toolCalls,
      metric.blockedCalls,
      metric.failedCalls,
      metric.duplicateReads,
      metric.noProgressCalls,
      metric.noProgressRatio,
      metric.completed,
    )
  })

  const webOffs: Disposer[] = []
  let boundWeb: WebService | undefined
  const bindWeb = (web: WebService): void => {
    if (boundWeb === web) return
    boundWeb = web
    webOffs.push(web.op('metrics.summary', (payload) => summary(db, clampLimit(payload.limit, 100))))
    webOffs.push(web.op('metrics.recent', (payload) => ({ runs: recent(db, clampLimit(payload.limit, 20)) })))
  }
  const existingWeb = ctx.get<WebService>('web')
  if (existingWeb) bindWeb(existingWeb)
  const offRegistered = ctx.on('capability/registered', (capability: string, value: unknown) => {
    if (capability === 'web') bindWeb(value as WebService)
  })
  const offUnregistered = ctx.on('capability/unregistered', (capability: string) => {
    if (capability !== 'web') return
    for (const off of webOffs.splice(0).reverse()) off()
    boundWeb = undefined
  })

  return () => {
    offUnregistered()
    offRegistered()
    offEvent()
    for (const off of webOffs.splice(0).reverse()) off()
    db.close()
  }
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(1000, n))
}

function recent(db: DatabaseSync, limit: number): RunMetric[] {
  const rows = db.prepare(`
    select * from run_metrics order by finished_at desc limit ?
  `).all(limit) as Array<Record<string, unknown>>
  return rows.map(rowOf)
}

function summary(db: DatabaseSync, limit: number): Record<string, unknown> {
  const rows = recent(db, limit)
  const latest = rows.slice(0, Math.max(1, Math.min(20, Math.ceil(rows.length / 2))))
  const previous = rows.slice(latest.length)
  const aggregate = aggregateRows(rows)
  return {
    sampleSize: rows.length,
    ...aggregate,
    current: aggregateRows(latest),
    previous: previous.length ? aggregateRows(previous) : null,
    delta: previous.length ? deltaOf(aggregateRows(latest), aggregateRows(previous)) : null,
    byMode: modeAggregates(rows),
  }
}

function aggregateRows(rows: readonly RunMetric[]): Record<string, number | null> {
  if (rows.length === 0) {
    return {
      avgTtftMs: null,
      avgDurationMs: null,
      avgToolCalls: 0,
      avgModelTurns: 0,
      duplicateReads: 0,
      noProgressRatio: 0,
      completionRate: 0,
    }
  }
  const ttfts = rows.flatMap((row) => row.ttftMs === undefined ? [] : [row.ttftMs])
  return {
    avgTtftMs: ttfts.length ? Math.round(avg(ttfts)) : null,
    avgDurationMs: Math.round(avg(rows.map((row) => row.durationMs))),
    avgToolCalls: round(avg(rows.map((row) => row.toolCalls))),
    avgModelTurns: round(avg(rows.map((row) => row.modelTurns))),
    duplicateReads: rows.reduce((sum, row) => sum + row.duplicateReads, 0),
    noProgressRatio: round(avg(rows.map((row) => row.noProgressRatio))),
    completionRate: round(avg(rows.map((row) => row.completed))),
  }
}

function deltaOf(current: Record<string, number | null>, previous: Record<string, number | null>): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const key of Object.keys(current)) {
    const a = current[key]
    const b = previous[key]
    out[key] = a === undefined || b === undefined || a === null || b === null ? null : round(a - b)
  }
  return out
}

function modeAggregates(rows: readonly RunMetric[]): Record<string, Record<string, number | null>> {
  const groups = new Map<string, RunMetric[]>()
  for (const row of rows) {
    const list = groups.get(row.mode)
    if (list) list.push(row)
    else groups.set(row.mode, [row])
  }
  return Object.fromEntries([...groups.entries()].map(([mode, list]) => [mode, aggregateRows(list)]))
}

function rowOf(row: Record<string, unknown>): RunMetric {
  return {
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    mode: String(row.mode),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    status: String(row.status),
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    durationMs: Number(row.duration_ms),
    ...(typeof row.ttft_ms === 'number' ? { ttftMs: row.ttft_ms } : {}),
    modelTurns: Number(row.model_turns),
    toolCalls: Number(row.tool_calls),
    blockedCalls: Number(row.blocked_calls),
    failedCalls: Number(row.failed_calls),
    duplicateReads: Number(row.duplicate_reads),
    noProgressCalls: Number(row.no_progress_calls),
    noProgressRatio: Number(row.no_progress_ratio),
    completed: Number(row.completed),
  }
}

function avg(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
