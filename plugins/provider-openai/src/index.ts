/**
 * @meng/provider-openai — 通用 OpenAI 协议适配器（含智谱 / minimax / one-api / vLLM）。
 *
 * 边界: adapter **只负责"把消息变成 delta 流"**。组块、重试、超时、计费、
 * 上下文压缩都不在这里 —— 组块是 @meng/llm 的 assemble()。
 *
 * 这个插件是 dsh `dsh-llm-pi-ai` 的对位：**一个 adapter 服务 N 条路由**。
 * 配置里的 `routes` 是一个字典, 一个 key 一家供应商。加一家不需要写代码,
 * 也不需要重启 —— 增删键会走 `registerAdapter().replace()`, 改值下一个请求生效。
 *
 * 与 `provider-deepseek` 的分工: DeepSeek 的 thinking 协议是另一套 wire
 * (thinking/effort 配对、reasoning_content 回传), 塞进这里会让通用分支长草。
 * 那是专有 adapter, 这是通用 adapter —— dsh 也是这么分的。
 */

import * as z from 'zod'
import type { Ctx, Disposer } from '@meng/core'
import { openScope } from '@meng/config'
import { CATALOG, catalogModels, catalogProvider, catalogProviderByBaseURL } from '@meng/llm-catalog'
import {
  LLM_CODE,
  LlmError,
  httpErrorCode,
  type Adapter,
  type AdapterHandle,
  type ConfigurableProvider,
  type DirectoryHandle,
  type ContentBlock,
  type FinishReason,
  type LLMService,
  type Message,
  type DiscoveredModel,
  type ModelInfo,
  type ProviderInfo,
  type StreamChunk,
  type StreamRequest,
  type ToolSpec,
} from '@meng/llm'
import { parseLine, sseLines } from './sse.ts'

export const name = 'provider-openai'
export const inject = ['llm']

export const CONFIG_SCOPE = 'llm.openai'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_API_KEY_ENV = 'MENG_LLM_API_KEY'
const DEFAULT_TEMPERATURE = 0.7

/**
 * 一条路由既没声明模型、也不在内置目录里时的兜底。
 *
 * 现实里只有一个使用者: 默认那条 `openai` 路由 —— `openai` 自己不在目录里
 * (目录只收第三方), 所以它的 `models: []` 会落到这里。
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
 * 一种 wire 协议。**表驱动**: 加协议 = 这里加一行 + 写一份 stream 翻译。
 *
 * 为什么只列一种: 我们只实现了 `openai-completions` 的 SSE 翻译。
 * `anthropic-messages` 与 `openai-responses` 的翻译是另一件事（不同的
 * 事件名、不同的块语义), 写一行假数据只会让用户在设置页选到一个当场
 * 报错的东西。等翻译写好了再进这张表 —— 加一行即可。
 */
export interface ProtocolSpec {
  /** chat 请求的路径, 拼在 baseURL 后面 */
  chatPath: string
  /** `GET <base>/models` 能读的才给。没有 = 这个协议没法探测, 请手填 */
  listingPath?: string
}

export const PROTOCOLS: Record<string, ProtocolSpec> = {
  'openai-completions': { chatPath: '/chat/completions', listingPath: '/models' },
}

const PROTOCOL_IDS = Object.keys(PROTOCOLS) as [string, ...string[]]

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

  baseURL: z.string().min(1),

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
   * 内置目录里这家供应商带的模型。
   *
   * 单独抽成函数是为了让"目录"是一个可替换的层 (测试可以直接打桩),
   * 而不是散在合并逻辑里的一个 `if`。
   *
   * **注意 `openai` 自己不在目录里** —— 目录只收"走同一个协议、但
   * 我们愿意替用户预填地址和模型清单"的第三方。所以默认那条 `openai`
   * 路由的 `models` 是空的、目录也是空的, 最后落到 `FALLBACK_MODELS`:
   * 升级后不至于一句话都说不出来, 用户填了 key 就能选到 `gpt-4o-mini`。
   */
  const catalogModelsOf = (route: string): ModelInfo[] => catalogModels(route)

  /**
   * 一条路由的模型清单。
   *
   * 三层合并, 照 dsh 的 `resolveRouteModels`:
   *   条目自己的字段 > 目录里的条目 > 路由的 default*
   *
   * `models` 非空 = **整体替换**目录 (dsh: models already replaces the
   * served catalog); 空 = 用目录; 都有 = 报错, 在 `missingOf` 里点名。
   */
  const modelsOf = (route: string): ModelInfo[] => {
    const profile = profileOf(route)
    if (!profile) return []

    const declared = profile.models
    const overrides = profile.modelOverrides ?? {}
    const catalog = catalogModelsOf(route)

    // 模型 id 集合: 声明的 > 目录的 > 只写了覆盖的键 > 兜底。
    // 最后那一档只在"没有目录、也没声明"时出现 —— 让一条刚加的空路由
    // 至少有一个能选的东西, 而不是从选择器里消失
    const ids =
      declared.length > 0
        ? declared.map((m) => m.id)
        : catalog.length > 0
          ? catalog.map((m) => m.id)
          : Object.keys(overrides).length > 0
            ? Object.keys(overrides)
            : FALLBACK_MODELS.map((m) => m.id)

    return ids.map((id) => {
      const entry = declared.find((m) => m.id === id)
      // 兜底条目也是"我们知道的条目", 所以要参与合并 —— 否则它的容量白写了
      const base = catalog.find((m) => m.id === id) ?? FALLBACK_MODELS.find((m) => m.id === id)
      const override = overrides[id]
      // 三层: 声明条目 > 目录条目 > 覆盖。覆盖排在目录后是为了让
      // "给目录里的模型改一个字段"不用把整条重抄一遍
      const source = entry ?? base
      const name = override?.name || source?.name || id
      return {
        id,
        name,
        contextWindow: override?.contextWindow ?? source?.contextWindow ?? profile.defaultContextWindow,
        maxTokens: override?.maxTokens ?? source?.maxTokens ?? profile.defaultMaxTokens,
        input: override?.input ?? source?.input ?? profile.defaultInput,
        ...(override?.reasoning ?? source?.reasoning) === undefined
          ? {}
          : { reasoning: override?.reasoning ?? source?.reasoning },
        ...((override?.description ?? source?.description) === undefined
          ? {}
          : { description: override?.description ?? source?.description }),
      }
    })
  }

  /**
   * 还差什么才能用。**全部由 adapter 自己算** —— 只有它知道缺的是
   * "字典里某一条的某个字段", 扁平配置项看不出来。
   */
  const missingOf = (route: string): string[] => {
    const profile = profileOf(route)
    if (!profile) return [`路由 ${route} 已经不在配置里, 但还挂在注册表上`]

    const out: string[] = []
    if (!apiKeyOf(profile)) out.push(`环境变量 ${profile.apiKeyEnv} 里没有值`)
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
    catalogProvider(route) === undefined && !(route in DEFAULT_ROUTES)

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

    const protocol = PROTOCOLS[profile.protocol]
    if (!protocol) {
      throw new LlmError(
        `路由 ${route} 的协议 ${profile.protocol} 这个 build 还不支持 (支持: ${PROTOCOL_IDS.join(', ')})`,
        LLM_CODE.NO_ADAPTER,
      )
    }

    const models = modelsOf(route)
    const model = req.model || models[0]?.id || ''
    // 输出上限只取**模型条目显式声明**的那一个。路由的 defaultMaxTokens
    // 是"不知道时的假设", 塞进 wire 会因为超出小模型限制而 400
    const declaredMax = models.find((m) => m.id === model)?.maxTokens

    const res = await fetch(`${stripSlash(profile.baseURL)}${protocol.chatPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // 不可关闭的自我标识: 上游统计/限流认这个, 也让请求一眼可分辨
        'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
        ...profile.headers,
      },
      body: JSON.stringify({
        model,
        messages: toOpenAI(req.messages),
        temperature: req.temperature ?? profile.temperature ?? DEFAULT_TEMPERATURE,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxTokens ?? declaredMax ? { max_tokens: req.maxTokens ?? declaredMax } : {}),
        ...(req.tools?.length ? { tools: toTools(req.tools) } : {}),
      }),
      signal: req.signal,
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw wireError(route, res.status, text, res.headers)
    }

    // 块号按**出现顺序**分配, 不是"正文固定 0 号"。
    // 旧写法在"先思考再说话"的模型上是错的: reasoning 和正文都往 0 号块塞,
    // assemble() 以先开的类型为准 (reasoning), 于是回答被并进思考块 ——
    // 而思考不上行广播, 界面上就只剩思考、没有回答。
    // 同一条规矩见 provider-deepseek/src/translate.ts
    let nextIndex = 0
    let textIndex: number | undefined
    let reasoningIndex: number | undefined
    const toolIndex = new Map<number, number>()
    let sawToolCall = false

    const lines = profile.streamIdleTimeoutMs
      ? withIdleTimeout(sseLines(res.body), profile.streamIdleTimeoutMs)
      : sseLines(res.body)

    for await (const line of lines) {
      const chunk = parseLine(line)
      if (!chunk) continue

      if (chunk.error?.message) {
        throw new LlmError(`provider ${route}: ${chunk.error.message}`, LLM_CODE.MALFORMED_RESPONSE)
      }

      if (chunk.usage) {
        yield { type: 'usage', usage: toUsage(chunk.usage) }
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta

        if (delta?.reasoning_content) {
          reasoningIndex ??= nextIndex++
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
        }
        if (delta?.content) {
          textIndex ??= nextIndex++
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }
        if (delta?.tool_calls?.length) {
          for (const call of delta.tool_calls) {
            const wireIndex = call.index ?? 0
            let index = toolIndex.get(wireIndex)
            if (index === undefined) {
              index = nextIndex++
              toolIndex.set(wireIndex, index)
            }
            // 第一个分片带 id/name, 后续只有 arguments 增量
            if (call.id || call.function?.name) sawToolCall = true
            yield {
              type: 'tool-call-delta',
              index,
              ...(call.id ? { id: call.id } : {}),
              ...(call.function?.name ? { name: call.function.name } : {}),
              argumentsDelta: call.function?.arguments ?? '',
            }
          }
        }
        if (choice.finish_reason) {
          yield { type: 'finish', reason: toFinish(choice.finish_reason, sawToolCall) }
          return
        }
      }
    }

    // 流断在 finish 之前 (连接掉了 / provider 忘了收尾): 交给 assemble() 补一个
    // error finish —— 这里补不出更多事实, 也不该伪装成成功
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
  ctx.effect(() =>
    llm.registerModelDiscovery(CONFIG_SCOPE, async (request): Promise<DiscoveredModel[]> => {
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
      const known = request.provider
        ? catalogModelsOf(request.provider)
        : baseURL
          ? (catalogProviderByBaseURL(baseURL)?.models ?? [])
          : []
      if (known.length > 0) {
        return known.map((m) => ({
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
      const spec = PROTOCOLS[protocol]
      if (!spec?.listingPath) {
        throw new LlmError(
          `协议 ${protocol} 没有可读的模型列表 —— 请手动添加模型`,
          LLM_CODE.DISCOVERY_UNSUPPORTED,
        )
      }

      const envName = request.apiKeyEnv || profile?.apiKeyEnv || ''
      const apiKey = usableKey(envName ? (process.env[envName] ?? '').trim() : '')

      const url = `${stripSlash(baseURL)}${spec.listingPath}`
      let res: Response
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
            ...(profile?.headers ?? {}),
          },
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch (err) {
        throw new LlmError(
          `连不上 ${url}: ${(err as Error).message}`,
          LLM_CODE.DISCOVERY_FAILED,
          { cause: err },
        )
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new LlmError(
          `${url} 返回 ${res.status}: ${text.slice(0, 200) || '(无正文)'}`,
          LLM_CODE.DISCOVERY_FAILED,
          { status: res.status },
        )
      }

      const text = await readBoundedText(res, url)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new LlmError(`${url} 返回的不是 JSON —— 这个地址可能不是 OpenAI 兼容端点`, LLM_CODE.DISCOVERY_FAILED)
      }
      return readListing(body, url)
    }),
  )

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

    for (const item of CATALOG) {
      const profile = active[item.id]
      out.push({
        provider: item.id,
        displayName: profile?.displayName ?? item.name,
        configScope: CONFIG_SCOPE,
        configPath: ['routes', item.id],
        models: item.models,
        template: {
          displayName: item.name,
          protocol: item.protocol,
          baseURL: item.baseURL,
          apiKeyEnv: item.apiKeyEnv[0] ?? DEFAULT_API_KEY_ENV,
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
      if (catalogProvider(id)) continue
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

  // 配置一变就对一遍。**订阅而不是轮询**: 没有变化就没有开销,
  // 也没有"两次轮询之间加了路由看不见"的窗口
  ctx.effect(
    () =>
      scope.onChange(() => {
        sync()
        syncDirectory()
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
 * 读一份 OpenAI 形状的模型列表。
 *
 * 字段名各家的叫法不一样（`context_window` / `context_length`,
 * `max_output_tokens` / `max_tokens`), 所以每个字段都试两个名字。
 * 没有 id 的条目**跳过而不是报错**: 一行坏数据不该让用户拿不到其余那些。
 */
function readListing(body: unknown, url: string): DiscoveredModel[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      `${url} 的响应里没有 data 数组 —— 这个端点不支持 /models, 请手动添加模型`,
      LLM_CODE.DISCOVERY_FAILED,
    )
  }

  const label = (...candidates: unknown[]): string | undefined => {
    for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c
    return undefined
  }
  const capacity = (...candidates: unknown[]): number | undefined => {
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c
    }
    return undefined
  }

  const out: DiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as Record<string, unknown> | null
    const id = label(entry?.['id'])
    if (!id) continue
    const name = label(entry?.['name'], entry?.['display_name'])
    const contextWindow = capacity(entry?.['context_window'], entry?.['context_length'])
    const maxTokens = capacity(entry?.['max_output_tokens'], entry?.['max_tokens'])
    out.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return out
}

// ── wire ↔ 中立层 ─────────────────────────────────────────────────────────────

function wireError(providerId: string, status: number, body: string, headers: Headers): LlmError {
  let wireMessage = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error?: { message?: string } }).error
      if (err?.message) wireMessage = err.message
    }
  } catch {
    // 非 JSON 的错误体 (网关 HTML 页等), 原样截断
  }
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const requestId = headers.get('x-request-id') ?? headers.get('request-id') ?? undefined
  return new LlmError(`provider ${providerId} 返回 ${status}: ${wireMessage.slice(0, 300)}`, httpErrorCode(status, wireMessage), {
    status,
    ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
    ...(requestId ? { requestId } : {}),
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

function toFinish(reason: string, sawToolCall: boolean): FinishReason {
  if (reason === 'tool_calls' || (reason === 'stop' && sawToolCall)) return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Token 口径: 互斥计数。OpenAI 系的 prompt_tokens 含缓存命中
 * (prompt_tokens_details.cached_tokens), 不减出来缓存流量会被重复计进成本
 */
function toUsage(wire: {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number } {
  const cached = wire.prompt_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, (wire.prompt_tokens ?? 0) - cached),
    outputTokens: wire.completion_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(wire.completion_tokens_details?.reasoning_tokens
      ? { reasoningTokens: wire.completion_tokens_details.reasoning_tokens }
      : {}),
  }
}

// ── 序列化: 块 → OpenAI wire ─────────────────────────────────────────────────

function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** Message[] → OpenAI wire 格式。导出是为了能被单测直接打 */
export function toOpenAI(messages: Message[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // tool-result 块按 OpenAI 语义拆成独立的 {role:'tool'} 消息;
      // 并发调用时一条 user 消息里会有多个结果, 每个都要出自己的那条
      const text = flattenText(m.content)
      if (text) out.push({ role: 'user', content: text })
      for (const block of m.content) {
        if (block.type === 'tool-result') {
          out.push({ role: 'tool', content: flattenText(block.content), tool_call_id: block.toolCallId })
        }
      }
      continue
    }
    if (m.role === 'assistant') {
      const text = flattenText(m.content)
      const toolCalls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.arguments } }))
      out.push({
        role: 'assistant',
        // 有 tool_calls 时给空 content 是非法的 (provider 直接 400)
        ...(text ? { content: text } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    out.push({ role: m.role, content: flattenText(m.content) })
  }
  return out
}

function toTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

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
