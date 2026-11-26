import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'

import type { ComposerModelGroup } from './layout.ts'
import type { Workspace } from './workspaces.ts'
import {
  formatScheduleTime,
  groupSchedules,
  recurrenceLabel,
  scheduleStatusLabel,
  type ScheduleRecord,
  type ScheduleRecurrence,
} from './schedule.ts'
import styles from './TaskCenter.module.css'

type Invoke = <T = unknown>(op: string, payload?: unknown) => Promise<T>

interface FormState {
  title: string
  prompt: string
  recurrence: ScheduleRecurrence
  time: string
  weekday: number
  dayOfMonth: number
  runAtLocal: string
  workspace: string
  model: string
}

function initialForm(model?: string): FormState {
  const tomorrow = new Date()
  tomorrow.setHours(9, 0, 0, 0)
  if (tomorrow.getTime() <= Date.now()) tomorrow.setDate(tomorrow.getDate() + 1)
  return {
    title: '',
    prompt: '',
    recurrence: 'daily',
    time: '09:00',
    weekday: 1,
    dayOfMonth: 1,
    runAtLocal: localInput(tomorrow.getTime()),
    workspace: '',
    model: model ?? '',
  }
}

function localInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function TaskCenter({
  invoke,
  workspaces,
  model,
  modelGroups,
  onOpenSession,
}: {
  invoke: Invoke
  workspaces: readonly Workspace[]
  model?: string
  modelGroups?: readonly ComposerModelGroup[]
  onOpenSession: (sessionId: string) => void
}) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [form, setForm] = useState<FormState>(() => initialForm(model))
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string }>()

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const list = await invoke<ScheduleRecord[]>('schedule.list')
      setSchedules(Array.isArray(list) ? list : [])
      setError(undefined)
    } catch (err) {
      setError(errText(err))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [invoke])

  useEffect(() => {
    let alive = true
    void refresh()
    const timer = window.setInterval(() => {
      if (alive) void refresh(true)
    }, 10_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const groups = useMemo(() => groupSchedules(schedules), [schedules])

  useEffect(() => {
    if (editingId !== undefined) return
    setForm((current) => current.model || !model ? current : { ...current, model })
  }, [editingId, model])

  function patch(next: Partial<FormState>): void {
    setForm((current) => ({ ...current, ...next }))
    setNotice(undefined)
  }

  function edit(schedule: ScheduleRecord): void {
    setEditingId(schedule.id)
    setForm({
      title: schedule.title,
      prompt: schedule.prompt,
      recurrence: schedule.recurrence,
      time: schedule.time ?? '09:00',
      weekday: schedule.weekday ?? 1,
      dayOfMonth: schedule.dayOfMonth ?? 1,
      runAtLocal: localInput(schedule.runAt ?? Date.now() + 3_600_000),
      workspace: schedule.workspace ?? '',
      model: schedule.model ?? model ?? '',
    })
    setNotice(undefined)
  }

  function resetForm(): void {
    setEditingId(undefined)
    setForm(initialForm())
    setNotice(undefined)
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    if (!form.title.trim() || !form.prompt.trim()) {
      setNotice({ tone: 'error', text: '任务名称和任务内容都不能为空' })
      return
    }
    if (!form.model.trim()) {
      setNotice({ tone: 'error', text: '请选择定时任务运行时使用的模型' })
      return
    }
    const payload = {
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      recurrence: form.recurrence,
      ...(form.workspace ? { workspace: form.workspace } : {}),
      model: form.model.trim(),
      ...(form.recurrence === 'once'
        ? { runAt: new Date(form.runAtLocal).getTime() }
        : { time: form.time }),
      ...(form.recurrence === 'weekly' ? { weekday: form.weekday } : {}),
      ...(form.recurrence === 'monthly' ? { dayOfMonth: form.dayOfMonth } : {}),
      enabled: editingId ? (schedules.find((item) => item.id === editingId)?.enabled ?? true) : true,
    }
    setBusy(true)
    setNotice(undefined)
    try {
      if (editingId) await invoke('schedule.update', { id: editingId, ...payload })
      else await invoke('schedule.create', payload)
      await refresh(true)
      resetForm()
      setNotice({ tone: 'ok', text: editingId ? '任务已更新' : '任务已创建并启用' })
    } catch (err) {
      setNotice({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function runNow(schedule: ScheduleRecord): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await invoke<{ sessionId: string }>('schedule.runNow', { id: schedule.id })
      await refresh(true)
      if (result?.sessionId) onOpenSession(result.sessionId)
    } catch (err) {
      setNotice({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun(schedule: ScheduleRecord): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      await invoke('schedule.cancelRun', { id: schedule.id })
      await refresh(true)
      setNotice({ tone: 'ok', text: '已请求停止，任务会在当前步骤结束后收起' })
    } catch (err) {
      setNotice({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function toggle(schedule: ScheduleRecord): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      await invoke('schedule.toggle', { id: schedule.id, enabled: !schedule.enabled })
      await refresh(true)
    } catch (err) {
      setNotice({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(schedule: ScheduleRecord): Promise<void> {
    if (confirmDelete !== schedule.id) {
      setConfirmDelete(schedule.id)
      return
    }
    setBusy(true)
    setNotice(undefined)
    try {
      await invoke('schedule.delete', { id: schedule.id })
      setConfirmDelete(undefined)
      if (editingId === schedule.id) resetForm()
      await refresh(true)
    } catch (err) {
      setNotice({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page} data-task-center="">
      <header className={styles.head}>
        <div>
          <h1>定时任务</h1>
          <p>到点后自动新建一条会话并运行。这里不混入当前会话的后台命令。</p>
        </div>
        <button type="button" className={styles.secondary} onClick={() => void refresh()}>刷新</button>
      </header>

      {notice && <div className={styles.notice} data-tone={notice.tone} role="status">{notice.text}</div>}
      {error && (
        <div className={styles.problem} role="alert">
          <strong>读不到定时任务</strong>
          <span>{error}</span>
          <button type="button" className={styles.secondary} onClick={() => void refresh()}>重试</button>
        </div>
      )}

      <div className={styles.layout}>
        <section className={styles.timeline} aria-label="任务时间表">
          {loading && schedules.length === 0 ? (
            <div className={styles.empty}>正在读取任务…</div>
          ) : groups.length === 0 ? (
            <div className={styles.empty}>
              <strong>还没有定时任务</strong>
              <p>在右侧描述要做什么，选一个时间，保存后就会出现在这里。</p>
            </div>
          ) : groups.map((group) => (
            <section key={group.key} className={styles.group} data-schedule-group={group.key}>
              <div className={styles.groupHead}><strong>{group.label}</strong><span>{group.items.length} 个</span></div>
              {group.items.map((schedule) => {
                const lastRun = schedule.runs[0]
                const status = scheduleStatusLabel(schedule)
                return (
                  <article key={schedule.id} className={styles.item} data-schedule-id={schedule.id} data-enabled={schedule.enabled ? '' : undefined}>
                    <div className={styles.rail} aria-hidden="true"><i /></div>
                    <div className={styles.itemMain}>
                      <div className={styles.itemTop}>
                        <div>
                          <h2>{schedule.title}</h2>
                          <p>{recurrenceLabel(schedule)} · {schedule.workspace ? schedule.workspace.split('/').at(-1) : '默认工作区'} · {schedule.model ?? '未指定模型'}</p>
                        </div>
                        <span className={styles.status} data-status={schedule.lastStatus ?? 'scheduled'}>{status}</span>
                      </div>
                      <div className={styles.itemMeta}>
                        <span>下次：{formatScheduleTime(schedule.nextRunAt)}</span>
                        {lastRun && <span>上次：{new Date(lastRun.at).toLocaleString('zh-CN', { hour12: false })}</span>}
                        {schedule.lastError && <span className={styles.errorText}>{schedule.lastError}</span>}
                      </div>
                      <div className={styles.actions}>
                        {schedule.lastStatus === 'running'
                          ? <button type="button" className={styles.dangerLink} disabled={busy} onClick={() => void cancelRun(schedule)}>停止任务</button>
                          : <button type="button" className={styles.primarySmall} disabled={busy} onClick={() => void runNow(schedule)}>立即运行</button>}
                        {lastRun && <button type="button" className={styles.link} onClick={() => onOpenSession(lastRun.sessionId)}>打开上次会话</button>}
                        <button type="button" className={styles.link} onClick={() => edit(schedule)}>编辑</button>
                        <button type="button" className={styles.link} onClick={() => void toggle(schedule)}>{schedule.enabled ? '暂停' : '继续'}</button>
                        <button type="button" className={styles.dangerLink} onClick={() => void remove(schedule)}>{confirmDelete === schedule.id ? '确认删除' : '删除'}</button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </section>
          ))}
        </section>

        <form className={styles.creator} onSubmit={(event) => void save(event)}>
          <div className={styles.creatorHead}>
            <div><strong>{editingId ? '编辑定时任务' : '新建定时任务'}</strong><span>保存后默认启用</span></div>
            {editingId && <button type="button" className={styles.link} onClick={resetForm}>取消编辑</button>}
          </div>

          <label>任务名称<input value={form.title} maxLength={120} placeholder="例如：每日销售汇总" onChange={(e) => patch({ title: e.target.value })} /></label>
          <label>让梦做什么<textarea rows={5} value={form.prompt} placeholder="用自然语言描述任务。例如：整理昨日销售数据，生成简报并标出异常门店。" onChange={(e) => patch({ prompt: e.target.value })} /></label>
          <label>重复规则
            <select value={form.recurrence} onChange={(e) => patch({ recurrence: e.target.value as ScheduleRecurrence })}>
              <option value="once">仅运行一次</option>
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </label>

          {form.recurrence === 'once' ? (
            <label>运行时间<input type="datetime-local" value={form.runAtLocal} onChange={(e) => patch({ runAtLocal: e.target.value })} /></label>
          ) : (
            <label>运行时间<input type="time" value={form.time} onChange={(e) => patch({ time: e.target.value })} /></label>
          )}
          {form.recurrence === 'weekly' && (
            <label>星期
              <select value={form.weekday} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
                {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
          )}
          {form.recurrence === 'monthly' && (
            <label>每月几号<input type="number" min={1} max={31} value={form.dayOfMonth} onChange={(e) => patch({ dayOfMonth: Number(e.target.value) })} /></label>
          )}
          <label>工作区
            <select value={form.workspace} onChange={(e) => patch({ workspace: e.target.value })}>
              <option value="">默认工作区</option>
              {workspaces.map((item) => <option key={item.id} value={item.path}>{item.name}</option>)}
            </select>
          </label>
          <label>运行模型
            <select value={form.model} onChange={(e) => patch({ model: e.target.value })}>
              <option value="">请选择模型</option>
              {(modelGroups ?? []).map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.models.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          <div className={styles.formFoot}>
            <button type="button" className={styles.secondary} onClick={resetForm}>清空</button>
            <button type="submit" className={styles.primary} disabled={busy}>{busy ? '保存中…' : editingId ? '保存修改' : '保存并启用'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
