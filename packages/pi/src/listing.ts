/**
 * 模型列表探测 —— **一种协议一个 listter**。
 *
 * 为什么单独一个文件：`index.ts` 已经 1000 行，而"怎么问端点要模型清单"
 * 和"怎么把配置变成路由"是两件变化节奏不同的事 —— 前者跟着各家的接口文档
 * 变（anthropic 一年改两次字段名），后者跟着我们的 schema 变。
 *
 * **只有 6 种协议有可读列表**。剩下 3 种不是"没实现"，是"没有这个端点"：
 * bedrock 要 `ListFoundationModels` + SigV4 签名，vertex 要 ADC，codex 是
 * 内部端点。它们的 `listable` 保持 false，界面上让用户手填 —— 报"没有列表"
 * 比报"连不上"诚实。
 *
 * 各家形状差得比想象中远（这是这文件存在的理由）：
 *
 * ```
 *   openai 兼容   GET {base}/models              { data: [{ id, name? }] }
 *   anthropic     GET {base}/v1/models           { data: [{ id, display_name }], has_more, last_id }
 *   gemini        GET {base}/v1beta/models       { models: [{ name: 'models/x', inputTokenLimit }], nextPageToken }
 *   azure         GET {base}/openai/models?api-version=…   { data: [{ id }] }
 * ```
 *
 * 认证头也是四套：`Authorization: Bearer` / `x-api-key` + 版本头 /
 * `x-goog-api-key` / `api-key`。混用一个函数只会写出"能跑但不对"的代码。
 */

import { LLM_CODE, LlmError, type DiscoveredModel } from '@meng/llm'

export interface ListingRequest {
  /**
   * 路由上填的接口地址。**可能带版本段也可能不带**：
   * `https://api.openai.com/v1`、`https://api.mistral.ai`、
   * `https://generativelanguage.googleapis.com/v1beta` 都是合法输入。
   */
  baseURL: string
  /** 明文密钥。空串 = 没配（有些端点允许匿名列举，照样发） */
  apiKey: string
  /** 路由自己声明的头，优先级最高（企业网关常要额外的 tenant 头） */
  headers?: Record<string, string>
}

interface Page {
  models: DiscoveredModel[]
  /** 下一页的**完整地址**。没有 = 到头了 */
  next?: string
}

export interface Lister {
  /** 出错时给人看的协议名 */
  label: string
  url(req: ListingRequest): string
  headers(req: ListingRequest): Record<string, string>
  page(body: unknown, url: string): Page
  /** 翻页上限。防"端点永远说还有下一页"把我们拖死 */
  maxPages?: number
}

// ── 公共零件 ─────────────────────────────────────────────────────────────────

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // 不是完整 URL（用户可能只填了 `localhost:8080/v1`）—— 当路径处理
    return url.replace(/^[a-z]+:\/\//i, '').replace(/^[^/]*/, '')
  }
}

/**
 * 补版本段 —— **只在地址是光秃秃的域名时补**。三种情况要分开：
 *
 * ```
 *   https://api.mistral.ai                         路径 = /        → 补 /v1
 *   https://openrouter.ai/api/v1                   路径 = /api/v1  → 直连
 *   http://127.0.0.1:1234/alt（自建网关的路径前缀）  路径 = /alt     → 直连，别动
 * ```
 *
 * 最后一行是这函数存在的理由：无条件补会把 `/alt` 变成 `/alt/v1`，
 * 用户看着自己的地址被改了却不知道为什么 404。**用户写了路径就听他的**，
 * 他比我们清楚自己的网关长什么样。
 */
function versioned(baseURL: string, fallback: string): string {
  const base = stripSlash(baseURL)
  const path = pathOf(base)
  if (/\/(v\d+[a-z0-9]*|beta)$/i.test(path)) return base
  return path === '' || path === '/' ? `${base}${fallback}` : base
}

/** 在一串字符串里挑第一个非空 */
function label(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  return undefined
}

/** 在一串东西里挑第一个正整数 */
function capacity(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c
  }
  return undefined
}

function notJson(url: string): LlmError {
  return new LlmError(`${url} 返回的不是 JSON —— 这个地址可能不对`, LLM_CODE.DISCOVERY_FAILED)
}

function noArray(url: string, what: string): LlmError {
  return new LlmError(
    `${url} 的响应里没有 ${what} —— 这个端点不提供模型列表，请手动添加模型`,
    LLM_CODE.DISCOVERY_FAILED,
  )
}

/** 给地址加上/换掉几个 query 参数 */
function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

// ── ① OpenAI 兼容（openai-completions / openai-responses / mistral） ─────────

/**
 * 最通用的一种，OpenRouter / Groq / Together / z.ai / Mistral 全是这个形状。
 *
 * 容量字段各家乱写，所以同义词都认一遍：`context_window`（OpenAI 新口径）/
 * `context_length`（OpenRouter）/ `max_output_tokens` / `max_tokens`。
 * 认不出来就留空 —— **未知就说未知**，编一个 8192 会让上下文压缩算错。
 */
export const openaiCompatible: Lister = {
  label: 'OpenAI 兼容',
  url: (req) => `${versioned(req.baseURL, '/v1')}/models`,
  headers: (req) => ({
    Accept: 'application/json',
    ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
    ...req.headers,
  }),
  page: (body, url) => {
    const data = (body as { data?: unknown })?.data
    if (!Array.isArray(data)) throw noArray(url, 'data 数组')
    return { models: data.flatMap(readOpenAIEntry) }
  },
}

function readOpenAIEntry(raw: unknown): DiscoveredModel[] {
  const entry = raw as Record<string, unknown> | null
  const id = label(entry?.['id'])
  if (!id) return []
  const name = label(entry?.['name'], entry?.['display_name'])
  const contextWindow = capacity(entry?.['context_window'], entry?.['context_length'])
  const maxTokens = capacity(entry?.['max_output_tokens'], entry?.['max_tokens'])
  return [
    {
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  ]
}

// ── ② Anthropic Messages ─────────────────────────────────────────────────────

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * `GET /v1/models`，认证走 `x-api-key`（**不是** Bearer），且必须带
 * `anthropic-version` —— 缺这个头会 400，报错正文还看不出是头的问题。
 *
 * 分页是游标式：`has_more` + `last_id`，下一页带 `after_id`。
 */
export const anthropicMessages: Lister = {
  label: 'Anthropic Messages',
  url: (req) => `${versioned(req.baseURL, '/v1')}/models?limit=1000`,
  headers: (req) => ({
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(req.apiKey ? { 'x-api-key': req.apiKey } : {}),
    ...req.headers,
  }),
  maxPages: 5,
  page: (body, url) => {
    const b = body as { data?: unknown; has_more?: unknown; last_id?: unknown } | null
    if (!Array.isArray(b?.data)) throw noArray(url, 'data 数组')
    const models = b.data.flatMap((raw): DiscoveredModel[] => {
      const entry = raw as Record<string, unknown> | null
      const id = label(entry?.['id'])
      if (!id) return []
      const name = label(entry?.['display_name'])
      const contextWindow = capacity(entry?.['context_window'], entry?.['max_input_tokens'])
      const maxTokens = capacity(entry?.['max_tokens'], entry?.['max_output_tokens'])
      return [
        {
          id,
          ...(name === undefined ? {} : { name }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
        },
      ]
    })
    const cursor = label(b['last_id'])
    const next = b['has_more'] === true && cursor ? withQuery(url, { after_id: cursor }) : undefined
    return { models, ...(next === undefined ? {} : { next }) }
  },
}

// ── ③ Google Gemini ──────────────────────────────────────────────────────────

/**
 * `GET /v1beta/models`，认证走 `x-goog-api-key`（也支持 `?key=`，头更干净）。
 *
 * **必须过滤**：这个端点把 embedding / TTS / 图片生成全列出来，直接展示的话
 * 用户会选到 `text-embedding-004` 然后在对话里发不出去。判据是
 * `supportedGenerationMethods` 里有 `generateContent`。
 *
 * 名字带前缀：资源名是 `models/gemini-3.8-flash`，对话时要用 `gemini-3.8-flash`，
 * 所以前缀要去掉。
 */
export const googleGenerativeAi: Lister = {
  label: 'Google Gemini',
  url: (req) => `${versioned(req.baseURL, '/v1beta')}/models?pageSize=1000`,
  headers: (req) => ({
    Accept: 'application/json',
    ...(req.apiKey ? { 'x-goog-api-key': req.apiKey } : {}),
    ...req.headers,
  }),
  maxPages: 5,
  page: (body, url) => {
    const b = body as { models?: unknown; nextPageToken?: unknown } | null
    if (!Array.isArray(b?.models)) throw noArray(url, 'models 数组')
    const models: DiscoveredModel[] = []
    for (const raw of b.models) {
      const entry = raw as Record<string, unknown> | null
      const methods = entry?.['supportedGenerationMethods']
      // 字段缺失时**放行**（老版本 API 没有这个字段），有就严格筛
      if (Array.isArray(methods) && !methods.includes('generateContent')) continue
      const name = label(entry?.['name'])
      if (!name) continue
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name
      const display = label(entry?.['displayName'])
      const contextWindow = capacity(entry?.['inputTokenLimit'])
      const maxTokens = capacity(entry?.['outputTokenLimit'])
      models.push({
        id,
        ...(display === undefined ? {} : { name: display }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      })
    }
    const token = label(b['nextPageToken'])
    const next = token ? withQuery(url, { pageToken: token }) : undefined
    return { models, ...(next === undefined ? {} : { next }) }
  },
}

// ── ④ Azure OpenAI ───────────────────────────────────────────────────────────

/**
 * 最麻烦的一家：地址里得带**资源名**，query 里得带 `api-version`，认证头是
 * `api-key`（不是 Bearer）。
 *
 * 地址有两种写法，都得认：
 *   · `https://{资源名}.openai.azure.com`          → 补 `/openai/models`
 *   · `https://{资源名}.openai.azure.com/openai/v1` → 直接接 `/models`
 *
 * `api-version` 用户没填就给个默认值 —— 报"缺 api-version"对他没帮助，
 * 他心里想的是"我就要个模型列表"。真要指定，在地址里带 query 即可（会被保留）。
 */
const AZURE_DEFAULT_API_VERSION = '2024-10-21'

export const azureOpenAI: Lister = {
  label: 'Azure OpenAI',
  url: (req) => {
    const base = stripSlash(req.baseURL)
    const path = pathOf(base)
    const root = /\/openai(\/v1)?$/i.test(path) ? base : `${base}/openai`
    const url = new URL(`${root}/models`)
    if (!url.searchParams.has('api-version')) {
      url.searchParams.set('api-version', AZURE_DEFAULT_API_VERSION)
    }
    return url.toString()
  },
  headers: (req) => ({
    Accept: 'application/json',
    ...(req.apiKey ? { 'api-key': req.apiKey } : {}),
    ...req.headers,
  }),
  page: (body, url) => {
    // Azure 有的版本给 `data`，有的给 `value`（同一家的两个世代）
    const b = body as { data?: unknown; value?: unknown } | null
    const list = Array.isArray(b?.data) ? b.data : Array.isArray(b?.value) ? b.value : undefined
    if (!list) throw noArray(url, 'data 数组')
    return { models: list.flatMap(readOpenAIEntry) }
  },
}

// ── 表 ───────────────────────────────────────────────────────────────────────

/**
 * 协议 → listter。**表里没有 = 这个协议真没有列表端点**（不是懒得写）。
 *
 * `mistral-conversations` 用的是 OpenAI 那个 listter：Mistral 自己就是
 * OpenAI 形状的 `/v1/models`。为它再写一份只会多一份会漂的解析。
 */
const LISTERS: Record<string, Lister> = {
  'openai-completions': openaiCompatible,
  'openai-responses': openaiCompatible,
  'mistral-conversations': openaiCompatible,
  'anthropic-messages': anthropicMessages,
  'google-generative-ai': googleGenerativeAi,
  'azure-openai-responses': azureOpenAI,
}

export function listerOf(protocol: string): Lister | undefined {
  return LISTERS[protocol]
}

/** 能列模型的协议 id —— 给 `PROTOCOLS.listable` 与错误文案用，只有一份来源 */
export function listableProtocols(): string[] {
  return Object.keys(LISTERS)
}

export async function readListing(body: unknown, url: string, lister: Lister): Promise<Page> {
  try {
    return lister.page(body, url)
  } catch (err) {
    if (err instanceof LlmError) throw err
    throw notJson(url)
  }
}
