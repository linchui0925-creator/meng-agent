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
  output?: Array<'text' | 'image'>
  reasoning?: boolean
  reasoningEfforts?: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  description?: string
  /**
   * 这个模型走哪种 wire 协议（B-22 新增）。
   *
   * **别把它当成"这家的协议"** —— 同一条路由下可以混几种（目录里的 `opencode`
   * 58 个模型分属 4 种）。这里只收下来，不参与渲染：一条路由一个协议，
   * 逐模型标协议反而会让人以为能逐模型切换。
   */
  api?: string
}

/**
 * 一条 wire 协议。`llm.protocols` 的下发形状（B-22 / B-23）。
 *
 * `listable` 是**派生**的（后端按 `listerOf()` 算）：端点上有可读的模型列表。
 * 「获取可用模型」按钮亮不亮只看它 —— 不看协议 id 的字符串。
 */
export interface ProtocolInfo {
  id: string
  /** 给人看的一行 */
  label: string
  listable: boolean
  /** 这条协议还缺哪些**配置形状表达不了**的东西。空/缺 = 一个 key 就能跑 */
  needs?: string[]
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
  /**
   * **可添加的（dormant）现在不带这个字段**（B-26 目录瘦身：199 KB → 26 KB）。
   * `undefined` = 没下发, 不是"没有模型" —— 要看就调 `llm.discoverModels({provider})`,
   * 目录命中时 0ms、不联网。
   */
  models?: ModelInfo[]
  /** 目录里这家有多少款。清单没下发时用它说"点添加会带来 6 款" */
  modelCount?: number
  available: boolean
  /** 模型清单来源：目录 / 厂商实时 / 手动 / 拉取失败 */
  modelSource?: 'catalog' | 'endpoint' | 'manual' | 'error'
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
  return list.filter((p) => !HIDDEN_IDS.has(p.id) && (p.dormant === true || p.configScope !== undefined))
}

/**
 * 用户明确要求不显示的。
 *
 * 三条判据, 各有各的理由:
 *
 *   · `openai` / `anthropic` —— **它们是协议, 不是供应商**（用户 2026-11-16 拍板）。
 *     pi 的目录里确实有这两家（38 款 gpt-5 / 15 款 claude）, 但把它们和 DeepSeek、
 *     Z.AI、Moonshot 并排摆着, 等于把"协议轴"混进了"厂商轴": 用户看到的是
 *     「OpenAI」和「OpenAI 兼容」两个近义的东西, 而真正想问的是"我接哪一家"。
 *     官方端点走「自定义 API」+ 对应协议即可 —— 那条路本来就存在。
 *     代价写清楚: 内核的**默认路由**（id 也是 `openai`）因此没有界面入口了。
 *     它是"什么都还没配时内核自己用的那条", 正常情况下用户配了别的家就用不到它。
 *
 *   · `mock` —— 没有可配的东西（见上面 `shownProviders`）。
 *
 * 和上面那类过滤一样, 这只是**界面投影**: `llm.catalog` 一个字段没少,
 * 诊断面板 / 内核自检照样看得见它们。代价是这条规则藏在渲染层 ——
 * 所以它必须是一个能被单测钉住的纯函数, 不是 JSX 里的一个 `if`。
 */
const HIDDEN_IDS = new Set(['openai', 'anthropic', 'mock'])

// ─────────────────────────────────────────────────────────────────────────────
// 详情面板: 当前值 ↔ 编辑框
//
// 后端有**两种**存法, 详情面板必须两种都认, 否则会有一类供应商"打开就是空框":
//   · 路由字典（openai 那类）: 整张 `routes` 是一个配置项, 一家是字典里的一个键
//   · 扁平（deepseek）: 每家一个 scope, 地址/密钥名/温度各是一行配置
// ─────────────────────────────────────────────────────────────────────────────

/** 详情面板里能改的那三项。`undefined` = 后端没这一项, **那一行不画** */
export interface RouteDraft {
  baseURL: string
  /** 密钥绑定的**环境变量名**，不是密钥本身 */
  env: string
  /** 空字符串 = 没设。后端没有这一项时整个字段是 undefined */
  temperature?: string
}

/**
 * 这条路由写在哪儿。
 *
 * **后端只对"可添加"的条目下发 `configPath`；已经添加的那些不带。**
 * （`packages/web/src/catalog.ts` 的 `catalogOf`: `providers` 那段没有
 * configPath，只有 `directory` 那段才有。）
 *
 * 直接后果: 只认 `configPath` 的话, 已添加的路由会被当成"扁平配置",
 * 保存时往 `llm.openai.baseURL` 这种**不存在的键**上写 —— 界面显示"保存成功",
 * 而配置一个字都没变。这个 bug 就是在它上面长出来的。
 *
 * 所以这里补一条推断: 在同一个 scope 的配置项里找"值是以这一家的 id 作键的
 * 那个对象"。找到 = 它住在那张字典里。找不到 = 它真是扁平的（deepseek 那种,
 * scope 里全是标量项）。
 *
 * 推断而不是硬编码 `llm.openai.routes`: 换一个插件管路由表, 这里跟着数据走。
 * 后端哪天给已添加的条目也补上 `configPath`, 第一分支就接管了, 这段不会挡路。
 *
 * `scope` 一起带出来, 是因为「获取可用模型」的 payload 必须有它（探测器按 scope
 * 注册）。让调用方从 `key` 里切 scope 是错的 —— scope 名自己带点
 * （`llm.deepseek`）, 按点切必然切错, 这个坑后端踩过一次。
 */
export function routeTargetOf(
  p: CatalogProvider,
): { scope: string; key: string; dictKey: string; id: string } | undefined {
  if (!p.configScope) return undefined
  if (p.configPath?.length) {
    return {
      scope: p.configScope,
      key: `${p.configScope}.${p.configPath[0]}`,
      dictKey: p.configPath[0]!,
      id: p.configPath[1] ?? p.id,
    }
  }
  for (const e of p.config) {
    if (e.type === 'object' && isRecord(e.value) && p.id in e.value) {
      return { scope: p.configScope, key: e.key, dictKey: e.name, id: p.id }
    }
  }
  return undefined
}

/**
 * 读这条路由现在生效的值。
 *
 * 密钥名在扁平那种里**不能读 `value`** —— 密钥行的 `value` 恒 `undefined`
 * （docs/06 §1.3）, 名字在 `secretRef` 里。读 `value` 的话那一格永远是空的,
 * 而它明明有一个正在用的变量名。
 */
export function routeDraftOf(p: CatalogProvider): RouteDraft {
  // ① 住在一张字典里（已添加的、以及还没添加但有 configPath 的）
  const slot = routeTargetOf(p)
  if (slot) {
    const dict = p.config.find((e) => e.name === slot.dictKey)?.value
    const one = isRecord(dict) ? dict[slot.id] : undefined
    if (isRecord(one)) {
      return {
        baseURL: typeof one.baseURL === 'string' ? one.baseURL : '',
        env: typeof one.apiKeyEnv === 'string' ? one.apiKeyEnv : '',
        temperature: typeof one.temperature === 'number' ? String(one.temperature) : '',
      }
    }
    // 还没写进配置（可添加的那类）→ 用它的模板当"将要写的东西"
    const t = p.template
    return {
      baseURL: typeof t?.baseURL === 'string' ? t.baseURL : '',
      env: typeof t?.apiKeyEnv === 'string' ? t.apiKeyEnv : '',
      temperature: typeof t?.temperature === 'number' ? String(t.temperature) : '',
    }
  }

  // ② 扁平: 一项一条配置
  const base = p.config.find((e) => e.name === 'baseURL')
  const secret = p.config.find((e) => e.secret)
  const temp = p.config.find((e) => e.name === 'temperature')
  return {
    baseURL: typeof base?.value === 'string' ? base.value : '',
    env: secret?.secretRef ?? '',
    // 后端没声明温度这一项就不画 —— 画一个改了什么都不发生的输入框比不画糟
    temperature: temp === undefined ? undefined : typeof temp.value === 'number' ? String(temp.value) : '',
  }
}

/**
 * 要写的那几步。**纯数据, 不在里面调 invoke** —— 这样"改一个字会写哪里"
 * 能单测, 而不是只能靠手点一次才知道。
 *
 * `whole` 是路由字典那条路: 后端只收整张字典, 所以先读回来改一条再写回。
 * `single` 是扁平那条路: 一项就是一项。
 */
export type WriteStep =
  | { kind: 'whole'; key: string; dictKey: string; id: string; patch: Record<string, unknown> }
  | { kind: 'single'; key: string; value: unknown }
  /**
   * 删掉一个扁平配置项。**只在"清空"时出现**（温度清空 = 没设，不是 0）。
   * 路由字典那条路不需要它: 整条 profile 写回时, patch 里的 `undefined` 就是删除。
   */
  | { kind: 'unset'; key: string }

/**
 * 表单 → 写入步骤。只写**真改过的**字段。
 *
 * 三个不能省的判断:
 *   · 没变的字段不进 patch —— 否则"我只改了地址"会连带把温度重写一遍,
 *     而温度这一格在没有那一项的后端上是空的, 空字符串会把数字字段写坏。
 *   · 温度清空 = **删掉这个键**, 不是写 0。0 是"确定要 0 温度", 语义完全不同。
 *   · 密钥写的是**变量名**。值只从 env 读, 这是整个配置层刻意的非对称。
 */
export function writeStepsOf(p: CatalogProvider, next: RouteDraft, before: RouteDraft): WriteStep[] {
  const patch: Record<string, unknown> = {}
  const flat: WriteStep[] = []

  const slot = routeTargetOf(p)
  if (!p.configScope) return []

  if (slot) {
    if (next.baseURL !== before.baseURL) patch.baseURL = next.baseURL.trim()
    if (next.env !== before.env) patch.apiKeyEnv = next.env.trim()
    if (next.temperature !== undefined && next.temperature !== before.temperature) {
      const t = next.temperature.trim()
      patch.temperature = t === '' ? undefined : Number(t)
    }
    if (Object.keys(patch).length === 0) return []
    return [{ kind: 'whole', key: slot.key, dictKey: slot.dictKey, id: slot.id, patch }]
  }

  // 扁平: 每个字段是独立的一项, key 就是全名
  if (next.baseURL !== before.baseURL) {
    flat.push({ kind: 'single', key: `${p.configScope}.baseURL`, value: next.baseURL.trim() })
  }
  if (next.env !== before.env) {
    const secret = p.config.find((e) => e.secret)
    // 用后端给的那一项名字, 不硬编码 `apiKey` —— deepseek 叫 apiKey,
    // 换一家插件可能叫 apiKeyEnv, 硬编码就是"有一家改不了"
    if (secret) flat.push({ kind: 'single', key: secret.key, value: next.env.trim() })
  }
  if (next.temperature !== undefined && next.temperature !== before.temperature) {
    flat.push({ kind: 'single', key: `${p.configScope}.temperature`, value: Number(next.temperature.trim()) })
  }
  return flat
}

// ─────────────────────────────────────────────────────────────────────────────
// 自定义 API: 表单 → 路由
//
// 后端**不需要新接口**: `routes` 是 `z.record(string, RouteSchema)`,
// 写一个新的键就是多一家供应商（`config.set` 一条就够）。所以这一整块
// 是纯前端的事 —— 但换算规则必须是纯函数, 否则"填了保存不了"只能靠手点。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 界面上**只给两种协议**（用户 2026-11-16 拍板：其他厂商都用这两种之一）。
 *
 * 这不是"后端只有两种"—— 后端接的是 pi-ai 的 9 种 —— 而是**那 9 种里只有这两种
 * 该出现在设置页**：
 *   · `openai-responses` / `mistral-conversations` / `google-generative-ai` /
 *     `azure-openai-responses`：厂商自己都另有一个 OpenAI 兼容端点，填那一份地址 +
 *     选「OpenAI 兼容」就能通。多摆四个近义项，用户要在四个里猜自己该选哪个。
 *   · `bedrock-converse-stream` / `google-vertex` / `openai-codex-responses`：门槛是
 *     凭据链（AWS / ADC / OAuth），我们的配置形状（一个环境变量名）表达不了 ——
 *     摆出来只能让人选了之后失败，那比不给选更糟。
 *
 * 其余 7 种**仍然写进配置文件就生效**（后端照认），只是这一页不提供入口。
 * 顺序 = 默认值在最前：新建网关九成是 OpenAI 兼容。
 */
export const OFFERED_PROTOCOLS = ['openai-completions', 'anthropic-messages'] as const

/** 表单默认选的那一种。**从 OFFERED_PROTOCOLS 取**，别在别处再写一份字面量 */
export const DEFAULT_PROTOCOL: string = OFFERED_PROTOCOLS[0]

/**
 * 后端下发的协议表 → 下拉里的选项。
 *
 * 过滤的是**取哪几项**（产品决定，见上），不是"自己抄一份标签表" ——
 * `label` 和 `listable` 一律从后端来：后端改了文案，界面跟着改；后端把某种协议
 * 的 `listable` 翻成 false，按钮跟着灰。硬编码整张表的话这两件事都会静默过期。
 *
 * 一个兜底：后端要是把这两个 id 都改了名，交集就是空的。那时**退回全量** ——
 * 空下拉等于"这一页彻底不能新建"，比多给几个选项糟得多。
 */
export function offeredProtocols(all: readonly ProtocolInfo[]): ProtocolInfo[] {
  const picked = OFFERED_PROTOCOLS.map((id) => all.find((p) => p.id === id)).filter(
    (p): p is ProtocolInfo => p !== undefined,
  )
  return picked.length > 0 ? picked : [...all]
}

/** 「新建自定义 API」表单里的格子。`models` 是一条一条加上去的 id 列表 */
export interface CustomDraft {
  name: string
  /** `llm.protocols` 里的一个 id。**不是字面量常量** —— 那是后端的能力 */
  protocol: string
  baseURL: string
  apiKeyEnv: string
  /**
   * 模型 id 列表。**是数组不是一行文本**（用户 2026-11-16：「自定义模型缺少
   * 主动添加模型」）。一行逗号文本做不到三件事: 逐条删掉、看见自己加了什么、
   * 加错了立刻改。而这三件事恰恰是"手填 id"这条路上最容易出错的地方。
   */
  models: string[]
}

export const EMPTY_DRAFT: CustomDraft = {
  name: '',
  protocol: DEFAULT_PROTOCOL,
  baseURL: '',
  apiKeyEnv: 'CUSTOM_API_KEY',
  models: [],
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
 *
 * 协议只拦"一个都没选"：那种情况只在后端下发了空协议表时出现（`offeredProtocols`
 * 会退回全量，但全量本身可能是空的）。不校验"是不是 9 种之一"—— 那是后端的
 * `RouteSchema` 的活, 前端复述一遍就是两份真相。
 */
export function draftErrors(draft: CustomDraft): DraftErrors {
  const out: DraftErrors = {}
  if (draft.name.trim() === '') out.name = '给它起个名字，之后你靠这个名字认它'
  if (draft.protocol.trim() === '') out.protocol = '选一种协议 —— 后端没给出可选的那张表'
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

/** 模型 id 的输入: 逗号 / 空格 / 换行都算分隔。空字符串 = 一个都不填（合法） */
export function parseModelIds(text: string): string[] {
  return [...new Set(text.split(/[,\s，、]+/).map((s) => s.trim()).filter(Boolean))]
}

/**
 * 「＋ 添加」: 把输入框里的一串 id 追加到已有列表。
 *
 * 三件事必须一起做, 少一件都会让用户觉得"点了没反应":
 *   · **一次可以粘一串**（`gpt-4o, o3`）—— 用户手里常常是从别处复制的清单;
 *   · **去重** —— 重复 id 进配置后会在模型清单里出现两次, 而且删一条另一条还在;
 *   · **保持已有顺序** —— 列表是用户自己排的, 追加就追加在末尾。
 */
export function addModelIds(current: readonly string[], text: string): string[] {
  const next = [...current]
  for (const id of parseModelIds(text)) if (!next.includes(id)) next.push(id)
  return next
}

/**
 * 「获取可用模型」/「测试连接」的 payload —— 同一个 op, 两种问法。
 *
 * 两条路是**后端定的**（B-19 §3）:
 *   · 新建一条路由时手里还没有路由 id → 给草稿（`baseURL` + `protocol` + `apiKeyEnv`）
 *   · 编辑一条已有路由时 → 给 `provider`（路由 id）, 后端按 id 认目录
 * `scope` 两条路都必须有 —— 探测器是按 scope 注册的, 缺了后端直接 400
 * 「缺 scope（这些供应商属于哪个插件）」, 而那句话对用户毫无意义。
 *
 * `source: 'endpoint'` 是**测试连接**那一档: 不翻目录, 直接打 `GET <base>/models`。
 * 它同时验了三件事 —— 地址通不通、协议对不对、密钥有没有效 —— 而目录命中那条路
 * 是零网络的, 拿它当"连接测试"会给出一个永远成功的假绿灯。所以:
 *
 *   获取可用模型 → 默认（目录认识就零网络直接答, 快）
 *   测试连接     → source: 'endpoint'（真的出一次网）
 *
 * 抽成纯函数是因为"少传一个字段"在界面上完全看不出来：按钮转一圈, 然后报一句
 * 没人看得懂的话。有了这个函数, "该传什么"能被单测钉住。
 */
export type DiscoverTarget =
  | { kind: 'draft'; scope: string; baseURL: string; protocol: string; apiKeyEnv: string }
  | { kind: 'route'; scope: string; provider: string }

export function discoverPayloadOf(
  target: DiscoverTarget,
  opts: { source?: 'endpoint' } = {},
): Record<string, unknown> {
  const base =
    target.kind === 'route'
      ? { scope: target.scope, provider: target.provider }
      : {
          scope: target.scope,
          baseURL: target.baseURL.trim(),
          protocol: target.protocol,
          apiKeyEnv: target.apiKeyEnv.trim(),
        }
  // 默认值（catalog）留在后端 —— 这里再写一遍 `: 'catalog'` 就是同一个默认值两份
  return opts.source === 'endpoint' ? { ...base, source: 'endpoint' } : base
}

/**
 * 「测试连接」该拿什么去问。
 *
 * 三种家, 三种问法 —— 判错哪一种都会得到一个"按钮转一圈然后什么都没发生":
 *
 *   · **路由型**（zai / groq / 自己加的）→ 只给 `provider`。地址、协议、变量名
 *     都在配置里, 前端再传一份就是两份真相, 而且会和用户刚保存的那份打架。
 *   · **扁平型**（deepseek）→ 它没有"路由 id"可认, 后端按 id 查不到; 只能把
 *     当前生效的三项（地址 / 协议 / 变量名）摆出来当草稿问。
 *   · **还没添加的**（dormant）→ 配置里没有它, 用 `template` 当草稿。详情面板
 *     现在不给它画这个按钮（那里只有「添加」）, 但函数本身得是**全的** ——
 *     留一个"某种态下返回 undefined"的口子, 那个态下按钮就永远是灰的。
 *
 * 返回 `undefined` 只有一种情况: 这一家连地址都没有, 问不了。
 */
export function probeTargetOf(p: CatalogProvider): DiscoverTarget | undefined {
  if (!p.configScope) return undefined

  if (p.dormant) {
    const t = p.template
    const baseURL = typeof t?.baseURL === 'string' ? t.baseURL : ''
    if (!baseURL) return undefined
    return {
      kind: 'draft',
      scope: p.configScope,
      baseURL,
      protocol: typeof t?.protocol === 'string' ? t.protocol : DEFAULT_PROTOCOL,
      apiKeyEnv: typeof t?.apiKeyEnv === 'string' ? t.apiKeyEnv : '',
    }
  }

  const slot = routeTargetOf(p)
  if (slot) return { kind: 'route', scope: slot.scope, provider: slot.id }

  const baseURL = endpointOf(p)
  if (!baseURL) return undefined
  return {
    kind: 'draft',
    scope: p.configScope,
    baseURL,
    // `protocol` 是目录里的展示字段（"这家主要走哪种 wire"）。扁平那家没有
    // 路由级的协议可读, 只能用它 —— 缺了按默认那一种问, 总比不问好
    protocol: p.protocol ?? DEFAULT_PROTOCOL,
    apiKeyEnv: secretOf(p).env ?? '',
  }
}

/**
 * 表单 → 写进 `routes[id]` 的那份 profile。
 *
 * 只写**用户真填了的** + 后端 schema 里有 `.default()` 的那几个。后者要写全,
 * 因为带 default 的字段在输出类型里是必填 —— 漏了它, 后端 parse 会补上默认值,
 * 但那是后端的假设, 不该由前端"以为"。
 */
export function profileOfDraft(draft: CustomDraft, id: string): Record<string, unknown> {
  return {
    displayName: draft.name.trim() || id,
    // 协议来自表单（选项由 `llm.protocols` 给）。写死一种的话, 用 Anthropic 那类
    // 网关建出来的路由会拿 OpenAI 的 wire 格式去发请求 —— 400, 而且看不出原因。
    protocol: draft.protocol,
    baseURL: draft.baseURL.trim(),
    apiKeyEnv: draft.apiKeyEnv.trim(),
    // 一条模型都不填也行: 后端会用目录/兜底（`modelsOf`），但界面上会显示成
    // 兜底那一条的名字。填了才是用户想要的清单，所以提示里让他填。
    models: draft.models.map((m) => ({ id: m })),
    modelOverrides: {},
    defaultContextWindow: PARAM_FALLBACK.contextWindow,
    defaultMaxTokens: PARAM_FALLBACK.maxTokens,
    defaultInput: ['text'],
    headers: {},
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 这一页只画「已添加」的 + 每条连接状态
//
// 用户 2026-11-16 第二轮：整页简化成"已接入的供应商 + 一个添加按钮"。
// 35 家内置目录不再铺在列表里 —— 它是**添加时**才需要看的东西。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 已经接进来的那些。**去掉 dormant**（目录里有、配置里没有）。
 *
 * 为什么把"可添加"从这一页拿掉: 它是 35 行噪音。用户来这一页要做的事只有两件 ——
 * 看我现在接了谁、再添一家。前者是这张表，后者是一个按钮。
 */
export function addedProviders(list: CatalogProvider[]): CatalogProvider[] {
  return shownProviders(list).filter((p) => p.dormant !== true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 前端模型视图：供应商激活 / 手动清单 / 分层
//
// 这一层只改界面看到什么，不改后端的 provider 注册或真实模型能力。
// 这样“停用”不会删除配置，也不会让设置页丢失恢复入口。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个供应商下的模型组。模型选择器按这个组画，不把所有家混成一排。 */
export interface ProviderModelGroup {
  id: string
  name: string
  models: ModelInfo[]
  modelSource?: string
}

/** 供应商默认启用；只有明确在停用名单里才隐藏。 */
export function providerIsEnabled(id: string, disabled: readonly string[]): boolean {
  return !disabled.includes(id)
}

/** 切换一家供应商的启用状态，返回新数组，不改入参。 */
export function toggleProviderEnabled(disabled: readonly string[], id: string): string[] {
  return disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id]
}

/**
 * 这家供应商在当前前端视图里的模型。
 *
 * `manualModels` 里**有键** = 手动清单，哪怕值是空数组；没键 = 用后端
 * 当前返回的清单。这个区别必须保留，否则“删到 0 个”会被误当成“没手动过”
 * 而回退到目录里的模型。
 */
export function modelsForProvider(
  p: CatalogProvider,
  manualModels: Record<string, readonly string[]>,
): ModelInfo[] {
  const base = p.models ?? []
  const manual = manualModels[p.id]
  if (manual === undefined) return base
  const byId = new Map(base.map((m) => [m.id, m]))
  return manual.map((id) => byId.get(id) ?? { id, name: id })
}

/** 把用户输入加进当前清单；第一次手动编辑会把后端当前清单固化成白名单。 */
export function addManualProviderModels(
  p: CatalogProvider,
  manualModels: Record<string, readonly string[]>,
  input: string,
): Record<string, string[]> {
  const current = modelsForProvider(p, manualModels).map((m) => m.id)
  const next = addModelIds(current, input)
  if (next.length === current.length) return Object.fromEntries(
    Object.entries(manualModels).map(([k, v]) => [k, [...v]]),
  )
  const out: Record<string, string[]> = Object.fromEntries(
    Object.entries(manualModels).map(([k, v]) => [k, [...v]]),
  )
  out[p.id] = next
  return out
}

/** 从当前清单删掉一个模型；删到空也保存为空清单。 */
export function removeManualProviderModel(
  p: CatalogProvider,
  manualModels: Record<string, readonly string[]>,
  id: string,
): Record<string, string[]> {
  const current = modelsForProvider(p, manualModels).map((m) => m.id)
  if (!current.includes(id)) return Object.fromEntries(
    Object.entries(manualModels).map(([k, v]) => [k, [...v]]),
  )
  const out: Record<string, string[]> = Object.fromEntries(
    Object.entries(manualModels).map(([k, v]) => [k, [...v]]),
  )
  out[p.id] = current.filter((x) => x !== id)
  return out
}

/** 恢复自动清单：删掉这一家的手动覆盖。 */
export function resetProviderModels(
  manualModels: Record<string, readonly string[]>,
  id: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(
    Object.entries(manualModels).map(([k, v]) => [k, [...v]]),
  )
  delete out[id]
  return out
}

/**
 * 模型选择器的数据源：只保留已启用、当前可用、确实有模型的供应商。
 * 顺序照后端目录，前端不重排。
 */
export function modelGroupsOf(
  list: readonly CatalogProvider[],
  disabledProviders: readonly string[],
  manualModels: Record<string, readonly string[]>,
  availableIds?: readonly string[],
): ProviderModelGroup[] {
  const allowed = availableIds === undefined ? undefined : new Set(availableIds)
  return list.flatMap((p) => {
    if (p.dormant || p.available !== true || !providerIsEnabled(p.id, disabledProviders)) return []
    const manual = manualModels[p.id] !== undefined
    const all = modelsForProvider(p, manualModels)
    // 后端 `llm.models` 是“真正能用”的最终名单；手动清单是用户明确指定的例外，
    // 不能因为厂商 /models 没列出来就把它删掉。
    const models = manual || allowed === undefined ? all : all.filter((m) => allowed.has(m.id))
    if (models.length === 0) return []
    return [{
      id: p.id,
      name: p.name,
      models,
      ...(p.modelSource ? { modelSource: p.modelSource } : {}),
    }]
  })
}

/** 一条路由的**原始** profile（参数、模型清单、覆盖都住在里面）。没有 = 还没写进配置 */
export function routeProfileOf(p: CatalogProvider): Record<string, unknown> | undefined {
  const slot = routeTargetOf(p)
  if (!slot) return undefined
  const dict = p.config.find((e) => e.name === slot.dictKey)?.value
  const one = isRecord(dict) ? dict[slot.id] : undefined
  return isRecord(one) ? one : undefined
}

/**
 * 一次连接测试的结果。
 *
 * `state` 只有两态 —— "还没测过"不是一种结果, 是**没有记录**。把它也写进
 * 存储的话, 每加一家就要先写一条"未连接", 而那条记录和"三个月前测过一次,
 * 结果丢了"长得一样。
 */
export interface ProbeRecord {
  state: 'ok' | 'fail'
  /** 什么时候测的（毫秒时间戳）。界面拿它说"3 分钟前"，也拿它判"太旧了" */
  at: number
  /** 成功时端点回了几款模型 */
  count?: number
  /** 失败时后端的原话 */
  message?: string
}

export type LinkState = 'ok' | 'fail' | 'unknown'

/** 三种态。`undefined` = 没测过 = 未连接 */
export function linkStateOf(rec: ProbeRecord | undefined): LinkState {
  return rec === undefined ? 'unknown' : rec.state
}

/**
 * 状态的说法。
 *
 * 用"已连接/连接失败/未连接"而不是"成功/失败/未知": 前两个是**事实**,
 * "未知"听起来像我们出了错。未连接是一个正常状态（刚加完还没测）。
 */
export const LINK_LABEL: Record<LinkState, string> = {
  ok: '已连接',
  fail: '连接失败',
  unknown: '未连接',
}

/**
 * 结果太旧了吗。
 *
 * 半小时。连接状态是**外部世界的事实**, 它会在我们不看着的时候变（key 过期、
 * 网关欠费、地址被墙）。留着一个三周前的绿灯比没有更糟 —— 它会让人不去复查。
 * 界面不自动重测（打开设置页不该替用户向五家外部 API 发请求）, 只把旧的标成
 * "未连接", 让人自己决定要不要再测一次。
 */
export const PROBE_TTL_MS = 30 * 60 * 1000

export function freshProbeOf(rec: ProbeRecord | undefined, now: number): ProbeRecord | undefined {
  if (rec === undefined) return undefined
  return now - rec.at <= PROBE_TTL_MS ? rec : undefined
}

/**
 * 解析存储里的那份状态表。**逐条校验, 不认识的就丢掉** ——
 * 它是 localStorage 里的东西: 可能是上个版本写的、可能被人手改过、也可能
 * 只写了一半（存到一半关页面）。整份 JSON.parse 成功不代表里面装的是我们要的形状,
 * 而一个 `state: 'ok'` 但 `at` 是字符串的记录会让"半小时前"算出 NaN。
 */
export function parseProbeStore(raw: string | null): Record<string, ProbeRecord> {
  if (raw === null || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, ProbeRecord> = {}
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (id === '' || v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const rec = v as Record<string, unknown>
    if (rec.state !== 'ok' && rec.state !== 'fail') continue
    if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue
    out[id] = {
      state: rec.state,
      at: rec.at,
      ...(typeof rec.count === 'number' && Number.isFinite(rec.count) ? { count: rec.count } : {}),
      ...(typeof rec.message === 'string' && rec.message !== '' ? { message: rec.message } : {}),
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由参数（思考程度 / 温度 / 默认容量 / 输入模态）
//
// **哪些行出现由后端声明决定, 不由前端写死。** 这一条是踩过坑的: 参数表写死在
// 前端的话, 后端加一个 `reasoningEffort`（2026-11-16 真加了）界面上就永远看不见,
// 而用户会以为"这个功能没做"。反过来, 前端凭空画一行后端不认的字段, 保存会
// 静默丢掉（zod 默认 strip 未知键）—— 那比不画糟得多。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `RouteSchema` 里两个带 `.default()` 的容量字段。**抄的是后端默认值**,
 * 只用来: ① 表单为空时显示占位 ② 建新路由时写全。
 * 判据永远在后端 —— 这里多写一个数只影响占位文案, 不影响写入。
 */
export const PARAM_FALLBACK = { contextWindow: 262144, maxTokens: 32768 } as const

/**
 * 一行可编辑参数。
 *
 * `kind` 决定用什么控件: 数字 / 枚举下拉 / 纯文本 / 多选模态。
 * `value` 一律是**字符串** —— 它是"界面上的那一格", 转成后端要的类型在
 * `paramStepsOf` 里做（空串 = 删掉这个键, 不是 0）。
 */
export interface ParamRow {
  /** 配置项名（写回时用它拼 key / 进 patch） */
  name: string
  label: string
  kind: 'number' | 'enum' | 'text' | 'modes'
  value: string
  /** `kind === 'enum'` 的选项 */
  options?: string[]
  /** `kind === 'modes'` 的当前选中 */
  modes?: string[]
  hint?: string
}

export interface RouteParams {
  rows: ParamRow[]
}

/**
 * 标签表。**只影响显示, 不影响"哪一行出现"** —— 不在表里的字段照样会出现,
 * 只是用它的配置项名当标签（后端加字段不该等前端改文案）。
 */
const PARAM_LABELS: Record<string, { label: string; hint?: string; kind?: ParamRow['kind'] }> = {
  thinking: {
    label: '思考开关',
    hint: '留空 = 不写这个字段，让服务端默认生效',
  },
  reasoningEffort: {
    label: '思考程度',
    hint: 'off = 关闭思考；high / max 越高想得越久（只有声明了它的供应商才有这一行）',
  },
  temperature: { label: '温度', hint: '0 – 2，越高越发散' },
  maxTokens: { label: '最大输出', hint: '单轮上限，token' },
  idleTimeoutMs: { label: '空闲超时', hint: '毫秒。思考轮会长时间静默，别调太小' },
  defaultContextWindow: { label: '默认上下文', hint: '模型没写容量时按它算' },
  defaultMaxTokens: { label: '默认最大输出', hint: '单轮上限，token' },
}

/**
 * 枚举字段的选项兜底。
 *
 * 优先用 `ConfigEntry.schema.enum`（B-24 之后 `schema` 是**干净的 JSON Schema**,
 * 后端改了枚举界面自动跟）。这一份只在"读不到 schema"时用（路由字典里的参数
 * 没有逐字段 schema）—— 抄的是 `provider-deepseek` 的 CONFIG。
 */
const KNOWN_ENUMS: Record<string, string[]> = {
  thinking: ['enabled', 'disabled'],
}

/** 供应商默认档作用于它的默认模型（实时首项）；off 是本地关闭意图，不是厂商 effort。 */
function reasoningOptionsOf(p: CatalogProvider): string[] {
  return ['off', ...(p.models?.[0]?.reasoningEfforts ?? [])]
}

/** 参数在界面上的显示顺序。**思考程度在最前** —— 它是这一轮用户点名要的 */
const PARAM_ORDER = [
  'reasoningEffort',
  'thinking',
  'temperature',
  'defaultContextWindow',
  'defaultMaxTokens',
  'maxTokens',
  'idleTimeoutMs',
]

function numText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function inputOf(v: unknown): Array<'text' | 'image'> {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is 'text' | 'image' => x === 'text' || x === 'image')
}

/** `schema.enum` 里那串字符串。读不到就返回 undefined（**不猜**） */
function enumOf(schema: unknown): string[] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  const e = (schema as { enum?: unknown }).enum
  if (!Array.isArray(e)) return undefined
  const out = e.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

function rowOf(name: string, value: string, options?: string[]): ParamRow {
  const meta = PARAM_LABELS[name]
  const kind: ParamRow['kind'] = meta?.kind ?? (options !== undefined ? 'enum' : 'number')
  return {
    name,
    label: meta?.label ?? name,
    kind: options !== undefined ? 'enum' : kind,
    value,
    ...(options === undefined ? {} : { options }),
    ...(meta?.hint === undefined ? {} : { hint: meta.hint }),
  }
}

/**
 * 读这条路由现在能调什么。
 *
 * 两种存法都要认（和 `routeDraftOf` 同一条规矩）:
 *   · 路由字典 → 参数在 profile 里。`temperature` / `defaultContextWindow` /
 *     `defaultMaxTokens` / `defaultInput` 是 schema 声明过的; 另外几个
 *     （思考程度、思考开关）**只有 profile 里真有才画** —— RouteSchema 现在没有
 *     它们, 凭空画一行会保存成"看起来成功、其实被 strip 掉"。
 *   · 扁平（deepseek）→ **按 `p.config` 里声明过的项画**。它现在有 thinking /
 *     reasoningEffort / temperature / maxTokens / idleTimeoutMs, 于是这五格自动
 *     出现; 后端明天加第六个, 这里不用改。
 */
export function paramsOf(p: CatalogProvider): RouteParams {
  const one = routeProfileOf(p)
  const rows: ParamRow[] = []

  if (one) {
    for (const name of ['reasoningEffort', 'thinking'] as const) {
      if (!(name in one)) continue
      const raw = one[name]
      if (typeof raw !== 'string') continue
      rows.push(rowOf(name, raw, name === 'reasoningEffort' ? reasoningOptionsOf(p) : KNOWN_ENUMS[name]))
    }
    rows.push(rowOf('temperature', numText(one.temperature)))
    rows.push(rowOf('defaultContextWindow', numText(one.defaultContextWindow)))
    rows.push(rowOf('defaultMaxTokens', numText(one.defaultMaxTokens)))
    if ('defaultInput' in one) {
      rows.push({
        name: 'defaultInput',
        label: '默认输入',
        kind: 'modes',
        value: '',
        modes: inputOf(one.defaultInput),
        hint: '模型没写模态时按它算',
      })
    }
    return { rows }
  }

  for (const name of PARAM_ORDER) {
    const entry = p.config.find((e) => e.name === name)
    if (entry === undefined) continue
    const options = name === 'reasoningEffort' ? reasoningOptionsOf(p) : enumOf(entry.schema) ?? KNOWN_ENUMS[name]
    const value =
      typeof entry.value === 'number'
        ? String(entry.value)
        : typeof entry.value === 'string'
          ? entry.value
          : ''
    rows.push(rowOf(name, value, options))
  }
  return { rows }
}

/**
 * 参数校验。空串一律合法（= 删掉这个键，回落后端默认）。
 *
 * 只拦两类: ① 该填数字的地方填了别的 ② 结构上不可能的组合。
 * 不拦范围（温度 0–2 之类）—— 那是后端 schema 的活, 前端复述一遍就是两份真相,
 * 而两份真相必然有一份先过期。
 */
export function paramErrorsOf(params: RouteParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of params.rows) {
    if (row.kind !== 'number') continue
    const raw = row.value.trim()
    if (raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      out[row.name] = '要填数字'
      continue
    }
    if (n < 0) out[row.name] = '不能是负数'
  }
  const num = (name: string): number | undefined => {
    const row = params.rows.find((r) => r.name === name)
    if (row === undefined || row.value.trim() === '') return undefined
    const n = Number(row.value)
    return Number.isFinite(n) ? n : undefined
  }
  const ctx = num('defaultContextWindow')
  const outMax = num('defaultMaxTokens')
  if (ctx !== undefined && outMax !== undefined && outMax >= ctx) {
    // 后端不拦这条（两个字段各自合法），但"最大输出 ≥ 上下文"是**结构上不可能**:
    // 上下文是输入+输出的总量, 输出不可能比它大。放过去只会在真发请求时炸。
    out.defaultMaxTokens = '最大输出不能大于等于上下文'
  }
  return out
}

/** 界面上的字符串 → 后端要的值。空串 = **删掉这个键**（不是 0，不是空数组） */
function paramValueOf(row: ParamRow): unknown {
  if (row.kind === 'modes') return row.modes !== undefined && row.modes.length > 0 ? row.modes : undefined
  const raw = row.value.trim()
  if (raw === '') return undefined
  return row.kind === 'number' ? Number(raw) : raw
}

/**
 * 参数 → 写入步骤。规矩和 `writeStepsOf` 完全一致（只写改过的、空串 = 删键）。
 *
 * 两条路分开走: 路由字典整条写回（patch 里的 `undefined` 就是删除）; 扁平那家
 * 一项一条配置, 删除要用 `config.unset` —— `config.set` 收到 `undefined` 会当场报错。
 */
export function paramStepsOf(p: CatalogProvider, next: RouteParams, before: RouteParams): WriteStep[] {
  if (!p.configScope) return []

  const patch: Record<string, unknown> = {}
  for (const row of next.rows) {
    const prev = before.rows.find((r) => r.name === row.name)
    const beforeKey = prev === undefined ? '' : JSON.stringify([prev.value, prev.modes])
    if (JSON.stringify([row.value, row.modes]) === beforeKey) continue
    patch[row.name] = paramValueOf(row)
  }
  if (Object.keys(patch).length === 0) return []

  const slot = routeTargetOf(p)
  if (slot) return [{ kind: 'whole', key: slot.key, dictKey: slot.dictKey, id: slot.id, patch }]

  const steps: WriteStep[] = []
  for (const [key, value] of Object.entries(patch)) {
    const full = `${p.configScope}.${key}`
    steps.push(value === undefined ? { kind: 'unset', key: full } : { kind: 'single', key: full, value })
  }
  return steps
}

// ─────────────────────────────────────────────────────────────────────────────
// 单个模型的参数（上下文 / 最大输出 / 是否支持推理 / 输入模态）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个模型能调的那四项。`undefined` = 后端没这一项（不是 0，也不是 false） */
export interface ModelTuning {
  contextWindow?: string
  maxTokens?: string
  /** `undefined` = 没表态（后端当"未知"）。false 是"确定不支持" */
  reasoning?: boolean
  input?: Array<'text' | 'image'>
}

function tuningOf(one: Record<string, unknown>): ModelTuning {
  return {
    contextWindow: numText(one.contextWindow),
    maxTokens: numText(one.maxTokens),
    reasoning: typeof one.reasoning === 'boolean' ? one.reasoning : undefined,
    input: inputOf(one.input),
  }
}

/** 这条路由**自己声明**的模型清单（`models`）。空 = 用目录兜底 */
export function declaredModelsOf(p: CatalogProvider): Array<Record<string, unknown>> {
  const one = routeProfileOf(p)
  if (!one || !Array.isArray(one.models)) return []
  return one.models.filter(isRecord)
}

/**
 * 每个模型现在能读到的参数值（界面用它做 `before`）。
 *
 * 两个来源**必须分开读**, 因为写回去的位置不同:
 *   · `models` 里有它 → 读那一条（用户自己拉下来的清单）
 *   · 否则 → 读 `modelOverrides[id]`（目录兜底 + 逐条覆盖）
 * 后端的规矩是 **`models` 与 `modelOverrides` 互斥**: 同时写会被 `missing`
 * 点名、那条路由直接不可用。所以这里也绝不能把两者混着读。
 */
export function tuningsOf(p: CatalogProvider): Record<string, ModelTuning> {
  const one = routeProfileOf(p)
  const out: Record<string, ModelTuning> = {}
  if (!one) return out
  const declared = Array.isArray(one.models) ? one.models.filter(isRecord) : []
  if (declared.length > 0) {
    for (const m of declared) {
      const id = typeof m.id === 'string' ? m.id : ''
      if (id !== '') out[id] = tuningOf(m)
    }
    return out
  }
  const ov = isRecord(one.modelOverrides) ? one.modelOverrides : {}
  for (const [id, v] of Object.entries(ov)) if (isRecord(v)) out[id] = tuningOf(v)
  return out
}

/** 表单里的字符串 → 后端要的类型。空串 = **删掉这个键**（不是 0，也不是 false） */
function tuningFields(t: ModelTuning): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    const raw = t[key]?.trim()
    if (raw === undefined) continue
    out[key] = raw === '' ? undefined : Number(raw)
  }
  if (t.reasoning !== undefined) out.reasoning = t.reasoning
  if (t.input !== undefined) out.input = t.input.length > 0 ? t.input : undefined
  return out
}

/**
 * 模型参数 → 写入 patch。**写回哪个字段由数据决定, 不由界面决定。**
 *
 * 这是这一整块最容易写错的地方:
 *   · 路由**声明了** `models`（点过「获取可用模型」/ 自动拉过）→ 改清单里那一条。
 *     顺手写 `modelOverrides` 的话, 后端会把整条路由标成"两套规则打架"、不可用。
 *   · 路由**没声明**（用目录兜底）→ 只能写 `modelOverrides`。那时写 `models`
 *     等于把目录里那几十款砍成用户改过的那一款。
 *
 * 只写**真改过的**模型（`next` 与 `before` 逐条比对）—— 否则保存一次会把
 * 目录里所有模型的参数都固化成"现在这一版", 之后目录更新就再也进不来了。
 */
export function modelsWriteOf(
  p: CatalogProvider,
  next: Record<string, ModelTuning>,
  before: Record<string, ModelTuning>,
): Record<string, unknown> {
  const changed = Object.keys(next).filter(
    (id) => JSON.stringify(next[id]) !== JSON.stringify(before[id] ?? {}),
  )
  if (changed.length === 0) return {}

  const declared = declaredModelsOf(p)
  if (declared.length > 0) {
    const models = declared.map((m) => {
      const id = typeof m.id === 'string' ? m.id : ''
      if (!changed.includes(id)) return m
      const out: Record<string, unknown> = { ...m }
      for (const [k, v] of Object.entries(tuningFields(next[id]!))) {
        if (v === undefined) delete out[k]
        else out[k] = v
      }
      return out
    })
    return { models }
  }

  const one = routeProfileOf(p) ?? {}
  const ov: Record<string, unknown> = isRecord(one.modelOverrides) ? { ...one.modelOverrides } : {}
  for (const id of changed) {
    const cur: Record<string, unknown> = isRecord(ov[id]) ? { ...(ov[id] as Record<string, unknown>) } : {}
    for (const [k, v] of Object.entries(tuningFields(next[id]!))) {
      if (v === undefined) delete cur[k]
      else cur[k] = v
    }
    ov[id] = cur
  }
  return { modelOverrides: ov }
}

/**
 * 把「端点回报的清单」和「用户逐条改过的参数」合起来。
 *
 * 为什么需要它: 重新拉取会写 `models`（整份替换），而用户可能已经给其中几款
 * 调过上下文。不合的话, 拉一次就把他的调整全抹掉; 而**先合再清空 `modelOverrides`**
 * 是唯一同时满足两条后端规矩的写法（两者互斥, 不能都留着）。
 */
export function mergePulledModels(found: ModelInfo[], overrides: Record<string, ModelTuning>): ModelInfo[] {
  return found.map((m) => {
    const t = overrides[m.id]
    if (t === undefined) return { id: m.id }
    const merged: ModelInfo = { id: m.id }
    if (t.contextWindow !== undefined && t.contextWindow !== '') merged.contextWindow = Number(t.contextWindow)
    if (t.maxTokens !== undefined && t.maxTokens !== '') merged.maxTokens = Number(t.maxTokens)
    if (t.reasoning !== undefined) merged.reasoning = t.reasoning
    if (t.input !== undefined && t.input.length > 0) merged.input = t.input
    return merged
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 「＋ 添加模型」卡片里的那个下拉
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 添加卡片的下拉项。**一个下拉, 两个分组**（自定义 API + 内置供应商）。
 *
 * 为什么不拆成两个下拉（先选类型、再选厂商）: 用户脑子里只有"我要接哪一家"，
 * 没有"类型"这一层。拆开等于让他先回答一个我们不关心的问题，而"自定义 API"
 * 本身就是一个选项（它也是一家"厂商"，只是名字要自己填）。
 *
 * 内置那一段**按名字排序**（目录顺序是 pi 的注册顺序，35 项里找一个名字
 * 靠翻是找不到的）。这里的排序不影响列表页 —— 那一页只有已添加的几家。
 */
export interface AddOption {
  /** `custom` 或 `builtin:<id>` */
  value: string
  label: string
  group: 'custom' | 'builtin'
}

export function addOptionsOf(list: CatalogProvider[]): AddOption[] {
  const builtin = shownProviders(list)
    .filter((p) => p.dormant === true && p.template !== undefined)
    .map((p) => ({ value: `builtin:${p.id}`, label: p.name, group: 'builtin' as const }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  return [{ value: 'custom', label: '自定义 API（填自己的地址）', group: 'custom' }, ...builtin]
}

/** 下拉项 → 目录里那一家。`custom` 返回 undefined */
export function builtinOf(list: CatalogProvider[], value: string): CatalogProvider | undefined {
  if (!value.startsWith('builtin:')) return undefined
  const id = value.slice('builtin:'.length)
  return list.find((p) => p.id === id)
}

/**
 * 从路由字典里拿掉一家。**返回新对象, 不改入参。**
 *
 * 移除是"整表写回时少一个键" —— 后端没有"删一条路由"的子路径
 * （`config.set` 的 `path` 只支持 set, 不支持删）。所以这里必须**保留其余每一条**:
 * 漏一条就是"我删了一家, 结果另一家也没了", 而那种事故在界面上完全看不出来。
 */
export function withoutRoute(dict: Record<string, unknown>, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(dict)) if (k !== id) out[k] = v
  return out
}

/**
 * 内置供应商的模板 + 用户在卡片里改过的三格 → 要写进去的 profile。
 *
 * **模板原样保留**（协议、默认容量、输入模态都在里面）。只覆盖用户真改过的那三格,
 * 而且是"改了才覆盖" —— 不覆盖的话, 用户把名字清空会写进去一个空标题。
 */
export function profileFromTemplate(
  template: Record<string, unknown>,
  edit: { displayName: string; baseURL: string; apiKeyEnv: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...template }
  const name = edit.displayName.trim()
  if (name !== '') out.displayName = name
  else if (typeof out.displayName !== 'string' || out.displayName === '') out.displayName = ''
  out.baseURL = edit.baseURL.trim()
  out.apiKeyEnv = edit.apiKeyEnv.trim()
  return out
}
