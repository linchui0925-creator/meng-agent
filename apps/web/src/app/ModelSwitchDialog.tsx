import { useEffect } from 'react'

import { Button } from '@meng/ui'

import type { ModelSwitchPrompt } from './layout.ts'
import styles from './ModelSwitchDialog.module.css'

export function ModelSwitchDialog({ prompt }: { prompt?: ModelSwitchPrompt }) {
  useEffect(() => {
    if (!prompt) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !prompt.busy) prompt.cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [prompt])

  if (!prompt) return null
  return (
    <div className={styles.backdrop} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="切换模型">
        <header className={styles.head}>
          <span className={styles.kicker}>新上下文</span>
          <h2>切换模型将重新建立会话上下文</h2>
        </header>

        <div className={styles.route}>
          <code>{prompt.fromLabel}</code>
          <span aria-hidden="true">→</span>
          <code>{prompt.toLabel}</code>
        </div>

        <p className={styles.explain}>前面的用户消息和助手最终回复会作为文字参考再次发送给新模型，不包含工具日志。</p>
        <div className={styles.cost}>
          <span>额外模型消耗</span>
          <strong>约 {formatTokens(prompt.estimatedInputTokens)} input tokens</strong>
        </div>

        {prompt.warning !== undefined && <p className={styles.warning}>{prompt.warning}</p>}
        {prompt.error !== undefined && <p className={styles.error} role="alert">{prompt.error}</p>}

        <footer className={styles.actions}>
          <Button variant="secondary" size="md" disabled={prompt.busy} onClick={prompt.cancel}>取消</Button>
          <Button variant="primary" size="md" disabled={prompt.busy || prompt.blocked} onClick={prompt.confirm}>
            {prompt.busy ? '切换中…' : prompt.blocked ? '当前不可切换' : '确认切换'}
          </Button>
        </footer>
      </section>
    </div>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}
