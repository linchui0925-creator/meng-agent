import type { Ctx, Disposer } from '@meng/core'
import type { PromptService } from '@meng/prompt'
import { dedupeMarkers, hasValidationAfterLastWrite, snapshotCurrentRun, type RunMarker } from '@meng/run-state'
import type { SessionService } from '@meng/session'
import { getTaskRouter } from '@meng/task-router'

export const name = 'meng-plugin-evidence-workbench'
export const inject = ['session', 'prompt']

export interface Config {
  maxMarkers?: number
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const session = ctx.get<SessionService>('session')
  const prompt = ctx.get<PromptService>('prompt')
  if (!session || !prompt) throw new Error('evidence-workbench 需要 session / prompt')
  const maxMarkers = Math.max(4, Math.floor(config.maxMarkers ?? 24))

  return prompt.section({
    id: 'task/evidence',
    order: 147,
    render: (_ctx, input) => {
      if (!input?.sessionId) return ''
      const route = getTaskRouter(ctx)?.current(input.sessionId)
      if (route?.mode === 'answer') return ''
      const snapshot = snapshotCurrentRun(session.read(input.sessionId))
      if (!snapshot || snapshot.markers.length === 0) return ''
      const shown = dedupeMarkers(snapshot.markers).slice(-maxMarkers)
      const hidden = Math.max(0, dedupeMarkers(snapshot.markers).length - shown.length)
      const lines = [
        '<task-evidence>',
        '这里只记录任务动作状态，不包含工具输出正文。它用于防止重复读取，不代表相关文件已经被完整理解。',
        `modified_files: ${snapshot.modifiedFiles.length ? snapshot.modifiedFiles.join(', ') : 'none'}`,
        `validation_after_last_write: ${hasValidationAfterLastWrite(snapshot) ? 'yes' : 'no'}`,
        ...shown.map(markerLine),
        ...(hidden > 0 ? [`- … 还有 ${hidden} 条较早状态已折叠`] : []),
        '</task-evidence>',
      ]
      return lines.join('\n')
    },
  })
}

function markerLine(marker: RunMarker & { count: number }): string {
  const target = marker.target ? ` · ${marker.target}` : ''
  const verification = marker.verification && marker.verification !== 'command'
    ? ` · ${marker.verification}`
    : ''
  const count = marker.count > 1 ? ` · x${marker.count}` : ''
  return `- ${marker.kind}: ${marker.tool}${target}${verification} · ${marker.status}${count}`
}
