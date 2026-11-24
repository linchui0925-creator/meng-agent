export type ScheduleRecurrence = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type ScheduleRunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'missed'

export interface ScheduleRun {
  id: string
  at: number
  sessionId: string
  status: ScheduleRunStatus
  finishedAt?: number
  error?: string
}

export interface ScheduleRecord {
  id: string
  title: string
  prompt: string
  recurrence: ScheduleRecurrence
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
  lastStatus?: ScheduleRunStatus
  lastError?: string
  runs: ScheduleRun[]
}

export interface ScheduleGroup {
  key: 'today' | 'tomorrow' | 'week' | 'later' | 'paused'
  label: string
  items: ScheduleRecord[]
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function recurrenceLabel(schedule: Pick<ScheduleRecord, 'recurrence' | 'time' | 'weekday' | 'dayOfMonth'>): string {
  switch (schedule.recurrence) {
    case 'once':
      return '仅一次'
    case 'daily':
      return `每天 ${schedule.time ?? ''}`.trim()
    case 'weekdays':
      return `工作日 ${schedule.time ?? ''}`.trim()
    case 'weekly':
      return `每${WEEKDAYS[schedule.weekday ?? 1]} ${schedule.time ?? ''}`.trim()
    case 'monthly':
      return `每月 ${schedule.dayOfMonth ?? 1} 日 ${schedule.time ?? ''}`.trim()
  }
}

export function formatScheduleTime(value: number | undefined, now = Date.now()): string {
  if (value === undefined) return '未安排'
  const date = new Date(value)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay(date, today)) return `今天 ${clock}`
  if (sameDay(date, tomorrow)) return `明天 ${clock}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`
}

export function groupSchedules(schedules: readonly ScheduleRecord[], now = Date.now()): ScheduleGroup[] {
  const groups: ScheduleGroup[] = [
    { key: 'today', label: '今天', items: [] },
    { key: 'tomorrow', label: '明天', items: [] },
    { key: 'week', label: '本周', items: [] },
    { key: 'later', label: '更晚', items: [] },
    { key: 'paused', label: '已暂停', items: [] },
  ]
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  for (const schedule of schedules) {
    if (!schedule.enabled) {
      groups[4]!.items.push(schedule)
      continue
    }
    const next = schedule.nextRunAt
    if (next === undefined) {
      groups[3]!.items.push(schedule)
      continue
    }
    const target = new Date(next)
    target.setHours(0, 0, 0, 0)
    const days = Math.round((target.getTime() - start.getTime()) / 86_400_000)
    if (days <= 0) groups[0]!.items.push(schedule)
    else if (days === 1) groups[1]!.items.push(schedule)
    else if (days <= 7) groups[2]!.items.push(schedule)
    else groups[3]!.items.push(schedule)
  }
  for (const group of groups) {
    group.items.sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
  }
  return groups.filter((group) => group.items.length > 0)
}

export function scheduleStatusLabel(schedule: ScheduleRecord): string {
  if (!schedule.enabled) return '已暂停'
  if (schedule.lastStatus === 'running') return '正在运行'
  if (schedule.lastStatus === 'failed') return '上次失败'
  if (schedule.lastStatus === 'missed') return '错过运行'
  return '已启用'
}
