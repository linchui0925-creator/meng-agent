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

// 真目录的投影（37 家 / 1109 条）。**自动生成**, 别手改 —— 见该文件头。
import { FIXTURE_DIRECTORY, type FixtureDirectoryEntry, type FixtureModel } from './directory.gen.ts'

export type FixtureName = 'ok' | 'blocked' | 'error' | 'jobs' | 'tools' | 'md' | 'question' | 'question-multi' | 'question-fail' | 'send-fail'

export const FIXTURE_NAMES: FixtureName[] = ['ok', 'blocked', 'error', 'jobs', 'tools', 'md', 'question', 'question-multi', 'question-fail', 'send-fail']

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

  if (name === 'ok' || name === 'send-fail') {
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
      {
        type: 'llm/completed',
        sessionId,
        runId,
        // usage 是真的: 真内核每轮 completed 都报。输入框那格"用了多少上下文"靠它,
        // 假数据不给的话那一格永远不出现, 等于这条链没验过
        payload: { text: '我先读文件，再查一下引用。', runId, usage: { in: 18432, out: 512 } },
      },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-r`, tool: 'read', args: { file_path: 'packages/session/src/index.ts' } } },
      /*
       * read 这条**带记录**：事件里是被截断的 12 行，全文在 `tool.record`。
       * 三个字段缺一不可 —— `truncated` 决定画不画入口，`recordId` 决定点了取什么，
       * `bytes` 只是让按钮上能写"13.6 KB"（用户凭它决定值不值得点）。
       */
      {
        type: 'tool/completed',
        sessionId,
        runId,
        payload: {
          callId: `${runId}-r`,
          tool: 'read',
          result: readOut,
          recordId: RECORD_READ,
          bytes: fixtureToolRecord().length,
          truncated: true,
        },
      },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-b`, tool: 'bash', args: { command: 'grep -rn "session.append" packages/' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId: `${runId}-b`, tool: 'bash', result: bashOut } },
      { type: 'tool/called', sessionId, runId, payload: { callId: `${runId}-w`, tool: 'write', args: { file_path: 'notes/x.md' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId: `${runId}-w`, tool: 'write', result: '已创建 notes/x.md (128 字节)' } },
      ...tail,
    ]
  }

  /**
   * md: **Markdown 渲染的样本**。
   *
   * 存在的理由: 其它 fixture 的助手消息都是一句人话, 那样"Markdown 有没有生效"
   * 在假数据上验不出来（纯文本过一遍渲染器还是纯文本）。这里放一段真的会
   * 触发每一种块的输出 —— 标题 / 列表 / 围栏代码 / 行内代码 / 粗体 / 链接 /
   * 引用, 外加一条 `javascript:` 链接（它必须**不**变成 `<a>`）。
   */
  if (name === 'md') {
    const answer = [
      '先说结论：**这份配置能跑**，但有三处要改。',
      '',
      '## 要改的三处',
      '',
      '1. `baseURL` 少了 `/v1`',
      '2. `apiKeyEnv` 指向一个不存在的变量',
      '3. 模型清单里有一条写错了',
      '',
      '改完大概是这样：',
      '',
      '```ts',
      "const route = {",
      "  baseURL: 'https://api.example.com/v1',",
      "  apiKeyEnv: 'MY_RELAY_KEY',",
      '}',
      '```',
      '',
      '> 注意：改完不用重启，下一个请求就生效。',
      '',
      '参考 [接口文档](https://example.com/docs)，或者看 [这条](javascript:alert(1)) —— 后者不该能点。',
      '',
      '裸链接：https://example.com/bare。 和不带协议的 example.com 不识别。',
      '',
      '- 第一条',
      '- 第二条',
      '',
      '| 项目 | 当前值 | 建议 |',
      '| --- | ---: | :---: |',
      '| 上下文 | `6144` | 保留 |',
      '| 代码 | 12.5px | 滚动 |',
    ].join('\n')

    return [
      { type: 'session/created', sessionId, payload: { title: '梦 · Markdown 样本' } },
      { type: 'turn/started', sessionId, runId, payload: { text: '帮我看看这份配置 https://example.com/user。', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '先说结论：', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '**这份配置能跑**', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: answer, runId, usage: { in: 6144, out: 380 } } },
      ...tail,
    ]
  }

  /**
   * question: **模型提问**的完整一轮。
   *
   * 这一轮是**挂起**的 —— 脚本里没有 turn/ended, 直到用户回答了才有下文。
   * 这正是 ask_user_question 在真内核里的形状: 模型停在那儿等你点选项。
   *
   * 选项里刻意放一个「其他城市」: 前端对它不能直接提交 key, 得开自由输入
   * (用户点它多半是想说一个列表之外的地方)。
   */
  if (name === 'question') {
    const questionId = `q-${runId}`
    return [
      { type: 'session/created', sessionId, payload: { title: '梦 · 提问演示' } },
      { type: 'turn/started', sessionId, runId, payload: { text: '帮我在本地部署一下', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '先确认一下城市。', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: '先确认一下城市。', runId, usage: { in: 2048, out: 32 } } },
      {
        type: 'question/asked',
        sessionId,
        runId,
        payload: {
          questionId,
          kind: 'info',
          title: '你想在哪个城市部署？',
          body: '不同城市的可用区不一样, 选一个我才能继续。',
          choices: [
            { key: 'beijing', label: '北京' },
            { key: 'shanghai', label: '上海' },
            { key: 'shenzhen', label: '深圳' },
            { key: 'other', label: '其他城市' },
          ],
          sessionId,
          runId,
        },
      },
    ]
  }

  /**
   * question-multi: 同时挂起三个问题，模拟模型在一次部署准备里连续追问。
   * 第一个问题和执行链关联（callId/toolName），用来验证卡片不再重复长正文。
   */
  if (name === 'question-multi') {
    const callId = `${runId}-prepare`
    const detail = '检测到当前目录同时包含开发环境、演示数据和一份本机密钥文件。直接部署会上传 1.8 GB 模型缓存、12 个测试数据库，以及 .env.local 中的接口密钥。建议只同步运行所需的文件，并重新生成生产配置。'
    return [
      { type: 'session/created', sessionId, payload: { title: '梦 · 多问题演示' } },
      { type: 'turn/started', sessionId, runId, payload: { text: '帮我在本地部署一下', runId } },
      { type: 'llm/chunk', sessionId, runId, payload: { delta: '目录检查完成，还有三项需要你确认。', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: '目录检查完成，还有三项需要你确认。', runId, usage: { in: 4096, out: 48 } } },
      { type: 'tool/called', sessionId, runId, payload: { callId, tool: 'deploy.prepare', args: { path: '/Users/linc/Documents/demo' } } },
      { type: 'tool/completed', sessionId, runId, payload: { callId, tool: 'deploy.prepare', result: detail } },
      {
        type: 'question/asked', sessionId, runId,
        payload: {
          questionId: `scope-${runId}`, kind: 'info', title: '这次要部署哪些内容？', body: detail,
          choices: [
            { key: 'prod-only', label: '只部署运行所需文件' },
            { key: 'with-cache', label: '包含模型缓存' },
            { key: 'manual', label: '停止部署，我手动整理' },
            { key: 'other', label: '使用其他目录' },
          ],
          toolName: 'deploy.prepare', callId, sessionId, runId,
        },
      },
      {
        type: 'question/asked', sessionId, runId,
        payload: {
          questionId: `secret-${runId}`, kind: 'approval', title: '允许写入测试环境的 .env.local 吗？',
          body: '该文件会保存测试环境所需的接口地址与本地密钥。', toolName: 'write', callId: `${runId}-write`,
          choices: [{ key: 'approve', label: '允许' }, { key: 'deny', label: '拒绝' }], sessionId, runId,
        },
      },
      {
        type: 'question/asked', sessionId, runId,
        payload: {
          questionId: `restart-${runId}`, kind: 'info', title: '部署完成后要重启本地服务吗？',
          choices: [{ key: 'restart', label: '现在重启' }, { key: 'later', label: '稍后我自己重启' }], sessionId, runId,
        },
      },
    ]
  }

  /** question-fail: 回答提交必然失败，用来验“失败原因以 JSON 交给模型”的前端半边。 */
  if (name === 'question-fail') {
    return [
      { type: 'session/created', sessionId, payload: { title: '梦 · 提交失败演示' } },
      { type: 'turn/started', sessionId, runId, payload: { text: '继续执行吗？', runId } },
      { type: 'llm/completed', sessionId, runId, payload: { text: '需要你确认后继续。', runId, usage: { in: 1024, out: 16 } } },
      {
        type: 'question/asked', sessionId, runId,
        payload: {
          questionId: `fail-${runId}`, kind: 'info', title: '是否继续执行？',
          choices: [{ key: 'continue', label: '继续' }], sessionId, runId,
        },
      },
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

/**
 * 挂起中的问题在假后端里的形状。抄 packages/questions 的 Question ——
 * 字段名一样, 前端那份解析器才不用为 fixture 单独写一套。
 */
interface PendingShape {
  questionId: string
  kind: string
  title: string
  body?: string
  choices?: { key: string; label: string }[]
  toolName?: string
  callId?: string
  sessionId: string
  runId?: string
  at: number
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
  /** 这段会话落在哪个工作区（`workspace.list` 里的 id）。缺 = 普通任务 */
  workspace?: string
  turns: { user: string; assistant: string }[]
}

/**
 * 假工作区。
 *
 * **id 就用绝对路径**，和真实现一致: 路径本身就是稳定的身份, 换一个 uuid 意味着
 * "同一个目录"在两次启动之间变成两个工作区, 而用户会看到同一个项目出现两次。
 *
 * `backend` 故意**没有会话** —— 它只在输入框那个选择器里出现, 不进侧栏:
 * 空工作区在侧栏占一个分组标题只是噪音（`splitByWorkspace` 的单测钉着这条）。
 */
export const FIXTURE_WORKSPACES = [
  { id: '/Users/linc/Documents/梦', name: '梦', path: '/Users/linc/Documents/梦' },
  { id: '/Users/linc/Projects/fronend', name: 'fronend', path: '/Users/linc/Projects/fronend' },
  { id: '/Users/linc/Projects/backend', name: 'backend', path: '/Users/linc/Projects/backend' },
] as const

/**
 * 工具分组（B-27）。三组、每组的工具名逐字照后端 —— 界面上那一行要能让用户
 * 认出"关掉它我会失去什么"，写自己的名字就白写了。
 */
export const FIXTURE_TOOL_GROUPS: Array<{ id: string; tools: string[] }> = [
  { id: 'core', tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'outline', 'ask_user_question'] },
  { id: 'jobs', tools: ['job_output', 'job_list', 'job_kill'] },
  { id: 'web', tools: ['web_fetch'] },
]

const WS_MENG: string = FIXTURE_WORKSPACES[0].id
const WS_FRONTEND: string = FIXTURE_WORKSPACES[1].id

/** 那条 read 记录在 fixture 里的 id。`tool.record` 认它，别的 id 一律当 404 */
const RECORD_READ = 'rec-read-1'

/**
 * `read` 那条工具调用的**完整**输出（300 行）。
 *
 * 事件里只放前 12 行 + 一句"后面还有 288 行"，全文走 `tool.record` ——
 * 这正是 B-27 三层分离的形状：事件流要能被完整回放（不该读几 MB 的 stdout），
 * 全文在本地记录里，想看的人自己取。纯 ASCII，所以 `length` 就是字节数。
 */
export function fixtureToolRecord(): string {
  return Array.from({ length: 300 }, (_, i) => `${i + 1}\tconst line${i + 1} = ${i + 1}`).join('\n')
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
      workspace: WS_MENG,
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
      workspace: WS_FRONTEND,
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
  /** 最近一次 `session.create` 带的工作区。`session.list` 用它报当前会话的归属 */
  let createdWorkspace: string | undefined
  /** 首条消息生成的默认标题，以及双击卡片提交的改名。只保存在假内核内存里。 */
  let createdTitle = '梦 · 演示会话'
  const renamedTitles = new Map<string, string>()
  /** `workspace.create` 建出来的那些。真内核落盘，这里只活在内存里 */
  const createdWorkspaces: Array<{ id: string; name: string; path: string }> = []
  /** 删除验收只改假内核内存，不接触任何正式会话。 */
  const deletedSessions = new Set<string>()
  const deletePayloads: unknown[] = []

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

  /**
   * **假目录 = 真目录的投影**, 不是手写的一份。
   *
   * 数据来自 `@meng/pi` 的 `catalog()`（pi-ai 的 37 家 / 1109 条）, 由
   * `scripts/gen-fixture-directory.ts` 生成成静态模块。以前这里手写了 5 家,
   * 后果是"设置页里只有 5 家"这个幻觉一路带进截图和验收 —— 而真内核有 37 家,
   * 用户 2026-11-16 直接问"内置供应商不止 7 个吧"。
   *
   * 为什么是生成而不是 import `@meng/pi`: 假内核被 `main.tsx` 动态 import,
   * 但直接吃 pi-ai 会把 10 个 SDK 依赖和 536KB 目录 JSON 一起拉进来。
   * 生成物只有设置页会读的字段（154KB）, 且**漂移有测试兜底**
   * （`pnpm test:fixture-directory` 会重新生成一遍逐字比对）。
   */
  const DIRECTORY: readonly FixtureDirectoryEntry[] = FIXTURE_DIRECTORY

  /**
   * `openai` 那条默认路由的 profile。字段抄自真内核的 `DEFAULT_ROUTES` ——
   * 那边每个字段都带 `.default()`, 所以是写全的; 这里也一样写全, 否则
   * "编辑这条路由"的表单会缺格子。
   */
  const OPENAI_ROUTE = {
    displayName: 'OpenAI',
    // `openai-responses` 而不是 `openai-completions`: 真内核那条默认路由走的是
    // pi-ai 的 responses 实现（B-22: 那家 38 个模型全在 `openai-responses` 上）。
    // 假数据写成 completions 的话, "设置页会显示这条路由的协议"这件事永远验不到
    // 另一种值 —— 而那是把 openai 放出来之后唯一新增的显示项。
    protocol: 'openai-responses',
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

  /**
   * 「测试连接」（`source: 'endpoint'`）时端点回报的那份清单。
   *
   * **故意和目录里的不一样**（目录给的是 glm 那 12 款）。原因: 设置页有两个
   * 按钮问同一个地址 —— 「获取可用模型」（默认走目录, 零网络）和「测试连接」
   * （强制出网）。两者回同一份数据的话, "前端到底有没有传 source"在假数据上
   * 永远验不出来, 而少传那个字段的表现是「测试连接」变成了一个永远成功的假绿灯。
   */
  const ENDPOINT_MODELS: FixtureModel[] = [
    { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072 },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 131072 },
    { id: 'glm-6-preview', name: 'GLM-6 Preview' },
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
    if (profile.models.length > 0) {
      /*
       * 声明了的就用它 —— 但**目录里认识的那些要补上容量**。
       *
       * 前端把拉到的模型写回配置时写的是 `[{ id }]`（`config.set` 只收 id,
       * 这一点和真内核一致）。若这里直接返回 `profile.models`, 界面上刚加完
       * 一家的模型清单会**突然丢掉所有上下文/输出容量** —— 用户会以为
       * "添加"把目录信息弄坏了。真内核也是这么合的（声明优先, 元数据按 id 补）。
       */
      const dir = directoryEntry(id)?.models ?? []
      return profile.models.map((m) => {
        const known = dir.find((d) => d.id === m.id)
        return known === undefined ? m : { ...known, ...m }
      })
    }
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
    /**
     * 权限模式（B-25）。**和 `sandbox.root` 同一个 scope** —— 目录是范围,
     * 模式是范围内外的宽严, 界面上就是同一页的两行。
     *
     * `schema.enum` 是真的: 设置页的分段控件从它读选项, 硬编码三个按钮的话
     * 后端加第四档界面就静默过期。默认 `auto` 也是内核的默认。
     */
    {
      key: 'sandbox.mode',
      scope: 'sandbox',
      name: 'mode',
      type: 'string',
      secret: false,
      required: false,
      desc: '权限模式: ask=每次都问 / auto=只问高风险(越界、敏感路径) / full=不问也不围栏',
      default: 'auto',
      value: val('sandbox.mode', 'auto'),
      source: src('sandbox.mode'),
      schema: { type: 'string', enum: ['ask', 'auto', 'full'], default: 'auto' },
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
    /**
     * 思考相关的两项（真内核 `provider-deepseek` 的 CONFIG 里有, 2026-11-16 加的）。
     *
     * 假数据必须有它们, 否则"设置页按后端声明画参数行"这件事**验不到**:
     * 一个只有 temperature 的 fixture 会让"只画声明过的字段"和"写死一行温度"
     * 在测试里长得一模一样。`schema.enum` 也是真的 —— 界面从它取下拉选项,
     * 硬编码选项的话后端加一档界面就静默过期。
     */
    {
      key: 'llm.deepseek.thinking',
      scope: 'llm.deepseek',
      name: 'thinking',
      type: 'string',
      secret: false,
      required: false,
      desc: 'wire 上的思考开关。留空 = 不写这个字段, 让服务端默认生效',
      value: val('llm.deepseek.thinking', ''),
      source: src('llm.deepseek.thinking'),
      schema: { type: 'string', enum: ['enabled', 'disabled'] },
    },
    {
      key: 'llm.deepseek.reasoningEffort',
      scope: 'llm.deepseek',
      name: 'reasoningEffort',
      type: 'string',
      secret: false,
      required: false,
      desc: '推理档位。off 落到 wire 是 thinking=disabled 且不带 effort',
      value: val('llm.deepseek.reasoningEffort', ''),
      source: src('llm.deepseek.reasoningEffort'),
      schema: { type: 'string', enum: ['off', 'high', 'max'] },
    },
    {
      key: 'llm.deepseek.temperature',
      scope: 'llm.deepseek',
      name: 'temperature',
      type: 'number',
      secret: false,
      required: false,
      desc: '采样温度。留空 = 用服务端默认',
      value: val<number | ''>('llm.deepseek.temperature', ''),
      source: src('llm.deepseek.temperature'),
      schema: { type: 'number', minimum: 0, maximum: 2 },
    },
    {
      key: 'llm.deepseek.maxTokens',
      scope: 'llm.deepseek',
      name: 'maxTokens',
      type: 'number',
      secret: false,
      required: false,
      desc: '单轮输出上限。留空 = 用服务端默认',
      value: val<number | ''>('llm.deepseek.maxTokens', ''),
      source: src('llm.deepseek.maxTokens'),
      schema: { type: 'number' },
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
  const catalog = () => {
    /**
     * 这张表上**已经出现过的 id**。目录那一段要把它们滤掉 —— 否则同一家画两遍
     * （React 报重复 key, 界面看起来像"添加没生效, 又多了一条"）。
     *
     * 判据不能只看 `routes()`: `deepseek` 是下面手写的那条（它有自己的扁平
     * 配置形状, 不是路由字典里的一家）, 而目录里**也有**它。
     * 每次调用重算, 因为用户点「添加」会往 routes 里加键。
     */
    const listed = new Set<string>(['deepseek', 'mock', ...Object.keys(routes())])

    return [
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
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'high',
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
     * `filter` 掉**已经在上面出现过的** —— 否则点完添加会同时出现两条 id
     * 相同的供应商, React 报重复 key, 界面上看起来像"添加没生效, 又多了一条"。
     * 判据不能只看 `routes()`: `deepseek` 是上面手写的那条（它有自己的扁平
     * 配置形状, 不是路由字典里的一家）, 目录里**也有**它 —— 只看 routes 的话
     * 它会画两遍。
     */
    ...DIRECTORY.filter((entry) => !listed.has(entry.id)).map((entry) => ({
      id: entry.id,
      name: entry.name,
      protocol: entry.protocol,
      /*
       * **可添加的那些不带 `models`**（B-26 目录瘦身: 199 KB → 26 KB）。
       *
       * `undefined` 和 `[]` 是两件事: `undefined` = 没下发（要看就调
       * `llm.discoverModels`）, `[]` = 这家真没有模型。给 `[]` 会让界面显示
       * "可添加，但没有模型" —— 一句假话。所以这里连字段都不给, 只给个数量
       * 让界面能说"目录里收录了 12 款"。
       *
       * 假数据必须跟着变: 还发全量的话, "前端有没有做 `?? []` 兜底"这件事
       * 在测试里永远验不到（真机上直接 `TypeError: models is not iterable`）。
       */
      modelCount: entry.models.length,
      available: false,
      dormant: true,
      configScope: 'llm.openai',
      configPath: ['routes', entry.id],
      template: templateOf(entry),
      config: [],
      missing: ['还没添加 —— 在设置页点"添加"即可'],
    })),
    ]
  }

  const events: StreamEvent[] = []
  const sentPayloads: unknown[] = []
  let fixtureContextUsed = 92_100
  let fixtureCompactionCount = 0
  const nowSeed = Date.now()
  const fixtureSchedules: Array<Record<string, unknown>> = [
    {
      id: 'sch-demo-1', title: '每日销售汇总', prompt: '整理昨日销售数据并生成简报。', recurrence: 'daily', time: '09:00',
      enabled: true, createdAt: nowSeed - 86_400_000, updatedAt: nowSeed, nextRunAt: nowSeed + 3_600_000,
      lastRunAt: nowSeed - 43_200_000, lastStatus: 'completed', runs: [],
    },
    {
      id: 'sch-demo-2', title: '周五运营周报', prompt: '汇总本周运营数据。', recurrence: 'weekly', weekday: 5, time: '18:00',
      enabled: true, createdAt: nowSeed - 172_800_000, updatedAt: nowSeed, nextRunAt: nowSeed + 86_400_000,
      runs: [],
    },
    {
      id: 'sch-demo-3', title: '接口巡检', prompt: '检查线上接口是否正常。', recurrence: 'daily', time: '22:00',
      enabled: false, createdAt: nowSeed - 259_200_000, updatedAt: nowSeed,
      lastRunAt: nowSeed - 7_200_000, lastStatus: 'failed', lastError: '连接超时', runs: [],
    },
  ]
  const uploadedAttachments: Array<{ id: string; sessionId: string; name: string; mime: string; size: number; dataBase64: string }> = []
  const listeners = new Set<(event: StreamEvent) => void>()

  /**
   * 挂起中的问题。**由事件驱动**: question/asked 来了就挂上, question/answered 来了就摘掉。
   * 不在 emit 里特判某个 fixture —— 任何发这个事件的脚本都自动对上。
   */
  const pendingQuestions = new Map<string, PendingShape>()
  /** 已经回答过的问题 id —— 再答一次要回 409 (与真内核同形) */
  const answeredQuestions = new Set<string>()
  /**
   * 假后端也得**活过一次刷新** —— 否则「刷新后把没答完的问题捞回来」这条根本验不了。
   *
   * 用 sessionStorage 存一份: 页面刷新还在, 换个标签页就没有 (和真内核的
   * 内存挂起一样, 但够验前端那条自愈路径了)。
   */
  const PENDING_KEY = 'meng.fixture.pendingQuestion'
  const savePending = (values: readonly PendingShape[]): void => {
    if (typeof window === 'undefined') return
    try {
      if (values.length === 0) window.sessionStorage.removeItem(PENDING_KEY)
      else window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(values))
    } catch {
      /* 隐私模式下写不了就写不了 —— 假后端, 不影响主流程 */
    }
  }
  const loadPending = (): PendingShape[] => {
    if (typeof window === 'undefined' || (name !== 'question' && name !== 'question-multi' && name !== 'question-fail')) return []
    try {
      const raw = window.sessionStorage.getItem(PENDING_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      const values = Array.isArray(parsed) ? parsed : [parsed]
      return values.filter((value): value is PendingShape => {
        return typeof (value as { questionId?: unknown })?.questionId === 'string'
      })
    } catch {
      return []
    }
  }
  /** 收到的回答。给验收脚本看的观察口 */
  const answerPayloads: { questionId: string; answer: string }[] = []
  /** 回答提交失败后，前端交给 question.fail 的原因。 */
  const questionFailurePayloads: { questionId: string; error: string }[] = []
  for (const question of loadPending()) pendingQuestions.set(question.questionId, question)

  let settle: (() => void) | undefined
  let settled = new Promise<void>((resolve) => {
    settle = resolve
  })

  function emit(draft: Draft): StreamEvent {
    const event: StreamEvent = { ...draft, seq: ++seq, at: Date.now() }
    events.push(event)
    // 挂起中的问题跟着事件走: asked 挂上, answered 摘掉
    if (draft.type === 'question/asked') {
      const payload = (draft.payload ?? {}) as Record<string, unknown>
      const questionId = typeof payload.questionId === 'string' ? payload.questionId : ''
      if (questionId) {
        pendingQuestions.set(questionId, {
          questionId,
          kind: typeof payload.kind === 'string' ? payload.kind : 'info',
          title: typeof payload.title === 'string' ? payload.title : '模型需要你回答',
          ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
          ...(Array.isArray(payload.choices)
            ? {
                choices: payload.choices
                  .filter((c): c is { key: string; label: string } => {
                    const one = c as { key?: unknown; label?: unknown }
                    return typeof one.key === 'string' && typeof one.label === 'string'
                  })
                  .map((c) => ({ key: c.key, label: c.label })),
              }
            : {}),
          ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
          ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}),
          sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : sessionId,
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
          at: event.at,
        })
      }
    } else if (draft.type === 'question/answered') {
      const payload = (draft.payload ?? {}) as Record<string, unknown>
      const questionId = typeof payload.questionId === 'string' ? payload.questionId : ''
      if (questionId) pendingQuestions.delete(questionId)
    }
    savePending([...pendingQuestions.values()])
    for (const fn of [...listeners]) {
      try {
        fn(event)
      } catch (err) {
        console.error('[fixture] 订阅者抛错:', err)
      }
    }
    return event
  }

  let activeRun: { runId: string; sessionId: string } | undefined
  let pumpEpoch = 0

  async function pump(drafts: Draft[], epoch: number): Promise<void> {
    for (const draft of drafts) {
      if (epoch !== pumpEpoch) return
      if (gap > 0) await sleep(gap)
      if (epoch !== pumpEpoch) return
      emit(draft)
    }
  }

  /**
   * **只给验收脚本用的观察口**: 假内核的配置原样挂到 window 上。
   *
   * 为什么需要它: 「添加内置供应商之后自动拉取模型」这件事的效果**只有配置里
   * 看得见** —— 界面上的模型清单在拉取前（目录兜底）和拉取后（配置里真有的）
   * 长得一模一样。只靠 DOM 断言的话, 这个功能删掉了测试也照样全绿。
   *
   * 只在 fixture 模式里执行（`main.tsx` 动态 import 这一段）, 不进生产包。
   */
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __mengFixtureSettings?: unknown }).__mengFixtureSettings = settings
    ;(window as unknown as { __mengFixtureSends?: unknown[] }).__mengFixtureSends = sentPayloads
    ;(window as unknown as { __mengFixtureDeletes?: unknown[] }).__mengFixtureDeletes = deletePayloads
    ;(window as unknown as { __mengFixtureAnswers?: unknown[] }).__mengFixtureAnswers = answerPayloads
    ;(window as unknown as { __mengFixtureQuestionFailures?: unknown[] }).__mengFixtureQuestionFailures = questionFailurePayloads
    ;(window as unknown as { __mengFixtureAttachments?: unknown[] }).__mengFixtureAttachments = uploadedAttachments
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

        /**
         * 能用哪些模型。真内核这里是 `llm().models()` —— **只含配好 key 的那几家**。
         * 假数据给几个真名字: 输入框那个模型选择器要能看出"换了之后真的不一样"，
         * 只给 `['mock']` 的话那一格永远只有一个选项，验不到"选择"这件事。
         */
        case 'llm.models':
          // 只列**能用**的那两家: 真内核的 `llm().models()` 就只过滤出配好 key 的。
          // 把 zai 的 glm 系列塞进来是错的 —— 那家没 key, 选了必然失败,
          // 而"能选但不能用"是这一格最不该出现的状态。
          return ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini']

        case 'tools.list':
          return [
            { name: 'bash', description: 'fixture 里的假 bash', parameters: { type: 'object', properties: {} } },
          ]

        case 'session.create': {
          /*
           * 记下用户选的工作区。**真内核现在还不认这个字段**（HANDOFF §1.16）,
           * 这里先按契约收下: 前端传了就生效，不传就不给这个键。
           */
          const ws = (payload as { workspace?: unknown } | undefined)?.workspace
          const title = (payload as { title?: unknown } | undefined)?.title
          createdWorkspace = typeof ws === 'string' && ws !== '' ? ws : undefined
          createdTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : '梦 · 演示会话'
          return { sessionId, at: Date.now() }
        }

        case 'session.rename': {
          const body = payload as { sessionId?: unknown; title?: unknown } | undefined
          const sid = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const title = typeof body?.title === 'string' ? body.title.trim() : ''
          if (!sid || !title) throw new Error('fixture: session.rename 缺 sessionId 或 title')
          if (sid === sessionId) createdTitle = title
          else renamedTitles.set(sid, title)
          return { ok: true }
        }

        case 'session.delete': {
          const body = payload as { sessionId?: unknown } | undefined
          const asked = typeof body?.sessionId === 'string' ? body.sessionId : ''
          deletePayloads.push({ sessionId: asked })
          deletedSessions.add(asked)
          const candidates = [sessionId, ...fixtureSessions(Date.now()).map((session) => session.sessionId)]
          const nextSessionId = candidates.find((id) => id !== asked && !deletedSessions.has(id))
          return { ok: true, ...(nextSessionId === undefined ? {} : { nextSessionId }) }
        }

        case 'session.read': {
          // 不带 sessionId 或缺省 = 当前会话 (老行为, 现有脚本都这么调)。
          // 带了别的 id = 假会话史 —— 只为让"切换会话"能真的点。
          const asked = (payload as { sessionId?: unknown } | undefined)?.sessionId
          const sid = typeof asked === 'string' && asked ? asked : sessionId
          if (deletedSessions.has(sid)) return []
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
              title: createdTitle,
              at: events[0]?.at ?? now,
              lastSeq: seq,
              // 还没聊过就不给 preview —— 界面会自然退化成单行, 正好演示这条兜底
              preview: firstUser ? String((firstUser.payload as { text?: unknown })?.text ?? '') : undefined,
              // 建会话时选的工作区。没选就不给这个键（= 普通任务）
              ...(createdWorkspace === undefined ? {} : { workspace: createdWorkspace }),
            },
            ...fixtureSessions(now).map((s) => ({
              sessionId: s.sessionId,
              title: renamedTitles.get(s.sessionId) ?? s.title,
              at: s.at,
              lastSeq: 0,
              preview: s.preview,
              ...(s.workspace === undefined ? {} : { workspace: s.workspace }),
            })),
          ].filter((session) => !deletedSessions.has(session.sessionId))
        }

        case 'attachment.put': {
          const body = payload as { sessionId?: unknown; name?: unknown; mime?: unknown; dataBase64?: unknown } | undefined
          const sid = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const name = typeof body?.name === 'string' ? body.name : ''
          const mime = typeof body?.mime === 'string' ? body.mime : ''
          const dataBase64 = typeof body?.dataBase64 === 'string' ? body.dataBase64 : ''
          if (!sid || !name || !mime || !dataBase64) throw new Error('fixture: attachment.put 缺字段')
          const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
          const size = Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding)
          const saved = { id: `att-${uploadedAttachments.length + 1}`, sessionId: sid, name, mime, size, dataBase64 }
          uploadedAttachments.push(saved)
          return { id: saved.id }
        }

        case 'attachment.read': {
          const body = payload as { sessionId?: unknown; attachmentId?: unknown } | undefined
          const sid = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const attachmentId = typeof body?.attachmentId === 'string' ? body.attachmentId : ''
          const found = uploadedAttachments.find((item) => item.id === attachmentId && item.sessionId === sid)
          if (!found) throw new Error(`附件不存在: ${attachmentId}`)
          return found
        }

        case 'session.switchModel': {
          const body = payload as { sessionId?: unknown; from?: unknown; to?: unknown } | undefined
          const sid = typeof body?.sessionId === 'string' ? body.sessionId : sessionId
          const from = typeof body?.from === 'string' ? body.from : undefined
          const to = typeof body?.to === 'string' ? body.to.trim() : ''
          if (!to) throw new Error('fixture: session.switchModel 缺 to')
          const reference = events
            .filter((event) => event.type === 'turn/started' || event.type === 'llm/completed')
            .map((event) => String((event.payload as { text?: unknown })?.text ?? '').trim())
            .filter(Boolean)
            .join('\n\n')
          const estimatedInputTokens = Math.max(1, Math.ceil(reference.length / 2))
          const event = emit({
            type: 'model/switched',
            sessionId: sid,
            payload: { ...(from ? { from } : {}), to, estimatedInputTokens, at: Date.now() },
          })
          return { ok: true, sessionId: sid, seq: event.seq }
        }

        case 'context.status': {
          const body = payload as { sessionId?: unknown; model?: unknown } | undefined
          const contextWindow = 128_000
          return {
            sessionId: String(body?.sessionId ?? sessionId),
            ...(typeof body?.model === 'string' ? { model: body.model } : {}),
            contextWindow,
            usedTokens: fixtureContextUsed,
            usedSource: 'estimate',
            thresholdRatio: 0.85,
            retainRatio: 0.16,
            thresholdTokens: 108_800,
            compacted: fixtureCompactionCount > 0,
            compactionCount: fixtureCompactionCount,
            ...(fixtureCompactionCount > 0
              ? { lastCompactedAt: Date.now(), lastSummarySeq: 900 + fixtureCompactionCount }
              : {}),
            canCompact: fixtureCompactionCount === 0,
            ...(fixtureCompactionCount > 0 ? { reason: '没有可压缩的较早轮次' } : {}),
          }
        }

        case 'context.compact': {
          const before = fixtureContextUsed
          const after = Math.max(1000, Math.round(before * 0.45))
          fixtureContextUsed = after
          fixtureCompactionCount += 1
          const event = emit({
            type: 'context/compacted',
            sessionId,
            payload: {
              summary: 'fixture compaction checkpoint',
              throughSeq: events.at(-1)?.seq ?? 0,
              trigger: 'manual',
              estimatedInputTokens: after,
              retainedMessages: 4,
            },
          })
          return {
            compacted: true,
            beforeTokens: before,
            afterTokens: after,
            summarySeq: event.seq,
          }
        }

        case 'schedule.list':
          return fixtureSchedules.map((item) => ({ ...item, runs: Array.isArray(item.runs) ? [...item.runs] : [] }))

        case 'schedule.create': {
          const body = payload as Record<string, unknown>
          const now = Date.now()
          const item = {
            id: `sch-${Date.now().toString(36)}`,
            title: String(body.title ?? '新任务'),
            prompt: String(body.prompt ?? ''),
            recurrence: String(body.recurrence ?? 'daily'),
            ...(body.time === undefined ? {} : { time: body.time }),
            ...(body.weekday === undefined ? {} : { weekday: body.weekday }),
            ...(body.dayOfMonth === undefined ? {} : { dayOfMonth: body.dayOfMonth }),
            ...(body.runAt === undefined ? {} : { runAt: body.runAt }),
            ...(body.workspace === undefined ? {} : { workspace: body.workspace }),
            enabled: body.enabled !== false,
            createdAt: now,
            updatedAt: now,
            nextRunAt: typeof body.runAt === 'number' ? body.runAt : now + 3_600_000,
            runs: [],
          }
          fixtureSchedules.push(item)
          return item
        }

        case 'schedule.update': {
          const body = payload as Record<string, unknown>
          const id = String(body.id ?? '')
          const index = fixtureSchedules.findIndex((item) => item.id === id)
          if (index < 0) throw new Error('fixture: 定时任务不存在')
          fixtureSchedules[index] = { ...fixtureSchedules[index], ...body, updatedAt: Date.now() }
          return fixtureSchedules[index]
        }

        case 'schedule.toggle': {
          const body = payload as Record<string, unknown>
          const id = String(body.id ?? '')
          const item = fixtureSchedules.find((one) => one.id === id)
          if (!item) throw new Error('fixture: 定时任务不存在')
          item.enabled = body.enabled === true
          item.updatedAt = Date.now()
          return item
        }

        case 'schedule.delete': {
          const body = payload as Record<string, unknown>
          const id = String(body.id ?? '')
          const index = fixtureSchedules.findIndex((item) => item.id === id)
          if (index < 0) throw new Error('fixture: 定时任务不存在')
          fixtureSchedules.splice(index, 1)
          return { ok: true }
        }

        case 'schedule.runNow': {
          return { ok: true, sessionId: 'fixture-schedule-run' }
        }

        case 'schedule.history':
          return []

        case 'job.output': {
          const body = payload as { jobId?: unknown } | undefined
          return { text: `fixture output for ${String(body?.jobId ?? 'job')}\n[status: running]`, job: { id: body?.jobId, status: 'running' } }
        }

        case 'job.kill': {
          const body = payload as { jobId?: unknown } | undefined
          const jobId = String(body?.jobId ?? '')
          emit({ type: 'job/completed', sessionId, payload: { id: jobId, kind: 'bash', label: '后台任务', status: 'killed', detail: '用户已停止', startedAt: Date.now() - 1000, finishedAt: Date.now() } })
          return { ok: true }
        }

        case 'job.startCommand': {
          const body = payload as { command?: unknown; description?: unknown } | undefined
          const command = String(body?.command ?? '后台命令')
          emit({ type: 'job/started', sessionId, payload: { id: 'bash-fixture', kind: 'bash', label: String(body?.description ?? command), status: 'running', startedAt: Date.now() } })
          return { ok: true, text: '已启动 bash-fixture' }
        }

        case 'session.send': {
          const input = payload as { text?: unknown; attachments?: unknown } | undefined
          if (name === 'send-fail' && Array.isArray(input?.attachments) && input.attachments.length > 0) {
            throw new Error('fixture: 图片发送失败')
          }
          sentPayloads.push(payload)
          // 与真内核一致: **不等完成**就返回 runId, 进展全走下行的
          runId = `run-${Date.now().toString(36)}`
          const ids = Array.isArray(input?.attachments)
            ? input.attachments.filter((id): id is string => typeof id === 'string')
            : []
          const attached = ids
            .map((id) => uploadedAttachments.find((item) => item.id === id))
            .filter((item): item is NonNullable<typeof item> => item !== undefined)
            .map(({ id, name, mime, size }) => ({ id, name, mime, size }))
          const drafts = script(name, sessionId, runId).map((draft) => {
            if (draft.type !== 'turn/started') return draft
            return {
              ...draft,
              payload: {
                ...(draft.payload as Record<string, unknown>),
                ...(typeof input?.text === 'string' ? { text: input.text } : {}),
                ...(attached.length > 0 ? { attachments: attached } : {}),
              },
            }
          })
          const epoch = ++pumpEpoch
          activeRun = { runId, sessionId }
          void pump(drafts, epoch).then(() => {
            if (activeRun?.runId === runId) activeRun = undefined
            settle?.()
          })
          return { runId, accepted: true }
        }

        /**
         * 工作区列表（HANDOFF §1.16 的契约形状）。
         *
         * 前端对老内核会 `catch` 掉，所以这里给不给都能跑。给出来是为了让
         * **侧栏那两段分组**和输入框那个选择器在假数据上真的能看。
         */
        /**
         * 回答挂起中的问题 (docs/06 §1.4)。
         *
         * 与真内核同形: 问题已经结束 → 409 (双击 / 重放 / 迟到都落这里),
         * 前端看到 409 就静默收起卡片。
         */
        case 'question.answer': {
          const body = payload as { questionId?: unknown; answer?: unknown } | undefined
          const questionId = typeof body?.questionId === 'string' ? body.questionId : ''
          const answer = typeof body?.answer === 'string' ? body.answer : ''
          if (!questionId || !answer) throw new Error('fixture: question.answer 缺 questionId 或 answer')
          if (questionId.startsWith('fail-')) throw new Error('fixture: 回答提交失败 (模拟网络错误)')
          const pending = pendingQuestions.get(questionId)
          if (answeredQuestions.has(questionId) || pending === undefined) {
            throw new Error('fixture: question.answer 失败 (409): 问题已经结束')
          }
          answeredQuestions.add(questionId)
          answerPayloads.push({ questionId, answer })
          // 回话用**标签**: 提交给内核的是 key ('beijing'), 但模型那边说的话应该是人话 ('北京')
          const label = pending.choices?.find((c) => c.key === answer)?.label ?? answer
          pendingQuestions.delete(questionId)
          savePending([...pendingQuestions.values()])
          const rid = runId ?? 'run-1'
          void pump([
            { type: 'question/answered', sessionId, payload: { questionId, outcome: 'answered', answer } },
            { type: 'llm/chunk', sessionId, runId: rid, payload: { delta: `好，${label}。`, runId: rid } },
            {
              type: 'llm/completed',
              sessionId,
              runId: rid,
              payload: { text: `好，${label}。`, runId: rid, usage: { in: 2176, out: 24 } },
            },
            { type: 'turn/ended', sessionId, runId: rid, payload: { reason: 'stop' } },
          ], pumpEpoch)
          return { ok: true, questionId }
        }

        /** 回答提交失败的结算入口：不伪造答案，只把原因交给等待中的模型。 */
        case 'question.fail': {
          const body = payload as { questionId?: unknown; error?: unknown } | undefined
          const questionId = typeof body?.questionId === 'string' ? body.questionId : ''
          const error = typeof body?.error === 'string' ? body.error.trim() : ''
          if (!questionId || !error) throw new Error('fixture: question.fail 缺 questionId 或 error')
          if (!pendingQuestions.has(questionId)) throw new Error('fixture: question.fail 失败 (409): 问题已经结束')
          pendingQuestions.delete(questionId)
          questionFailurePayloads.push({ questionId, error })
          savePending([...pendingQuestions.values()])
          void pump([
            { type: 'question/answered', sessionId, payload: { questionId, outcome: 'failed', error } },
          ], pumpEpoch)
          return { ok: true, questionId }
        }

        /** 挂起中的问题 (UI 刷新自愈用)。没有就是空数组 */
        case 'question.list':
          return [...pendingQuestions.values()]

        case 'workspace.list':
          // 与真后端完全同形：外层有 workspaces。直接给数组会让 fixture 漏测解包这一层。
          return { workspaces: [...FIXTURE_WORKSPACES, ...createdWorkspaces] }

        case 'fs.list': {
          const raw = String((payload as { path?: unknown } | undefined)?.path ?? '')
          const path = raw === '.' ? '/Users/linc/Documents/梦' : raw
          const dirs: Record<string, string[]> = {
            '/Users/linc/Documents/梦': ['apps', 'docs', 'packages', 'scripts'],
            '/Users/linc/Documents/梦/apps': ['server', 'web'],
            '/Users/linc/Documents/梦/apps/web': [],
            '/Users/linc/Documents/梦/apps/server': [],
            '/Users/linc/Documents/梦/docs': [],
            '/Users/linc/Documents/梦/packages': ['core', 'web', 'workspaces'],
            '/Users/linc/Documents/梦/packages/core': [],
            '/Users/linc/Documents/梦/packages/web': [],
            '/Users/linc/Documents/梦/packages/workspaces': [],
            '/Users/linc/Documents/梦/scripts': [],
            '/Users/linc/Documents': ['梦'],
            '/Users/linc': ['Documents'],
            '/': ['Users'],
            '/Users': ['linc'],
          }
          const files: Record<string, string[]> = {
            '/Users/linc/Documents/梦/apps/web': ['package.json', 'vite.config.ts'],
            '/Users/linc/Documents/梦/docs': ['HANDOFF.md'],
            '/Users/linc/Documents/梦/packages/web': ['package.json'],
          }
          if (!(path in dirs)) throw new Error(`fixture: 目录不存在 ${path}`)
          return {
            path,
            ...(path === '/' ? {} : { parent: path.slice(0, path.lastIndexOf('/')) || '/' }),
            entries: [
              ...(dirs[path] ?? []).map((name) => ({ name, dir: true })),
              ...(files[path] ?? []).map((name) => ({ name, dir: false })),
            ],
          }
        }

        case 'workspace.pick':
          // 真后端会弹系统选择窗口；fixture 直接模拟用户选中了 web 项目。
          return { path: '/Users/linc/Documents/梦/apps/web' }

        /**
         * 新建工作区（B-28）。真内核会 `mkdir -p` 并记进 workspaces.json；
         * 假数据只需要"建完能在列表里看见、能被选中"，那正是界面依赖的部分。
         */
        case 'workspace.create': {
          const path = (payload as { path?: unknown } | undefined)?.path
          if (typeof path !== 'string' || path.trim() === '') throw new Error('fixture: workspace.create 缺 path')
          const p = path.trim()
          const name = p.split('/').filter(Boolean).pop() ?? p
          const ws = { id: p, name, path: p }
          if (!createdWorkspaces.some((w) => w.id === p)) createdWorkspaces.push(ws)
          return ws
        }

        /**
         * 工具组现状（B-27）。`enabled` 由 `tools.disabled` 推出来 ——
         * 和真内核一样：配置是唯一的真值，组状态是它的投影。
         */
        case 'tools.groups': {
          const disabled = Array.isArray(settings['tools.disabled'])
            ? (settings['tools.disabled'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : []
          return FIXTURE_TOOL_GROUPS.map((g) => ({
            ...g,
            enabled: !g.tools.some((t) => disabled.includes(t)),
          }))
        }

        /**
         * 每个工具用过几次。**只有带 sessionId 的调用才算**（B-27 明写），
         * 所以这里的数字是"真实会话里的用量"，不含启动自检。
         */
        case 'tool.stats': {
          const t = Date.now()
          return [
            { tool: 'read', count: 34, lastAt: t - 4 * 60_000 },
            { tool: 'bash', count: 21, lastAt: t - 9 * 60_000 },
            { tool: 'grep', count: 12, lastAt: t - 26 * 60_000 },
            { tool: 'write', count: 5, lastAt: t - 3 * 60 * 60_000 },
            { tool: 'web_fetch', count: 2, lastAt: t - 26 * 60 * 60_000 },
          ]
        }

        /**
         * 取一条工具记录的全文。认不出的 id 一律抛 —— 真内核那边是 404，
         * 界面把**任何**失败都当"已被清理"，所以这里不需要造一个像 HTTP 的错误。
         */
        case 'tool.record': {
          const recordId = (payload as { recordId?: unknown } | undefined)?.recordId
          if (recordId !== RECORD_READ) throw new Error(`记录不存在: ${String(recordId)}`)
          const text = fixtureToolRecord()
          return { text, bytes: text.length, presentation: { group: 'core', elapsedMs: 1240 } }
        }

        /**
         * git 状态。真内核也没有这个 op（§1.17）—— 一个目录是不是 git 仓库、
         * 当前在哪个分支、有没有未提交改动，只有能碰磁盘的那一侧知道。
         * `dirty: true` 是故意的: 那一格要在截图里看得见。
         */
        case 'git.status':
          return { branch: 'main', dirty: true }

        case 'session.abort': {
          pumpEpoch += 1
          const running = activeRun
          activeRun = undefined
          if (running) {
            emit({
              type: 'turn/ended',
              sessionId: running.sessionId,
              runId: running.runId,
              payload: { reason: 'aborted', runId: running.runId },
            })
          }
          return { ok: true }
        }

        case 'question.list':
          return []

        // ── 设置页: 供应商目录 + 配置读写 ──────────────────
        // 四个 op 的形状与真内核一致 (packages/web/src/ops.ts),
        // 前端照着它写就行了; 真内核那边一处不改这里就过期, 所以下面
        // set/unset 走的是同一套"改完重读"的语义, 而不是返回一个假 ok
        case 'llm.catalog':
          return catalog()

        /**
         * 可选协议 —— 9 项，`listable` 6 项（与 B-23 的真内核一致）。
         *
         * 为什么 fixture 要把**界面上根本选不到的**那 7 种也发下来: 设置页的下拉
         * 是从这张表里**挑两项**（`offeredProtocols`），只发两项的话, "挑"这个动作
         * 和"原样显示"在 fixture 里长得一模一样 —— 硬编码成两项也照样全绿。
         * 发全量, 那条过滤才真的被验到。
         *
         * `bedrock` / `vertex` / `codex` 的 `needs` 也是真的（真内核给的就是这几句）,
         * 它们不会显示, 但"不该显示"得先有东西可显示才算验过。
         */
        case 'llm.protocols':
          return [
            { id: 'openai-completions', label: 'OpenAI 兼容 (/chat/completions)', listable: true },
            { id: 'openai-responses', label: 'OpenAI Responses (/responses)', listable: true },
            { id: 'anthropic-messages', label: 'Anthropic Messages', listable: true },
            { id: 'google-generative-ai', label: 'Google Gemini', listable: true },
            { id: 'mistral-conversations', label: 'Mistral', listable: true },
            {
              id: 'azure-openai-responses',
              label: 'Azure OpenAI',
              listable: true,
              needs: ['资源名与 api-version（填在接口地址里）'],
            },
            {
              id: 'bedrock-converse-stream',
              label: 'Amazon Bedrock',
              listable: false,
              needs: ['AWS 凭据（AWS_ACCESS_KEY_ID / AWS_PROFILE / IAM 角色）与区域'],
            },
            {
              id: 'google-vertex',
              label: 'Google Vertex AI',
              listable: false,
              needs: ['GCP project + location + 应用默认凭据 (ADC)'],
            },
            {
              id: 'openai-codex-responses',
              label: 'OpenAI Codex',
              listable: false,
              needs: ['OAuth 登录态（本仓库没有 OAuth 存储）'],
            },
          ]

        /**
         * 模型发现 —— 设置页的「获取可用模型」**和**「测试连接」。
         *
         * 真内核有两条路: 内置目录认识这家就**直接答 (零网络)**, 不认识的
         * 才去 `GET <base>/models`；`source: 'endpoint'` 是"不管目录, 一律出网"
         * 的出口（B-22 #4），「测试连接」用的就是它。
         *
         * fixture 不联网, 但**两条路的结果必须不一样** —— 一样的话"前端有没有
         * 传 source"在假数据上验不出来, 而少传那个字段的表现是「测试连接」
         * 变成一个永远成功的假绿灯。所以:
         *   · 目录那条 → 目录里的模型（和这家真实有的东西一致）
         *   · 端点那条 → ENDPOINT_MODELS（一份"端点自己报的"清单）
         *
         * 端点那条还会**因为密钥没值而 401** —— 真端点就是这么回的, 而
         * 界面上"连上了"和"没连上"两个状态都得有东西能画出来。默认的
         * `CUSTOM_API_KEY` 不在 env 里, 正好是那个失败样本。
         */
        case 'llm.discoverModels': {
          const { scope, provider, baseURL, apiKeyEnv, source } = (payload ?? {}) as {
            scope?: string
            provider?: string
            baseURL?: string
            apiKeyEnv?: string
            source?: string
          }
          // `scope` 是真内核的**硬要求**（探测器按 scope 注册, 缺了 400）。
          // fixture 不装这道门的话, 前端少传 scope 会在假数据上全绿、在真机上 400,
          // 而那句 400 的文案（「缺 scope（这些供应商属于哪个插件）」）用户看不懂
          if (!scope) throw new Error('fixture: llm.discoverModels 缺 scope（真内核会 400）')

          const one = provider === undefined ? undefined : routes()[provider]
          const base = (baseURL ?? one?.baseURL ?? '').replace(/\/+$/, '')
          const bound = apiKeyEnv ?? one?.apiKeyEnv

          if (source === 'endpoint') {
            // 真内核这里是 `fetch(`${base}/models`)`。没有地址 / 变量里没有值
            // 就是它真实的两种失败, 原话照抄（前端不改写, 用户靠这句话分辨
            // 该去改地址还是该去配 key）
            if (!base) throw new Error('fixture: llm.discoverModels 出网前没有地址')
            if (bound === undefined || !env.has(bound)) {
              throw new Error(
                `GET ${base}/models 返回 401: {"error":{"message":"invalid api key"}}（${bound ?? '没有绑定变量名'} 里没有值）`,
              )
            }
            return ENDPOINT_MODELS
          }

          /*
           * 目录那条: 先按路由 id 认目录（零网络）, 认不出才 GET /models。
           *
           * **查的是 `DIRECTORY` 而不是 `catalog()`**: B-26 之后可添加的那些在
           * catalog 里**不带 `models`**（瘦身）, 而"目录命中就 0ms 答"正是
           * `discoverModels` 存在的意义 —— 它读的始终是目录本身。
           */
          const dirEntry = DIRECTORY.find((c) => c.id === provider)
          if (dirEntry) {
            return dirEntry.models.map((m) => ({
              id: m.id,
              name: m.name,
              ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
              ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
            }))
          }
          if (!base) throw new Error('fixture: llm.discoverModels 至少要 provider 或 baseURL')
          return ENDPOINT_MODELS
        }

        case 'credential.status': {
          const { ref } = (payload ?? {}) as { ref?: string }
          if (ref) return { ref, present: env.has(ref) }
          return { refs: [...env].sort() }
        }

        case 'credential.set': {
          const { ref, value } = (payload ?? {}) as { ref?: string; value?: string }
          if (!ref || !value?.trim()) throw new Error('fixture: credential.set 缺 ref 或 value')
          env.add(ref)
          return { ref, present: true }
        }

        case 'credential.unset': {
          const { ref } = (payload ?? {}) as { ref?: string }
          if (!ref) throw new Error('fixture: credential.unset 缺 ref')
          env.delete(ref)
          return { ref, present: false }
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

    if (name === 'ok' || name === 'send-fail') {
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
      const bashOut = String((bash?.payload as { result?: unknown } | undefined)?.result ?? '')
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
