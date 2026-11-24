/**
 * 把**真目录**投影成 fixture 用的静态表。
 *
 * ## 为什么需要这一步
 *
 * `apps/web/src/dev/fixture-kernel.ts` 是浏览器里的假内核。它以前手写了 5 家供应商,
 * 后果是"设置页里只有 5 家"这个幻觉一路带进截图和验收 —— 而真内核有 37 家。
 * 用户 2026-11-16 直接问"内置供应商不止 7 个吧", 就是被那份假数据骗的。
 *
 * 但假内核**不能直接 import `@meng/pi`**:
 *   · 它被 `main.tsx` 静态 import, 整份 pi-ai（10 个 SDK 依赖 + 536KB 目录 JSON）
 *     会进主 bundle —— 而它只在 `?transport=fixture` 时有意义;
 *   · pi-ai 的 10 个协议实现是懒加载的, 但目录数据是急加载的, 那 536KB 谁也躲不掉。
 *
 * 所以这里做一次**编译期投影**: 读真目录, 只留设置页真正会读的字段, 写成一个静态模块。
 * 浏览器拿到的是纯数据, 零依赖。
 *
 * ## 漂移怎么防
 *
 * `--check` 模式重新生成一遍再逐字比对, `pnpm test:fixture-directory` 跑它。
 * pi-ai 一升级、目录一变, 这里就红 —— 而不是等某天有人发现"假数据里少了一家"。
 *
 * 用法:
 *   node --experimental-strip-types scripts/gen-fixture-directory.ts           # 重写
 *   node --experimental-strip-types scripts/gen-fixture-directory.ts --check   # 只比对
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { catalog, primeCatalog, type CatalogProvider as PiProvider } from '../packages/pi/src/index.ts'

const OUT = join(import.meta.dirname ?? '.', '..', 'apps', 'web', 'src', 'dev', 'directory.gen.ts')

/** 设置页真正会读的模型字段。多一个字段就多一份要跟着 pi 漂的数据 */
interface SlimModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  output?: string[]
  reasoning?: boolean
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

interface SlimProvider {
  id: string
  name: string
  protocol: string
  baseURL: string
  apiKeyEnv: string[]
  models: SlimModel[]
}

/**
 * 一家 → 一条。
 *
 * 三个刻意的取舍:
 *   · **`protocols[0]`** —— 一家可能混几种协议（cloudflare 三种、opencode 四种）,
 *     而假内核的模板只能写一个。取第一个（pi 的目录里它就是这家主推的那条）。
 *   · **`baseUrl` 可能是空串**（azure / vertex 要资源名）—— 空就写空, 别编一个假地址:
 *     设置页对"地址是空的"有专门的画法, 编一个反而验不到那条。
 *   · **模型全留**, 不截断。截断的话每家都显示"3 款", 而"这家有 114 款"正是
 *     用户要在列表里看出来的信息。
 */
function slimOf(p: PiProvider): SlimProvider {
  const models: SlimModel[] = p.models.map((m) => {
    const one: SlimModel = { id: String(m.id) }
    if (typeof m.name === 'string' && m.name !== '' && m.name !== m.id) one.name = m.name
    if (typeof m.contextWindow === 'number') one.contextWindow = m.contextWindow
    if (typeof m.maxTokens === 'number') one.maxTokens = m.maxTokens
    // `input` 只在**带图**时写: 全是 text 的话界面什么都不画, 存着也是噪音
    const input = Array.isArray(m.input) ? m.input.map(String) : []
    if (input.includes('image')) one.input = input
    if (m.reasoning === true) one.reasoning = true
    return one
  })

  return {
    id: p.id,
    name: p.name,
    protocol: p.protocols[0] ?? 'openai-completions',
    baseURL: p.baseUrl ?? '',
    // 空数组 = 这家不吃"一个环境变量"（bedrock 走 AWS 凭据链, 目录给的是 AWS_* 变量）
    apiKeyEnv: p.env,
    models,
  }
}

function render(list: readonly SlimProvider[], count: { models: number }): string {
  const body = list
    .map((p) => {
      const head = [
        `    id: ${JSON.stringify(p.id)},`,
        `    name: ${JSON.stringify(p.name)},`,
        `    protocol: ${JSON.stringify(p.protocol)},`,
        `    baseURL: ${JSON.stringify(p.baseURL)},`,
        `    apiKeyEnv: ${JSON.stringify(p.apiKeyEnv)},`,
      ]
      const models = p.models.map((m) => `      ${JSON.stringify(m)},`)
      return [
        '  {',
        ...head,
        '    models: [',
        ...models,
        '    ],',
        '  },',
      ].join('\n')
    })
    .join('\n')

  return `/**
 * **自动生成, 别手改。** 改这个文件没有意义 —— 下次跑生成器会被覆盖。
 *
 * 数据源: \`@meng/pi\` 的 \`catalog()\`（pi-ai 目录的投影）, 生成时 ${list.length} 家 /
 * ${count.models} 条模型。
 *
 * 重新生成:
 *   node --experimental-strip-types scripts/gen-fixture-directory.ts
 *
 * 漂移检查（pi 升级后忘了重跑就会红）:
 *   pnpm test:fixture-directory
 *
 * 为什么是生成而不是 import: 假内核被 \`main.tsx\` 静态 import, 直接吃 pi-ai
 * 会把 10 个 SDK 依赖和 536KB 目录数据塞进主 bundle。这里只留设置页会读的字段。
 */

/** 假目录里的一款模型。字段与 \`llm.catalog\` 下发的 \`ModelInfo\` 同形 */
export interface FixtureModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  output?: string[]
  reasoning?: boolean
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

/** 假目录里的一家供应商 */
export interface FixtureDirectoryEntry {
  id: string
  name: string
  /** 这家主推的 wire 协议（一家可能混几种, 这里只留第一个） */
  protocol: string
  /** 空串 = 这家必须自己填地址（azure / vertex 要资源名） */
  baseURL: string
  /** 候选环境变量名, 第一个是推荐的那个。空数组 = 不吃单个环境变量 */
  apiKeyEnv: string[]
  models: FixtureModel[]
}

export const FIXTURE_DIRECTORY: readonly FixtureDirectoryEntry[] = [
${body}
]
`
}

await primeCatalog()
const list = catalog().map(slimOf)
const count = { models: list.reduce((n, p) => n + p.models.length, 0) }
const text = render(list, count)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`✗ ${OUT} 不存在 —— 跑一遍生成器: node --experimental-strip-types scripts/gen-fixture-directory.ts`)
    process.exit(1)
  }
  if (current === text) {
    console.log(`✓ fixture 目录与真目录一致（${list.length} 家 / ${count.models} 条）`)
  } else {
    console.error('✗ fixture 目录与真目录不一致 —— pi-ai 升级过？重跑:')
    console.error('    node --experimental-strip-types scripts/gen-fixture-directory.ts')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`✓ 写入 ${OUT} —— ${list.length} 家 / ${count.models} 条, ${(text.length / 1024).toFixed(0)} KB`)
}
