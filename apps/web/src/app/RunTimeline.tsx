import { useEffect, useState } from 'react'

import type { SlotComponent, ToolRecord } from './layout.ts'
import type { Message, ModifiedFile, RunMarker, RunStep, ToolCall } from './conversation.ts'
import { Markdown } from './Markdown.tsx'
import { ToolCard } from './ToolCard.tsx'
import styles from './RunTimeline.module.css'

interface RunTimelineProps {
  message: Message
  autoFold: boolean
  readRecord?: (recordId: string) => Promise<ToolRecord>
  Slot: SlotComponent
  onOpenFile: (file: ModifiedFile) => void
}

export function RunTimeline({ message, autoFold, readRecord, Slot, onOpenFile }: RunTimelineProps) {
  const parts = message.steps ?? []
  const steps = parts.filter((part): part is RunStep => part.kind === 'step')
  if (steps.length === 0) return null
  const running = message.status === 'streaming'
  const currentStepId = running ? steps[steps.length - 1]?.id : undefined
  return (
    <details className={styles.run} open={running}>
      <summary className={styles.head}>
        <span className={styles.live} data-live={running ? '' : undefined} />
        <span className={styles.headTitle}>执行过程</span>
        <span className={styles.headCount}>· {steps.length} 步</span>
        <RunElapsed start={message.at} end={running ? undefined : message.finishedAt} live={running} />
      </summary>
      <div className={styles.timeline}>
        {parts.map((part, index) => part.kind === 'marker'
          ? <RunMarkerRow key={part.id} marker={part} />
          : (
            <RunStepRow
              key={part.id}
              step={part}
              current={part.id === currentStepId}
              autoFold={autoFold}
              readRecord={readRecord}
              Slot={Slot}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    </details>
  )
}

function RunStepRow({ step, current, autoFold, readRecord, Slot, onOpenFile }: {
  step: RunStep
  current: boolean
  autoFold: boolean
  readRecord?: (recordId: string) => Promise<ToolRecord>
  Slot: SlotComponent
  onOpenFile: (file: ModifiedFile) => void
}) {
  const files = modifiedFilesOfStep(step)
  const summary = step.text.replace(/\s+/g, ' ').trim().slice(0, 120) || '正在准备下一步…'
  if (current) {
    return (
      <section className={styles.step} data-current="">
        <span className={styles.node}>{step.index}</span>
        <div className={styles.currentLabel}><i />{step.status === 'waiting' ? '等待工具' : '正在执行'}</div>
        <div className={styles.thought}><Markdown text={step.text || (step.status === 'waiting' ? '正在调用工具…' : '')} caret={step.status === 'streaming'} /></div>
        {files.length > 0 && <FileChanges files={files} onOpenFile={onOpenFile} />}
        {step.tools.length > 0 && <Tools tools={step.tools} autoFold={autoFold} readRecord={readRecord} Slot={Slot} />}
      </section>
    )
  }
  return (
    <details className={styles.step} data-status={step.status}>
      <summary>
        <span className={styles.node}>{step.index}</span>
        <span className={styles.stepSummary}>{summary}</span>
        <span className={styles.stepMeta}>{step.tools.length > 0 ? `${step.tools.length} 个工具` : '完成'}</span>
        <span className={styles.chevron}>›</span>
      </summary>
      <div className={styles.stepBody}>
        {step.text && <div className={styles.thought}><Markdown text={step.text} /></div>}
        {files.length > 0 && <FileChanges files={files} onOpenFile={onOpenFile} />}
        {step.tools.length > 0 && <Tools tools={step.tools} autoFold={autoFold} readRecord={readRecord} Slot={Slot} />}
      </div>
    </details>
  )
}

function RunMarkerRow({ marker }: { marker: RunMarker }) {
  return (
    <div className={styles.marker} data-tone={marker.tone}>
      <span>{marker.label}{marker.detail ? ` · ${marker.detail}` : ''}</span>
    </div>
  )
}

function Tools({ tools, autoFold, readRecord, Slot }: {
  tools: ToolCall[]
  autoFold: boolean
  readRecord?: (recordId: string) => Promise<ToolRecord>
  Slot: SlotComponent
}) {
  return (
    <div className={styles.tools}>
      {tools.map((tool) => {
        const card = { tool, autoFold, readRecord }
        return <Slot key={tool.callId} name="conversation.tool" props={card} fallback={<ToolCard {...card} />} />
      })}
    </div>
  )
}

function FileChanges({ files, onOpenFile }: { files: ModifiedFile[]; onOpenFile: (file: ModifiedFile) => void }) {
  return (
    <div className={styles.files} aria-label="修改的文件">
      {files.map((file) => (
        <button type="button" className={styles.file} key={`${file.callId}:${file.path}`} onClick={() => onOpenFile(file)} title={file.path}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h5" />
          </svg>
          <span>{file.path.split('/').pop() ?? file.path}</span>
          <small>{file.tool === 'write' ? '写入' : '编辑'}</small>
        </button>
      ))}
    </div>
  )
}

function modifiedFilesOfStep(step: RunStep): ModifiedFile[] {
  return step.tools.flatMap((tool) => {
    if (tool.tool !== 'write' && tool.tool !== 'edit') return []
    const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
    const path = typeof args.file_path === 'string' ? args.file_path : ''
    if (!path) return []
    return [{
      path,
      tool: tool.tool,
      callId: tool.callId,
      ...(tool.startedAt === undefined ? {} : { at: tool.startedAt }),
      ...(typeof args.content === 'string' ? { content: args.content } : {}),
      ...(typeof args.old_string === 'string' ? { oldText: args.old_string } : {}),
      ...(typeof args.new_string === 'string' ? { newText: args.new_string } : {}),
    }]
  })
}

function RunElapsed({ start, end, live }: { start: number; end?: number; live: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return <span className={styles.elapsed}>{formatDuration(Math.max(0, (end ?? (live ? now : start)) - start))}</span>
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds % 3600 / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
