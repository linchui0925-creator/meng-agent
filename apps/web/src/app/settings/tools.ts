/**
 * 「工具组」这一页的**纯逻辑**（B-27）。
 *
 * 为什么单独一个文件: 这一页真正会出错的地方不是布局, 而是三件数据活儿 ——
 * 脏数据怎么兜底、一组的用量怎么从逐工具的统计里合出来、"关掉哪些工具"
 * 怎么从"哪几组关着"还原成那个数组。这三件都能在没有 DOM 的情况下测。
 *
 * 一条贯穿的规矩: **后端是唯一真值**。这里不做乐观合并、不缓存、不猜 ——
 * `enabled` 由 `tools.disabled` 推出来（后端算的），前端只负责把它摆出来和改它。
 */

export interface ToolGroup {
  /** `core` / `jobs` / `web`；后端将来加第四组，这里自动多一行 */
  id: string
  /** 这一组里有哪些工具名。界面要把它们列出来 —— 用户凭这个判断"关掉会失去什么" */
  tools: string[]
  enabled: boolean
}

export interface ToolStat {
  tool: string
  count: number
  /** 最近一次用它的时刻。缺 = 内核没给（老版本），那就只说次数 */
  lastAt?: number
}

/**
 * 组 id → 人话。
 *
 * 认不出的 id **原样显示**（`custom` 也比空白强）: 后端加一组而前端还没跟上时,
 * 用户至少知道"有个叫 custom 的组", 而不是看见一行没名字的开关。
 */
export const GROUP_LABELS: Record<string, string> = {
  core: '核心',
  jobs: '后台任务',
  web: '联网',
}

/**
 * 每一组关掉之后**会失去什么**。
 *
 * 这一段是这一页最该说清楚的东西: "core / jobs / web" 三个词本身不解释后果,
 * 而用户是按后果做决定的。core 那句必须够重 —— 关掉它基本等于把助手废了。
 */
export const GROUP_HINTS: Record<string, string> = {
  core: '读文件、改文件、跑命令、提问。关掉它基本没法干活了。',
  jobs: '起后台任务、读它的输出、杀掉它。关掉之后任务起得来，但读不到结果。',
  web: '抓网页。关掉之后模型不能上网。',
}

/** `tools.disabled` 的键名。写在 `KERNEL_CONFIG` 里, 前端只当字符串用 */
export const DISABLED_KEY = 'tools.disabled'

/**
 * 把后端下发的组列表收拾干净。
 *
 * 三条兜底，每一条都对应一种真实会发生的脏数据:
 *   ① 不是数组 / 元素不是对象 → 丢掉（老内核可能返回 undefined）
 *   ② `tools` 里混了非字符串 → 只留字符串（不然渲染时 `code` 里会出现 [object Object]）
 *   ③ 缺 `enabled` → 当**开着**。默认关会让用户莫名少一半工具，而"多给了工具"
 *      最多是 prompt 长一点。
 */
export function normalizeGroups(raw: unknown): ToolGroup[] {
  if (!Array.isArray(raw)) return []
  const out: ToolGroup[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id === '') continue
    const tools = Array.isArray(rec.tools) ? rec.tools.filter((t): t is string => typeof t === 'string') : []
    out.push({ id: rec.id, tools, enabled: rec.enabled !== false })
  }
  return out
}

/** 同理：统计里的脏数据不能把整页带崩 —— 它只影响"用过几次"那行小字 */
export function normalizeStats(raw: unknown): ToolStat[] {
  if (!Array.isArray(raw)) return []
  const out: ToolStat[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.tool !== 'string' || rec.tool === '') continue
    const count = typeof rec.count === 'number' && Number.isFinite(rec.count) && rec.count > 0 ? rec.count : 0
    out.push({
      tool: rec.tool,
      count,
      ...(typeof rec.lastAt === 'number' && Number.isFinite(rec.lastAt) ? { lastAt: rec.lastAt } : {}),
    })
  }
  return out
}

/**
 * 一组的总用量。
 *
 * **次数相加、时间取最晚** —— 不能取平均: "这一组最近什么时候被动过"是一个
 * 存在性问题, 平均值会让"三天前用过一次 + 刚刚用过一次"看起来像"一天半前"。
 */
export function groupUsage(group: ToolGroup, stats: readonly ToolStat[]): { count: number; lastAt?: number } {
  let count = 0
  let lastAt: number | undefined
  for (const tool of group.tools) {
    const stat = stats.find((s) => s.tool === tool)
    if (stat === undefined) continue
    count += stat.count
    if (stat.lastAt !== undefined && (lastAt === undefined || stat.lastAt > lastAt)) lastAt = stat.lastAt
  }
  return { count, ...(lastAt === undefined ? {} : { lastAt }) }
}

/**
 * 「用过 34 次 · 4 分钟前」。
 *
 * `count === 0` 时说**"还没用过"**而不是"用过 0 次": 后者读起来像"用过, 但次数是 0",
 * 而这一行存在的意义是帮用户判断"关掉它我会不会疼"。
 * 没有 `lastAt` 就只说次数 —— 编一个时间比少说一句更糟。
 */
export function usageText(count: number, lastAt: number | undefined, now: number): string {
  if (count <= 0) return '还没用过'
  if (lastAt === undefined) return `用过 ${count} 次`
  return `用过 ${count} 次 · ${relativeTime(lastAt, now)}`
}

/** 相对时间。只到"天"这一档 —— 工具用量不需要比这更细 */
export function relativeTime(at: number, now: number): string {
  const diff = now - at
  if (!Number.isFinite(diff) || diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 当前关着的那几组 → 要写进 `tools.disabled` 的工具名。
 *
 * **排序去重**不是洁癖: 这个数组会被写进设置文件, 顺序不稳的话用户每点一次
 * 开关, 配置文件里就多一行"看起来变了但语义没变"的 diff。
 */
export function disabledOf(groups: readonly ToolGroup[]): string[] {
  const set = new Set<string>()
  for (const g of groups) if (!g.enabled) for (const t of g.tools) set.add(t)
  return [...set].sort()
}

/** 点一下开关。只翻这一个，别的原样 —— 返回新数组，不改入参 */
export function toggleGroup(groups: readonly ToolGroup[], id: string): ToolGroup[] {
  return groups.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))
}

/** core 被关掉了没有。关掉它要在页面上挂一句重话 */
export function coreOff(groups: readonly ToolGroup[]): boolean {
  return groups.some((g) => g.id === 'core' && !g.enabled)
}
