/**
 * @meng/provider-openai — 通用多协议适配器（OpenAI / Anthropic / Gemini / Bedrock…）。
 *
 * 边界: adapter **只负责"把消息变成 delta 流"**。组块、重试、超时、计费、
 * 上下文压缩都不在这里 —— 组块是 @meng/llm 的 assemble()。
 *
 * 这个插件是 dsh `dsh-llm-pi-ai` 的对位：**一个 adapter 服务 N 条路由**。
 * 配置里的 `routes` 是一个字典, 一个 key 一家供应商。加一家不需要写代码,
 * 也不需要重启 —— 增删键会走 `registerAdapter().replace()`, 改值下一个请求生效。
 *
 * **wire 实现不在这个文件里**：9 种协议的 SSE 翻译由 `@meng/pi` 转交给 pi-ai。
 * 这里只剩四件事：配置形状、模型清单合并、缺什么、探测。
 *
 * 与 `provider-deepseek` 的分工: DeepSeek 的 thinking 协议是另一套 wire
 * (thinking/effort 配对、reasoning_content 回传), 塞进这里会让通用分支长草。
 * 那是专有 adapter, 这是通用 adapter —— dsh 也是这么分的。
 */

import * as z from 'zod'
import type { Ctx, Disposer } from '@meng/core'
import { getConfig, openScope } from '@meng/config'
import {
  PROTOCOLS as PI_PROTOCOLS,
  catalog as piCatalog,
  catalogProvider as piCatalogProvider,
  catalogProviderByBaseURL,
  createRouteProvider,
  listableProtocols,
  listerOf,
  primeCatalog,
  protocolIds,
  readListing,
  toChunks,
  toContext,
  type CatalogModel,
  type ListingRequest,
  type ProtocolInfo,
} from '@meng/pi'
import {
  LLM_CODE,
  LlmError,
  type Adapter,
  type AdapterHandle,
  type ConfigurableProvider,
  type DirectoryHandle,
  type DiscoveredModel,
  type LLMService,
  type ModelDiscoveryRequest,
  type ModelInfo,
  type ProviderInfo,
  type StreamChunk,
  type StreamRequest,
} from '@meng/llm'

export const name = 'provider-openai'
export const inject = ['llm']

export const CONFIG_SCOPE = 'llm.openai'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_API_KEY_ENV = 'MENG_LLM_API_KEY'
const DEFAULT_TEMPERATURE = 0.7

/**
 * 一条路由既没声明模型、也不在内置目录里时的兜底。
 *
 * 现实里只有一个使用者: 默认那条 `openai` 路由 —— 它的 `models: []` 会落到这里。
 *
 * **带容量**。曾经这里是 `['gpt-4o-mini']` 一个名字, 容量于是从路由的
 * `defaultContextWindow` 拿 —— 设置页会把 262144 当成事实显示出来,
 * 而 gpt-4o-mini 真实是 128k。兜底这一条我们是**知道**的, 没有理由编。
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128_000, maxTokens: 16_384, input: ['text'] },
]

/**
 * 模型没写容量时的**假设值**。照抄 dsh 的 262144 / 32768。
 *
 * 这是"不知道就按这个算", 不是"模型真的是这个" —— 所以它只用于预算和
 * 界面显示, **不会**被塞进 wire 的 `max_tokens`（那会因为超出小模型的
 * 限制而 400）。
 */
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768
const DEFAULT_INPUT = ['text'] as const

// ─────────────────────────────────────────────────────────────────────────────
// wire 协议
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 协议表来自 `@meng/pi`（也就是 pi-ai）。**表驱动**: 加协议 = 上游加一份
 * SSE 翻译 + 我们这里什么都不用改。
 *
 * 9 种全在：openai-completions / openai-responses / anthropic-messages /
 * google-generative-ai / mistral-conversations / azure-openai-responses /
 * bedrock-converse-stream / google-vertex / openai-codex-responses。
 *
 * 其中三种（azure / bedrock / vertex）的端点地址、凭据形态不是"一个 key +
 * 一个地址"能表达的，配置项里仍然可以选，但 `missing` 会点名还差什么。
 *
 * `listable`（能不能点"获取可用模型"）**不是写在这里的**，由 pi 的
 * `listerOf()` 算：有 listter 才是 true。曾经这张表和实现各写一份，
 * 加第三种协议时必然漂成"按钮灰着但实现好了"。
 */
export const PROTOCOLS: readonly ProtocolInfo[] = PI_PROTOCOLS

const PROTOCOL_IDS = protocolIds() as [string, ...string[]]

export function protocolInfo(id: string): ProtocolInfo | undefined {
  return PROTOCOLS.find((p) => p.id === id)
}
// ─────────────────────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_MODALITIES = ['text', 'image'] as const

/**
 * 一条模型。**对应 dsh 的 `models` 条目**: 名字、上下文窗口、最大输出、模态。
 *
 * 为什么不是字符串: 选择器要显示上下文窗口, 压缩策略要知道容量, 附件要
 * 知道能不能收图。只存名字等于把这些信息丢给调用方去猜。
 */
const ModelSchema = z.object({
  id: z.string().min(1),
  /** 显示名。留空 = 用 id */
  name: z.string().optional(),
  /** 上下文总量 (输入 + 输出), token */
  contextWindow: z.number().int().positive().optional(),
  /** 单轮最大输出, token */
  maxTokens: z.number().int().positive().optional(),
  /** 接受的输入模态。留空 = 用路由的 defaultInput */
  input: z.array(z.enum(INPUT_MODALITIES)).optional(),
  /** 是否支持推理档。留空 = 未知 */
  reasoning: z.boolean().optional(),
  /**
   * 这个模型走哪种协议。留空 = 跟路由的 `protocol`。
   *
   * 为什么要能单独写：一家供应商的模型可能分属几种协议 —— opencode 那家
   * 58 个模型里混着 completions / responses / anthropic / gemini 四种。
   * 只能填路由级协议的话，那家就只能用其中四分之一。
   */
  api: z.enum(PROTOCOL_IDS).optional(),
  description: z.string().optional(),
})

/** `modelOverrides` 的值: 除了 id 之外和模型条目一模一样（id 是字典键） */
const ModelOverrideSchema = ModelSchema.omit({ id: true })

/**
 * 一条路由的 profile。**对应 dsh-llm-pi-ai 里 `providers` 字典的一个 value。**
 *
 * 这个形状是"自由配置供应商"的全部秘密: 以前整个插件只有一份配置, 于是
 * 它只能代表**一家**。改成字典之后, 键就是路由名, 一个 key 一家 ——
 * 用户想接自己的网关, 不需要等我们写插件。
 *
 * `apiKeyEnv` 是**每条路由各自的**: 两家第三方网关两个 key 是常态,
 * 共用一个环境变量名等于其中一家永远拿错凭据。
 */
const RouteSchema = z.object({
  /** 给人看的名字。留空回落成路由名 (路由名是英文 id, 不该直接上界面) */
  displayName: z.string().optional(),

  /** wire 协议。表里没有的选不了 —— 选了就是当场发不出去的配置 */
  protocol: z.enum(PROTOCOL_IDS).default('openai-completions'),

  /**
   * 接口地址。**允许为空**: azure / google-vertex 这类端点里带资源名，
   * 我们替用户编不出来。空地址在这里合法，由 `missingOf` 说"还差地址" ——
   * 比在 schema 层拒绝更好，因为拒绝会让"添加这家"这个动作整个失败，
   * 用户连"它需要什么"都看不到。
   */
  baseURL: z.string().default(''),

  /**
   * **环境变量名, 不是密钥。** 值只从 `process.env` 读, 永不落盘 ——
   * 这条来自 dsh: a literal key is not a configuration value。
   */
  apiKeyEnv: z.string().min(1).default(DEFAULT_API_KEY_ENV),

  /**
   * 这个路由能用的模型。**非空 = 整体替换内置目录**（dsh 的
   * `models already replaces the served catalog`）; 空 = 用目录。
   *
   * 与 `modelOverrides` 互斥: models 已经整体替换了目录, 再逐个覆盖
   * 就是两套规则打架。同时写会在 `missing` 里被点名, 那条路由不可用。
   */
  models: z.array(ModelSchema).default([]),

  /** 给目录里的模型逐个改字段。与 `models` 互斥 */
  modelOverrides: z.record(z.string(), ModelOverrideSchema).default({}),

  /** 模型没写容量时的假设值。只用于预算/显示, 不进 wire */
  defaultContextWindow: z.number().int().positive().default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.enum(INPUT_MODALITIES)).default([...DEFAULT_INPUT]),

  /** 额外的请求头。有些网关要 `X-Tenant` / `HTTP-Referer` 这类东西 */
  headers: z.record(z.string(), z.string()).default({}),

  temperature: z.number().min(0).max(2).optional(),
  /** 多久没收到数据帧判流挂死。默认不设 = 不启用看门狗 */
  streamIdleTimeoutMs: z.number().int().positive().optional(),
})

export type RouteProfile = z.infer<typeof RouteSchema>
export type RouteMap = Record<string, RouteProfile>

/**
 * 默认路由。**单独提出来是因为它还有第二个用途**: 判断一条路由是"内置"
 * 还是"用户自己加的" (`isDeclared`)。不带出来就只能靠路由名硬编 `'openai'`,
 * 于是默认值改一次名字, 设置页上这条路由就突然变成了"自定义"。
 */
const DEFAULT_ROUTES: RouteMap = {
  openai: {
    displayName: 'OpenAI',
    protocol: 'openai-completions',
    baseURL: DEFAULT_BASE_URL,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    models: [],
    modelOverrides: {},
    // 带 `.default()` 的字段在**输出类型**里是必填, 所以默认对象要写全
    // （这不代表用户必须手动填 —— 它们会以默认值出现在设置页里）
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultInput: [...DEFAULT_INPUT],
    headers: {},
  },
}

/**
 * 配置声明。**只有一项**: 一张路由表。
 *
 * 为什么不是"每个字段一项" (baseURL / apiKey / models 各一条 entry):
 * 那样只能描述一家。要做多供应商, 配置本身必须是**可增删键的结构**,
 * 而"可增删键"在 JSON Schema 里就是 object + additionalProperties ——
 * 正好也是设置页要画的那个东西。
 *
 * 默认值里带一条 `openai`: 升级后行为不变, 用户打开设置页就能看到一条
 * 能直接填 key 的路由, 而不是一个空表 + 一句"请自行添加"。
 */
export const CONFIG = {
  routes: z
    .record(z.string(), RouteSchema)
    .default(DEFAULT_ROUTES)
    .meta({
      description:
        '一组 OpenAI 协议路由: 键是路由名, 值是它的协议 / 地址 / 密钥变量名 / 模型。加一条就是多一家供应商, 不用重启',
    }),
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行时
// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx: Ctx): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-openai 依赖 llm')

  const { scope, dispose } = openScope(ctx, CONFIG_SCOPE, CONFIG)
  ctx.effect(() => dispose)

  /**
   * 当前这一份路由表。**每次读 scope, 不缓存。**
   *
   * 于是"改了某条路由的地址/模型"下一个请求就生效, 不需要重新注册 ——
   * 重新注册会让在飞的请求拿到一个正在被卸掉的路由。只有**增删键**才要
   * `replace()`。
   */
  const routes = (): RouteMap => {
    const raw = scope.get<RouteMap>('routes')
    return raw !== null && typeof raw === 'object' ? raw : {}
  }

  const profileOf = (route: string): RouteProfile | undefined => routes()[route]

  /** 一条路由的凭据**值**。路由里存的是变量名, 值只从 env 读 */
  const apiKeyOf = (profile: RouteProfile | undefined): string => {
    if (!profile) return ''
    const envName = profile.apiKeyEnv || DEFAULT_API_KEY_ENV
    const own = (process.env[envName] ?? '').trim()
    if (own) return own
    // 历史名字。**只在绑的是默认名时**才看它: 用户显式绑了 MY_KEY 却去读
    // OPENAI_API_KEY, 会让"我明明绑了却没生效"变得毫无线索
    if (envName === DEFAULT_API_KEY_ENV) return (process.env['OPENAI_API_KEY'] ?? '').trim()
    return ''
  }

  /**
   * 内置目录里这家供应商带的模型（pi-ai 的原始条目，含 `compat`）。
   *
   * 单独抽成函数是为了让"目录"是一个可替换的层 (测试可以直接打桩),
   * 而不是散在合并逻辑里的一个 `if`。
   *
   * **注意 `openai` 自己也在目录里** —— pi-ai 的目录是"每家供应商提供什么
   * 模型"，不像上一版只收第三方。默认那条 `openai` 路由因此直接拿到 38 个
   * 模型，不再落到 `FALLBACK_MODELS`（兜底还在，给用户自建的空网关用）。
   */
  const catalogModelsOf = (route: string): CatalogModel[] => piCatalogProvider(route)?.models ?? []

  /**
   * 一条路由的模型清单 —— **pi 形状**，直接能喂给请求。
   *
   * 三层合并, 照 dsh 的 `resolveRouteModels`:
   *   条目自己的字段 > 目录里的条目 > 路由的 default*
   *
   * `models` 非空 = **整体替换**目录 (dsh: models already replaces the
   * served catalog); 空 = 用目录; 都有 = 报错, 在 `missingOf` 里点名。
   *
   * 目录条目的 `compat` / `thinkingLevelMap` **原样保留** —— 各家的协议怪癖
   * 全在那里（智谱的 thinkingFormat、某些网关不支持 store/developer role）。
   * 只抄 id 和容量的话，这些模型会以"能连上但行为不对"的方式坏掉。
   */
  const mergeModels = (route: string): CatalogModel[] => {
    const profile = profileOf(route)
    if (!profile) return []

    const declared = profile.models
    const overrides = profile.modelOverrides ?? {}
    const directory = catalogModelsOf(route)

    // 模型 id 集合: 声明的 > 目录的 > 只写了覆盖的键 > 兜底。
    // 最后那一档只在"没有目录、也没声明"时出现 —— 让一条刚加的空网关
    // 至少有一个能选的东西, 而不是从选择器里消失
    const ids =
      declared.length > 0
        ? declared.map((m) => m.id)
        : directory.length > 0
          ? directory.map((m) => m.id)
          : Object.keys(overrides).length > 0
            ? Object.keys(overrides)
            : FALLBACK_MODELS.map((m) => m.id)

    return ids.map((id) => {
      const entry = declared.find((m) => m.id === id)
      // 兜底条目也是"我们知道的条目", 所以要参与合并 —— 否则它的容量白写了
      const base =
        directory.find((m) => m.id === id) ??
        (FALLBACK_MODELS.find((m) => m.id === id) as unknown as CatalogModel | undefined)
      const override = overrides[id]
      // 三层: 声明条目 > 目录条目 > 覆盖。覆盖排在目录后是为了让
      // "给目录里的模型改一个字段"不用把整条重抄一遍
      const source = (entry ?? base) as
        | { name?: string; contextWindow?: number; maxTokens?: number; input?: readonly string[]; reasoning?: boolean; api?: string; description?: string }
        | undefined
      const compat = (base as { compat?: unknown } | undefined)?.compat
      const thinkingLevelMap = (base as { thinkingLevelMap?: unknown } | undefined)?.thinkingLevelMap
      return {
        id,
        name: override?.name || source?.name || id,
        // 声明里没写协议就跟路由的 —— 一条路由一个默认协议，个别模型可覆盖
        api: entry?.api ?? source?.api ?? profile.protocol,
        provider: route,
        baseUrl: profile.baseURL || (base as { baseUrl?: string } | undefined)?.baseUrl || '',
        reasoning: override?.reasoning ?? source?.reasoning ?? false,
        input: (override?.input ?? source?.input ?? profile.defaultInput) as ('text' | 'image')[],
        cost:
          (base as { cost?: CatalogModel['cost'] } | undefined)?.cost ??
          ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as CatalogModel['cost']),
        contextWindow: override?.contextWindow ?? source?.contextWindow ?? profile.defaultContextWindow,
        maxTokens: override?.maxTokens ?? source?.maxTokens ?? profile.defaultMaxTokens,
        ...(compat === undefined ? {} : { compat }),
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      } as CatalogModel
    })
  }

  /**
   * 界面上看到的模型清单 —— `mergeModels` 的投影。
   *
   * 只投这一层的理由: 界面要知道的是"叫什么、多大、收不收图、走哪条协议"，
   * 不需要 cost 和 compat。**两套合并逻辑必然会漂**，所以只有一份，
   * 这里只做形状转换。
   */
  const projectModel = (m: CatalogModel): ModelInfo => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: m.input as ModelInfo['input'],
    reasoning: m.reasoning,
    api: String(m.api),
  })

  const modelsOf = (route: string): ModelInfo[] => mergeModels(route).map(projectModel)

  /**
   * 还差什么才能用。**全部由 adapter 自己算** —— 只有它知道缺的是
   * "字典里某一条的某个字段", 扁平配置项看不出来。
   */
  const missingOf = (route: string): string[] => {
    const profile = profileOf(route)
    if (!profile) return [`路由 ${route} 已经不在配置里, 但还挂在注册表上`]

    const out: string[] = []
    /**
     * 有些协议的凭据**不是"一个环境变量"**：bedrock 走 AWS 凭据链、
     * vertex 要 ADC、codex 要 OAuth 登录态。对这些协议说"环境变量 X 里
     * 没有值"是把用户引向一个不存在的变量名 —— 所以先报协议自带的那一段。
     */
    const needs = protocolInfo(profile.protocol)?.needs ?? []
    if (needs.length > 0) out.push(...needs)
    else if (!apiKeyOf(profile)) out.push(`环境变量 ${profile.apiKeyEnv} 里没有值`)

    if (profile.models.length > 0 && Object.keys(profile.modelOverrides).length > 0) {
      out.push('models 与 modelOverrides 只能二选一 (models 已经整体替换了模型目录)')
    }
    if (modelsOf(route).length === 0) out.push('这条路由没有任何模型')
    return out
  }

  /**
   * 这条路由是不是用户自己加的。
   *
   * 两条判据: 不在内置目录里, **且**不是声明默认里自带的那几条。
   * 少第二条, 默认的 `openai` 路由会在设置页上被打成"自定义" ——
   * 用户没加过它, 却要看到一个"这是你自己加的"标签。
   */
  const isDeclared = (route: string): boolean =>
    piCatalogProvider(route) === undefined && !(route in DEFAULT_ROUTES)

  const adapter: Adapter = {
    info(route) {
      const profile = profileOf(route)
      const missing = missingOf(route)
      return {
        ...(profile?.displayName ? { name: profile.displayName } : {}),
        ...(profile?.protocol ? { protocol: profile.protocol } : {}),
        configScope: CONFIG_SCOPE,
        declared: isDeclared(route),
        available: missing.length === 0,
        ...(missing.length > 0 ? { missing } : {}),
      }
    },

    models: (route) => modelsOf(route),

    resolveModel(route, model) {
      return modelsOf(route).find((m) => m.id === model)
    },

    stream: (route, req) => streamRoute(route, req),
  }

  /**
   * 一条路由的一次请求。**读的是 profile 现值**, 所以改地址/模型/温度
   * 都不需要重新注册。
   *
   * wire 层不在这个文件里 —— 由 `@meng/pi` 转给 pi-ai 对应协议的实现
   * （9 种协议共用同一个入口）。这里只做三件事：找到模型、把消息转成
   * pi 的 `Context`、把事件转回我们的 chunk。
   */
  async function* streamRoute(route: string, req: StreamRequest): AsyncIterable<StreamChunk> {
    const profile = profileOf(route)
    if (!profile) throw new LlmError(`路由 ${route} 已经从配置里删掉了`, LLM_CODE.NO_ADAPTER)

    const apiKey = apiKeyOf(profile)
    if (!apiKey) {
      throw new LlmError(
        `路由 ${route} 没拿到凭据: 环境变量 ${profile.apiKeyEnv} 是空的`,
        LLM_CODE.MISSING_CREDENTIAL,
      )
    }

    const models = mergeModels(route)
    const modelId = req.model || models[0]?.id || ''
    const model = models.find((m) => m.id === modelId)
    if (!model) {
      throw new LlmError(
        `路由 ${route} 没有模型 ${modelId || '(空)'} —— 检查它的 models / modelOverrides`,
        LLM_CODE.NO_ADAPTER,
      )
    }
    if (!protocolInfo(String(model.api))) {
      throw new LlmError(
        `模型 ${modelId} 要协议 ${String(model.api)}, 这个 build 不支持 (支持: ${PROTOCOL_IDS.join(', ')})`,
        LLM_CODE.NO_ADAPTER,
      )
    }

    const provider = createRouteProvider({
      id: route,
      name: profile.displayName ?? route,
      baseUrl: profile.baseURL,
      ...(Object.keys(profile.headers).length === 0 ? {} : { headers: profile.headers }),
      models,
      // 现读：设置里换了变量名/值，下一个请求就跟上
      key: () => apiKeyOf(profileOf(route)),
    })

    const context = toContext({
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      api: String(model.api),
      provider: route,
      model: model.id,
    })

    // 输出上限只取**真实知道的**那一个：条目显式声明 > 目录里的真实容量 >
    // 不传。路由的 `defaultMaxTokens` 是"不知道时的假设"，塞进 wire 会因为
    // 超出小模型的限制而 400（gpt-4o-mini 真实 16k，假设值是 32k）
    const explicitMax =
      profile.models.find((m) => m.id === modelId)?.maxTokens ??
      profile.modelOverrides?.[modelId]?.maxTokens ??
      catalogModelsOf(route).find((m) => m.id === modelId)?.maxTokens

    const temperature = req.temperature ?? profile.temperature ?? DEFAULT_TEMPERATURE
    const events = provider.streamSimple(model, context, {
      apiKey,
      temperature,
      ...(req.maxTokens ?? explicitMax ? { maxTokens: req.maxTokens ?? explicitMax } : {}),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    })

    // 看门狗包在事件流上, 不是包在字节流上 —— 我们不再碰字节
    yield* toChunks(
      profile.streamIdleTimeoutMs ? withIdleTimeout(events, profile.streamIdleTimeoutMs) : events,
    )
  }

  /**
   * 注册 / 换路由。**只有增删键时才动注册表** —— 值的变化由现读覆盖。
   *
   * `replace()` 而不是"卸光再注册": 后者有一个"模型列表突然空了"的窗口,
   * 并发请求正好落在那里就会以为这家供应商没了。
   */
  let handle: AdapterHandle | undefined
  let registered: string[] = []

  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i])

  const sync = (): void => {
    const want = Object.keys(routes())
    if (sameSet(want, registered)) return
    try {
      if (!handle) handle = llm.registerAdapter(want, adapter)
      else handle.replace(want)
      registered = want
    } catch (err) {
      // 撞了别的插件占用的路由名 (用户把路由命名成 deepseek 就会这样)。
      // 保留上一次的注册表, 但**绝不能静默** —— 用户得知道它没生效
      console.error('[meng] provider-openai: 路由表更新被拒, 保留上一次的注册:', err)
    }
  }

  /**
   * 模型发现 —— 设置页那个「获取可用模型」按钮。
   *
   * 两条路, 与 dsh 一致:
   *   · 内置目录知道的供应商 → **直接答, 不打网络**。目录里的容量信息
   *     比端点报的更全（多数 `/models` 只给一个 id）
   *   · 目录不认识的（用户自加的网关）→ 才真去 `GET <base>/models`
   *
   * 密钥从**环境变量**读, 不接受请求里传来的明文值 —— 见
   * `ModelDiscoveryRequest.apiKeyEnv` 上的注释。
   */
  const discover = async (request: ModelDiscoveryRequest): Promise<DiscoveredModel[]> => {
      const profile = request.provider ? profileOf(request.provider) : undefined
      const baseURL = request.baseURL || profile?.baseURL || ''

      /**
       * 目录先认一遍, **两条认法都要有**:
       *   · 按路由 id —— 编辑一条已经存在的路由
       *   · 按接口地址 —— 设置页点"添加供应商", 这时手里只有模板里的
       *     `baseURL`, 还没有路由 id。只认 id 的话这一步就得去打网络,
       *     而打网络要密钥, 用户恰恰还没填
       *
       * 命中目录就**不联网**: 目录里的容量比端点报的更全 (多数 `/models`
       * 只给一个 id)。代价是"端点其实换过模型"这件事看不出来 —— 真要
       * 以端点为准时, 用户手写 `models` 整体替换即可。
       */
      const directoryModels: CatalogModel[] = request.provider
        ? catalogModelsOf(request.provider)
        : baseURL
          ? (catalogProviderByBaseURL(baseURL)?.models ?? [])
          : []

      /**
       * `source: 'endpoint'` 时**不看目录**, 直接往下打网络。
       *
       * 这是"以端点为准"的落点: 目录是快照, 供应商下线一款、上线一款,
       * 目录都不知道, 而用户账号下真实能用什么只有端点知道。默认仍走目录
       * （省一次网络请求, 且容量更全), 但那条快路不该变成"永远问不到真话"。
       */
      if (request.source !== 'endpoint' && directoryModels.length > 0) {
        return directoryModels.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
          ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
        }))
      }

      if (!baseURL) {
        throw new LlmError(
          '没有 API 地址, 也不知道是哪条路由 —— 请先填地址再获取',
          LLM_CODE.DISCOVERY_FAILED,
        )
      }

      const protocol = request.protocol || profile?.protocol || 'openai-completions'
      /**
       * **表里没有 = 这个协议真没有列表端点**，不是懒得写：
       * bedrock 要 `ListFoundationModels` + SigV4 签名，vertex 要 ADC，
       * codex 是内部端点。报"没有列表"比硬打一个 404 再说"地址错"诚实。
       */
      const lister = listerOf(protocol)
      if (!lister) {
        throw new LlmError(
          `协议 ${protocol} 没有可读的模型列表 —— 请手动添加模型（能列举的是 ${listableProtocols().join(' / ')}）`,
          LLM_CODE.DISCOVERY_UNSUPPORTED,
        )
      }

      const envName = request.apiKeyEnv || profile?.apiKeyEnv || ''
      const apiKey = usableKey(envName ? (process.env[envName] ?? '').trim() : '')

      const listing: ListingRequest = {
        baseURL,
        apiKey,
        ...(profile?.headers ? { headers: profile.headers } : {}),
      }

      /**
       * 翻页。anthropic 用游标（`after_id`）、gemini 用 `pageToken`，
       * 请求形状不同，但对外都是"给我下一页的地址" —— 循环只认这一个约定。
       *
       * 上限由各 listter 声明（默认 1 页）。宁可少列也不能让一个坏端点
       * 永远返回 `has_more: true` 把我们拖在这里。
       */
      const found: DiscoveredModel[] = []
      let url = lister.url(listing)
      const maxPages = lister.maxPages ?? 1
      for (let page = 0; page < maxPages; page++) {
        const body = await getJson(url, lister.headers(listing), request.signal, lister.label)
        const got = await readListing(body, url, lister)
        found.push(...got.models)
        if (got.next === undefined) break
        url = got.next
      }
    return withCapacity(found, directoryModels)
  }

  ctx.effect(() => llm.registerModelDiscovery(CONFIG_SCOPE, discover))

  sync()

  /**
   * 设置页的"添加供应商"列表 = **内置目录** + **用户已声明的路由**。
   *
   * 为什么内置的未激活供应商也要进这个列表: 它们不在注册表里（没配 key、
   * 甚至配置里没有这个键）, 光靠 `listProviders()` 设置页根本不知道
   * "智谱 / 月之暗面 / Groq 这三家是可以加的"。dsh 管这张表叫
   * configurable-provider 目录。
   *
   * `template` 是"点添加之后写进去的那一条": 地址 / 协议 / 密钥变量名都
   * 预填好, 模型留空 —— 留空就会用目录, 于是用户只填 key 就完事。
   */
  const directoryEntries = (): ConfigurableProvider[] => {
    const active = routes()
    const out: ConfigurableProvider[] = []

    for (const item of piCatalog()) {
      const profile = active[item.id]
      // 一家可能有好几种协议（opencode 混着 4 种）。路由级只能填一个，
      // 所以取**第一个**当默认；个别模型想换协议，在 models 条目里写 `api`
      const protocol = item.protocols[0] ?? 'openai-completions'
      out.push({
        provider: item.id,
        displayName: profile?.displayName ?? item.name,
        configScope: CONFIG_SCOPE,
        configPath: ['routes', item.id],
        // 清单不下发, 但"有几款"要给 —— 界面要能说"点添加会带来 6 款"
        modelCount: item.models.length,
        /**
         * **刻意不给 models。** 目录是 37 家 / 1110 条, 全下发一次 199 KB ——
         * 而设置页一次只看一家。要看哪家, 调 `llm.discoverModels({provider})`
         * 就行: 目录命中时 19ms、零网络。
         *
         * 这就是"留空位, 界面按需拉"。字段是 `models?:`, 不给 = 没下发,
         * 不是"这家没有模型"。
         */
        template: {
          displayName: item.name,
          protocol,
          // 没地址的那几家（azure / vertex）先给空串 —— schema 允许占位,
          // `missingOf` 会说"还差地址"。给个假地址更坏: 用户会以为能直接连
          baseURL: item.baseUrl ?? '',
          apiKeyEnv: item.env[0] ?? DEFAULT_API_KEY_ENV,
          models: [],
          modelOverrides: {},
        },
      })
    }

    // 不在目录里的那些也列出来, 包括声明默认自带的 `openai` ——
    // 它们已经活着 (`listProviders()` 里有), 这里重复一次是为了让
    // "这张表 = 所有可能存在的路由"这句话成立, 不用调用方自己合并两份。
    // 标记要和 `RouteFacts.declared` 同源, 否则同一个 id 在两个入口里
    // 一个是"自定义"一个是"内置"
    for (const [id, profile] of Object.entries(active)) {
      if (piCatalogProvider(id)) continue
      out.push({
        provider: id,
        displayName: profile.displayName ?? id,
        configScope: CONFIG_SCOPE,
        configPath: ['routes', id],
        // 只在"是"的时候给。`false` 和"没这个字段"在消费方是同一个意思,
        // 给两个形状等于让每个读它的地方都写一遍 `=== true`
        ...(isDeclared(id) ? { declared: true } : {}),
        models: modelsOf(id),
        template: {},
      })
    }
    return out
  }

  let dirHandle: DirectoryHandle | undefined
  let dirFacts = ''

  const syncDirectory = (): void => {
    const entries = directoryEntries()
    // 深比较: 目录里有 declared 标记与显示名, 改名也该刷 —— 但没必要每次都 replace
    const facts = JSON.stringify(entries)
    if (facts === dirFacts) return
    try {
      if (!dirHandle) dirHandle = llm.registerConfigurableProviders(entries)
      else dirHandle.replace(entries)
      dirFacts = facts
    } catch (err) {
      console.error('[meng] provider-openai: 目录更新被拒, 保留上一次的目录:', err)
    }
  }

  syncDirectory()

  /**
   * 目录的**骨架**是同步建的（37 家 1109 条，全部来自静态数据），但"每家
   * 认哪个环境变量"要问 pi 的 auth resolver，那是 async 的。
   *
   * 为什么不等它再建目录: 设置页不该为了"预填一个变量名"晚 100ms 才出现
   * 37 家供应商。先给骨架（`env: []`，模板里 `apiKeyEnv` 落到默认名），
   * 探完再刷一次 —— 刷新走 `replace()`，界面上只是那一格换了值。
   */
  let alive = true
  ctx.effect(() => () => {
    alive = false
  })
  void primeCatalog()
    .then(() => {
      if (alive) syncDirectory()
    })
    .catch((err: unknown) => {
      // 探不到就只是模板里少个变量名，不影响任何请求路径 —— 不报错更不该崩
      console.warn('[meng] provider-openai: 供应商环境变量名探测失败, 用默认名:', err)
    })

  /**
   * 保存路由后**自动拉一次模型**。
   *
   * 只对**目录不认识**的路由动手。目录认识的 (zai / groq / …) 模型由目录供 ——
   * 把目录抄进配置反而把快照冻住: 目录更新了它也不会变, 而用户在配置文件里
   * 多了一份自己不知道的旧清单。所以"自动拉"解决的是自建网关那一段:
   * 它不写 models 就只剩一个兜底的 gpt-4o-mini。
   *
   * 写回用**子路径** (`routes.<id>.models`), 不动别的字段 —— 整表写回会和
   * 设置页的读-改-写互相覆盖 (那条正是 config.set 加 path 的理由)。
   *
   * 失败不重试: 网关没配 key / 协议不支持列表都会失败, 而每次 onChange 都重试
   * 等于把一个必然失败的请求绑在每一次保存上。记下"这组参数试过了", 换了
   * 地址/协议/变量名才再试。
   */
  const autoTried = new Map<string, string>()
  const signatureOf = (profile: RouteProfile): string =>
    [profile.baseURL, profile.protocol, profile.apiKeyEnv].join('|')

  const autoFillModels = async (): Promise<void> => {
    const svc = getConfig(ctx)
    if (!svc) return
    for (const [id, profile] of Object.entries(routes())) {
      if (piCatalogProvider(id)) continue // 目录认识 → 模型由目录供
      if (profile.models.length > 0) continue // 用户自己写了模型, 别覆盖
      if (!profile.baseURL.trim()) continue // 没地址, 拉不了
      const sig = signatureOf(profile)
      if (autoTried.get(id) === sig) continue
      autoTried.set(id, sig)
      try {
        const found = await discover({ provider: id })
        if (found.length === 0) continue
        await svc.set(
          CONFIG_SCOPE,
          'routes',
          // 只搬 DiscoveredModel 有的四个字段。缺容量就是"不知道",
          // 不补 0 —— 补 0 会让界面显示"上下文 0", 那是假信息
          found.map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
            ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
          })),
          [id, 'models'],
        )
        console.log(`[meng] provider ${id} · 自动拉到 ${found.length} 个模型`)
      } catch (err) {
        // 拉不到不是错误: 用户还能手填。但要说一句, 否则"配好了却只有
        // 一个 gpt-4o-mini"会像 bug
        const why = err instanceof Error ? err.message : String(err)
        console.warn(`[meng] provider ${id} · 自动拉模型失败 (可手动添加): ${why}`)
      }
    }
  }

  // 配置一变就对一遍。**订阅而不是轮询**: 没有变化就没有开销,
  // 也没有"两次轮询之间加了路由看不见"的窗口
  ctx.effect(
    () =>
      scope.onChange(() => {
        sync()
        syncDirectory()
        // 不 await: 拉模型是网络请求, 不能让保存动作等它。
        // 拉回来之后自己会再触发一次 onChange (models 非空 → 不会重复拉)
        void autoFillModels()
      }),
  )

  if (!process.env.MENG_QUIET) {
    for (const route of Object.keys(routes())) {
      const profile = profileOf(route)
      if (!profile) continue
      const ids = modelsOf(route).map((m) => m.id)
      const key = apiKeyOf(profile) ? '' : ` · 未配置 (${profile.apiKeyEnv} 为空)`
      console.log(`[meng] provider ${route} · ${ids.join(', ')} · ${stripSlash(profile.baseURL)}${key}`)
    }
  }

  return () => {
    dirHandle?.()
    dirHandle = undefined
    handle?.()
    handle = undefined
    dispose()
  }
}


// ── 看门狗 ───────────────────────────────────────────────────────────────────

/**
 * 空闲看门狗：**不是**总时长超时, 是"多久没收到下一帧"。
 *
 * 与 `provider-deepseek` 里那份同源。思考模型一次可能想 60 秒, 但期间会持续
 * 吐 reasoning-delta; 真正的挂死是一个字节都不来。总时长超时会误杀长思考。
 * 触发后抛 TIMEOUT, assemble() 会把它变成一条带 code 的 error finish。
 */
async function* withIdleTimeout<T>(source: AsyncIterable<T>, ms: number): AsyncIterable<T> {
  const it = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new LlmError(`流 ${ms}ms 没有任何数据帧, 判为挂死`, LLM_CODE.TIMEOUT))
        }, ms)
      })
      try {
        const next = await Promise.race([it.next(), timeout])
        if (next.done) return
        yield next.value
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  } finally {
    // 超时/取消时把源关掉, 否则底层 reader 会一直挂着连接
    await it.return?.(undefined)
  }
}


// ── 模型发现 ─────────────────────────────────────────────────────────────────

/** 模型列表的响应上限。端点是用户填的地址, 上限卡在**实际读到的字节**上 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/**
 * 密钥的可用性检查。空 = 不带鉴权（有些内网网关不需要）。
 *
 * 为什么要自己查: 键里有中文/全角字符时, `fetch` 抛的是 ByteString 的
 * TypeError, 报错会把"你粘贴了一个带空格的 key"说成"网络错误"。
 */
function usableKey(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0xff) {
      throw new LlmError(
        'API 密钥里有 HTTP 头带不了的字符（中文 / 全角符号）, 请粘贴原始密钥',
        LLM_CODE.INVALID_CREDENTIAL,
      )
    }
  }
  return value
}

/** 读响应体, 超过上限就拒。先看声明的长度, 再按实际读到的字节卡 */
async function readBoundedText(res: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} 的响应超过 ${MAX_LISTING_BYTES} 字节, 已拒绝`, LLM_CODE.DISCOVERY_FAILED)

  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await res.body?.cancel()
    throw oversized()
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_LISTING_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * 发一次 GET 并读出 JSON。
 *
 * 三类失败分开说，因为它们对用户的下一步完全不同：
 *   · 连不上       → 地址或网络有问题（改地址 / 检查代理）
 *   · 非 2xx       → 密钥或权限有问题（把状态码和正文原样给出来）
 *   · 不是 JSON    → 地址指向的不是这家 API（最常见的错：把网页地址当接口地址）
 *
 * `label` 是协议名（"Anthropic Messages"），出现在错误里比"OpenAI 兼容端点"
 * 准 —— 用户填的明明是 anthropic 的地址。
 */
async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)', ...headers },
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    throw new LlmError(`连不上 ${url}: ${(err as Error).message}`, LLM_CODE.DISCOVERY_FAILED, {
      cause: err,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new LlmError(
      `${label} 的 ${url} 返回 ${res.status}: ${text.slice(0, 200) || '(无正文)'}`,
      LLM_CODE.DISCOVERY_FAILED,
      { status: res.status },
    )
  }

  const text = await readBoundedText(res, url)
  try {
    return JSON.parse(text)
  } catch {
    throw new LlmError(
      `${url} 返回的不是 JSON —— 这个地址可能不是 ${label} 端点`,
      LLM_CODE.DISCOVERY_FAILED,
    )
  }
}

/**
 * 端点只报了 id 时, 用目录**补**容量。
 *
 * 为什么必须补: `/models` 是"有哪些模型"的接口, 几乎没有端点会返回上下文
 * 窗口和输出上限。不补的话, 用户点一次"以端点为准"就把所有容量变成"不知道"，
 * 而压缩策略要靠它做决定 —— **拉一次真数据不该让系统变笨**。
 *
 * 只填端点**没给**的字段。端点给了就以端点为准, 它才是真相; 目录只负责
 * "端点懒得说的那部分"。目录里根本没有的模型（新上线的）就留空 ——
 * 未知就是未知, 不编。
 */
function withCapacity(found: DiscoveredModel[], directory: readonly CatalogModel[]): DiscoveredModel[] {
  if (directory.length === 0) return found
  const byId = new Map(directory.map((m) => [m.id, m]))
  return found.map((m) => {
    const known = byId.get(m.id)
    if (!known) return m
    return {
      ...m,
      ...(m.name === undefined && known.name ? { name: known.name } : {}),
      ...(m.contextWindow === undefined && known.contextWindow !== undefined
        ? { contextWindow: known.contextWindow }
        : {}),
      ...(m.maxTokens === undefined && known.maxTokens !== undefined ? { maxTokens: known.maxTokens } : {}),
    }
  })
}

// ── 杂项 ─────────────────────────────────────────────────────────────────────

/**
 * wire 层整段（请求序列化 / SSE 解析 / 事件映射 / 错误包装 / token 口径）
 * **不在这个文件里**，全部由 `@meng/pi` 转给 pi-ai 的 9 份协议实现。
 *
 * 曾经这里有 `toOpenAI` / `toTools` / `toUsage` / `wireError` 约 200 行 ——
 * 那是只有一种协议时的手写翻译。协议从 1 种变成 9 种之后，继续留着它们
 * 就是两套 wire 实现（一套在用，一套没人调但测试还打它），比删掉更危险。
 */

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 本插件注册的全部路由。现在不止一条, 所以按 configScope 认亲, 不按固定 id */
const routesOf = (ctx: Ctx): ProviderInfo[] =>
  ctx.get<LLMService>('llm')?.listProviders().filter((p) => p.configScope === CONFIG_SCOPE) ?? []

export const invariant = {
  pkg: '@meng/provider-openai',
  checks: [
    {
      id: 'declared',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm) throw new Error('llm 未注册')
        const mine = routesOf(ctx)
        // 默认配置里有一条 openai, 所以"一条都没有"只可能是配置被清空成 {} 了 ——
        // 那是用户能做出来的事, 说出来比默默没有供应商好
        if (mine.length === 0) throw new Error(`${CONFIG_SCOPE} 下一条路由都没有 (routes 是空表)`)
        for (const info of mine) {
          if (!info.configScope) throw new Error(`路由 ${info.id} 没挂 configScope, 设置页找不到它的配置`)
        }
      },
    },
    {
      /** 见 provider-deepseek 里同名检查的注释: 只在"没有别的可用 provider"时才算失败 */
      id: 'credential-present',
      run(ctx: Ctx) {
        const mine = routesOf(ctx)
        if (mine.some((p) => p.available)) return
        const llm = ctx.get<LLMService>('llm')
        const others = llm?.listProviders().filter((p) => p.configScope !== CONFIG_SCOPE && p.available) ?? []
        if (others.length > 0) return
        // 缺什么由 provider 自己说 (它知道每条路由绑的是哪个变量名)
        const missing = mine.flatMap((p) => p.missing ?? [])
        throw new Error(
          `provider-openai 没有一条可用路由${missing.length > 0 ? `: ${missing.join('; ')}` : ''} —— 而也没有别的可用 provider`,
        )
      },
    },
  ],
}
