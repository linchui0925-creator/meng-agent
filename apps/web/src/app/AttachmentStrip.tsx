import type { ComposerAttachment } from './attachments.ts'
import styles from './AttachmentStrip.module.css'

export function AttachmentStrip({
  items,
  remove,
}: {
  items: readonly ComposerAttachment[]
  remove: (localId: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className={styles.strip} aria-label="待发送附件">
      {items.map((item) => (
        <div key={item.localId} className={styles.item} data-status={item.status}>
          {item.previewUrl !== undefined ? (
            <img className={styles.thumb} src={item.previewUrl} alt="" />
          ) : (
            <span className={styles.fileIcon} aria-hidden="true">图</span>
          )}
          <span className={styles.copy}>
            <b title={item.name}>{item.name}</b>
            <span>
              {item.status === 'uploading'
                ? '上传中…'
                : item.status === 'error'
                  ? item.error ?? '上传失败'
                  : `${Math.max(1, Math.round(item.size / 1024))} KB`}
            </span>
          </span>
          <button
            type="button"
            className={styles.remove}
            aria-label={`移除附件 ${item.name}`}
            onClick={() => remove(item.localId)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
