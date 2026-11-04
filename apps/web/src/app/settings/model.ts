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

/** `200000` → `200K`，`1000000` → `1M`。**不知道就返回 undefined**，不返回 `—` */
export function formatTokens(n?: number): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
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
