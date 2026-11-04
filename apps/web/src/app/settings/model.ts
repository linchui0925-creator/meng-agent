/**
 * 模型分区要的数据形状 —— **手写的镜像，不是从后端包 import 的类型**。
 *
 * 为什么不用 `import type { CatalogProvider } from '@meng/config'`:
 * 类型擦除只保证运行时不多一行代码, 而 typecheck 仍要把那个包的整张类型图解析一遍
 * （`ConfigItem = z.ZodType` 会把 zod 拖进来）。前端不装 zod 这条线是刻意的,
 * 不该从类型这一侧又开个口子。
 *
 * 代价写清楚: 后端改了形状, 这里**不会**报错, 要对着 docs/06 手动跟。
 * 所以下面每个字段都注了「缺了怎么画」—— 形状变了最容易漏的正是"缺失语义"。
 *
 * 与后端一致的两条铁律（B-21）:
 *   · 容量字段缺 = **不知道**, 不是 0, 也不是"不支持"。别补默认值。
 *   · 顺序 = 后端给的顺序（活着的在前, 可添加的在后）。前端不重排:
 *     重排会让供应商每次启动都可能换位置。
 */

/** 一个模型条目。除了 id/name 之外全部可缺 —— 缺就是"我们不知道" */
export interface ModelInfo {
  id: string
  /** 给人看的名字。缺就回落成 id */
  name?: string
  /** 上下文总量（token） */
  contextWindow?: number
  /** 单轮最大输出（token） */
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoning?: boolean
  description?: string
}

/** 一条配置项。字段来自 `packages/config` 的 `ConfigEntry`（见 docs/06 §1.3） */
export interface ConfigEntry {
  key: string
  scope: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  /** 只对标量给。对象/数组的默认值去 `schema.default` 拿 */
  default?: string | number | boolean
  secret: boolean
  required: boolean
  desc?: string
  /** 当前生效值。密钥行恒 undefined；对象配置是对象，**别做字符串拼接** */
  value?: unknown
  source?: 'settings' | 'env' | 'manifest' | 'default'
  secretRef?: string
  present?: boolean
  unresolved?: string
  schema?: unknown
}

/** 一家供应商在目录里的样子 */
export interface CatalogProvider {
  id: string
  name: string
  /** 不参与路由，只用于显示/分组 */
  protocol?: string
  models: ModelInfo[]
  available: boolean
  /** true = 内置目录里有、配置里还没加。**不是**"缺 key"，`config` 恒为 [] */
  dormant?: boolean
  /** true = 用户自己加的（不在内置目录里） */
  declared?: boolean
  /** 点「添加」时往哪儿写: `['routes', 'zai']` */
  configPath?: string[]
  /** 激活它时写进配置的初始 profile（原样写，别自己补字段） */
  template?: Record<string, unknown>
  configScope?: string
  config: ConfigEntry[]
  missing: string[]
}

/**
 * 界面上的四种态。
 *
 * `dormant` 必须最先判 —— 它同时满足 `available: false`，判晚了就会被
 * 画成"缺 key 的供应商"，而两者要给的行动完全不同（一个点添加，一个去配 key）。
 *
 * `fixed`（没有 `configScope`）在设置页里**不渲染** —— `shownProviders` 会先滤掉它。
 * 这里仍然判出来, 是因为它是数据层真实存在的一种态: 诊断面板、内核自检要能回答
 * "这家为什么不可配"。界面不画 ≠ 数据里没有。
 */
export type ProviderState = 'available' | 'unconfigured' | 'dormant' | 'fixed'

export function stateOf(p: CatalogProvider): ProviderState {
  if (p.dormant) return 'dormant'
  // 没有 configScope = 没有可配的东西（mock 这类）。它不是"缺配置"，是"不用配"
  if (!p.configScope) return p.available ? 'fixed' : 'unconfigured'
  return p.available ? 'available' : 'unconfigured'
}

export const STATE_LABEL: Record<ProviderState, string> = {
  available: '可用',
  unconfigured: '未配置',
  dormant: '可添加',
  fixed: '可用',
}

/** 头行那个字母章。中文名就取首字 —— 比硬塞一个图标更像"这一家" */
export function stampOf(name: string): string {
  const first = [...name.trim()][0] ?? '?'
  return first.toUpperCase()
}

/**
 * 头行右侧的模型摘要。
 *
 * 用 `name` 不用 `id`: 目录里的 id 是 `glm-4.7` 这种, 而界面上要给人看的是 `GLM-4.7`。
 * 这也是 B-21 破坏性变更的落点 —— 老的 `models.join(', ')` 现在会得到 `[object Object]`。
 */
export function modelSummary(models: ModelInfo[], max = 3): string {
  if (models.length === 0) return '目录里还没有模型'
  const names = models.slice(0, max).map((m) => m.name || m.id)
  const rest = models.length - names.length
  return names.join(' · ') + (rest > 0 ? ` +${rest}` : '')
}

/** `200000` → `196K`，`1048576` → `1M`（1024 的倍数不该说成 "1.0M"）。**不知道就返回 undefined** */
export function formatTokens(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  if (n >= 1_000_000) {
    // 先四舍五入到一位再拼 —— `1.048576.toFixed(1)` 得到 "1.0", 那个 ".0"
    // 会让人以为"精确到 1.0M", 而实际是 1048576。整数值就别带小数
    const m = Math.round((n / 1_000_000) * 10) / 10
    return `${m}M`
  }
  if (n >= 1000) return `${Math.round(n / 1024)}K`
  return String(n)
}

/** 目录里最大的一档上下文。全都没容量就返回 undefined（**别显示 0**） */
export function widestContext(models: ModelInfo[]): number | undefined {
  let max: number | undefined
  for (const m of models) {
    if (m.contextWindow !== undefined && (max === undefined || m.contextWindow > max)) max = m.contextWindow
  }
  return max
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 接口地址。
 *
 * 两种存法都要认, 因为后端有两类插件:
 *   · 单路由（deepseek）: 配置项里就有一条扁平的 `baseURL`
 *   · 路由字典（openai）: 只有一个 `routes` 项, 地址在 `routes[id].baseURL`
 * 不认第二种的话, 用户自己加的网关会显示成"没有地址"。
 */
export function endpointOf(p: CatalogProvider): string | undefined {
  const flat = p.config.find((e) => e.name === 'baseURL')
  if (flat && typeof flat.value === 'string' && flat.value) return flat.value

  const routes = p.config.find((e) => e.name === 'routes')
  const one = isRecord(routes?.value) ? routes.value[p.id] : undefined
  if (isRecord(one) && typeof one.baseURL === 'string' && one.baseURL) return one.baseURL
  return undefined
}

/**
 * 密钥绑定的环境变量名 + 那一行"有没有值"。
 *
 * `present` 只有扁平密钥项才给; 路由字典里的 `apiKeyEnv` 没有 present,
 * 这时用 `available` 兜底 —— 它本来就是这个意思（有 key 才可用）。
 */
export function secretOf(p: CatalogProvider): { env?: string; present?: boolean } {
  const flat = p.config.find((e) => e.secret)
  if (flat?.secretRef) return { env: flat.secretRef, present: flat.present }

  const routes = p.config.find((e) => e.name === 'routes')
  const one = isRecord(routes?.value) ? routes.value[p.id] : undefined
  if (isRecord(one) && typeof one.apiKeyEnv === 'string' && one.apiKeyEnv) {
    return { env: one.apiKeyEnv, present: p.available }
  }
  return {}
}

/** 异常 → 一行能直接显示给人看的话。后端 message 本来就是给人看的, 别改写它 */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return '不知道出了什么错'
}

/**
 * 设置页里真正要画出来的供应商。
 *
 * 滤掉「没有配置项、也没有模板」的那一类 —— `mock` 就是这种: 装着就能用,
 * 没有任何可配的东西。它在设置页里**什么事都做不了**, 占一行只制造两个误解:
 * 「这家是不是缺了什么」和「为什么它跟我一样是供应商」。
 *
 * 判断放在前端而不是求后端别下发, 因为这只是**界面投影**: `llm.catalog`
 * 一个字段都没少, 换一个界面（诊断面板 / 内核自检）照样能看见它。
 * 代价是规则藏在渲染层 —— 所以它必须是一个能被单测钉住的纯函数, 而不是
 * 散在 JSX 里的一个 `if`。
 */
export function shownProviders(list: CatalogProvider[]): CatalogProvider[] {
  return list.filter((p) => p.dormant === true || p.configScope !== undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// 自定义 API: 表单 → 路由
//
// 后端**不需要新接口**: `routes` 是 `z.record(string, RouteSchema)`,
// 写一个新的键就是多一家供应商（`config.set` 一条就够）。所以这一整块
// 是纯前端的事 —— 但换算规则必须是纯函数, 否则"填了保存不了"只能靠手点。
// ─────────────────────────────────────────────────────────────────────────────

/** 「新建自定义 API」表单里的四个格子。`models` 是逗号/空白分隔的一行文本 */
export interface CustomDraft {
  name: string
  baseURL: string
  apiKeyEnv: string
  models: string
}

export const EMPTY_DRAFT: CustomDraft = {
  name: '',
  baseURL: '',
  apiKeyEnv: 'CUSTOM_API_KEY',
  models: '',
}

/** 环境变量名。**只收合法标识符** —— 写错了它永远是"没有值", 而界面上看不出区别 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type DraftErrors = Partial<Record<keyof CustomDraft, string>>

/**
 * 表单校验。空对象 = 可以保存。
 *
 * 判据全部来自后端的 `RouteSchema`, 一条都不多: `baseURL` 有 `minLength: 1`
 * （这里再要求 `http(s)://` 是因为"填个 `api.xxx.com`"是最常见的错,
 * 而它会在发请求时才炸, 报错离现场很远）。
 *
 * 名称**不能空**: 它是界面上的标题, 也是路由 id 的来源。允许空的话会掉到
 * `custom` 这种名字上, 用户之后没法分辨哪个是自己的哪一个。
 */
export function draftErrors(draft: CustomDraft): DraftErrors {
  const out: DraftErrors = {}
  if (draft.name.trim() === '') out.name = '给它起个名字，之后你靠这个名字认它'
  if (draft.baseURL.trim() === '') out.baseURL = '填接口地址，例如 https://api.example.com/v1'
  else if (!/^https?:\/\//i.test(draft.baseURL.trim())) out.baseURL = '要以 http:// 或 https:// 开头'
  if (!ENV_NAME.test(draft.apiKeyEnv.trim())) out.apiKeyEnv = '变量名只能用字母、数字、下划线，且不能以数字开头'
  return out
}

/**
 * 路由 id —— 用户填的名字到配置键。
 *
 * **为什么要 slug 而不是让用户填路由名**: 路由名是给程序看的（`model` 点名、
 * 日志里显形）。让用户理解"键名不能有空格和中文"是在为我们的数据结构收税。
 * 中文/纯符号的名字 slug 出来是空的, 那时回落 `custom` + 序号 —— 宁可是个
 * 没意义的名字, 也不能是空键（空键在 JSON 里合法, 但设置页会画不出来）。
 */
export function routeIdOf(name: string, taken: readonly string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom'

  const used = new Set(taken)
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** 模型那一行: 逗号 / 空格 / 换行都算分隔。空字符串 = 一个都不填（合法） */
export function parseModelIds(text: string): string[] {
  return [...new Set(text.split(/[,\s，、]+/).map((s) => s.trim()).filter(Boolean))]
}

/**
 * 表单 → 写进 `routes[id]` 的那份 profile。
 *
 * 只写**用户真填了的** + 后端 schema 里有 `.default()` 的那几个。后者要写全,
 * 因为带 default 的字段在输出类型里是必填 —— 漏了它, 后端 parse 会补上默认值,
 * 但那是后端的假设, 不该由前端"以为"。
 */
export function profileOfDraft(draft: CustomDraft, id: string): Record<string, unknown> {
  const ids = parseModelIds(draft.models)
  return {
    displayName: draft.name.trim() || id,
    // 目前后端只实现了这一种 wire 协议（`RouteSchema` 里 enum 只有它）。
    // 等它多一种, 这里要跟着改成表单里的一个选择框 —— 那时 schema 的 enum 就是选项源。
    protocol: 'openai-completions',
    baseURL: draft.baseURL.trim(),
    apiKeyEnv: draft.apiKeyEnv.trim(),
    // 一条模型都不填也行: 后端会用目录/兜底（`modelsOf`），但界面上会显示成
    // 兜底那一条的名字。填了才是用户想要的清单，所以提示里让他填。
    models: ids.map((id2) => ({ id: id2 })),
    modelOverrides: {},
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    headers: {},
  }
}

