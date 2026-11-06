/**
 * fixture 内核 —— 让前端在后端还没起、provider 还没配的时候就能整条跑通。
 *
 * 用法三处:
 *   1. 浏览器: `?fixture=ok` / `?fixture=blocked` / `?fixture=error`
 *   2. node:   `node --experimental-strip-types apps/web/src/dev/fixture-kernel.ts --smoke`
 *   3. 单测:   直接 `createFixtureKernel('ok')` 塞进 `createInprocTransport`
 *
 * **硬规矩: 只能产出 docs/06 §2 闭集里的事件 type。**
 * 插件不许发明新 type (前端会对未知 type 直接丢弃), fixture 更不许 ——
 * 否则联调时才发现前端"少写了一个分支", 而那个分支根本不存在。
 *
 * 事件序列的长度是**算出来的**, 不是拍的:
 *   ok       session/created + turn/started + 12×llm/chunk + llm/completed + turn/ended = 16
 *   blocked  session/created + turn/started + 3×llm/chunk + llm/completed + tool/called + tool/blocked + turn/ended = 9
 *   error    session/created + turn/started + 2×llm/chunk + error + turn/ended = 6
 *   tools    session/created + turn/started + 2×llm/chunk + llm/completed + 3×(tool/called + tool/completed) + turn/ended = 12
 */

import type { StreamEvent } from '@meng/transport'
import type { InprocKernel } from '@meng/transport/inproc'

export type FixtureName = 'ok' | 'blocked' | 'error' | 'jobs' | 'tools'

export const FIXTURE_NAMES: FixtureName[] = ['ok', 'blocked', 'error', 'jobs', 'tools']

/** 12 片拼起来必须等于这句话 —— 少一片多一片都算 fixture 坏了 */
export const REPLY_TEXT = '你好, 梦。这是一段会被切成 12 片的回复。'
const CHUNKS = ['你', '好', ', ', '梦', '。', '这是', '一段', '会被', '切成', ' 12', ' 片', '的回复。']

export interface FixtureKernel extends InprocKernel {
  readonly name: FixtureName
  /** 已产出的事件 (按 seq 顺序), 供断言与调试面板读 */
  readonly events: StreamEvent[]
  /** 该 fixture 的事件流跑完了 —— smoke 脚本靠它收尾, 不靠 sleep 猜 */
  whenSettled(): Promise<void>
}

interface Draft {
  type: string
  payload?: unknown
  sessionId?: string
  runId?: string
}

function script(name: FixtureName, sessionId: string, runId: string): Draft[] {
  const head: Draft[] = [
    { type: 'session/created', sessionId, payload: { title: '梦 · 演示会话' } },
    { type: 'turn/started', sessionId, runId, payload: { text: '给我讲讲这个平台', runId } },
  ]
  const tail: Draft[] = [{ type: 'turn/ended', sessionId, runId, payload: { reason: 'stop' } }]

  if (name === 'ok') {
    return [
      ...head,
      ...CHUNKS.map((delta) => ({ type: 'llm/chunk', sessionId, runId, payload: { delta, runId } })),
      { type: 'llm/completed', sessionId, runId, payload: { text: REPLY_TEXT, runId, usage: { in: 12, out: 26 } } },
      ...tail,
    ]
  }

  if (name === 'blocked') {
    const callId = `${runId}-call-1`
    return [
      ...head,
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '我来跑一下', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '这个命令', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '。', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: '我来跑一下这个命令。', runId } },
      { type: 'tool/called', sessionId, runId, payload: { callId, tool: 'bash', args: { command: 'rm -rf /' } } },
      {
        type: 'tool/blocked',
        sessionId,
        runId,
        payload: { callId, tool: 'bash', reason: '灾难命令止血带: rm -rf 被拒绝' },
      },
      ...tail,
    ]
  }

  // jobs: 后台任务全流程。`job/started` 后端 2026-11-03 已上线 (B-12), 所以这里
  // 按 B-04 拍板的同构快照先发 running、间隔后再发终态 —— 正好验「运行中 → 落定」
  // 整条链, 以及 started→completed 同 id upsert 成一条。
  if (name === 'jobs') {
    const now = Date.now()
    return [
      ...head,
      ...CHUNKS.slice(0, 4).map((delta) => ({ type: 'llm/chunk', sessionId, runId, payload: { delta, runId } })),
      { type: 'llm/completed', sessionId, runId, payload: { text: '你。', runId } },
      {
        // running 快照: 有 startedAt、无 finishedAt (B-04 拍板的形状)。
        // startedAt 写"3 秒前", 让时间戳看起来是活的。
        type: 'job/started',
        sessionId,
        payload: {
          id: 'bash-1',
          kind: 'bash',
          label: 'pnpm -r build',
          status: 'running',
          startedAt: now - 3_000,
        },
      },
      {
        // 同 id 的终态快照: started → completed 靠 upsert 合成同一条,
        // 而不是叠两条 (这正是 B-03 first-wins 语义要保护的模型)。
        type: 'job/completed',
        sessionId,
        payload: {
          id: 'bash-1',
          kind: 'bash',
          label: 'pnpm -r build',
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: now - 3_000,
          finishedAt: now - 500,
        },
      },
      {
        type: 'job/completed',
        sessionId,
        payload: {
          id: 'bash-2',
          kind: 'bash',
          label: 'pnpm -r build',
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: now - 46_000,
          finishedAt: now - 4_000,
        },
      },
      {
        type: 'job/completed',
        sessionId,
        payload: {
          id: 'fetch-1',
          kind: 'fetch',
          label: 'GET api.github.com/repos/meng',
          status: 'failed',
          detail: '502 Bad Gateway',
          startedAt: now - 12_000,
          finishedAt: now - 2_000,
        },
      },
      ...tail,
    ]
  }

  /**
   * tools: 工具 **done** 态的样本。
   *
   * output 形状**抄真实工具的渲染输出**, 不自己编:
   *   read  → `文件名 (共 N 行)` + `行号\t内容`   (plugins/tool-fs read)
   *   bash  → stdout + `[exit code: N]`           (plugins/tool-bash render())
   *   write → 一句话                              (plugins/tool-fs write)
   *
   * 为什么非要真形状: 后端 agent 目前**没接线** —— packages/agent 里
   * `await tools.call()` 写好了, 但 apps/server 没有任何一处调 agent.run(),
   * 所以真事件一条都发不出来。拿真格式造样本, 等那天接上了界面读的就是真东西,
   * 不用返工; 反过来用编的样本, 接上那天才发现摘要和折叠阈值全错。
   */
  if (name === 'tools') {
    const readOut = [
      'packages/session/src/index.ts (共 300 行)',
      // 12 行内容: 够长到必须折叠, 又不至于在截图里占满一屏
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}\tconst line${i + 1} = ${i + 1}`),
      '… 后面还有 288 行 — 用 offset=13 继续',
    ].join('\n')
    // 非零退出在 tool-bash 里是"结果"不是"失败" —— ok 仍是 true,
    // 界面只能从文本里的 [exit code: 1] 认出来。这一条专门验它。
    // 顺带带上 [stderr]: 真实 bash 输出里 stderr 就是这么插的, 界面靠它分色
    const bashOut = [
      'grep: packages/: No such file or directory',
      '[stderr]',
      "grep: unrecognized option '--git'",
      '[exit code: 1]',
    ].join('\n')

    return [
      { type: 'session/created', sessionId, payload: { title: '梦 · 演示会话' } },
      { type: 'turn/started', sessionId, runId, payload: { text: '把 session 这个文件读出来看看', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '我先读文件', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '，再查一下引用。', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: '我先读文件，再查一下引用。', runId } },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-r`, tool: 'read', args: { file_path: 'packages/session/src/index.ts' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId: `${runId}-r`, tool: 'read', output: readOut } },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-b`, tool: 'bash', args: { command: 'grep -rn "session.append" packages/' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId: `${runId}-b`, tool: 'bash', output: bashOut } },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-w`, tool: 'write', args: { file_path: 'notes/x.md' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId: `${runId}-w`, tool: 'write', output: '已创建 notes/x.md (128 字节)' } },
      ...tail,
    ]
  }

  // error: 内核侧报错, 但**连接不中断** —— 这条要能验出来
  return [
    ...head,
    { type: 'llm/chunk', sessionId, runId, payload: { delta: '我正在', runId } },
    { type: 'llm/chunk', sessionId, runId, payload: { delta: '想…', runId } },
    { type: 'error', sessionId, runId, payload: { code: 'no-provider', message: '没有可用 provider (fixture)' } },
    { type: 'turn/ended', sessionId, runId, payload: { reason: 'error', error: 'no-provider' } },
  ]
}

export interface FixtureOptions {
  /** 两个事件之间的间隔 (ms)。默认 0: node 里跑得快, 浏览器里想看清流式就传 20 */
  gap?: number
}

/**
 * 假会话史 —— **只为让「切换会话」这条交互在无后端时真的能点**。
 *
 * 时间由调用方传 now 现算, 不写死：写死的话过两天"今天"那组就空了,
 * 演示时看到的和设计时的不是同一张图。
 */
interface FakeSession {
  sessionId: string
  title: string
  at: number
  preview: string
  turns: { user: string; assistant: string }[]
}

export function fixtureSessions(now: number): FakeSession[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const t0 = today.getTime()
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  return [
    {
      // 当前会话**不进这张表** —— 它的历史就是真事件流, 由 session.read 直接返回
      sessionId: 'fixture-s-1',
      title: '消息要不要去气泡',
      at: t0 + 11 * HOUR + 5 * 60_000,
      preview: '通栏流比气泡更适合长回复，但会少一层视觉边界',
      turns: [
        { user: '气泡和通栏流你更倾向哪个', assistant: '通栏流。气泡的边界感主要服务短消息，长回复里那圈边框只是噪声。' },
        { user: '那用户和助手怎么区分', assistant: '靠角色标记，不靠容器。用户侧再加一道细压线，权重比气泡轻得多。' },
      ],
    },
    {
      sessionId: 'fixture-s-2',
      title: 'job 事件怎么接',
      at: t0 + 9 * HOUR + 12 * 60_000,
      preview: 'started 与 completed 同形状，按 id upsert',
      turns: [
        { user: '任务条要实时显示进度吗', assistant: '不显示百分比。只显示在跑/完成/失败三态，进度数字在工具自己都不确定时只会撒谎。' },
      ],
    },
    {
      sessionId: 'fixture-s-3',
      title: '插件面板怎么排序',
      at: t0 - DAY + 18 * HOUR + 40 * 60_000,
      preview: '问题优先：failed 排最前，其余按状态',
      turns: [
        { user: '三十个插件打开面板先看谁', assistant: '先看没起来的。二十六个 active 是噪音，打开面板的人九成是来找"哪个坏了"。' },
      ],
    },
    {
      sessionId: 'fixture-s-4',
      title: '三栏布局的断点',
      at: t0 - DAY + 10 * HOUR + 2 * 60_000,
      preview: 'container query 查壳宽，不是视口宽',
      turns: [
        { user: '为什么不用 media query', assistant: '壳被嵌进别的容器时视口宽度会骗人。查壳自己的宽度，组件搬到哪儿都对。' },
      ],
    },
    {
      sessionId: 'fixture-s-5',
      title: '对比度审计',
      at: t0 - 3 * DAY,
      preview: '只审这次写过的 token 参与的配对',
      turns: [
        { user: '全量审会不会太慢', assistant: '会。而且全量审会把没改过的地方也报一遍，真正的回归就淹了。只审写集。' },
      ],
    },
  ]
}

/** 假会话史 → 协议里真有的两类事件。不发明 type, 否则联调时才发现分支不存在 */
function historyEvents(s: FakeSession): StreamEvent[] {
  const out: StreamEvent[] = []
  let n = 0
  for (const turn of s.turns) {
    out.push({
      seq: ++n,
      sessionId: s.sessionId,
      type: 'turn/started',
      at: s.at,
      payload: { text: turn.user, runId: `${s.sessionId}-${n}` },
    })
    out.push({
      seq: ++n,
      sessionId: s.sessionId,
      type: 'llm/completed',
      at: s.at + 1000,
      payload: { text: turn.assistant, runId: `${s.sessionId}-${n}` },
    })
  }
  return out
}

export function createFixtureKernel(name: FixtureName, options: FixtureOptions = {}): FixtureKernel {
  const { gap = 0 } = options
  const sessionId = 'fixture-session'
  let seq = 0
  let runId = ''

  /**
   * 设置页的假数据。**故意做成"可写"的**: `config.set` 改完, 下一次
   * `llm.catalog` 要能看见新值 —— 否则前端只能验"渲染", 验不了"保存后
   * 那一行有没有跟着变", 而后者才是设置页最容易画错的地方。
   *
   * **形状跟真内核一致** (`plugins/provider-openai/src/index.ts` 的 `CONFIG`)。
   * 从 2026-11-04 起 `llm.openai` 只有一项 `routes` —— 一张路由字典。
   * 原来是 baseURL / apiKey / temperature 三个扁平字段, 那套只能描述**一家**
   * 供应商: 用户想同时接官方和自建网关时, 第二个地方都没有。
   */
  /**
   * 哪些环境变量"有值"。fixture 用集合模拟; 真内核读的是 process.env。
   *
   * `DEEPSEEK_API_KEY` 是**故意给的** —— 它是列表里唯一看得见的"可用"态
   * （绿章 / 绿点）。不给的话三种态里少一种: `MENG_LLM_API_KEY` 属于 openai
   * 那条默认路由, 而它在设置页里被隐藏了, 于是界面上永远看不到"配好了"长什么样。
   */
  const env = new Set(['MENG_LLM_API_KEY', 'DEEPSEEK_API_KEY'])

  const settings: Record<string, unknown> = {
    'llm.deepseek.baseURL': 'https://api.deepseek.com',
    'llm.deepseek.models': ['deepseek-chat', 'deepseek-reasoner'],
  }

  /** 当前值: 写过的从 settings 来, 没写过的回落默认 */
  const val = <T>(key: string, fallback: T): T => (key in settings ? (settings[key] as T) : fallback)
  /** 来源: 设置页要画"这个值是你填的, 还是默认的" */
  const src = (key: string): 'settings' | 'default' => (key in settings ? 'settings' : 'default')

  type FixtureModel = {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    input?: string[]
    reasoning?: boolean
  }

  /** 假目录里的一家。形状照真内核 `llm.catalog` 的下发格式, 不是 pi 的内部形状 */
  type FixtureDirectoryEntry = {
    id: string
    name: string
    protocol: string
    baseURL: string
    /** 候选环境变量名, 第一个是推荐的那个 */
    apiKeyEnv: string[]
    models: FixtureModel[]
  }

  /**
   * **假目录**。只有 4 家, 不是真目录的镜像 —— 真目录有 37 家 1109 条模型,
   * 那是 `@meng/pi` 的事, 浏览器里搬一份等于复制一份必然漂移的数据。
   *
   * 选这 5 家的理由不是"代表", 是**每种界面分支都要有人演**:
   *   · `zai`        → 「可添加 → 添加 → 未配置」全流程 (check-settings 钉这条)
   *   · `groq`       → 第二家能加的, 证明列表不是只有一家
   *   · `together`   → 同上, 顺带撑一下长列表的滚动
   *   · `anthropic`  → **另一种协议**。设置页要能画出"这家走 Messages 协议",
   *                    只演 openai-completions 的话那段渲染永远没人走
   *
   * 刻意**没有** bedrock / vertex 这类"不是填个 key 就能用"的: 它们的模板
   * 里没有环境变量可填, 而假内核没有凭据链可演 —— 演成"有个 key 框"比不演更糟。
   */
  const DIRECTORY: readonly FixtureDirectoryEntry[] = [
    {
      id: 'zai',
      name: 'Z.AI',
      protocol: 'openai-completions',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyEnv: ['ZAI_API_KEY'],
      models: [
        { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072, input: ['text'], reasoning: true },
        { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200000, maxTokens: 131072, input: ['text', 'image'], reasoning: true },
      ],
    },
    {
      id: 'groq',
      name: 'Groq',
      protocol: 'openai-completions',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKeyEnv: ['GROQ_API_KEY'],
      models: [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 131072, maxTokens: 32768, input: ['text'] },
      ],
    },
    {
      id: 'together',
      name: 'Together',
      protocol: 'openai-completions',
      baseURL: 'https://api.together.xyz/v1',
      apiKeyEnv: ['TOGETHER_API_KEY'],
      models: [
        { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B', contextWindow: 131072, maxTokens: 16384, input: ['text'] },
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      protocol: 'anthropic-messages',
      baseURL: 'https://api.anthropic.com',
      apiKeyEnv: ['ANTHROPIC_API_KEY'],
      models: [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'], reasoning: true },
      ],
    },
  ]

  /**
   * `openai` 那条默认路由的 profile。字段抄自真内核的 `DEFAULT_ROUTES` ——
   * 那边每个字段都带 `.default()`, 所以是写全的; 这里也一样写全, 否则
   * "编辑这条路由"的表单会缺格子。
   */
  const OPENAI_ROUTE = {
    displayName: 'OpenAI',
    protocol: 'openai-completions',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'MENG_LLM_API_KEY',
    models: [] as FixtureModel[],
    modelOverrides: {} as Record<string, Partial<FixtureModel>>,
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'] as string[],
    headers: {} as Record<string, string>,
  }
  type FixtureRoute = typeof OPENAI_ROUTE

  /**
   * 声明自带的路由名。它们不算"用户自己加的"。
   *
   * **从假目录取**, 不手写 —— 手写的清单会和目录分叉, 而分叉的后果是
   * "设置页里明明有这家, 加完却被标成自己加的"。
   */
  const builtin = new Set(['openai', ...DIRECTORY.map((c) => c.id)])

  /** 路由表现读 settings —— 写完立刻能看见, 前端才验得了"加一条" */
  const routes = (): Record<string, FixtureRoute> =>
    val('llm.openai.routes', { openai: OPENAI_ROUTE }) as Record<string, FixtureRoute>

  /** 一条路由能不能用: 只看它绑的那个环境变量里有没有值 (真内核同一判据) */
  const usable = (route: FixtureRoute): boolean => env.has(route.apiKeyEnv)

  /**
   * **兜底那一条模型**。真内核是 `FALLBACK_MODELS`: 既没声明、目录里也
   * 没有时才用它 —— 也就是"用户手填的一条自定义网关"。
   * 容量是**知道的真值**, 不是路由的 default* —— 后者只是"没写容量时的假设"。
   */
  const FALLBACK_MODELS: FixtureModel[] = [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxTokens: 16384, input: ['text'] },
  ]

  /** 假目录里的那一家 */
  const directoryEntry = (id: string) => DIRECTORY.find((c) => c.id === id)

  /**
   * 一条路由现在有哪些模型。
   *
   * 三段判据**必须和真内核同序** (`provider-openai` 的 `modelsOf`):
   *   ① 路由自己声明了 → 用它
   *   ② 它在内置目录里 → 用目录（点"添加"之后 `template.models` 是空, 走的就是这条）
   *   ③ 都不在 → 兜底那一条
   *
   * 曾经这里是 `id === 'zai' ? ZAI_MODELS : FALLBACK_MODELS` —— 加第二家
   * 目录供应商时就会静默退化成"添加前写 10 款、添加后变成 GPT-4o mini"。
   */
  const modelsOfRoute = (id: string, profile: FixtureRoute): FixtureModel[] => {
    if (profile.models.length > 0) return profile.models
    return (directoryEntry(id)?.models as FixtureModel[] | undefined) ?? FALLBACK_MODELS
  }

  /** 「添加」写进配置的那份初始 profile。真内核的 `template` 就是这个形状 */
  const templateOf = (entry: FixtureDirectoryEntry): FixtureRoute => ({
    displayName: entry.name,
    protocol: entry.protocol,
    baseURL: entry.baseURL,
    apiKeyEnv: entry.apiKeyEnv[0] ?? 'MENG_LLM_API_KEY',
    models: [],
    modelOverrides: {},
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    headers: {},
  })

  /** deepseek 绑的环境变量名。密钥行存的是**名字**, 不是值 */
  const dsKeyEnv = (): string => String(val('llm.deepseek.apiKey', 'DEEPSEEK_API_KEY'))

  const configEntries = () => [
    /**
     * 工作区根目录。**内核侧只有这一项** (`KERNEL_CONFIG.sandbox.root`), 但它是
     * 七个插件的围栏基准 —— 设置页要能看见它、改它, 而且要看得出"这个值是谁定的"。
     *
     * fixture 只演两态: 默认 (`.`) 与设置页写过。第三态 `env` 在真内核里才出现
     * (MENG_WORKSPACE 优先), 这里演不出来就不演 —— 来源文案的正确性由
     * `sourceLabel()` 的单测钉, 不靠假数据凑。
     */
    {
      key: 'sandbox.root',
      scope: 'sandbox',
      name: 'root',
      type: 'string',
      secret: false,
      required: false,
      desc: '工作区根目录。文件读写、搜索、bash 的 cwd 都不能越过它',
      default: '.',
      value: val('sandbox.root', '.'),
      source: src('sandbox.root'),
      schema: { type: 'string', default: '.' },
    },
    {
      key: 'llm.deepseek.apiKey',
      scope: 'llm.deepseek',
      name: 'apiKey',
      type: 'string',
      secret: true,
      required: true,
      desc: '密钥绑定的环境变量名。值是进程启动时读的, 换 key 要重启',
      secretRef: dsKeyEnv(),
      present: env.has(dsKeyEnv()),
      schema: { type: 'string' },
    },
    {
      key: 'llm.deepseek.baseURL',
      scope: 'llm.deepseek',
      name: 'baseURL',
      type: 'string',
      secret: false,
      required: false,
      desc: '接口地址。第三方代理填它自己那一份, 不要带结尾斜杠',
      default: 'https://api.deepseek.com',
      value: val('llm.deepseek.baseURL', 'https://api.deepseek.com'),
      source: src('llm.deepseek.baseURL'),
      schema: { type: 'string', default: 'https://api.deepseek.com' },
    },
    {
      key: 'llm.deepseek.models',
      scope: 'llm.deepseek',
      name: 'models',
      type: 'array',
      secret: false,
      required: false,
      desc: '这个路由能用的模型名。改完立刻生效, 不用重启',
      value: val('llm.deepseek.models', ['deepseek-chat', 'deepseek-reasoner']),
      source: src('llm.deepseek.models'),
      schema: {
        type: 'array',
        items: { type: 'string' },
        default: ['deepseek-chat', 'deepseek-reasoner'],
      },
    },
    {
      /**
       * **整个 scope 只有这一项。** 设置页要画的是"一张键值表, 每个值是一个
       * profile 表单", 而不是三行扁平输入框 —— 加一家供应商 = 加一个键。
       *
       * 值是**对象**, 所以 `ConfigEntry.value` 是 `unknown`: 消费方按 schema
       * 收窄, 别对它做字符串拼接。
       */
      key: 'llm.openai.routes',
      scope: 'llm.openai',
      name: 'routes',
      type: 'object',
      secret: false,
      required: false,
      desc: '一组 OpenAI 协议路由: 键是路由名, 值是它的协议 / 地址 / 密钥变量名 / 模型。加一条就是多一家供应商, 不用重启',
      value: routes(),
      source: src('llm.openai.routes'),
      schema: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['baseURL'],
          properties: {
            displayName: { type: 'string' },
            protocol: { type: 'string', enum: ['openai-completions'], default: 'openai-completions' },
            baseURL: { type: 'string', minLength: 1 },
            apiKeyEnv: { type: 'string', minLength: 1, default: 'MENG_LLM_API_KEY' },
            models: { type: 'array', items: { type: 'object' }, default: [] },
            modelOverrides: { type: 'object', additionalProperties: { type: 'object' }, default: {} },
            defaultContextWindow: { type: 'number', default: 262144 },
            defaultMaxTokens: { type: 'number', default: 32768 },
            defaultInput: { type: 'array', items: { type: 'string', enum: ['text', 'image'] }, default: ['text'] },
            headers: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            streamIdleTimeoutMs: { type: 'number' },
          },
        },
        default: { openai: OPENAI_ROUTE },
      },
    },
  ]

  /**
   * `llm.catalog` 的输出。**顺序 = 注册顺序**: 活着的在前, 目录里还没加的
   * 在后 —— 前端不该自己排序, 排序会让供应商每次启动都可能换位置。
   *
   * 三态各来一个, 一张屏就能看全:
   *   · deepseek  未配置 (缺 key)  · openai 可用  · zai **还没添加** (`dormant`)
   * mock 是"没有可配的东西"的那种, 界面上要画成不可配, 而不是空表单。
   */
  const catalog = () => [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      // 模型条目从 2026-11-04 起是**对象**: 名字之外的容量/模态都在里面。
      // 前端不能再 `models.join(', ')`
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxTokens: 8192, input: ['text'] },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          contextWindow: 128000,
          maxTokens: 65536,
          input: ['text'],
          reasoning: true,
        },
      ] as FixtureModel[],
      available: env.has(dsKeyEnv()),
      configScope: 'llm.deepseek',
      config: configEntries().filter((e) => e.scope === 'llm.deepseek'),
      missing: env.has(dsKeyEnv()) ? [] : [`${dsKeyEnv()} 里没有值`],
    },
    // 路由表里的每一条都是一家供应商。默认只有 `openai`, 用户加一条就多一行
    ...Object.entries(routes()).map(([id, profile]) => ({
      id,
      name: profile.displayName ?? id,
      protocol: profile.protocol,
      models: modelsOfRoute(id, profile),
      available: usable(profile),
      ...(builtin.has(id) ? {} : { declared: true }),
      configScope: 'llm.openai',
      config: configEntries().filter((e) => e.scope === 'llm.openai'),
      missing: usable(profile) ? [] : [`环境变量 ${profile.apiKeyEnv} 里没有值`],
    })),
    {
      // 没有 configScope 的那种: 界面上要能画成"不可配", 而不是一个空表单
      id: 'mock',
      name: 'mock',
      models: [{ id: 'mock-1', name: 'mock-1' }] as FixtureModel[],
      available: true,
      config: [],
      missing: [],
    },
    /**
     * **还没激活**的那些: 内置目录里有、配置里还没有。
     *
     * 这一段**直接遍历 `DIRECTORY`**, 不手写某一家 —— 手写的话假数据就只有
     * 一条, 于是"设置页里只有一家供应商"这种幻觉会一路带进截图和验收
     * （实际发生过一次: 前端看着像没接目录）。
     *
     * `dormant` 的语义与真内核一致: 目录里有、配置里没加。所以这里必须
     * `filter` 掉已经在 `routes()` 里的 —— 否则点完添加会同时出现两条 id
     * 相同的供应商, React 报重复 key, 界面上看起来像"添加没生效, 又多了一条"。
     */
    ...DIRECTORY.filter((entry) => routes()[entry.id] === undefined).map((entry) => ({
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      models: entry.models as FixtureModel[],
      available: false,
      dormant: true,
      configScope: 'llm.openai',
      configPath: ['routes', entry.id],
      template: templateOf(entry),
      config: [],
      missing: ['还没添加 —— 在设置页点"添加"即可'],
    })),
  ]

  const events: StreamEvent[] = []
  const listeners = new Set<(event: StreamEvent) => void>()

  let settle: (() => void) | undefined
  let settled = new Promise<void>((resolve) => {
    settle = resolve
  })

  function emit(draft: Draft): void {
    const event: StreamEvent = { ...draft, seq: ++seq, at: Date.now() }
    events.push(event)
    for (const fn of [...listeners]) {
      try {
        fn(event)
      } catch (err) {
        console.error('[fixture] 订阅者抛错:', err)
      }
    }
  }

  async function pump(drafts: Draft[]): Promise<void> {
    for (const draft of drafts) {
      if (gap > 0) await sleep(gap)
      emit(draft)
    }
  }

  return {
    name,
    events,

    whenSettled(): Promise<void> {
      return settled
    },

    async call(op: string, payload?: unknown): Promise<unknown> {
      switch (op) {
        case 'kernel.hello':
          return { version: 1, modules: [], plugins: [] }

        case 'llm.models':
          return ['mock']

        case 'tools.list':
          return [
            { name: 'bash', description: 'fixture 里的假 bash', parameters: { type: 'object', properties: {} } },
          ]

        case 'session.create':
          return { sessionId, at: Date.now() }

        case 'session.read': {
          // 不带 sessionId 或缺省 = 当前会话 (老行为, 现有脚本都这么调)。
          // 带了别的 id = 假会话史 —— 只为让"切换会话"能真的点。
          const asked = (payload as { sessionId?: unknown } | undefined)?.sessionId
          const sid = typeof asked === 'string' && asked ? asked : sessionId
          if (sid === sessionId) return events
          const fake = fixtureSessions(Date.now()).find((s) => s.sessionId === sid)
          return fake ? historyEvents(fake) : []
        }

        case 'session.list': {
          const now = Date.now()
          const firstUser = events.find((e) => e.type === 'turn/started')
          return [
            {
              sessionId,
              title: '梦 · 演示会话',
              at: events[0]?.at ?? now,
              lastSeq: seq,
              // 还没聊过就不给 preview —— 界面会自然退化成单行, 正好演示这条兜底
              preview: firstUser ? String((firstUser.payload as { text?: unknown })?.text ?? '') : undefined,
            },
            ...fixtureSessions(now).map((s) => ({
              sessionId: s.sessionId,
              title: s.title,
              at: s.at,
              lastSeq: 0,
              preview: s.preview,
            })),
          ]
        }

        case 'session.send': {
          // 与真内核一致: **不等完成**就返回 runId, 进展全走下行的
          runId = `run-${Date.now().toString(36)}`
          const drafts = script(name, sessionId, runId)
          void pump(drafts).then(() => settle?.())
          return { runId, accepted: true }
        }

        case 'session.abort':
          return { ok: true }

        case 'question.list':
          return []

        // ── 设置页: 供应商目录 + 配置读写 ──────────────────
        // 四个 op 的形状与真内核一致 (packages/web/src/ops.ts),
        // 前端照着它写就行了; 真内核那边一处不改这里就过期, 所以下面
        // set/unset 走的是同一套"改完重读"的语义, 而不是返回一个假 ok
        case 'llm.catalog':
          return catalog()

        /**
         * 模型发现 —— 设置页的「获取可用模型」。
         *
         * 真内核有两条路: 内置目录认识这家就**直接答 (零网络)**, 不认识的
         * 才去 `GET <base>/models`。fixture 不联网, 所以只演"直接答"那一路,
         * 而且**故意混进一条目录里没有的** —— 前端要验的是"发现结果怎么和
         * 现有清单合并"(新的加进去、有的更新容量、没再返回的留着还是删掉),
         * 全给已知的就验不出来。
         */
        case 'llm.discoverModels': {
          const { provider, baseURL } = (payload ?? {}) as { provider?: string; baseURL?: string }
          // 真内核有两条认法: 先按路由 id 认目录 (零网络), 认不出才 GET /models。
          // fixture 不打网络, 所以第一条路照抄, 第二条路给一份固定的"端点回报"
          // —— 只有 baseURL 时就是这条路 (新建路由时手里正好只有 baseURL)
          const known = catalog().find((p) => p.id === provider)
          if (known) {
            return known.models.map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
              ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
            }))
          }
          if (!baseURL) throw new Error('fixture: llm.discoverModels 至少要 provider 或 baseURL')
          return [
            { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072 },
            { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 131072 },
            { id: 'glm-6-preview', name: 'GLM-6 Preview' },
          ]
        }

        case 'config.list':
          return configEntries()

        case 'config.set': {
          const { key, value } = (payload ?? {}) as { key?: string; value?: unknown }
          if (!key || value === undefined) throw new Error('fixture: config.set 缺 key 或 value')
          settings[key] = value
          // 密钥行写的是**变量名**, 不是值 —— 所以这里不需要"记住用户填过 key"。
          // 把绑定改成 MY_KEY 之后 env 里没有这个名字, 那一行自然变红,
          // 正好是真内核对"我明明填了却没生效"的表达方式
          const entry = configEntries().find((e) => e.key === key)
          return { entry, scopeEntries: configEntries().filter((e) => e.scope === entry?.scope) }
        }

        case 'config.unset': {
          const { key } = (payload ?? {}) as { key?: string }
          if (!key) throw new Error('fixture: config.unset 缺 key')
          delete settings[key]
          const entry = configEntries().find((e) => e.key === key)
          return { entry, scopeEntries: configEntries().filter((e) => e.scope === entry?.scope) }
        }

        /**
         * 与真内核 `StatusGraph.toJSON()` 逐字段一致 (`{ nodes: NodeRecord[] }`)。
         * 故意把 7 个状态里**会出问题的那几个**都摆出来 —— 面板最容易被画错的是
         * pending 被当成错误染成红的、loading 被当成 active 不动画。fixture 若只给
         * 一堆 active, 这两个 bug 到真机上才会露头。
         */
        case 'plugin.graph':
          return {
            nodes: [
              { id: 'llm-mock', name: 'Mock Provider', status: 'active', inject: ['ctx.llm'], since: Date.now() - 60_000 },
              {
                id: 'demo-ui',
                name: '界面增强 (示例)',
                status: 'active',
                inject: [],
                client: { immediately: false, platforms: ['web'], slots: ['sidebar.header', 'statusbar.item'] },
                since: Date.now() - 30_000,
              },
              {
                id: 'web-search',
                name: '联网搜索',
                status: 'pending',
                inject: [],
                missing: ['secret:SEARCH_API_KEY'],
                since: Date.now() - 8_000,
              },
              {
                id: 'guard-safety',
                name: '安全策略',
                status: 'failed',
                inject: ['ctx.tools'],
                error: 'meng.patch.yml: 第 12 行 inject 写成了 string, 应为 string[]',
                since: Date.now() - 4_000,
              },
              { id: 'indexer', name: '索引器', status: 'loading', inject: ['ctx.fs'], since: Date.now() },
              { id: 'telemetry', name: '遥测', status: 'disabled', inject: [], since: Date.now() - 120_000 },
            ],
          }

        default:
          throw new Error(`fixture: 未实现的 op ${op}`)
      }
    },

    subscribe(fn: (event: StreamEvent) => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/**
 * 从 URL 读 fixture 名。浏览器里 `?fixture=blocked`, 缺省 `ok`。
 * 非 'ok'/'blocked'/'error' 一律回落到 ok —— 打错字不该白屏,
 * 但要在控制台说一声。
 */
export function fixtureFromSearch(search: string): FixtureName {
  const raw = new URLSearchParams(search).get('fixture')
  if (!raw) return 'ok'
  if ((FIXTURE_NAMES as string[]).includes(raw)) return raw as FixtureName
  console.warn(`[fixture] 未知 fixture "${raw}", 回落到 ok`)
  return 'ok'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ────────────────────────────── node 冒烟 ──────────────────────────────
 * 只在 `--smoke` 下执行。浏览器里 process 不存在, 这段会被 tree-shake 掉。
 */

async function smoke(): Promise<void> {
  const { createInprocTransport } = await import('@meng/transport/inproc')
  let failures = 0

  function check(ok: boolean, label: string, detail = ''): void {
    if (ok) {
      console.log(`  ✓ ${label}`)
    } else {
      failures++
      console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`)
    }
  }

  for (const name of FIXTURE_NAMES) {
    const kernel = createFixtureKernel(name)
    const transport = createInprocTransport(kernel)

    const states: string[] = []
    transport.onStateChange((s) => states.push(s))

    check(transport.state() === 'connecting', '初始状态是 connecting (不是同步 online)')

    const seen: StreamEvent[] = []
    transport.subscribe((event) => seen.push(event))

    const hello = (await transport.invoke('kernel.hello')) as { version: number }
    check(hello.version === 1, 'hello 拿到 manifest')

    await transport.invoke('session.create', {})
    await transport.invoke('session.send', { sessionId: 'fixture-session', text: '给我讲讲这个平台' })
    await kernel.whenSettled()

    const types = seen.map((e) => e.type)
    const text = seen
      .filter((e) => e.type === 'llm/chunk')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')

    const seqs = seen.map((e) => e.seq)
    check(
      seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1),
      'seq 严格单调递增 (断线重放的前提)',
    )

    if (name === 'ok') {
      check(text === REPLY_TEXT, `12 片拼接等于原文`, `实际 "${text}"`)
      check(types.includes('turn/ended'), '收到 turn/ended')
      console.log(
        `fixture=ok        ${seen.length} 事件 · ${seen.filter((e) => e.type === 'llm/chunk').length} 片 · 拼接后: "${text}"`,
      )
    }

    if (name === 'blocked') {
      const blocked = seen.find((e) => e.type === 'tool/blocked')
      check(Boolean(blocked), 'tool/blocked 出现')
      check(
        (blocked?.payload as { reason?: string } | undefined)?.reason?.includes('止血带') ?? false,
        'blocked 带 reason',
      )
      console.log(`fixture=blocked   ${seen.length} 事件 · tool/blocked 出现 · reason="${(blocked?.payload as { reason: string }).reason}"`)
    }

    if (name === 'tools') {
      const done = seen.filter((e) => e.type === 'tool/completed')
      check(done.length === 3, '三个工具都落定', `实际 ${done.length}`)
      const bash = done.find((e) => (e.payload as { tool: string }).tool === 'bash')
      const bashOut = String((bash?.payload as { output?: unknown } | undefined)?.output ?? '')
      // 这条是工具卡的命门: 后端把非零退出当"结果"而不是"失败" (ok 仍是 true),
      // 界面唯一的线索就是文本里的 [exit code: 1]。样本里没有它, 摘要就验不出来
      check(bashOut.includes('[exit code: 1]'), 'bash 样本带非零退出')
      console.log(`fixture=tools     ${seen.length} 事件 · 3×tool/completed · bash 带 [exit code: 1]`)
    }

    if (name === 'error') {
      check(types.includes('error'), 'error 事件出现')
      check(transport.state() === 'online', 'error 之后连接仍存活 (state=online)')
      // 还能再发一次 op —— 这才是"连接没死"的实证
      const again = (await transport.invoke('llm.models')) as string[]
      check(again.length > 0, 'error 之后仍能继续 invoke')
      console.log(`fixture=error     ${seen.length} 事件 · error 后 state=${transport.state()} · 仍能 invoke`)
    }

    transport.dispose()
    check(transport.state() === 'offline', 'dispose 后 offline')
    check(states.join('→') === 'online→offline', '状态机序列 online→offline', states.join('→'))
    console.log()
  }

  console.log('─'.repeat(52))
  console.log(failures === 0 ? 'fixture 冒烟全部通过' : `fixture 冒烟失败 ${failures} 项`)
  if (failures > 0) process.exit(1)
}

const isNode = typeof process !== 'undefined' && Array.isArray(process.argv)
if (isNode && process.argv.includes('--smoke')) {
  await smoke()
}
