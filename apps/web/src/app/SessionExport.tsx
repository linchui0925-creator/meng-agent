/**
 * 侧栏会话行上的「导出」按钮（挂在 `sidebar.item.actions` 槽位）。
 *
 * 为什么是槽位而不是写死在侧栏里: 那个位置本来就是留给"会话级动作"的
 * （重命名 / 删除 / 导出）, 侧栏只管摆位, 动作由插件注册。这样将来"删除会话"
 * 只需要再注册一个, 不用动侧栏。
 *
 * 为什么导出**不需要后端新接口**: `session.read` 已经能拿到整条事件流,
 * 而消息是它的事件投影。后端加一个 `session.export` 只会让同一份数据有两条路。
 */

import { useState } from 'react'
import { IconButton, Tooltip } from '@meng/ui'
import type { StreamEvent } from '@meng/transport'

import { project } from './conversation.ts'
import { exportFileName, exportMarkdown } from './export.ts'
import { DownloadIcon } from './icons.tsx'

/** 触发一次浏览器下载。**不挂到 DOM 上** —— 挂上去再点会留下一个看不见的 <a> */
function download(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 立刻 revoke 在部分浏览器上会把还没开始的下载掐掉; 下一轮事件循环再收
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function SessionExport({
  sessionId,
  title,
  invoke,
}: {
  sessionId?: string
  title?: string
  invoke: (op: string, payload?: unknown) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function run(): Promise<void> {
    if (sessionId === undefined || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const events = await invoke('session.read', { sessionId })
      const list = Array.isArray(events) ? (events as StreamEvent[]) : []
      const at = Date.now()
      const name = title !== undefined && title !== '' ? title : sessionId
      download(exportMarkdown(project(list), { title: name, at }), exportFileName(name, at))
    } catch (err) {
      // 失败要说出来: 点了没反应和"导出成功了但文件在哪"分不清
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip label={error !== undefined ? `导出失败：${error}` : '导出为 Markdown'}>
      <IconButton
        size="sm"
        aria-label="导出会话"
        data-export-session={sessionId ?? ''}
        disabled={busy}
        onClick={() => void run()}
      >
        <DownloadIcon />
      </IconButton>
    </Tooltip>
  )
}
