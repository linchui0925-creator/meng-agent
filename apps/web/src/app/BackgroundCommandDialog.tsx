import { useEffect, useState } from 'react'

import styles from './BackgroundCommandDialog.module.css'

export function BackgroundCommandDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (command: string, description?: string) => Promise<void>
}) {
  const [command, setCommand] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setError(undefined)
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose, open])

  if (!open) return null

  async function submit(): Promise<void> {
    const value = command.trim()
    if (!value || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit(value, description.trim() || undefined)
      setCommand('')
      setDescription('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.backdrop} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="后台运行命令">
        <header>
          <span>会话内任务</span>
          <h2>后台运行命令</h2>
          <p>命令会继续运行，你可以留在当前会话做别的事。</p>
        </header>
        <label>
          命令
          <textarea
            autoFocus
            rows={4}
            value={command}
            placeholder="例如：pnpm test"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label>
          任务名称（可选）
          <input value={description} placeholder="例如：运行测试" onChange={(event) => setDescription(event.target.value)} />
        </label>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <footer>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className={styles.primary} disabled={busy || !command.trim()} onClick={() => void submit()}>
            {busy ? '正在启动…' : '开始运行'}
          </button>
        </footer>
      </section>
    </div>
  )
}
