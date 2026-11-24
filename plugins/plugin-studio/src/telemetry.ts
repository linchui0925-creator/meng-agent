import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type PluginEventType = 'install' | 'update' | 'uninstall' | 'worker-crash' | 'feedback'

export interface PluginEvent {
  type: PluginEventType
  at: number
  pluginId: string
  version?: string
  channel?: string
  compatible?: 'ok' | 'broken' | 'unknown'
  rating?: number
  note?: string
  error?: string
}

export interface TelemetrySummary {
  installs: number
  updates: number
  uninstalls: number
  workerCrashes: number
  feedback: number
  averageRating?: number
  compatibility: { ok: number; broken: number; unknown: number }
  byPlugin: Record<string, number>
}

const MAX_NOTE = 2000
const EVENT_TYPES = new Set<PluginEventType>(['install', 'update', 'uninstall', 'worker-crash', 'feedback'])

export class LocalPluginTelemetry {
  readonly file: string

  constructor(directory: string) {
    this.file = join(resolve(directory), 'telemetry.jsonl')
  }

  record(event: Omit<PluginEvent, 'at'> & { at?: number }): PluginEvent {
    if (!event.pluginId.trim()) throw new Error('telemetry.pluginId 不能为空')
    if (!EVENT_TYPES.has(event.type)) throw new Error(`未知遥测事件: ${event.type}`)
    if (event.rating !== undefined && (!Number.isFinite(event.rating) || event.rating < 1 || event.rating > 5)) {
      throw new Error('遥测 rating 必须是 1-5')
    }
    const clean: PluginEvent = {
      ...event,
      at: event.at ?? Date.now(),
      pluginId: event.pluginId.trim(),
      ...(event.note ? { note: event.note.slice(0, MAX_NOTE) } : {}),
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    const previous = existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''
    writeFileSync(tmp, `${previous}${JSON.stringify(clean)}\n`)
    renameSync(tmp, this.file)
    return clean
  }

  list(limit = 200, pluginId?: string): PluginEvent[] {
    if (!existsSync(this.file)) return []
    const events = readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as PluginEvent] } catch { return [] }
      })
      .filter((event) => !pluginId || event.pluginId === pluginId)
    return events.slice(-Math.max(0, limit))
  }

  summary(pluginId?: string): TelemetrySummary {
    const events = this.list(10_000, pluginId)
    const summary: TelemetrySummary = {
      installs: 0,
      updates: 0,
      uninstalls: 0,
      workerCrashes: 0,
      feedback: 0,
      compatibility: { ok: 0, broken: 0, unknown: 0 },
      byPlugin: {},
    }
    let ratingTotal = 0
    let ratingCount = 0
    for (const event of events) {
      summary.byPlugin[event.pluginId] = (summary.byPlugin[event.pluginId] ?? 0) + 1
      if (event.type === 'install') summary.installs++
      else if (event.type === 'update') summary.updates++
      else if (event.type === 'uninstall') summary.uninstalls++
      else if (event.type === 'worker-crash') summary.workerCrashes++
      else if (event.type === 'feedback') {
        summary.feedback++
        if (event.rating !== undefined) {
          ratingTotal += event.rating
          ratingCount++
        }
        const compatibility = event.compatible ?? 'unknown'
        summary.compatibility[compatibility]++
      }
    }
    if (ratingCount > 0) summary.averageRating = Number((ratingTotal / ratingCount).toFixed(2))
    return summary
  }
}
