import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { ShieldIcon } from './icons.tsx'
import styles from './PermissionWarningDialog.module.css'

export function PermissionWarningDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, open])

  if (!open) return null

  return createPortal(
    <div className={styles.backdrop} role="presentation">
      <section className={styles.dialog} role="alertdialog" aria-modal="true" aria-label="绝对权限警告">
        <div className={styles.head}>
          <span className={styles.icon} aria-hidden="true"><ShieldIcon /></span>
          <div>
            <span className={styles.kicker}>高风险设置</span>
            <h2>确定使用绝对权限？</h2>
          </div>
        </div>
        <p>开启后，高风险命令将直接执行，不再请求确认。这个设置会影响所有会话，不只是当前这一段。</p>
        <p className={styles.scope}>只在明确信任当前工作区和将要运行的命令时使用。</p>
        <footer>
          <button type="button" className={styles.cancel} onClick={onCancel}>取消</button>
          <button type="button" className={styles.confirm} onClick={onConfirm}>仍然使用绝对权限</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
