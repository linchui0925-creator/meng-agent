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

interface JobOutputResult {
  text: string
  lossy?: boolean
  spillPath?: string
  tailTruncated?: boolean
}

interface JobOutputView extends JobOutputResult {
  jobId: string
}

export function JobTray({
  jobs,
  readOutput,
  stop,
}: {
  jobs: JobRow[]
  readOutput: (jobId: string, full?: boolean) => Promise<JobOutputResult>
  stop: (jobId: string) => Promise<unknown>
}) {
  const running = jobs.filter((job) => job.status === 'running').length
  const failed = jobs.filter((job) => job.status === 'failed').length
  const previousRunning = useRef(0)
  const [open, setOpen] = useState(running > 0)
  const [busy, setBusy] = useState<string>()
  const [output, setOutput] = useState<JobOutputView>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (running > 0) setOpen(true)
    else if (previousRunning.current > 0) setOpen(false)
    previousRunning.current = running
  }, [running])

  /*
   * 查看中的任务还在跑时自动刷新尾部。这里用 full=true：后端走“不消费”的快照，
   * 不会把模型下一次 job_output 该读的增量抢走。只在面板真正展开时轮询。
   */
  useEffect(() => {
    if (!output) return
    const job = jobs.find((item) => item.id === output.jobId)
    if (!job || job.status !== 'running') return
    let alive = true
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try {
        const next = await readOutput(output.jobId, true)
        if (alive) setOutput((current) => current?.jobId === output.jobId ? { ...next, jobId: output.jobId } : current)
      } catch {
        // 轮询抖动不覆盖用户正在看的内容；手动点“查看输出”会给出明确错误。
      } finally {
        reading = false
      }
    }
    const timer = setInterval(() => void refresh(), 1600)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [jobs, output?.jobId, readOutput])

  if (jobs.length === 0) return null

  const lead = jobs.find((job) => job.status === 'running') ?? jobs[0]
  const leadLabel = lead ? ` · ${friendlyLabel(lead.label)}` : ''
  const summary = running > 0
    ? `${running} 个任务在后台运行${leadLabel}`
    : `${jobs.length} 个后台任务已结束${failed > 0 ? `，${failed} 个失败` : ''}`

  async function view(job: JobRow): Promise<void> {
    if (busy) return
    setBusy(job.id)
    setError(undefined)
    try {
      const result = await readOutput(job.id, true)
      setOutput({ ...result, jobId: job.id })
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

  const outputJob = output ? jobs.find((job) => job.id === output.jobId) : undefined

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
                  <strong title={job.label}>{friendlyLabel(job.label)}</strong>
                  <span className={styles.kind}>{KIND_TEXT[job.kind] ?? job.kind}</span>
                </div>
                <div className={styles.meta}>
                  <span>{STATUS_TEXT[job.status]}</span>
                  <span>{job.status === 'running' ? '已运行' : '用时'} {duration(job)}</span>
                  {job.detail && <span>{job.detail}</span>}
                </div>
                {job.command && (
                  <details className={styles.command}>
                    <summary>命令</summary>
                    <code>{job.command}</code>
                  </details>
                )}
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
                <strong>{outputJob?.status === 'running' ? '实时输出' : '最近输出'}</strong>
                <button type="button" onClick={() => setOutput(undefined)}>收起</button>
              </div>
              <pre>{output.text || emptyOutputHint(outputJob)}</pre>
              {(output.lossy || output.tailTruncated || output.spillPath) && (
                <div className={styles.outputMeta}>
                  {output.tailTruncated && <span>只显示最后一段</span>}
                  {output.lossy && <span>更早内容已滑出内存窗口</span>}
                  {output.spillPath && <span>全量输出：{output.spillPath}</span>}
                </div>
              )}
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

function emptyOutputHint(job: JobRow | undefined): string {
  if (!job) return '任务还没有产生可显示的输出。'
  if (looksRedirected(job.command)) {
    return '任务没有标准输出：命令把输出重定向到文件了。可以展开上面的“命令”查看目标文件。'
  }
  return job.status === 'running'
    ? '任务还在运行，目前还没有产生输出。面板会自动刷新。'
    : '任务没有产生标准输出。'
}

function looksRedirected(command: string | undefined): boolean {
  return command !== undefined && /(?:^|\s)>{1,2}\s*\S+/.test(command)
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
