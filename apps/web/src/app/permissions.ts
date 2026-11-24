/**
 * 权限模式（三档）的**共同词汇**。
 *
 * 为什么单独一份而不是留在设置页里: 现在有**两个地方**要摆这三档 ——
 * 设置页的「工作区」分区, 和输入框下面那条环境栏（用户参考图里的
 * "Default Permissions"）。两处各写一份标签, 迟早一处改了另一处没改,
 * 表现是"设置页说『帮我批准』, 输入框说『自动批准』" —— 同一件事两个名字。
 *
 * 名字是**后端定的**（`packages/config` 里 `sandbox.mode` 的注释）,
 * 前端只负责摆出来。id 从 `schema.enum` 读, 后端加第四档时两处一起多一项。
 */

/** 三档的说法。**和后端 `sandbox.mode` 的注释逐字对齐**，别起第三套名字 */
export const MODE_LABELS: Record<string, string> = {
  ask: '请求批准',
  auto: '帮我批准',
  full: '绝对权限',
}

/**
 * 每一档"会发生什么"。
 *
 * 用户选的是**风险偏好**，而"帮我批准"这种名字本身不解释"批准到什么程度"。
 * 所以每档都要有一句"它到底问什么"。
 */
export const MODE_HINTS: Record<string, string> = {
  ask: '工作区内写文件、改文件、跑命令都先问你；读工作区外也问。',
  auto: '只问高风险的：越界读、越界写、敏感路径（.git / .env / .ssh）。其余自主。',
  full: '不问，也不设围栏。适合在一次性容器里跑。',
}

/** 后端没给 enum 时的兜底（`sandbox.mode` 的三个 id，抄的是 `packages/config`） */
export const MODE_IDS = ['ask', 'auto', 'full'] as const

/** 认不出的一律当 `auto` —— 它是内核的默认值，也是"问该问的"那一档 */
export const MODE_FALLBACK = 'auto'

/**
 * 干净的 JSON Schema 里的枚举值。
 *
 * B-24 §2 之后 `ConfigEntry.schema` 是**真的** JSON Schema, 所以选项可以直接
 * 从 `schema.enum` 读 —— 后端改枚举, 界面自动跟, 不需要改前端。
 * 读不到就返回 undefined（**不猜**）。
 */
export function enumOf(schema: unknown): string[] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  const e = (schema as { enum?: unknown }).enum
  if (!Array.isArray(e)) return undefined
  const out = e.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

/** id 列表 → 下拉/分段用的选项。**顺序照后端给的**（宽严顺序是信息） */
export function permissionOptionsOf(ids: readonly string[] = MODE_IDS): Array<{ value: string; label: string }> {
  return ids.map((id) => ({ value: id, label: MODE_LABELS[id] ?? id }))
}

/** 这一档会不会问。`full` 不问 —— 界面上"越界会被拒绝"只在它以外成立 */
export function modeAsks(mode: string): boolean {
  return mode !== 'full'
}
