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
  return list.filter((p) => !HIDDEN_IDS.has(p.id) && (p.dormant === true || p.configScope !== undefined))
}

/**
 * 用户明确要求不显示的。
 *
 * `openai` 是 `DEFAULT_ROUTES` 里那条**声明自带的默认路由** —— 它不是"用户接的
 * 供应商", 而是"什么都还没配时内核自己用的那条"。把它和 Z.AI / Groq 并排摆着,
 * 会让人以为它也是一个可以挑的品牌。
 *
 * 和上面 `mock` 那类过滤一样, 这只是**界面投影**: `llm.catalog` 一个字段没少,
 * 诊断面板 / 内核自检照样看得见它。代价是这条规则藏在渲染层 ——
 * 所以它必须是一个能被单测钉住的纯函数, 不是 JSX 里的一个 `if`。
 */
const HIDDEN_IDS = new Set(['openai'])

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
 */
export function routeTargetOf(p: CatalogProvider): { key: string; dictKey: string; id: string } | undefined {
  if (!p.configScope) return undefined
  if (p.configPath?.length) {
    return {
      key: `${p.configScope}.${p.configPath[0]}`,
      dictKey: p.configPath[0]!,
      id: p.configPath[1] ?? p.id,
    }
  }
  for (const e of p.config) {
    if (e.type === 'object' && isRecord(e.value) && p.id in e.value) {
      return { key: e.key, dictKey: e.name, id: p.id }
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

/**

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

