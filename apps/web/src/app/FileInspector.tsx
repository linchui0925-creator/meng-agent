import type { ModifiedFile } from './conversation.ts'
import styles from './FileInspector.module.css'

export function FileInspector({ file, onClose }: { file: ModifiedFile; onClose: () => void }) {
  const name = file.path.split('/').pop() ?? file.path
  const content = file.content ?? ''
  return (
    <aside className={styles.inspector} aria-label="文件详情">
      <header className={styles.head}>
        <div className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h5" /></svg>
        </div>
        <div className={styles.title}>
          <strong>{name}</strong>
          <span>{file.path}</span>
        </div>
        <button type="button" className={styles.close} aria-label="关闭文件详情" onClick={onClose}>×</button>
      </header>

      <div className={styles.meta}>
        <span data-kind={file.tool}>{file.tool === 'write' ? '整文件写入' : '局部编辑'}</span>
        {file.at !== undefined ? <span>{new Date(file.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> : null}
      </div>

      {file.tool === 'write' ? (
        <CodeBlock content={content} />
      ) : (
        <div className={styles.diff}>
          <DiffPart tone="remove" text={file.oldText ?? ''} />
          <DiffPart tone="add" text={file.newText ?? ''} />
        </div>
      )}
    </aside>
  )
}

function CodeBlock({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className={styles.code}>
      {lines.map((line, index) => (
        <div className={styles.line} key={index}>
          <span className={styles.lineNo}>{index + 1}</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function DiffPart({ tone, text }: { tone: 'add' | 'remove'; text: string }) {
  return (
    <section className={styles.diffPart} data-tone={tone}>
      <header>{tone === 'add' ? '新增' : '移除'}</header>
      <pre>{text || '（空）'}</pre>
    </section>
  )
}
