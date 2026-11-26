import type { SessionEvent } from '@meng/session'

export type RunMarkerKind = 'read' | 'write' | 'search' | 'verify'
export type RunMarkerStatus = 'running' | 'ok' | 'failed' | 'blocked'
export type VerificationKind = 'test' | 'build' | 'typecheck' | 'lint' | 'check' | 'command'

export interface RunMarker {
  seq: number
  callId: string
  tool: string
  kind: RunMarkerKind
  status: RunMarkerStatus
  target?: string
  verification?: VerificationKind
}

export interface RunSnapshot {
  runId?: string
  startedAt: number
  markers: RunMarker[]
  modifiedFiles: string[]
  verificationMarkers: RunMarker[]
}

interface PendingCall {
  seq: number
  callId: string
  tool: string
  args: Record<string, unknown>
  kind?: RunMarkerKind
  target?: string
  verification?: VerificationKind
}

const MARKER_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash'])

/**
 * 只投影“任务动作”，不投影工具输出。
 *
 * 这里刻意不 generic 地记录所有工具：memory_search、job_list、网页抓取等
 * 与当前读写证据无关，混进来只会让模型把状态当内容继续复述。
 */
export function snapshotCurrentRun(events: readonly SessionEvent[]): RunSnapshot | undefined {
  let turnIndex = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/started') { turnIndex = i; break }
  }
  if (turnIndex < 0) return undefined
  const turn = events[turnIndex]!
  const runData = turn.data as { runId?: unknown }
  const runId = typeof runData.runId === 'string' && runData.runId ? runData.runId : undefined
  const inRun = (event: SessionEvent): boolean => {
    if (event.seq <= turn.seq) return false
    const id = (event.data as { runId?: unknown } | undefined)?.runId
    return runId === undefined || id === undefined || id === runId
  }

  const pending = new Map<string, PendingCall>()
  const markers: RunMarker[] = []

  for (const event of events) {
    if (!inRun(event)) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const callId = typeof data.callId === 'string' ? data.callId : ''
    if (!callId) continue
    if (event.type === 'tool/called') {
      const tool = typeof data.tool === 'string' ? data.tool : ''
      if (!MARKER_TOOLS.has(tool)) continue
      const args = data.args && typeof data.args === 'object' ? data.args as Record<string, unknown> : {}
      const classified = classifyCall(tool, args)
      if (!classified) continue
      pending.set(callId, {
        seq: event.seq,
        callId,
        tool,
        args,
        kind: classified.kind,
        ...(classified.target ? { target: classified.target } : {}),
        ...(classified.verification ? { verification: classified.verification } : {}),
      })
      continue
    }
    if (event.type === 'tool/completed') {
      const item = pending.get(callId)
      if (!item?.kind) continue
      markers.push({
        seq: item.seq,
        callId,
        tool: item.tool,
        kind: item.kind,
        status: data.ok === false ? 'failed' : 'ok',
        ...(item.target ? { target: item.target } : {}),
        ...(item.verification ? { verification: item.verification } : {}),
      })
      pending.delete(callId)
      continue
    }
    if (event.type === 'tool/blocked') {
      const item = pending.get(callId)
      const tool = typeof data.tool === 'string' ? data.tool : item?.tool ?? ''
      if (!MARKER_TOOLS.has(tool)) continue
      const classified = item?.kind ? item : classifyCall(tool, {})
      if (!classified?.kind) continue
      markers.push({
        seq: item?.seq ?? event.seq,
        callId,
        tool,
        kind: classified.kind,
        status: 'blocked',
        ...(classified.target ? { target: classified.target } : {}),
        ...(classified.verification ? { verification: classified.verification } : {}),
      })
      pending.delete(callId)
    }
  }

  for (const item of pending.values()) {
    if (!item.kind) continue
    markers.push({
      seq: item.seq,
      callId: item.callId,
      tool: item.tool,
      kind: item.kind,
      status: 'running',
      ...(item.target ? { target: item.target } : {}),
      ...(item.verification ? { verification: item.verification } : {}),
    })
  }

  const modifiedFiles = unique(markers
    .filter((marker) => marker.kind === 'write' && marker.status === 'ok' && marker.target)
    .map((marker) => marker.target!))
  const verificationMarkers = markers.filter((marker) => marker.kind === 'verify' && marker.status === 'ok')
  return { ...(runId ? { runId } : {}), startedAt: turn.at, markers, modifiedFiles, verificationMarkers }
}

export function hasValidationAfterLastWrite(snapshot: RunSnapshot): boolean {
  if (snapshot.modifiedFiles.length === 0) return true
  const lastWriteSeq = Math.max(...snapshot.markers
    .filter((marker) => marker.kind === 'write' && marker.status === 'ok')
    .map((marker) => marker.seq))
  const codeFiles = snapshot.modifiedFiles.filter(isCodeFile)
  if (codeFiles.length > 0) {
    return snapshot.verificationMarkers.some((marker) =>
      marker.seq > lastWriteSeq && marker.verification !== 'command'
    )
  }
  const readBack = snapshot.markers.some((marker) =>
    marker.kind === 'read' &&
    marker.status === 'ok' &&
    marker.seq > lastWriteSeq &&
    marker.target !== undefined &&
    snapshot.modifiedFiles.includes(marker.target)
  )
  return readBack || snapshot.verificationMarkers.some((marker) => marker.seq > lastWriteSeq)
}

export function dedupeMarkers(markers: readonly RunMarker[]): Array<RunMarker & { count: number }> {
  const out = new Map<string, RunMarker & { count: number }>()
  for (const marker of markers) {
    const key = [marker.kind, marker.tool, marker.target ?? '', marker.verification ?? '', marker.status].join('|')
    const found = out.get(key)
    if (found) found.count++
    else out.set(key, { ...marker, count: 1 })
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq)
}

function classifyCall(tool: string, args: Record<string, unknown>): Pick<RunMarker, 'kind' | 'target' | 'verification'> | undefined {
  if (tool === 'read') return { kind: 'read', ...(pathOf(args) ? { target: pathOf(args)! } : {}) }
  if (tool === 'write' || tool === 'edit') return { kind: 'write', ...(pathOf(args) ? { target: pathOf(args)! } : {}) }
  if (tool === 'glob') return { kind: 'search', ...(stringOf(args.pattern) ? { target: stringOf(args.pattern)! } : {}) }
  if (tool === 'grep') {
    const pattern = stringOf(args.pattern)
    return { kind: 'search', ...(pattern ? { target: pattern } : {}) }
  }
  if (tool === 'bash') {
    const command = stringOf(args.command) ?? ''
    return { kind: 'verify', verification: verificationKind(command) }
  }
  return undefined
}

function verificationKind(command: string): VerificationKind {
  if (/\b(?:test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/i.test(command)) return 'test'
  if (/\b(?:typecheck|tsc(?:\s|$))\b/i.test(command)) return 'typecheck'
  if (/\b(?:build|vite\s+build|pnpm\s+run\s+build)\b/i.test(command)) return 'build'
  if (/\b(?:lint|eslint|ruff)\b/i.test(command)) return 'lint'
  if (/\b(?:check|verify|validate)\b/i.test(command)) return 'check'
  return 'command'
}

function pathOf(args: Record<string, unknown>): string | undefined {
  const raw = args.file_path ?? args.path
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 300) : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined
}

function isCodeFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|css|scss|vue|svelte)$/i.test(file)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
