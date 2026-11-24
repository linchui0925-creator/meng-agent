import { useEffect, useState } from 'react'

import type { FileListing } from './attachments.ts'
import { joinPath, relativeToRoot } from './attachments.ts'
import styles from './ReferencePicker.module.css'

export function ReferencePicker({
  open,
  root,
  listFiles,
  onSelect,
  onClose,
}: {
  open: boolean
  root: string
  listFiles: (path: string) => Promise<FileListing>
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [listing, setListing] = useState<FileListing>()
  const [startPath, setStartPath] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function load(path: string): Promise<void> {
    setLoading(true)
    setError(undefined)
    try {
      const next = await listFiles(path)
      setListing(next)
      setStartPath((current) => current ?? next.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setListing(undefined)
      setStartPath(undefined)
      void load(root)
    }
    // root 只在打开面板时作为起点；用户浏览中的路径不能被一次父级重渲染重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root])

  if (!open) return null
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="引用文件">
        <header className={styles.head}>
          <div>
            <h2>引用文件</h2>
            <p>只插入相对路径，不上传文件</p>
          </div>
          <button type="button" className={styles.close} aria-label="关闭引用文件" onClick={onClose}>×</button>
        </header>

        <div className={styles.path} title={listing?.path ?? root}>{listing?.path ?? root}</div>

        <div className={styles.list}>
          {loading && <p className={styles.status}>正在读取目录…</p>}
          {!loading && error !== undefined && <p className={styles.error}>{error}</p>}
          {!loading && error === undefined && listing?.parent !== undefined && (
            <button type="button" className={styles.row} onClick={() => void load(listing.parent!)}>
              <span className={styles.icon} aria-hidden="true">↑</span>
              <span>上一级</span>
            </button>
          )}
          {!loading && error === undefined && listing?.entries.map((entry) => {
            const child = joinPath(listing.path, entry.name)
            return (
              <button
                key={`${entry.dir ? 'd' : 'f'}:${entry.name}`}
                type="button"
                className={styles.row}
                data-dir={entry.dir}
                onClick={() => {
                  if (entry.dir) {
                    void load(child)
                    return
                  }
                  onSelect(relativeToRoot(startPath ?? root, child))
                  onClose()
                }}
              >
                <span className={styles.icon} aria-hidden="true">{entry.dir ? '▸' : '·'}</span>
                <span>{entry.name}</span>
              </button>
            )
          })}
          {!loading && error === undefined && listing?.entries.length === 0 && (
            <p className={styles.status}>这个目录是空的</p>
          )}
        </div>
      </section>
    </div>
  )
}
