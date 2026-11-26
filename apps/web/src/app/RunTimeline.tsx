import { useEffect, useRef, useState } from 'react'

import type { SlotComponent, ToolRecord } from './layout.ts'
import { toolTitle, type Message, type ModifiedFile, type RunMarker, type RunStep, type ToolCall } from './conversation.ts'
import { Markdown } from './Markdown.tsx'
import { ToolCard } from './ToolCard.tsx'
import styles from './RunTimeline.module.css'

const RECENT_STEPS = 3

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
  const recentStepIds = new Set(steps.slice(-RECENT_STEPS).map((step) => step.id))
  const firstRecentPart = parts.findIndex((part) => part.kind === 'step' && recentStepIds.has(part.id))
  const splitAt = steps.length > RECENT_STEPS && firstRecentPart >= 0 ? firstRecentPart : 0
  const olderParts = parts.slice(0, splitAt)
  const recentParts = parts.slice(splitAt)
  return (
    <details className={styles.run} open={running}>
      <summary className={styles.head}>
        <span className={styles.live} data-live={running ? '' : undefined} />
        <span className={styles.headTitle}>执行过程</span>
        <RunElapsed start={message.at} end={running ? undefined : message.finishedAt} live={running} />
      </summary>
      <div className={styles.timeline}>
        {olderParts.length > 0 ? (
          <details className={styles.older}>
            <summary>
              <span>更早过程</span>
              <span className={styles.olderAction}>展开</span>
            </summary>
            <div className={styles.olderBody}>
              {olderParts.map((part) => part.kind === 'marker'
                ? <RunMarkerRow key={part.id} marker={part} />
                : (
                  <RunStepRow
                    key={part.id}
                    step={part}
                    current={false}
                    autoFold={autoFold}
                    readRecord={readRecord}
                    Slot={Slot}
                    onOpenFile={onOpenFile}
                  />
                ))}
            </div>
          </details>
        ) : null}
        {recentParts.map((part) => part.kind === 'marker'
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
  const hasText = step.text.trim() !== ''
  const hasReasoning = (step.reasoning?.trim() ?? '') !== ''
  const summary = summaryOf(step)
  const reasoning = hasReasoning && step.reasoning !== undefined
    ? <ReasoningRow text={step.reasoning} running={step.status === 'streaming'} />
    : null

  if (current) {
    return (
      <section className={styles.step} data-current="">
        <div className={styles.currentLabel}><i />{step.status === 'waiting' ? '等待工具' : '正在执行'}</div>
        {reasoning}
        {hasText && (
          <div className={styles.thought}>
            <Markdown text={step.text} caret={step.status === 'streaming'} />
          </div>
        )}
        {!hasText && !hasReasoning && step.status === 'waiting' && (
          <div className={styles.thought}>正在调用工具…</div>
        )}
        {files.length > 0 && <FileChanges files={files} onOpenFile={onOpenFile} />}
        {step.tools.length > 0 && <Tools tools={step.tools} autoFold={autoFold} readRecord={readRecord} Slot={Slot} />}
      </section>
    )
  }
  return (
    <details className={styles.step} data-status={step.status}>
      <summary>
        <span className={styles.stepSummary}>{summary}</span>
        <span className={styles.chevron}>›</span>
      </summary>
      <div className={styles.stepBody}>
        {reasoning}
        {hasText && <div className={styles.thought}><Markdown text={step.text} /></div>}
        {files.length > 0 && <FileChanges files={files} onOpenFile={onOpenFile} />}
        {step.tools.length > 0 && <Tools tools={step.tools} autoFold={autoFold} readRecord={readRecord} Slot={Slot} />}
      </div>
    </details>
  )
}

/** 思考块只用一行导航；完整正文点开才渲染，避免流式时不断把会话顶下去。 */
function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const summary = running ? latestLine(text) : firstLine(text)
  useEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  }, [running, summary])
  return (
    <div className={styles.reasoningRow} data-running={running ? '' : undefined}>
      <button
        type="button"
        className={styles.reasoningHead}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.reasoningMark} aria-hidden="true">✦</span>
        <span className={styles.reasoningTitle}>思考</span>
        <span className={styles.reasoningSeparator} aria-hidden="true" />
        <span
          ref={summaryRef}
          className={styles.reasoningSummary}
          data-follow-end={running ? '' : undefined}
        >
          {summary || '正在思考…'}
        </span>
        <span className={styles.reasoningChevron} aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && <pre className={styles.reasoningBody}>{text}</pre>}
    </div>
  )
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

function summaryOf(step: RunStep): string {
  const text = (step.text.trim() || step.reasoning?.trim() || '').replace(/\s+/g, ' ')
  if (text) return text.slice(0, 120)
  const tool = step.tools.at(-1)
  if (tool) {
    const title = toolTitle(tool)
    return step.status === 'streaming' || step.status === 'waiting' ? `${title}…` : title
  }
  return step.status === 'waiting' ? '等待工具结果…' : '已完成这一步'
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
        const card = { tool, compact: true, autoFold, readRecord }
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
