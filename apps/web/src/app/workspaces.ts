/**
 * 工作区：数据形状 + 侧栏分组。
 *
 * 为什么单独一个文件: 「一个会话属于哪个工作区」是这一轮唯一一处**跨数据源**的
 * 判断（会话列表 × 工作区列表），而它同时决定侧栏怎么分组、新建会话带哪个目录。
 * 写成纯函数才能在 node 里把边界钉死 —— 比如"会话指向一个已经不存在的工作区"
 * 时该退化成普通任务，而不是从列表里消失。
 *
 * ── 和后端的关系（B-28，2026-11-19 起）──
 * `session.list[].workspace` / `workspace.list` 已经有了，界面按"有就分组、没有就平铺"
 * 渲染。字段仍然可选：老内核或普通任务不该因此报错，也不该被塞进一个空工作区。
 * 契约见 HANDOFF §1.16 / B-28。
 */

import { activityAtOf, sortSessionsByActivity, type SessionSummary } from './sessions.ts'

export interface Workspace {
  id: string
  /** 给人看的名字。缺就回落成路径的最后一段 */
  name: string
  /** 绝对路径。界面上不常显示，但它是这个工作区的**身份** */
  path: string
}

/** 路径的最后一段。`/Users/x/梦` → `梦`；末尾有斜杠也认 */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  // 根目录（`/`、`C:\`）去掉斜杠之后什么都不剩 —— 那就把原串还回去。
  // 返回空串会让工作区名字变成空白，而它明明有一个名字叫「/」
  if (trimmed === '') return path
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const last = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return last === '' ? trimmed : last
}

/**
 * 后端返回的工作区列表。**脏数据一律跳过**，不让一个坏字段把整块打空。
 *
 * `id` 缺了就用路径当 id —— 路径本身就是稳定的身份，比让后端再造一个 uuid 好：
 * 换一个 uuid 意味着"同一个目录"在两次启动之间变成两个工作区。
 */
export function normalizeWorkspaces(raw: unknown): Workspace[] {
  // B-28 真后端给 `{ workspaces: [...] }`；数组是早期 fixture 的形状，继续兼容，
  // 但两种入口最后只能走同一份逐项校验，不能让包裹对象被当成“没有工作区”。
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { workspaces?: unknown }).workspaces)
      ? (raw as { workspaces: unknown[] }).workspaces
      : []
  const out: Workspace[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const path = typeof rec.path === 'string' ? rec.path.trim() : ''
    const id = typeof rec.id === 'string' && rec.id !== '' ? rec.id : path
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof rec.name === 'string' && rec.name !== '' ? rec.name : basenameOf(path || id)
    out.push({ id, name, path: path === '' ? id : path })
  }
  return out
}

export interface SessionSplit {
  /** 不属于任何工作区的会话（参考图里的「Tasks」） */
  tasks: SessionSummary[]
  /** 每个工作区一组，只保留**真有会话**的那些，按最近活动时间倒序 */
  groups: Array<{ workspace: Workspace; items: SessionSummary[] }>
}

/**
 * 按工作区切开会话。
 *
 * 三条规矩:
 *   1. **认不出工作区的会话归到任务里**，不是丢掉。工作区被删了、字段是老数据、
 *      或者后端给了个没在列表里的 id —— 三种情况用户都还想看见那段对话。
 *   2. **空工作区不进侧栏**。它没有内容可展开，占一个分组标题只是噪音
 *      （要"在这个目录里开新会话"是输入框那个选择器的事）。
 *   3. 组内和组间都按最近活动倒序 —— 和工作区本身的创建顺序无关。
 */
export function splitByWorkspace(
  sessions: readonly SessionSummary[],
  workspaces: readonly Workspace[],
): SessionSplit {
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const tasks: SessionSummary[] = []
  const buckets = new Map<string, SessionSummary[]>()

  for (const s of sessions) {
    const id = s.workspace
    if (id === undefined || !byId.has(id)) {
      tasks.push(s)
      continue
    }
    const list = buckets.get(id) ?? []
    list.push(s)
    buckets.set(id, list)
  }

  const groups = [...buckets.entries()]
    .map(([id, items]) => ({
      workspace: byId.get(id)!,
      items: sortSessionsByActivity(items),
    }))
    .sort((a, b) => activityAtOf(b.items[0] ?? { at: 0 }) - activityAtOf(a.items[0] ?? { at: 0 }))

  return { tasks: sortSessionsByActivity(tasks), groups }
}

/**
 * 输入框那个「工作区」选择器显示什么。
 *
 * 三种情况:
 *   · 选中了某个工作区 → 它的名字
 *   · 没选 → 「不指定目录」——**不要**显示成"默认"，那会让人以为有个隐藏的默认值
 *   · 选中的工作区已经不在列表里（被删了）→ 仍然显示它的 id，让人看得出这条会话
 *     指向一个不存在的地方，而不是悄悄变回"不指定"
 */
export function workspaceLabelOf(
  id: string | undefined,
  workspaces: readonly Workspace[],
): string {
  if (id === undefined) return '不指定目录'
  const found = workspaces.find((w) => w.id === id)
  return found === undefined ? id : found.name
}
