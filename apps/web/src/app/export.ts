/**
 * 会话导出：把投影出来的消息拼成一份 Markdown。
 *
 * 为什么从**消息**导出而不是从事件: 消息是事件的投影（`conversation.ts`），
 * 用户要的是"我看到的这段对话", 不是"内核发过的 47 个 chunk"。事件里有
 * `llm/chunk` 这种中间态, 直接倒出来没人看得懂。
 *
 * 为什么是 Markdown 而不是 JSON: 导出多半是为了贴进 issue、发给同事、或者存进
 * 笔记。JSON 是给程序看的, 而这个功能是给人在别处继续用的。
 *
 * 纯函数, 不碰 DOM —— 拼串那部分要能单测, 下载那一步留在组件里。
 */

import type { Message, ToolCall } from './conversation.ts'

export interface ExportMeta {
  /** 会话标题。空的话用 sessionId */
  title: string
  /** 导出时刻（毫秒） */
  at: number
}

/**
 * 单个工具输出最多留这么多字。
 *
 * 一次 `read` 可以回 300 行、一次 `bash` 可以回几万行。整份塞进去的结果是
 * 导出文件几十 KB、打开就卡, 而**看的人只想知道"它跑了什么、成没成"**。
 * 截断处写明原文多长, 需要细节的人可以回去看界面。
 */
const MAX_TOOL_CHARS = 4000

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `2026-11-16 14:30`。本地时区 —— 导出是给人看的, 不是给日志对齐用的 */
export function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `20261116-1430`，用在文件名里 */
function stampCompact(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * 文件名。**去掉文件系统不认的字符**, 空标题回落成「会话」——
 * 中文标题里的 `:`、`/`、`?` 在 macOS/Linux 上会直接把文件名截断或建不出来。
 */
export function exportFileName(title: string, at: number): string {
  const slug = title
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `梦-${slug === '' ? '会话' : slug}-${stampCompact(at)}.md`
}

/** 工具调用的参数。原样 JSON —— 导出是给人核对的, 不是给程序解析的 */
function argsOf(tool: ToolCall): string {
  if (tool.args === undefined) return ''
  try {
    return JSON.stringify(tool.args)
  } catch {
    return ''
  }
}

function toolBlock(tool: ToolCall): string {
  const lines: string[] = []
  const args = argsOf(tool)
  lines.push(`#### 工具 · ${tool.tool}${args === '' ? '' : ` ${args}`}`)
  if (tool.status === 'running') lines.push('> 还没跑完（导出时仍在运行）')
  if (tool.status === 'blocked') lines.push(`> 被拒绝：${tool.reason ?? '没有说明'}`)
  if (tool.status === 'done') {
    const text = typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? '')
    const body = text.trim()
    if (body === '') {
      lines.push('> 没有输出')
    } else {
      const cut = body.length > MAX_TOOL_CHARS
      lines.push('```text')
      lines.push(cut ? body.slice(0, MAX_TOOL_CHARS) : body)
      lines.push('```')
      if (cut) lines.push(`> 输出已截断：原文 ${body.length} 字`)
    }
  }
  return lines.join('\n')
}

export function exportMarkdown(messages: readonly Message[], meta: ExportMeta): string {
  const out: string[] = []
  out.push(`# ${meta.title.trim() === '' ? '会话' : meta.title.trim()}`)
  out.push('')
  out.push(`> 导出自梦 · ${stamp(meta.at)} · ${messages.length} 条消息`)

  for (const m of messages) {
    const hasText = m.text.trim() !== ''
    if (!hasText && m.tools.length === 0 && m.status !== 'error') continue
    out.push('')
    out.push(m.role === 'user' ? '## 你' : '## 助手')
    out.push('')
    if (hasText) out.push(m.text.trimEnd())
    for (const tool of m.tools) {
      out.push('')
      out.push(toolBlock(tool))
    }
    if (m.status === 'error') {
      out.push('')
      out.push(`> ⚠️ 出错（${m.errorCode ?? 'error'}）：${m.error ?? '没有说明'}`)
    }
  }

  out.push('')
  return out.join('\n')
}
