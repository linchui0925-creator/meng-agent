import { useState } from 'react'

import type { MemoryStatus } from '@meng/loop'

import type { ContextCompactResult } from './layout.ts'
import styles from './ContextPanel.module.css'

export function ContextPanel({
  status,
  compact,
  onClose,
}: {
  status: MemoryStatus
  compact?: () => Promise<ContextCompactResult>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ContextCompactResult>()
  const [error, setError] = useState<string>()

  const used = Math.max(0, status.usedTokens)
  const total = status.contextWindow
  const usedPct = total !== undefined && total > 0 ? Math.min(100, (used / total) * 100) : undefined
  const thresholdPct = Math.min(100, Math.max(0, status.thresholdRatio * 100))
  const remaining = status.thresholdTokens === undefined ? undefined : Math.max(0, status.thresholdTokens - used)
  const lastCompact = status.lastCompactedAt === undefined
    ? undefined
    : new Date(status.lastCompactedAt).toLocaleString('zh-CN', { hour12: false })

  async function run(): Promise<void> {
    if (busy || compact === undefined) return
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(await compact())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.panel} data-context-panel="" aria-label="上下文状态">
      <header className={styles.head}>
        <div>
          <strong>上下文空间</strong>
          <span>达到阈值后会自动整理成摘要</span>
        </div>
        <span className={styles.state} data-state={status.compacted ? 'done' : 'normal'}>
          {status.compacted ? `已整理 ${status.compactionCount} 次` : '未整理'}
        </span>
      </header>

      <div className={styles.hero}>
        <span className={styles.used}>{formatTokens(used)}</span>
        {total !== undefined && <span className={styles.total}>/ {formatTokens(total)} tokens</span>}
      </div>

      <div className={styles.meter} aria-hidden="true">
        {usedPct !== undefined && <span className={styles.fill} style={{ width: `${usedPct}%` }} />}
        {total !== undefined && <i className={styles.threshold} style={{ left: `${thresholdPct}%` }} />}
      </div>
      <p className={styles.hint}>
        {remaining === undefined
          ? '模型没有报告上下文窗口，只能显示当前估算长度。'
          : remaining > 0
            ? `距离自动整理还剩 ${formatTokens(remaining)} tokens。`
            : '已经达到自动整理阈值；下一次上下文准备时会自动压缩。'}
      </p>
      <p className={styles.scope}>包含系统提示、工具说明和当前会话历史，不等于最后一句消息的长度。</p>

      <dl className={styles.facts}>
        <div>
          <dt>自动阈值</dt>
          <dd>{status.thresholdTokens === undefined ? '未知' : `${formatTokens(status.thresholdTokens)} · ${Math.round(status.thresholdRatio * 100)}%`}</dd>
        </div>
        <div>
          <dt>保留最近</dt>
          <dd>{Math.round(status.retainRatio * 100)}%</dd>
        </div>
        <div>
          <dt>已整理</dt>
          <dd>{status.compactionCount} 次</dd>
        </div>
        <div>
          <dt>最近一次</dt>
          <dd>{lastCompact ?? '无'}</dd>
        </div>
      </dl>

      <p className={styles.note}>整理会生成摘要检查点，原始聊天不会删除。完成后状态会重新从后端读取。</p>

      {!status.canCompact && status.reason !== undefined && (
        <p className={styles.reason} data-context-reason="">{status.reason}</p>
      )}
      {error !== undefined && <p className={styles.error} role="alert">{error}</p>}
      {result !== undefined && (
        <p className={styles.result} data-compact-result="" role="status">
          {result.compacted
            ? `已整理：${formatTokens(result.beforeTokens ?? 0)} → ${formatTokens(result.afterTokens ?? 0)} tokens`
            : result.reason ?? '这次没有产生压缩。'}
          {result.summarySeq !== undefined ? ` · 摘要 #${result.summarySeq}` : ''}
        </p>
      )}

      <footer className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>收起</button>
        <button
          type="button"
          className={styles.primary}
          data-context-compact=""
          disabled={busy || !status.canCompact || compact === undefined}
          title={status.canCompact ? '立即整理上下文' : status.reason}
          onClick={() => void run()}
        >
          {busy ? '正在整理…' : result?.compacted && status.canCompact ? '再次整理' : '立即整理上下文'}
        </button>
      </footer>
    </section>
  )
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  if (value >= 1000) return `${Math.round(value / 1024)}K`
  return String(Math.round(value))
}
