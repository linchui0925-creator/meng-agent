/**
 * @meng/provider-deepseek — DeepSeek 官方 chat-completions 接入。
 *
 * 为什么单独一个插件，而不是复用 `provider-openai`：
 *   DeepSeek 的 thinking 协议不是 OpenAI 的超集，它是**另一套**——
 *   `thinking: {type}` 与 `reasoning_effort` 要合法配对、带工具调用时必须回传
 *   `reasoning_content`、cache 命中是独立字段。把这些塞进通用 adapter，通用那份
 *   就会长出厂商分支，下一个人加厂商时不知道该往哪写。dsh 也是这么分的
 *   （`dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 是两个包，互斥）。
 *   要接"别的 OpenAI 兼容厂商"，用 `provider-openai`；要接 DeepSeek，用这里。
 *
 * 抄 dsh `dsh-llm-deepseek` 的**行为**，不抄它的框架：
 *   - ✅ thinking/effort 配对、reasoning_content 回传、(no output) 占位、
 *     cache 折减、空闲看门狗、attribution UA、稳定错误码
 *   - ❌ schemastery 配置 schema / credentials seam / settings 热更新 /
 *     registerModelDiscovery —— 我们没有这三个包，抄进来就是死代码
 *
 * 凭据引用：配置里存的是**引用名**，不是密钥本身；值由本机凭据库保存，
 * 找不到时回退到同名环境变量。dsh 的原话仍是底线：
 * 「a literal key is not a configuration value」——密钥不写进 settings/清单。
 */

import * as z from 'zod'
import type { Ctx, Disposer } from '@meng/core'
import { getCredentials, openScope, probeSecret } from '@meng/config'
import {
  LLM_CODE,
  LlmError,
  httpErrorCode,
  toModelInfo,
  type LLMService,
  type ModelInfo,
  type ModelModality,
  type ReasoningEffort as LlmReasoningEffort,
  type Provider,
  type StreamChunk,
  type StreamRequest,
} from '@meng/llm'
import {
  ReasoningEffortError,
  UnsupportedImageError,
  serializeRequest,
  type ReasoningEffort,
  type ThinkingMode,
} from './serialize.ts'
import { ssePayloads } from './sse.ts'
import { translate } from './translate.ts'

export const name = 'provider-deepseek'
export const inject = ['llm']

/** 路由 id。**不是配置项** —— 一个插件实例一条路由, 多账号是另一件事 */
const ROUTE = 'deepseek'

/**
 * 配置的 scope 名。设置页靠它把"这家供应商"和"它的几行配置"连起来:
 * `llm.catalog` 只回一个 scope 名, 设置页再去 `config.list()` 里捞同 scope 的行。
 */
export const CONFIG_SCOPE = 'llm.deepseek'

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner']
const DEFAULT_IDLE_TIMEOUT_MS = 300_000

const EFFORT_LEVELS: readonly LlmReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 端点内容是外部输入：只归一已知类型，未知值不拿来冒充能力。 */
function modalitiesOf(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is ModelModality => item === 'text' || item === 'image')
}

function effortsOf(value: unknown): LlmReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is LlmReasoningEffort =>
    typeof item === 'string' && (EFFORT_LEVELS as readonly string[]).includes(item))
}

function effortOf(value: unknown): LlmReasoningEffort | undefined {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? value as LlmReasoningEffort
    : undefined
}

/**
 * 官方两款的容量。**只有这两个是"知道"的** —— 用户改成一个我们没听说过的
 * 模型名时, 返回 `{id, name}` 而不编容量: 未知可以试, 编错了会让压缩
 * 策略按一个假的上下文窗口做决定。
 *
 * 放常量而不是配置: 它是厂商事实, 不是部署选择。要覆盖就改 `models`
 * 里那一项（第 2 步给 `provider-openai` 做的那种对象写法）—— 这个插件
 * 的 `models` 还是字符串数组, 因为 DeepSeek 官方只有这两款。
 */
const KNOWN_MODELS: Record<string, ModelInfo> = {
  'deepseek-chat': {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    contextWindow: 128_000,
    maxTokens: 8192,
    input: ['text'],
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    contextWindow: 128_000,
    maxTokens: 65_536,
    input: ['text'],
    reasoning: true,
  },
}

/**
 * 这个 provider 的配置声明。**写在这里, 不写在清单里。**
 *
 * 清单里的 `config:` 只有一份, 而且改它要改 YAML 再重启; 声明写在这里,
 * 设置页就能画出表单, 用户点一下就能改。这也是"设置页不需要认识插件"的
 * 实现方式 —— 它只读 `config.list()`。
 *
 * `meta({env})` 是给**老环境变量名**留的活路: 名字已经进了部署脚本和文档,
 * 改掉就是静默失效 (`DEEPSEEK_BASE_URL` 还在, 但没人读了)。
 */
export const CONFIG = {
  baseURL: z.string().default(DEFAULT_BASE_URL).meta({
    env: 'DEEPSEEK_BASE_URL',
    description: '接口地址。第三方代理填它自己那一份, 不要带结尾斜杠',
  }),

  /**
   * **存的是凭据引用名, 不是密钥。** 值由本机凭据库保存（0600），
   * 找不到时回退到同名环境变量；密钥不经过配置通道、不进 settings/清单。
   */
  apiKey: z.string().meta({
    secret: true,
    env: 'DEEPSEEK_API_KEY',
    required: true,
    description: '密钥绑定的环境变量名。值是进程启动时读的, 换 key 要重启',
  }),

  models: z.array(z.string()).default(DEFAULT_MODELS).meta({
    description: '这个路由能用的模型名。改完立刻生效, 不用重启',
  }),

  thinking: z.enum(['enabled', 'disabled']).optional().meta({
    description: 'wire 上的思考开关。留空 = 不写这个字段, 让服务端默认生效',
  }),

  reasoningEffort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional().meta({
    description: '默认推理档位；具体可选项以厂商实时模型能力为准，off = 关闭思考',
  }),

  temperature: z.number().min(0).max(2).optional().meta({
    description: '采样温度。留空 = 用服务端默认',
  }),

  maxTokens: z.number().int().positive().optional().meta({
    description: '单轮输出上限。留空 = 用服务端默认',
  }),

  idleTimeoutMs: z.number().int().positive().default(DEFAULT_IDLE_TIMEOUT_MS).meta({
    description: '多久没收到任何数据帧就判流挂死。思考轮会长时间静默, 别调太小',
  }),
}

export function apply(ctx: Ctx): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-deepseek 依赖 llm')

  const { scope, dispose } = openScope(ctx, CONFIG_SCOPE, CONFIG)
  const credentials = getCredentials(ctx)
  ctx.effect(() => dispose)

  /**
   * 每次请求时读配置, 不在装载时冻结。
   *
   * 这不是洁癖: 用户在设置页改完 baseURL 之后, 下一个请求就该用新的。
   * 冻结了的话表现为"我改了但没生效", 而那条路径上没有一行报错。
   * 在飞的那条流保留它开始时的那一份。
   */
  const read = () => ({
    baseURL: stripSlash(scope.get<string>('baseURL') ?? DEFAULT_BASE_URL),
    keyEnv: scope.secretRef('apiKey') ?? 'DEEPSEEK_API_KEY',
    apiKey: (scope.secret('apiKey') ?? '').trim(),
    thinking: scope.get<ThinkingMode>('thinking'),
    reasoningEffort: scope.get<ReasoningEffort>('reasoningEffort'),
    temperature: scope.get<number>('temperature'),
    maxTokens: scope.get<number>('maxTokens'),
    idleTimeoutMs: scope.get<number>('idleTimeoutMs') ?? DEFAULT_IDLE_TIMEOUT_MS,
  })

  const provider: Provider = {
    id: ROUTE,
    displayName: 'DeepSeek',
    configScope: CONFIG_SCOPE,

    // getter 而不是快照: 模型名是用户在设置页里能改的东西, 改完
    // 选择器和路由要立刻跟着变。快照会变成"重启才生效"的黑洞
    get models(): ModelInfo[] {
      const list = scope.get<string[]>('models')
      const names = Array.isArray(list) && list.length > 0 ? list : DEFAULT_MODELS
      return names.map((name) => KNOWN_MODELS[name] ?? { id: name, name })
    },

    /** 凭据在不在。设置页据此显示"可用 / 未配置" */
    available: () => (scope.secret('apiKey') ?? '').trim() !== '',

    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      const cfg = read()
      if (!cfg.apiKey) {
        throw new LlmError(
          `provider ${ROUTE} 没拿到凭据: 环境变量 ${cfg.keyEnv} 是空的`,
          LLM_CODE.MISSING_CREDENTIAL,
        )
      }

      // 序列化可能抛 ReasoningEffortError（部署不支持要的档位）——
      // 这是配置错误，不是网络错误，必须原样冒到调用方
      let body: Record<string, unknown>
      try {
        body = serializeRequest({
          request: req,
          thinking: cfg.thinking,
          reasoningEffort: cfg.reasoningEffort,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
        })
      } catch (err) {
        if (err instanceof ReasoningEffortError || err instanceof UnsupportedImageError) throw new LlmError(err.message, err.code)
        throw err
      }

      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          // 不可关闭的自我标识：上游统计/限流认这个，也让请求一眼可分辨是谁发的
          'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw wireError(ROUTE, res.status, text, res.headers)
      }

      yield* withIdleTimeout(translate(ssePayloads(res.body)), cfg.idleTimeoutMs)
    },
  }

  const discover = async (request: import('@meng/llm').ModelDiscoveryRequest): Promise<import('@meng/llm').DiscoveredModel[]> => {
    const cfg = read()
    const baseURL = request.baseURL ? stripSlash(request.baseURL) : cfg.baseURL
    const keyEnv = request.apiKeyEnv || cfg.keyEnv
    const apiKey = request.apiKeyEnv
      ? (credentials?.get(keyEnv) || process.env[keyEnv] || '').trim()
      : cfg.apiKey
    if (!apiKey) {
      throw new LlmError(`环境变量 ${keyEnv} 里没有值，无法读取 DeepSeek 模型清单`, LLM_CODE.MISSING_CREDENTIAL)
    }

    let res: Response
    try {
      res = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
          Accept: 'application/json',
        },
        ...(request.signal ? { signal: request.signal } : {}),
      })
    } catch (err) {
      throw new LlmError(`连不上 DeepSeek 模型清单: ${(err as Error).message}`, LLM_CODE.DISCOVERY_FAILED)
    }
    if (!res.ok) throw wireError(ROUTE, res.status, await res.text().catch(() => ''), res.headers)

    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new LlmError('DeepSeek /models 返回的不是 JSON', LLM_CODE.DISCOVERY_FAILED)
    }
    const rows = (body as { data?: unknown }).data
    if (!Array.isArray(rows)) {
      throw new LlmError('DeepSeek /models 没有 data 数组，本次未拉到模型清单', LLM_CODE.DISCOVERY_FAILED)
    }
    return rows.flatMap((row): import('@meng/llm').DiscoveredModel[] => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      if (typeof item.id !== 'string' || !item.id) return []
      const known = KNOWN_MODELS[item.id]
      const input = modalitiesOf(item.input_modalities)
      const output = modalitiesOf(item.output_modalities)
      const effort = item.effort && typeof item.effort === 'object'
        ? item.effort as Record<string, unknown>
        : undefined
      const reasoningEfforts = effortsOf(effort?.supported_levels)
      const defaultReasoningEffort = effortOf(effort?.default_level)
      return [{
        ...(known ?? {}),
        id: item.id,
        name: typeof item.name === 'string' ? item.name : known?.name ?? item.id,
        ...(typeof item.context_window === 'number' ? { contextWindow: item.context_window } : {}),
        ...(typeof item.max_output_tokens === 'number' ? { maxTokens: item.max_output_tokens } : {}),
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(reasoningEfforts === undefined ? {} : { reasoning: reasoningEfforts.length > 0, reasoningEfforts }),
        ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
      }]
    })
  }
  const offDiscovery = llm.registerModelDiscovery(CONFIG_SCOPE, discover)
  ctx.effect(() => scope.onChange(() => llm.invalidateModels()))
  const off = llm.register(provider)
  if (!process.env.MENG_QUIET) {
    const cfg = read()
    const think = cfg.thinking ? ` · thinking=${cfg.thinking}` : ''
    const key = cfg.apiKey ? '' : ` · 未配置 (${cfg.keyEnv} 为空)`
    // `toModelInfo` 不能省: `models` 从 2026-11-04 起是 `ModelEntry[]`
    // (`string | ModelInfo`), 直接拼会打出 "[object Object], [object Object]",
    // 而这行日志是排查"为什么模型选不到"的第一现场
    const names = provider.models.map((m) => toModelInfo(m).id).join(', ')
    console.log(`[meng] provider ${ROUTE} · ${names} · ${cfg.baseURL}${think}${key}`)
  }
  return () => {
    offDiscovery()
    off()
    dispose()
  }
}

// ── 看门狗 ───────────────────────────────────────────────────────────────────

/**
 * 空闲看门狗：**不是**总时长超时，是"多久没收到下一帧"。
 *
 * 思考模型一次可能想 60 秒，但期间会持续吐 reasoning-delta；真正的挂死是
 * 一个字节都不来。用总时长超时会误杀长思考，用空闲超时才对得上事实。
 * 触发后抛 TIMEOUT，assemble() 会把它变成一条带 code 的 error finish。
 */
async function* withIdleTimeout<T>(source: AsyncIterable<T>, ms: number): AsyncIterable<T> {
  const it = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new LlmError(`流 ${ms}ms 没有任何数据帧，判为挂死`, LLM_CODE.TIMEOUT))
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
    // 超时/取消时把源关掉，否则底层 reader 会一直挂着连接
    await it.return?.(undefined)
  }
}

// ── HTTP 错误 → 稳定 code ────────────────────────────────────────────────────

/**
 * 与 `provider-openai` 里那份同源。等第三个 adapter 出现时再提到 `@meng/llm`
 * —— 现在就抽，等于为两个调用点造一个抽象层。
 */
function wireError(providerId: string, status: number, body: string, headers: Headers): LlmError {
  let wireMessage = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error?: { message?: string } }).error
      if (err?.message) wireMessage = err.message
    }
  } catch {
    // 非 JSON 的错误体（网关 HTML 页等），原样截断
  }
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const requestId = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id') ?? undefined

  return new LlmError(
    `provider ${providerId} 返回 ${status}: ${wireMessage.slice(0, 300)}`,
    httpErrorCode(status, wireMessage),
    {
      status,
      ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
      ...(requestId ? { requestId } : {}),
    },
  )
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export const invariant = {
  pkg: '@meng/provider-deepseek',
  checks: [
    {
      id: 'declared',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm) throw new Error('llm 未注册')
        // 这条查的是"声明真的挂上了": 路由出现在 listProviders 里, 且带着自己的 scope。
        // 少了它, 设置页会静默地看不到这家供应商 —— 而界面上没有任何报错
        const info = llm.listProviders().find((p) => p.id === ROUTE)
        if (!info) throw new Error(`路由 ${ROUTE} 没注册上`)
        if (!info.configScope) throw new Error(`路由 ${ROUTE} 没挂 configScope, 设置页找不到它的配置`)
      },
    },
    {
      /**
       * 装了但没 key ——— **只在"它是唯一能顶上的那家"时才算失败。**
       *
       * 为什么不能无条件红: 现在所有供应商都是一直装着的 (设置页要能列出
       * "未配置"的那几家, 否则用户没有入口去配), 于是"某一家没 key"是
       * **正常状态**, 不是故障。无条件红会让每次启动都以 exit 1 收场,
       * 于是真正的故障也被淹没在一条天天出现的红里。
       *
       * 整机真的没有可用模型时, @meng/llm 的 default-route-usable 会红;
       * 这条的额外价值是**说出环境变量名** —— 那句话才是用户要改的东西。
       */
      id: 'credential-present',
      run(ctx: Ctx) {
        const { value, ref } = probeSecret(ctx, CONFIG_SCOPE, 'apiKey', CONFIG)
        if ((value ?? '').trim()) return
        const llm = ctx.get<LLMService>('llm')
        const others = llm?.listProviders().filter((p) => p.id !== ROUTE && p.available) ?? []
        if (others.length > 0) return
        throw new Error(
          `${ref ?? 'DEEPSEEK_API_KEY'} 为空 —— 这个 provider 现在发不出请求, 而也没有别的可用 provider`,
        )
      },
    },
  ],
}
