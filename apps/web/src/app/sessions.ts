/**
 * 会话列表：数据 + 分组。
 *
 * 两个刻意的选择：
 *
 * 1. **`preview` 是可选的**。后端 `session.list` 现在只给 `sessionId / title / at / lastSeq`
 *    （`SessionMeta`），没有内容预览。所以这里的类型把它写成可选，界面按"有就多一行、
 *    没有就单行"渲染 —— 后端哪天加上这个字段，界面自动变丰满，不用改一行代码。
 *    这比"等字段到了再开始"划算：外形先立住，数据慢慢长。
 *
 * 2. **分组是纯函数**，不碰 transport、不碰 Date.now()（now 由调用方传）。
 *    理由很实际：跨天分组是最容易在跨零点、时区、夏令时上出错的一段逻辑，
 *    写成纯函数才能在单测里把"23:59 和 00:01 算两天"这种边界钉死。
 */

import type { Transport } from '@meng/transport'

export interface SessionSummary {
  sessionId: string
  title: string
  /** 首次活动时间（后端 `SessionMeta.at`）。排序与分组都用它 */
  at: number
  lastSeq: number
  /** 内容预览。后端目前不提供 —— 有就渲染第二行，没有就单行 */
  preview?: string
  /**
   * 这段会话绑在哪个工作区（工作区的 `id`）。
   *
   * 后端 `session.list` 现在**还不给**这个字段（HANDOFF §1.16）。缺 = 不属于任何
   * 工作区 = 侧栏「任务」那一段。给了就按工作区分组 —— 见 `workspaces.ts`。
   */
  workspace?: string
}

/**
 * 新会话的默认名字来自首条消息，而不是后端生成的流水号。
 * 多行消息只取第一行；过长名字保留前 48 个字符，避免撑坏侧栏。
 */
export function sessionTitleFromInput(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const normalized = firstLine.replace(/[\t ]+/g, ' ')
  const chars = Array.from(normalized)
  return chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : normalized
}

export interface SessionGroup {
  key: 'today' | 'yesterday' | 'earlier'
  label: string
  items: SessionSummary[]
}

const DAY = 24 * 60 * 60 * 1000

/** 当天零点。用本地时区 —— 用户说的"今天"是手机上的今天，不是 UTC 的 */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 按「今天 / 昨天 / 更早」分组，组内按时间倒序。
 *
 * 用**日历日**而不是"24 小时窗口"：凌晨 1 点看昨天 23 点的会话，它属于"昨天"，
 * 而不是"刚刚"。后者在聊天类产品里是最常见的违和感来源之一。
 */
export function groupSessions(list: readonly SessionSummary[], now: number): SessionGroup[] {
  const today = startOfDay(now)
  const yesterday = today - DAY

  const buckets: Record<SessionGroup['key'], SessionSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  }

  for (const s of list) {
    const day = startOfDay(s.at)
    if (day >= today) buckets.today.push(s)
    else if (day >= yesterday) buckets.yesterday.push(s)
    else buckets.earlier.push(s)
  }

  const labels: Record<SessionGroup['key'], string> = {
    today: '今天',
    yesterday: '昨天',
    earlier: '更早',
  }

  return (['today', 'yesterday', 'earlier'] as const)
    .map((key) => ({
      key,
      label: labels[key],
      // 组内倒序：最近聊过的排最前。**不改动入参** —— sort 原地排序会污染调用方的数组
      items: [...buckets[key]].sort((a, b) => b.at - a.at),
    }))
    .filter((g) => g.items.length > 0)
}

/** 侧栏任务区默认只展示最近 5 条，超过后折叠。 */
export const TASK_PREVIEW_LIMIT = 5

/**
 * 任务预览。当前会话如果排在 5 条之外，要替换最后一条把它带出来 ——
 * 否则用户点进一条旧任务，侧栏反而找不到当前项。
 */
export function previewTasks(
  list: readonly SessionSummary[],
  activeId: string | undefined,
  limit = TASK_PREVIEW_LIMIT,
): { items: SessionSummary[]; hidden: number } {
  const size = Math.max(0, Math.floor(limit))
  const items = list.slice(0, size)
  if (activeId !== undefined && list.some((item) => item.sessionId === activeId) && !items.some((item) => item.sessionId === activeId)) {
    const active = list.find((item) => item.sessionId === activeId)
    if (active && items.length > 0) items[items.length - 1] = active
  }
  return { items, hidden: Math.max(0, list.length - items.length) }
}

/** 后端返回的脏数据一律兜底，不让一个坏字段把整张列表打空 */
export function normalizeSessions(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return []
  const out: SessionSummary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : ''
    if (!sessionId) continue
    out.push({
      sessionId,
      title: typeof rec.title === 'string' && rec.title ? rec.title : '未命名会话',
      at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
      lastSeq: typeof rec.lastSeq === 'number' && Number.isFinite(rec.lastSeq) ? rec.lastSeq : 0,
      preview: typeof rec.preview === 'string' && rec.preview ? rec.preview : undefined,
      workspace: typeof rec.workspace === 'string' && rec.workspace ? rec.workspace : undefined,
    })
  }
  return out
}

/**
 * 拉会话列表。**失败返回空数组而不是抛** —— 侧栏空着比整页报错好，
 * 列表本身就是次要信息，它挂了不该带走主界面。
 */
export async function listSessions(transport: Transport): Promise<SessionSummary[]> {
  try {
    return normalizeSessions(await transport.invoke('session.list'))
  } catch {
    return []
  }
}

/** 归档只是本机视图状态：不从后端删会话，也不改变会话内容。 */
export const ARCHIVED_SESSIONS_KEY = 'meng.archivedSessions'

export function readArchivedSessions(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ARCHIVED_SESSIONS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))]
  } catch {
    return []
  }
}

export function writeArchivedSessions(ids: readonly string[]): void {
  try {
    localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify(ids))
  } catch {
    // 隐私模式或存储已满时仍保留当前页面里的归档状态。
  }
}
