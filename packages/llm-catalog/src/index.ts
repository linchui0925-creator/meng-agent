/**
 * @meng/llm-catalog — 内置供应商目录（纯数据, 零依赖）。
 *
 * ## 这是什么
 *
 * "用户接一家供应商, 只要填一个 key" 的前提是有人知道**地址、协议、模型名、
 * 上下文窗口**。dsh 把这件事放在 `@earendil-works/pi-ai` 的 provider 目录里
 * （39 家, 每家一份模型 JSON）。我们抄这层目录 —— 不是抄它的 wire 实现。
 *
 * ## 来源与取舍
 *
 * 数据提取自 `@earendil-works/pi-ai`（MIT）的 `dist/providers/data/*.json`,
 * 2026-11 提取。**只保留 `openai-completions` 协议的模型**: 那是本仓库
 * 目前唯一实现了 SSE 翻译的协议。anthropic-messages / openai-responses /
 * google-generative-ai 的供应商（anthropic、google、minimax、kimi-coding…）
 * 故意不在表里 —— 列出来会让用户在设置页选中一家, 然后当场发不出去。
 * 等对应的协议实现落地, 从 pi-ai 再提一次即可。
 *
 * ## 为什么单独一个包
 *
 * `@meng/llm` 是 provider-neutral 的缝, 不认识任何厂商; `provider-openai`
 * 是 adapter, 但它不该把几百行模型数据塞进源码。目录是**第三个东西**:
 * 只被读, 不依赖任何人。
 */

export type ModelInput = 'text' | 'image'

/** 目录里的一条模型。字段语义与 `@meng/llm` 的 `ModelInfo` 一致 */
export interface CatalogModel {
  id: string
  name: string
  /** 上下文总量 (输入 + 输出), token。缺 = 目录没写 */
  contextWindow?: number
  /** 单轮最大输出, token。缺 = 目录没写 */
  maxTokens?: number
  input?: ModelInput[]
  /** 是否支持推理档。缺 = 未知 */
  reasoning?: boolean
}

/** 目录里的一家供应商。`id` 就是配置里的路由名 */
export interface CatalogProvider {
  id: string
  name: string
  /** wire 协议。当前只会有 `openai-completions` */
  protocol: string
  baseURL: string
  /** 候选环境变量名, 第一个是推荐的那个 */
  apiKeyEnv: string[]
  models: CatalogModel[]
}

/** 生成的表。**顺序稳定**, 界面按它画 */
export const CATALOG: readonly CatalogProvider[] = [
  {
    id: "moonshotai-cn",
    name: "Moonshot AI CN",
    protocol: "openai-completions",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    models: [
      {"id": "kimi-k2-0711-preview", "name": "Kimi K2 0711", "contextWindow": 131072, "maxTokens": 16384, "input": ["text"], "reasoning": false},
      {"id": "kimi-k2-0905-preview", "name": "Kimi K2 0905", "contextWindow": 262144, "maxTokens": 262144, "input": ["text"], "reasoning": false},
      {"id": "kimi-k2-thinking", "name": "Kimi K2 Thinking", "contextWindow": 262144, "maxTokens": 262144, "input": ["text"], "reasoning": true},
      {"id": "kimi-k2-thinking-turbo", "name": "Kimi K2 Thinking Turbo", "contextWindow": 262144, "maxTokens": 262144, "input": ["text"], "reasoning": true},
      {"id": "kimi-k2-turbo-preview", "name": "Kimi K2 Turbo", "contextWindow": 262144, "maxTokens": 262144, "input": ["text"], "reasoning": false},
      {"id": "kimi-k2.5", "name": "Kimi K2.5", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k2.6", "name": "Kimi K2.6", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k2.7-code-highspeed", "name": "Kimi K2.7 Code HighSpeed", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k3", "name": "Kimi K3", "contextWindow": 1048576, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
    ],
  },
  {
    id: "qwen-token-plan-cn",
    name: "Qwen Token Plan CN",
    protocol: "openai-completions",
    baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["QWEN_TOKEN_PLAN_CN_API_KEY"],
    models: [
      {"id": "MiniMax-M2.5", "name": "MiniMax-M2.5", "contextWindow": 196608, "maxTokens": 32768, "input": ["text"], "reasoning": true},
      {"id": "deepseek-v3.2", "name": "DeepSeek V3.2", "contextWindow": 131072, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "contextWindow": 1000000, "maxTokens": 384000, "input": ["text"], "reasoning": true},
      {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "contextWindow": 1000000, "maxTokens": 384000, "input": ["text"], "reasoning": true},
      {"id": "glm-5", "name": "GLM-5", "contextWindow": 202752, "maxTokens": 16384, "input": ["text"], "reasoning": true},
      {"id": "glm-5.1", "name": "GLM-5.1", "contextWindow": 202752, "maxTokens": 128000, "input": ["text"], "reasoning": true},
      {"id": "glm-5.2", "name": "GLM-5.2", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "kimi-k2.5", "name": "Kimi K2.5", "contextWindow": 262144, "maxTokens": 98304, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k2.6", "name": "Kimi K2.6", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "kimi-k2.7-code", "name": "Kimi K2.7 Code", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "qwen3.6-flash", "name": "Qwen3.6 Flash", "contextWindow": 1000000, "maxTokens": 65536, "input": ["text", "image"], "reasoning": true},
      {"id": "qwen3.6-plus", "name": "Qwen3.6 Plus", "contextWindow": 1000000, "maxTokens": 65536, "input": ["text", "image"], "reasoning": true},
      {"id": "qwen3.7-max", "name": "Qwen3.7 Max", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "qwen3.7-plus", "name": "Qwen3.7 Plus", "contextWindow": 1000000, "maxTokens": 65536, "input": ["text", "image"], "reasoning": true},
      {"id": "qwen3.8-max-preview", "name": "Qwen3.8 Max Preview", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    protocol: "openai-completions",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["ZAI_API_KEY"],
    models: [
      {"id": "glm-4.5-air", "name": "GLM-4.5-Air", "contextWindow": 131072, "maxTokens": 98304, "input": ["text"], "reasoning": true},
      {"id": "glm-4.7", "name": "GLM-4.7", "contextWindow": 204800, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5-turbo", "name": "GLM-5-Turbo", "contextWindow": 200000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5.1", "name": "GLM-5.1", "contextWindow": 200000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5.2", "name": "GLM-5.2", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5v-turbo", "name": "GLM-5V-Turbo", "contextWindow": 200000, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
    ],
  },
  {
    id: "zai-coding-cn",
    name: "Z.AI Coding CN",
    protocol: "openai-completions",
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: ["ZAI_CODING_CN_API_KEY"],
    models: [
      {"id": "glm-4.5-air", "name": "GLM-4.5-Air", "contextWindow": 131072, "maxTokens": 98304, "input": ["text"], "reasoning": true},
      {"id": "glm-4.7", "name": "GLM-4.7", "contextWindow": 204800, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5-turbo", "name": "GLM-5-Turbo", "contextWindow": 200000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5.1", "name": "GLM-5.1", "contextWindow": 200000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5.2", "name": "GLM-5.2", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "glm-5v-turbo", "name": "GLM-5V-Turbo", "contextWindow": 200000, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
    ],
  },
  {
    id: "xiaomi",
    name: "Xiaomi",
    protocol: "openai-completions",
    baseURL: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: ["XIAOMI_API_KEY"],
    models: [
      {"id": "mimo-v2-flash", "name": "MiMo-V2-Flash", "contextWindow": 262144, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "mimo-v2-omni", "name": "MiMo-V2-Omni", "contextWindow": 262144, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
      {"id": "mimo-v2-pro", "name": "MiMo-V2-Pro", "contextWindow": 1048576, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "mimo-v2.5", "name": "MiMo-V2.5", "contextWindow": 1048576, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
      {"id": "mimo-v2.5-pro", "name": "MiMo-V2.5-Pro", "contextWindow": 1048576, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "mimo-v2.5-pro-ultraspeed", "name": "MiMo-V2.5-Pro-UltraSpeed", "contextWindow": 1048576, "maxTokens": 131072, "input": ["text"], "reasoning": true},
    ],
  },
  {
    id: "ant-ling",
    name: "Ant Ling",
    protocol: "openai-completions",
    baseURL: "https://api.ant-ling.com/v1",
    apiKeyEnv: ["ANT_LING_API_KEY"],
    models: [
      {"id": "Ling-2.6-1T", "name": "Ling 2.6 1T", "contextWindow": 262144, "maxTokens": 65536, "input": ["text"], "reasoning": false},
      {"id": "Ling-2.6-flash", "name": "Ling 2.6 Flash", "contextWindow": 262144, "maxTokens": 65536, "input": ["text"], "reasoning": false},
      {"id": "Ring-2.6-1T", "name": "Ring 2.6 1T", "contextWindow": 262144, "maxTokens": 65536, "input": ["text"], "reasoning": true},
    ],
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "openai-completions",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    models: [
      {"id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": false},
      {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B", "contextWindow": 131072, "maxTokens": 32768, "input": ["text"], "reasoning": false},
      {"id": "meta-llama/llama-4-scout-17b-16e-instruct", "name": "Llama 4 Scout 17B 16E", "contextWindow": 131072, "maxTokens": 8192, "input": ["text", "image"], "reasoning": false},
      {"id": "openai/gpt-oss-120b", "name": "GPT OSS 120B", "contextWindow": 131072, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-20b", "name": "GPT OSS 20B", "contextWindow": 131072, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-safeguard-20b", "name": "Safety GPT OSS 20B", "contextWindow": 131072, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "qwen/qwen3-32b", "name": "Qwen3-32B", "contextWindow": 131072, "maxTokens": 40960, "input": ["text"], "reasoning": true},
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-completions",
    baseURL: "https://api.cerebras.ai/v1",
    apiKeyEnv: ["CEREBRAS_API_KEY"],
    models: [
      {"id": "gemma-4-31b", "name": "Gemma 4 31B IT", "contextWindow": 131072, "maxTokens": 40960, "input": ["text", "image"], "reasoning": true},
      {"id": "gpt-oss-120b", "name": "GPT OSS 120B", "contextWindow": 131072, "maxTokens": 40960, "input": ["text"], "reasoning": true},
      {"id": "zai-glm-4.7", "name": "Z.AI GLM-4.7", "contextWindow": 131072, "maxTokens": 40960, "input": ["text"], "reasoning": true},
    ],
  },
  {
    id: "together",
    name: "Together",
    protocol: "openai-completions",
    baseURL: "https://api.together.ai/v1",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    models: [
      {"id": "MiniMaxAI/MiniMax-M2.7", "name": "MiniMax-M2.7", "contextWindow": 202752, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "MiniMaxAI/MiniMax-M3", "name": "MiniMax-M3", "contextWindow": 524288, "maxTokens": 250000, "input": ["text", "image"], "reasoning": true},
      {"id": "Qwen/Qwen2.5-7B-Instruct-Turbo", "name": "Qwen 2.5 7B Instruct Turbo", "contextWindow": 32768, "maxTokens": 32768, "input": ["text"], "reasoning": false},
      {"id": "Qwen/Qwen3.5-9B", "name": "Qwen3.5 9B", "contextWindow": 262144, "maxTokens": 65536, "input": ["text", "image"], "reasoning": true},
      {"id": "Qwen/Qwen3.6-Plus", "name": "Qwen3.6 Plus", "contextWindow": 1000000, "maxTokens": 500000, "input": ["text"], "reasoning": true},
      {"id": "Qwen/Qwen3.7-Max", "name": "Qwen3.7 Max", "contextWindow": 1000000, "maxTokens": 500000, "input": ["text"], "reasoning": false},
      {"id": "deepseek-ai/DeepSeek-V4-Pro", "name": "DeepSeek V4 Pro", "contextWindow": 512000, "maxTokens": 384000, "input": ["text"], "reasoning": true},
      {"id": "google/gemma-4-31B-it", "name": "Gemma 4 31B Instruct", "contextWindow": 262144, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
      {"id": "meta-llama/Llama-3.3-70B-Instruct-Turbo", "name": "Llama 3.3 70B", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": false},
      {"id": "moonshotai/Kimi-K2.6", "name": "Kimi K2.6", "contextWindow": 262144, "maxTokens": 131000, "input": ["text", "image"], "reasoning": true},
      {"id": "moonshotai/Kimi-K2.7-Code", "name": "Kimi K2.7 Code", "contextWindow": 262144, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "nvidia/nemotron-3-ultra-550b-a55b", "name": "Nemotron 3 Ultra 550B A55B", "contextWindow": 512300, "maxTokens": 512300, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-120b", "name": "GPT OSS 120B", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-20b", "name": "GPT OSS 20B", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "thinkingmachines/Inkling", "name": "Inkling", "contextWindow": 524288, "maxTokens": 131072, "input": ["text", "image"], "reasoning": true},
      {"id": "zai-org/GLM-5.2", "name": "GLM-5.2", "contextWindow": 262144, "maxTokens": 164000, "input": ["text"], "reasoning": true},
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    protocol: "openai-completions",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: ["NVIDIA_API_KEY"],
    models: [
      {"id": "meta/llama-3.1-70b-instruct", "name": "Llama 3.1 70b Instruct", "contextWindow": 128000, "maxTokens": 4096, "input": ["text"], "reasoning": false},
      {"id": "meta/llama-3.1-8b-instruct", "name": "Llama 3.1 8B Instruct", "contextWindow": 16000, "maxTokens": 4096, "input": ["text"], "reasoning": false},
      {"id": "meta/llama-3.2-11b-vision-instruct", "name": "Llama 3.2 11b Vision Instruct", "contextWindow": 128000, "maxTokens": 4096, "input": ["text", "image"], "reasoning": false},
      {"id": "meta/llama-3.2-90b-vision-instruct", "name": "Llama-3.2-90B-Vision-Instruct", "contextWindow": 128000, "maxTokens": 8192, "input": ["text", "image"], "reasoning": false},
      {"id": "meta/llama-3.3-70b-instruct", "name": "Llama 3.3 70b Instruct", "contextWindow": 128000, "maxTokens": 4096, "input": ["text"], "reasoning": false},
      {"id": "minimaxai/minimax-m3", "name": "MiniMax-M3", "contextWindow": 1000000, "maxTokens": 16384, "input": ["text", "image"], "reasoning": true},
      {"id": "mistralai/mistral-small-4-119b-2603", "name": "mistral-small-4-119b-2603", "contextWindow": 128000, "maxTokens": 8192, "input": ["text", "image"], "reasoning": true},
      {"id": "moonshotai/kimi-k2.6", "name": "Kimi K2.6", "contextWindow": 262144, "maxTokens": 262144, "input": ["text", "image"], "reasoning": true},
      {"id": "nvidia/nemotron-3-nano-30b-a3b", "name": "nemotron-3-nano-30b-a3b", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "name": "Nemotron 3 Nano Omni", "contextWindow": 256000, "maxTokens": 65536, "input": ["text", "image"], "reasoning": true},
      {"id": "nvidia/nemotron-3-super-120b-a12b", "name": "Nemotron 3 Super", "contextWindow": 262144, "maxTokens": 262144, "input": ["text"], "reasoning": true},
      {"id": "nvidia/nemotron-3-ultra-550b-a55b", "name": "Nemotron 3 Ultra 550B A55B", "contextWindow": 1000000, "maxTokens": 65536, "input": ["text"], "reasoning": true},
      {"id": "nvidia/nvidia-nemotron-nano-9b-v2", "name": "nvidia-nemotron-nano-9b-v2", "contextWindow": 131072, "maxTokens": 131072, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-120b", "name": "GPT-OSS-120B", "contextWindow": 128000, "maxTokens": 8192, "input": ["text"], "reasoning": true},
      {"id": "openai/gpt-oss-20b", "name": "GPT OSS 20B", "contextWindow": 131072, "maxTokens": 32768, "input": ["text"], "reasoning": true},
      {"id": "stepfun-ai/step-3.5-flash", "name": "Step 3.5 Flash", "contextWindow": 256000, "maxTokens": 16384, "input": ["text"], "reasoning": true},
      {"id": "stepfun-ai/step-3.7-flash", "name": "Step 3.7 Flash", "contextWindow": 256000, "maxTokens": 16384, "input": ["text", "image"], "reasoning": true},
      {"id": "z-ai/glm-5.2", "name": "GLM-5.2", "contextWindow": 1000000, "maxTokens": 131072, "input": ["text"], "reasoning": true},
    ],
  },
]

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]))

const normalizeBaseURL = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase()

/** 按路由 id 找一家。找不到 = 这不是内置供应商（用户自己加的网关） */
export function catalogProvider(id: string): CatalogProvider | undefined {
  return BY_ID.get(id)
}

/**
 * 按**接口地址**找一家。
 *
 * 给"还没保存的路由草稿"用: 设置页点"添加供应商"时手里只有模板里的
 * `baseURL`, 还没有路由 id, 而"这家有哪些模型"正是要显示的东西。
 * 只按 id 匹配的话, 这一步只能去打网络 —— 而打网络要密钥, 用户还没填。
 *
 * 比较前归一首尾斜杠与大小写: 用户从文档里抄 `https://api.z.ai/api/.../v4/`
 * (带尾斜杠) 不该匹配不上目录里的那一行。
 */
export function catalogProviderByBaseURL(baseURL: string): CatalogProvider | undefined {
  const want = normalizeBaseURL(baseURL)
  if (!want) return undefined
  return CATALOG.find((p) => normalizeBaseURL(p.baseURL) === want)
}

/** 一家的模型。不在目录里 = 空数组（不是"没模型", 是"目录不认识它"） */
export function catalogModels(id: string): CatalogModel[] {
  return BY_ID.get(id)?.models ?? []
}

/** 目录里的全部路由 id，按表顺序 */
export function catalogIds(): string[] {
  return CATALOG.map((p) => p.id)
}
