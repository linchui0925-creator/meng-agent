export type Recurrence = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface ScheduleTimeInput {
  recurrence: Recurrence
  time?: string
  weekday?: number
  dayOfMonth?: number
  runAt?: number
}

export function parseClock(value: string | undefined): { hour: number; minute: number } | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '')
  return match === null ? undefined : { hour: Number(match[1]), minute: Number(match[2]) }
}

function atDate(day: Date, hour: number, minute: number): Date {
  const d = new Date(day)
  d.setHours(hour, minute, 0, 0)
  return d
}

function nextDaily(from: Date, hour: number, minute: number): Date {
  const d = atDate(from, hour, minute)
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1)
  return d
}

function nextWeekday(from: Date, hour: number, minute: number): Date {
  const d = nextDaily(from, hour, minute)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function nextWeekly(from: Date, weekday: number, hour: number, minute: number): Date {
  const d = atDate(from, hour, minute)
  let add = (weekday - d.getDay() + 7) % 7
  if (add === 0 && d.getTime() <= from.getTime()) add = 7
  d.setDate(d.getDate() + add)
  return d
}

function nextMonthly(from: Date, dayOfMonth: number, hour: number, minute: number): Date {
  for (let offset = 0; offset < 24; offset++) {
    const probe = new Date(from.getFullYear(), from.getMonth() + offset, 1, hour, minute, 0, 0)
    const lastDay = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate()
    probe.setDate(Math.min(dayOfMonth, lastDay))
    if (probe.getTime() > from.getTime()) return probe
  }
  throw new Error('无法计算下一次每月执行时间')
}

export function nextRunAt(input: ScheduleTimeInput, from = Date.now()): number | undefined {
  if (input.recurrence === 'once') {
    return input.runAt !== undefined && input.runAt > from ? input.runAt : undefined
  }
  const clock = parseClock(input.time)
  if (clock === undefined) return undefined
  const start = new Date(from)
  let next: Date
  switch (input.recurrence) {
    case 'daily':
      next = nextDaily(start, clock.hour, clock.minute)
      break
    case 'weekdays':
      next = nextWeekday(start, clock.hour, clock.minute)
      break
    case 'weekly':
      next = nextWeekly(start, input.weekday ?? 1, clock.hour, clock.minute)
      break
    case 'monthly':
      next = nextMonthly(start, input.dayOfMonth ?? 1, clock.hour, clock.minute)
      break
    default:
      return undefined
  }
  return next.getTime()
}
