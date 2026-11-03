/**
 * 后台任务条。
 *
 * 位置在输入框**上方**: 任务条回答的是"我还能不能让 agent 干活", 而输入框就是干活的入口,
 * 两件事挨着才对。放到状态条那边会变成"遥测", 用户不会去看。
 *
 * 「关掉」的语义 (这是后端那条 job/completed 通知真正在驱动的东西):
 *   收到终态 → 状态词从「运行中」变成「完成/已中止/失败」→ **5 秒后整条消失**。
 *   为什么不立即消失: 任务跑了三分钟, 结束时"啪"一下没了, 用户只会觉得界面闪了一下,
 *   根本不知道刚才那个活完了没有。5 秒 = 够看一眼结论 + 不占位置。
 *   为什么不常驻: 它是横切状态条, 不是历史记录; 要查历史有 job_list 工具和会话流。
 *   用户可以点 × 提前关掉, 也可以点条本身(仅终态)立刻收起。
 *
 * 定时器用 ref 记"已经排过的 id", 不用 effect 里每次重建:
 * 否则 jobs 数组每变一次(比如又来一条新任务)所有倒计时都会重置, 先完成的那条反而不消失。
 */

import { useEffect, useRef, useState } from 'react'

import { IconButton } from '@meng/ui'

import { CloseIcon } from './icons.tsx'
import type { JobRow } from './conversation.ts'
import styles from './App.module.css'

/** 终态条停留多久。够看一眼, 不够碍事 */
const LINGER_MS = 5000

const STATUS_TEXT: Record<JobRow['status'], string> = {
  running: '运行中',
  completed: '完成',
  killed: '已中止',
  failed: '失败',
}

export interface JobBarProps {
  jobs: JobRow[]
}

export function JobBar({ jobs }: JobBarProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    for (const job of jobs) {
      if (job.status === 'running' || timers.current.has(job.id)) continue
      const timer = setTimeout(() => {
        timers.current.delete(job.id)
        setDismissed((prev) => new Set(prev).add(job.id))
      }, LINGER_MS)
      timers.current.set(job.id, timer)
    }
  }, [jobs])

  // 卸载时清干净: 未清的 timer 在条已经不存在的页面上 setState 是纯泄漏
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const visible = jobs.filter((job) => !dismissed.has(job.id))
  if (visible.length === 0) return null

  return (
    <div className={styles.jobbar} role="status" aria-live="polite">
      {visible.map((job) => {
        const running = job.status === 'running'
        return (
          <div key={job.id} className={styles.jobRow} data-status={job.status}>
            <span
              className={`${styles.jobDot} ${running ? styles.jobDotLive : styles[`jobDot-${job.status}`]}`}
              aria-hidden="true"
            />
            <span className={styles.jobKind}>{job.kind}</span>
            <span className={styles.jobLabel} title={job.label}>
              {job.label}
            </span>
            <span className={styles.jobStatus}>
              {STATUS_TEXT[job.status] ?? job.status}
              {job.detail ? ` · ${job.detail}` : ''}
            </span>
            <span className={styles.jobTime}>{duration(job)}</span>
            <IconButton
              aria-label={`关闭任务 ${job.label}`}
              size="sm"
              onClick={() => setDismissed((prev) => new Set(prev).add(job.id))}
            >
              <CloseIcon />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

/** 已落定用真实耗时, 在跑用"到现在"。都不做实时跳秒 —— 任务条不该有自己的心跳 */
function duration(job: JobRow): string {
  const end = job.finishedAt ?? job.startedAt
  const ms = Math.max(0, end - job.startedAt)
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
