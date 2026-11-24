import { useEffect, useRef, useState } from 'react'

import type { JobRow } from './conversation.ts'
import styles from './JobTray.module.css'

const STATUS_TEXT: Record<JobRow['status'], string> = {
  running: '运行中',
  completed: '已完成',
  killed: '已停止',
  failed: '失败',
}

const KIND_TEXT: Record<string, string> = {
  bash: '后台命令',
  fetch: '网络任务',
  tool: '后台工具',
}

export function JobTray({
  jobs,
  readOutput,
  stop,
}: {
  jobs: JobRow[]
  readOutput: (jobId: string) => Promise<{ text: string; job?: unknown }>
  stop: (jobId: string) => Promise<unknown>
}) {
  const running = jobs.filter((job) => job.status === 'running').length
  const failed = jobs.filter((job) => job.status === 'failed').length
  const previousRunning = useRef(0)
  const [open, setOpen] = useState(running > 0)
  const [busy, setBusy] = useState<string>()
  const [output, setOutput] = useState<{ jobId: string; text: string }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (running > 0) setOpen(true)
    else if (previousRunning.current > 0) setOpen(false)
    previousRunning.current = running
  }, [running])

  if (jobs.length === 0) return null

  const summary = running > 0
    ? `${running} 个任务在后台运行`
    : `${jobs.length} 个后台任务已结束${failed > 0 ? `，${failed} 个失败` : ''}`

  async function view(job: JobRow): Promise<void> {
    if (busy) return
    setBusy(job.id)
    setError(undefined)
    try {
      const result = await readOutput(job.id)
      setOutput({ jobId: job.id, text: result.text || '(暂无新输出)' })
      setOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  async function kill(job: JobRow): Promise<void> {
    if (busy) return
    setBusy(job.id)
    setError(undefined)
    try {
      await stop(job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section className={styles.tray} data-job-tray="" data-open={open ? '' : undefined} aria-label="会话后台任务">
      <button type="button" className={styles.head} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={styles.live} data-running={running > 0 ? '' : undefined} aria-hidden="true" />
        <strong>{summary}</strong>
        <span className={styles.hint}>{running > 0 ? '可以继续聊天' : '任务记录留在本会话'}</span>
        <span className={styles.chevron} aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>

      {open && (
        <div className={styles.body}>
          {jobs.map((job) => (
            <div key={job.id} className={styles.row} data-status={job.status} data-job-id={job.id}>
              <span className={styles.dot} aria-hidden="true" />
              <div className={styles.main}>
                <div className={styles.titleLine}>
                  <strong>{friendlyLabel(job.label)}</strong>
                  <span className={styles.kind}>{KIND_TEXT[job.kind] ?? job.kind}</span>
                </div>
                <div className={styles.meta}>
                  <span>{STATUS_TEXT[job.status]}</span>
                  <span>已运行 {duration(job)}</span>
                  {job.detail && <span>{job.detail}</span>}
                </div>
              </div>
              <div className={styles.actions}>
                <button type="button" disabled={busy === job.id} onClick={() => void view(job)}>
                  {busy === job.id ? '读取中…' : '查看输出'}
                </button>
                {job.status === 'running' && (
                  <button type="button" className={styles.stop} disabled={busy === job.id} onClick={() => void kill(job)}>停止</button>
                )}
              </div>
            </div>
          ))}

          {error && <p className={styles.error} role="alert">{error}</p>}
          {output && (
            <div className={styles.output}>
              <div className={styles.outputHead}>
                <strong>最近输出</strong>
                <button type="button" onClick={() => setOutput(undefined)}>收起</button>
              </div>
              <pre>{output.text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function friendlyLabel(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return '后台任务'
  return clean.length > 72 ? `${clean.slice(0, 72)}…` : clean
}

function duration(job: JobRow): string {
  const end = job.finishedAt ?? Date.now()
  const ms = Math.max(0, end - job.startedAt)
  if (ms < 1000) return '<1 秒'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}
