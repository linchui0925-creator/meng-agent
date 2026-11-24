import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { SessionSummary } from './sessions.ts'
import styles from './App.module.css'

interface RenameSessionDialogProps {
  session: SessionSummary
  onClose: () => void
  onRename: (sessionId: string, title: string) => Promise<void>
}

/** 独立的视图弹层；真正保存仍由 App 通过 LayoutApi 完成。 */
export function RenameSessionDialog({ session, onClose, onRename }: RenameSessionDialogProps) {
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => previous?.focus()
  }, [])

  const save = async (): Promise<void> => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError('请输入会话名称')
      inputRef.current?.focus()
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await onRename(session.sessionId, nextTitle)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return createPortal(
    <div
      className={styles.renameScrim}
      data-rename-scrim=""
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        className={styles.renameDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-session-title"
        aria-describedby={error ? 'rename-session-error' : undefined}
        data-rename-dialog={session.sessionId}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onClose()
          }
          if (event.key !== 'Tab') return
          const focusable = cardRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)')
          if (!focusable || focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className={styles.renameEyebrow}>SESSION</div>
          <h2 className={styles.renameHeading} id="rename-session-title">
            重命名会话
          </h2>
          <p className={styles.renameDescription}>用一个容易辨认的名字，稍后更快找到它。</p>
          <label className={styles.renameLabel} htmlFor="rename-session-input">
            会话名称
          </label>
          <input
            ref={inputRef}
            id="rename-session-input"
            className={styles.renameInput}
            data-rename-input=""
            value={title}
            maxLength={200}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => {
              setTitle(event.target.value)
              setError(undefined)
            }}
          />
          {error && (
            <p className={styles.renameError} id="rename-session-error" role="alert">
              {error}
            </p>
          )}
          <div className={styles.renameActions}>
            <button
              type="button"
              className={styles.renameCancel}
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className={styles.renameSave}
              data-rename-save=""
              disabled={busy || !title.trim()}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
