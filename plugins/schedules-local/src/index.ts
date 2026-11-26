/**
 * 定时任务执行器。任务定义落在 `.meng/schedules.json`，到点后新建一条会话并运行。
 *
 * 刻意不复用 jobs：jobs 管的是有输出、可停止的进程；定时任务管的是“到点让梦做一件事”，
 * 它最终产生一条普通会话。两套生命周期混在一起会让“停止”含义变得不清楚。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { LoopService } from '@meng/loop'
import type { SessionService } from '@meng/session'
import { HttpError, type WebService } from '@meng/web'
import { nextRunAt, parseClock, type Recurrence } from './time.ts'

export const name = 'meng-plugin-schedules-local'
export const inject = ['session', 'loop', 'web']

type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'missed'

interface ScheduleRun {
  id: string
  at: number
  sessionId: string
  status: RunStatus
  finishedAt?: number
  error?: string
}

interface Schedule {
  id: string
  title: string
  prompt: string
  recurrence: Recurrence
  time?: string
  weekday?: number
  dayOfMonth?: number
  runAt?: number
  workspace?: string
  model?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: RunStatus
  lastError?: string
  runs: ScheduleRun[]
}

export interface SchedulesConfig {
  dir?: string
  tickMs?: number
}

const RECURRENCES = new Set<Recurrence>(['once', 'daily', 'weekdays', 'weekly', 'monthly'])
const MAX_RUNS = 20

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readStore(file: string): Schedule[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Schedule => {
      const one = item as Partial<Schedule>
      return typeof one.id === 'string' && typeof one.title === 'string' && typeof one.prompt === 'string'
    })
  } catch (err) {
    console.error(`[schedules] 读取失败，按空列表启动: ${errText(err)}`)
    return []
  }
}

function writeStore(file: string, schedules: readonly Schedule[]): void {
  const text = `${JSON.stringify(schedules, null, 2)}\n`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function validateBase(input: Partial<Schedule>): Omit<Schedule, 'id' | 'createdAt' | 'updatedAt' | 'runs'> {
  const title = String(input.title ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  if (!title) throw new HttpError('bad-request', '缺任务标题')
  if (!prompt) throw new HttpError('bad-request', '缺任务内容')
  if (title.length > 120) throw new HttpError('bad-request', '任务标题最多 120 字')
  if (prompt.length > 20_000) throw new HttpError('bad-request', '任务内容最多 20000 字')
  const recurrence = String(input.recurrence ?? 'daily') as Recurrence
  if (!RECURRENCES.has(recurrence)) throw new HttpError('bad-request', '不支持的重复规则')

  if (recurrence === 'once') {
    if (typeof input.runAt !== 'number' || !Number.isFinite(input.runAt)) throw new HttpError('bad-request', '一次性任务需要运行时间')
  } else if (parseClock(input.time) === undefined) {
    throw new HttpError('bad-request', '重复任务需要 HH:mm 格式的运行时间')
  }
  if (recurrence === 'weekly') {
    if (!Number.isInteger(input.weekday) || (input.weekday ?? -1) < 0 || (input.weekday ?? 7) > 6) {
      throw new HttpError('bad-request', '每周任务需要 0–6 的星期值')
    }
  }
  if (recurrence === 'monthly') {
    if (!Number.isInteger(input.dayOfMonth) || (input.dayOfMonth ?? 0) < 1 || (input.dayOfMonth ?? 32) > 31) {
      throw new HttpError('bad-request', '每月任务需要 1–31 的日期')
    }
  }
  const workspace = typeof input.workspace === 'string' && input.workspace.trim() !== '' ? input.workspace.trim() : undefined
  if (workspace !== undefined && (!existsSync(workspace) || !statSync(workspace).isDirectory())) {
    throw new HttpError('bad-request', `工作区不存在: ${workspace}`)
  }
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) throw new HttpError('bad-request', '定时任务必须选择运行模型，不能让它偷偷回落到第一家供应商')
  return {
    title,
    prompt,
    recurrence,
    ...(typeof input.time === 'string' && input.time !== '' ? { time: input.time } : {}),
    ...(typeof input.weekday === 'number' ? { weekday: input.weekday } : {}),
    ...(typeof input.dayOfMonth === 'number' ? { dayOfMonth: input.dayOfMonth } : {}),
    ...(typeof input.runAt === 'number' ? { runAt: input.runAt } : {}),
    ...(workspace === undefined ? {} : { workspace }),
    model,
    enabled: input.enabled !== false,
  }
}

export function apply(ctx: Ctx, config: SchedulesConfig = {}): Disposer {
  const dir = config.dir ?? '.meng'
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'schedules.json')
  const schedules = readStore(file)
  const running = new Set<string>()
  const controllers = new Map<string, AbortController>()
  const session = () => {
    const service = ctx.get<SessionService>('session')
    if (!service) throw new HttpError('no-capability', '会话能力未装载', 503)
    return service
  }
  const loop = () => {
    const service = ctx.get<LoopService>('loop')
    if (!service) throw new HttpError('no-capability', '对话循环未装载', 503)
    return service
  }
  const web = () => {
    const service = ctx.get<WebService>('web')
    if (!service) throw new HttpError('no-capability', '网页能力未装载', 503)
    return service
  }

  const save = () => writeStore(file, schedules)
  const publicSchedule = (schedule: Schedule): Schedule => ({ ...schedule, runs: schedule.runs.slice(0, MAX_RUNS) })

  function recompute(schedule: Schedule, from = Date.now()): void {
    schedule.nextRunAt = schedule.enabled ? nextRunAt(schedule, from) : undefined
  }

  // 上次进程退出时还在 running 的记录不可能真的还活着，启动时明确收口。
  for (const schedule of schedules) {
    for (const run of schedule.runs) {
      if (run.status !== 'running') continue
      run.status = 'failed'
      run.finishedAt = Date.now()
      run.error = '梦重启时任务被中断'
    }
    const runningRun = schedule.runs.find((run) => run.status === 'running')
    if (runningRun) {
      schedule.lastStatus = 'failed'
      schedule.lastError = runningRun.error
    }
    if (schedule.recurrence === 'once' && schedule.enabled && (schedule.runAt ?? 0) <= Date.now()) {
      schedule.enabled = false
      schedule.lastStatus = 'missed'
      schedule.lastError = '梦停机期间错过了运行时间'
    }
    recompute(schedule)
  }
  save()

  async function startRun(schedule: Schedule): Promise<{ sessionId: string }> {
    if (running.has(schedule.id)) throw new HttpError('conflict', '这个任务正在运行', 409)
    if (!schedule.model?.trim()) {
      throw new HttpError('bad-request', '定时任务还没有选择运行模型，请到任务中心编辑并选择模型')
    }
    const sessionId = randomUUID().slice(0, 8)
    const runId = randomUUID().slice(0, 8)
    const now = Date.now()
    const ctrl = new AbortController()
    running.add(schedule.id)
    controllers.set(schedule.id, ctrl)
    const run: ScheduleRun = { id: runId, at: now, sessionId, status: 'running' }
    schedule.runs.unshift(run)
    schedule.runs = schedule.runs.slice(0, MAX_RUNS)
    schedule.lastRunAt = now
    schedule.lastStatus = 'running'
    schedule.lastError = undefined
    if (schedule.recurrence === 'once') {
      schedule.enabled = false
      schedule.nextRunAt = undefined
    } else {
      recompute(schedule, now)
    }
    save()

    session().append(sessionId, 'session/created', {
      title: `定时任务 · ${schedule.title}`,
      ...(schedule.workspace ? { workspace: schedule.workspace } : {}),
    })

    void (async () => {
      let final: RunStatus = 'completed'
      let failure: string | undefined
      try {
        for await (const event of loop().run({
          sessionId,
          text: schedule.prompt,
          model: schedule.model,
          runId,
          signal: ctrl.signal,
        })) {
          if (event.type === 'text') {
            web().broadcast('llm/chunk', { delta: event.text, runId }, { sessionId, runId })
          }
          if (event.type === 'done' && event.reason !== 'stop') {
            final = event.reason === 'aborted' ? 'aborted' : 'failed'
            failure = event.error ?? `本轮以 ${event.reason} 结束`
          }
        }
      } catch (err) {
        final = ctrl.signal.aborted ? 'aborted' : 'failed'
        failure = errText(err)
        web().broadcast('error', { code: 'internal', message: failure, runId }, { sessionId, runId })
      } finally {
        run.status = final
        run.finishedAt = Date.now()
        if (failure) run.error = failure
        schedule.lastStatus = final
        schedule.lastError = failure
        running.delete(schedule.id)
        controllers.delete(schedule.id)
        save()
      }
    })()

    return { sessionId }
  }

  const offs: Disposer[] = []
  const op = (name: string, handler: (payload: Record<string, unknown>) => unknown | Promise<unknown>) => {
    offs.push(web().op(name, handler))
  }

  op('schedule.list', () => schedules
    .map(publicSchedule)
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER)
    }))

  op('schedule.create', (payload) => {
    const base = validateBase(payload as Partial<Schedule>)
    const now = Date.now()
    const schedule: Schedule = {
      id: randomUUID().slice(0, 10),
      ...base,
      createdAt: now,
      updatedAt: now,
      runs: [],
    }
    recompute(schedule)
    if (schedule.enabled && schedule.nextRunAt === undefined) {
      throw new HttpError('bad-request', '这个时间已经过去，请重新选择')
    }
    schedules.push(schedule)
    save()
    return publicSchedule(schedule)
  })

  op('schedule.update', (payload) => {
    const id = String(payload.id ?? '')
    const schedule = schedules.find((item) => item.id === id)
    if (!schedule) throw new HttpError('not-found', '任务不存在', 404)
    const merged = { ...schedule, ...payload, runs: schedule.runs, id: schedule.id, createdAt: schedule.createdAt }
    const base = validateBase(merged)
    Object.assign(schedule, base, { updatedAt: Date.now() })
    recompute(schedule)
    if (schedule.enabled && schedule.nextRunAt === undefined) throw new HttpError('bad-request', '这个时间已经过去，请重新选择')
    save()
    return publicSchedule(schedule)
  })

  op('schedule.toggle', (payload) => {
    const id = String(payload.id ?? '')
    const schedule = schedules.find((item) => item.id === id)
    if (!schedule) throw new HttpError('not-found', '任务不存在', 404)
    schedule.enabled = payload.enabled === true
    schedule.updatedAt = Date.now()
    recompute(schedule)
    if (schedule.enabled && schedule.nextRunAt === undefined) {
      schedule.enabled = false
      throw new HttpError('bad-request', '这个一次性任务的时间已经过去，请编辑后再启用')
    }
    save()
    return publicSchedule(schedule)
  })

  op('schedule.delete', (payload) => {
    const id = String(payload.id ?? '')
    const index = schedules.findIndex((item) => item.id === id)
    if (index < 0) throw new HttpError('not-found', '任务不存在', 404)
    if (running.has(id)) throw new HttpError('conflict', '任务正在运行，先停止或等它结束', 409)
    schedules.splice(index, 1)
    save()
    return { ok: true }
  })

  op('schedule.runNow', async (payload) => {
    const id = String(payload.id ?? '')
    const schedule = schedules.find((item) => item.id === id)
    if (!schedule) throw new HttpError('not-found', '任务不存在', 404)
    return { ok: true, ...(await startRun(schedule)) }
  })

  op('schedule.cancelRun', (payload) => {
    const id = String(payload.id ?? '')
    const ctrl = controllers.get(id)
    if (!ctrl) throw new HttpError('conflict', '任务没有在运行', 409)
    ctrl.abort()
    return { ok: true }
  })

  op('schedule.history', () => schedules
    .flatMap((schedule) => schedule.runs.map((run) => ({ scheduleId: schedule.id, title: schedule.title, ...run })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 100))

  const tick = () => {
    const now = Date.now()
    for (const schedule of schedules) {
      if (!schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      if (running.has(schedule.id)) continue
      void startRun(schedule).catch((err) => {
        schedule.lastStatus = 'failed'
        schedule.lastError = errText(err)
        save()
      })
    }
  }
  const timer = setInterval(tick, config.tickMs ?? 5000)
  if (typeof timer.unref === 'function') timer.unref()
  offs.push(() => clearInterval(timer))
  offs.push(() => {
    for (const ctrl of controllers.values()) ctrl.abort()
    controllers.clear()
  })

  return () => {
    for (const off of offs.reverse()) off()
  }
}

export const invariant = defineInvariant('@meng/plugin-schedules-local', [
  {
    id: 'ops-registered',
    run(ctx) {
      const web = ctx.get<WebService>('web')
      if (!web) throw new Error('schedules-local 缺少 web 能力面')
      for (const name of ['schedule.list', 'schedule.create', 'schedule.update', 'schedule.toggle', 'schedule.runNow', 'schedule.cancelRun', 'schedule.delete', 'schedule.history']) {
        if (!web.ops().includes(name)) throw new Error(`schedules-local 没注册 ${name}`)
      }
    },
  },
])
