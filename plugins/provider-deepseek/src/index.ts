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
 * 凭据的最小替代：`apiKeyEnv` 存的是**环境变量名**，不是密钥本身。
 * dsh 的原话是「a literal key is not a configuration value」——
 * 密钥一旦写进清单，就会跟着清单进 git、进日志、进别人的截图。
 */

import type { Ctx, Disposer } from '@meng/core'
import {
  LLM_CODE,
  LlmError,
  httpErrorCode,
  type LLMService,
  type Provider,
  type StreamChunk,
  type StreamRequest,
} from '@meng/llm'
import {
  ReasoningEffortError,
  serializeRequest,
  type ReasoningEffort,
  type ThinkingMode,
} from './serialize.ts'
import { ssePayloads } from './sse.ts'
import { translate } from './translate.ts'

export const name = 'provider-deepseek'
export const inject = ['llm']

export interface DeepSeekConfig {
  /** 路由 id。多个 DeepSeek 账号（官方 + 第三方代理）可以各占一个 */
  id?: string
  baseURL?: string
  /** **环境变量名**，不是密钥本身 */
  apiKeyEnv?: string
  models?: string[]
  thinking?: ThinkingMode
  reasoningEffort?: ReasoningEffort
  temperature?: number
  maxTokens?: number
  /** 多久没收到任何数据帧就判流挂死。DeepSeek 的思考轮可能长时间静默，别调太小 */
  idleTimeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner']
const DEFAULT_IDLE_TIMEOUT_MS = 300_000

export function apply(ctx: Ctx, config: DeepSeekConfig = {}): Disposer {
  const llm = ctx.get<LLMService>('llm')
  if (!llm) throw new Error('provider-deepseek 依赖 llm')

  const id = config.id ?? 'deepseek'
  const baseURL = stripSlash(config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL)
  const keyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  const models = config.models ?? DEFAULT_MODELS
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  /**
   * 凭据**每次请求时**读，不在装载时冻结。
   * 这样改环境变量 / 换 key 下一个请求就生效，不需要重启进程
   * （dsh 管这条叫"连接事实每次操作解析"）。在飞的那条流保留它开始时的那一份。
   */
  const readKey = (): string => (process.env[keyEnv] ?? '').trim()

  const provider: Provider = {
    id,
    models,

    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      const apiKey = readKey()
      if (!apiKey) {
        throw new LlmError(
          `provider ${id} 没拿到凭据: 环境变量 ${keyEnv} 是空的`,
          LLM_CODE.MISSING_CREDENTIAL,
        )
      }

      // 序列化可能抛 ReasoningEffortError（部署不支持要的档位）——
      // 这是配置错误，不是网络错误，必须原样冒到调用方
      let body: Record<string, unknown>
      try {
        body = serializeRequest({
          request: req,
          thinking: config.thinking,
          reasoningEffort: config.reasoningEffort,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        })
      } catch (err) {
        if (err instanceof ReasoningEffortError) throw new LlmError(err.message, err.code)
        throw err
      }

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // 不可关闭的自我标识：上游统计/限流认这个，也让请求一眼可分辨是谁发的
          'User-Agent': 'meng-agent/0.1 (+https://github.com/linc/meng)',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw wireError(id, res.status, text, res.headers)
      }

      yield* withIdleTimeout(translate(ssePayloads(res.body)), idleTimeoutMs)
    },
  }

  const off = llm.register(provider)
  if (!process.env.MENG_QUIET) {
    const think = config.thinking ? ` · thinking=${config.thinking}` : ''
    console.log(`[meng] provider ${id} · ${models.join(', ')} · ${baseURL}${think}`)
  }
  return off
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
      id: 'registered',
      run(ctx: Ctx) {
        const llm = ctx.get<LLMService>('llm')
        if (!llm) throw new Error('llm 未注册')
        if (!llm.models().length) throw new Error('没有任何模型, agent 无法启动')
      },
    },
    {
      /**
       * 装了但没 key —— 这件事必须**在启动时**说出来，不能等到用户打第一句话。
       * 只警告不拒绝启动: 离线开发时下面还挂着 provider-mock, 整机不该起不来。
       */
      id: 'credential-present',
      run(ctx: Ctx, config?: DeepSeekConfig) {
        const keyEnv = config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
        if (!(process.env[keyEnv] ?? '').trim()) {
          throw new Error(`${keyEnv} 为空 —— 这个 provider 现在发不出请求（离线可用 provider-mock）`)
        }
      },
    },
  ],
}
