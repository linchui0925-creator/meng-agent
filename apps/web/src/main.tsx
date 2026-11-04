/**
 * 网页端入口。三端(web / desktop renderer / mobile webview)共用这一个入口,
 * 差异只在 platform 与 transport 能力面由谁提供。
 *
 * 顺序严格照 docs/05 §5 的两段式:
 *   1. 建模块系统 + 渲染加载页 (不等插件, 也不等后端)
 *   2. 拉 manifest → 创建 entries → 静默 → 全量 sweep
 *   3. settled 翻转, 一次性切到真 UI
 *
 * 当前阶段 (M3-M4) 的 transport 是 **inproc + fixture**:
 * `?fixture=ok|blocked|error` 三个脚本化路径, 走的是与真 ws 完全相同的
 * Transport 接口。等 F6 的 ws 实现到位, 这里只换一行 createXxxTransport,
 * App 与投影逻辑一行都不用动 —— 这是当初把 inproc 做成"第三种实现"的目的。
 */

import '@meng/ui/tokens.css'

import * as React from 'react'
import { StrictMode, useCallback, useRef, useState } from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

import * as MengCore from '@meng/core'
import { createContext } from '@meng/core'
import type { BootManifest, GraphNodeLike, PluginRow } from '@meng/modules'
import { isBuiltin, toPluginRows } from '@meng/modules'
import { createClientModuleSystem, type ClientModuleLoader } from '@meng/modules/client'
import { bootShell, type EntryState, type ShellHandle } from '@meng/shell'
import * as MengSlots from '@meng/slots'
import { createSlotRegistry, type SlotDef, type SlotRegistry } from '@meng/slots'
import type { Transport } from '@meng/transport'
import { createInprocTransport } from '@meng/transport/inproc'
import { createWsTransport, localStorageSeqStore } from '@meng/transport/ws'
import * as MengUi from '@meng/ui'
import { createThemeController } from '@meng/ui'
import * as MengWebReact from '@meng/web-react'
import { AppRoot, TransportProvider } from '@meng/web-react'

import { App } from './app/App.tsx'
import { CrashBomb, CrashBoundary, FallbackShell, shouldBootSafe } from './app/FallbackShell.tsx'
import { DEMO_PLUGIN_ID, demoRuntime } from './app/demo-plugin.tsx'
import { DEMO_SKIN_ID, demoSkinRuntime } from './app/demo-skin-plugin.tsx'
import { AppearanceSection } from './app/settings/AppearanceSection.tsx'
import { SettingsView } from './app/settings/SettingsView.tsx'
import { createFixtureKernel, fixtureFromSearch } from './dev/fixture-kernel.ts'
import { applyTheme, readThemeMode } from './theme.ts'

// URL 参数在这里读一次, bootstrap 与主题共用
const params = new URLSearchParams(location.search)

// 首帧前定主题: 晚一帧就会看到浅色闪一下
applyTheme(params.has('theme') ? (params.get('theme') === 'dark' ? 'dark' : 'light') : readThemeMode())

/**
 * 宿主声明的 slot 目录。
 *
 * **这份目录永远是宿主的责任, 不由 manifest 带下来** —— 插件只能往已声明的座位插,
 * 不能自己发明座位 (docs/08 §4: 未声明即 throw)。F5 有了运行时装载之后变的是
 * 「谁的代码来占座」, 不是「谁来造座」。
 */
const SLOT_DEFS: Array<[string, SlotDef]> = [
  // 整体布局: 空着 = 内置布局 (fallback), 有插件占用 = 整块换掉
  ['layout.root', { kind: 'single', scope: 'root' }],
  // 输入框: chain。既要能被「永久替换」(皮肤), 又要能被「临时接管」(审批条) ——
  // 同一个座位不能既 single 又 chain, 所以声明成 chain, 永久替换 = select 恒返回非 null
  ['composer', { kind: 'chain', scope: 'session-maybe' }],
  ['sidebar.footer', { kind: 'list', scope: 'root' }],
  ['conversation.actions', { kind: 'list', scope: 'session' }],

  /* ── F2b 扩容的一批 (5 个) ──
   *
   * 判据只有两条, 不满足就不加:
   *   a) 不声明它, 某个界面功能**根本无处安放** (结构位)
   *   b) 它是不装插件就用不上、装了插件就必需**入口** (增强位)
   *
   * 「可能有用」不是理由 —— 每个 slot 都要宿主声明 + 布局留渲染点 + 断言,
   * 目录越长, 后来人越难判断该往哪插。
   * 刻意没加的: message.bubble (气泡要被砍掉, 见 docs/07 F2b)。
   */
  // 侧栏头部: 搜索 / 收藏 / 分组切换
  ['sidebar.header', { kind: 'list', scope: 'root' }],
  // 会话项操作: 重命名 / 删除 / 导出。用 session-maybe, 首屏那个"当前会话项"也能挂
  ['sidebar.item.actions', { kind: 'list', scope: 'session-maybe' }],
  // 标题栏动作: 分享 / 导出 / 全局开关
  ['topbar.actions', { kind: 'list', scope: 'root' }],
  // 输入框工具条: 附件 / 模型选择 / 引用文件。没有它, 插件想加一个按钮
  // 就只能整块替换 composer —— 那是用大炮打蚊子, 还会丢草稿
  ['composer.actions', { kind: 'list', scope: 'session-maybe' }],
  // 状态条: token 用量 / 模型名 / 索引进度。用 root, 无会话时也该能显示
  ['statusbar.item', { kind: 'list', scope: 'root' }],

  /* ── 设置页的一批 (2 个, 2026-11-04 v3 定案) ──
   *
   * 形态: 整窗接管 (盖住侧栏+主区), 会话流**不卸载**只 inert ——
   * 这是用户拍板的 B 方案: 返回时滚动位置原样。
   * 样张: docs/prototypes/settings-v3.html; 规范: docs/13-frontend-plugin-spec.md。
   *
   * 为什么 view 不进 layout.root: layout.root 是 single, 被顶掉 = 内置布局卸载,
   * 会话流跟着死 —— 违背 B。settings.view 是叠在布局之上的整窗层,
   * select 拿宿主的 view 状态: 用户打开设置 → 上台盖住; 关闭 → 让位。
   * 用 chain 不用 single: 「整窗视图」将来不止设置一个 (引导页、锁屏…),
   * 同一座位排队选举, 谁的 select 返回非 null 谁上台。
   */
  // 设置页本身: 整窗层, 打开时盖住一切 (底下 inert), 内置会话流是天然的空座 fallback
  ['settings.view', { kind: 'chain', scope: 'root' }],
  // 设置页内部分区: 每个分区一个插件 (外观/对话/工作区/密钥), 左导航按 order 排
  ['settings.section', { kind: 'list', scope: 'root' }],
]

/**
 * 手抄的插件清单 —— **只在 fixture 模式用**。
 *
 * ws 模式下这份表被 `fetchManifestPlugins()` 整个替换掉: 后端 2026-11-03 已经把
 * `client?: { platforms, immediately, slots }` 随状态图节点下发 (docs/11, 后端 HANDOFF B-02),
 * 前端用 `toPluginRows()` 转成插件行, url 按约定 `/plugins/<id>/client.js` 由 id 拼出。
 *
 * 留着这份表不是偷懒: fixture 模式没有后端、没有 hello 帧, 而界面必须能跑起来给人看。
 * 它同时也是「后端没起时界面照样可用」这条底线的实例。
 */
const PLUGIN_ROWS: PluginRow[] = [
  {
    id: 'demo-ui',
    url: '/plugins/demo-ui/client.js',
    platforms: ['web'],
    inject: ['slots'],
    immediately: false,
    // 随发行版打包 → 保守启动时保留
    origin: 'builtin',
  },
]

interface Booted {
  handle: ShellHandle
  transport: Transport
  slots: SlotRegistry
  /** 非 null 表示跑在 fixture 上 */
  fixture: string | null
  /** 模块系统。dev 面板与浏览器验收脚本靠它做 invalidate */
  modules: ClientModuleLoader
}

/**
 * 共享模块表 —— 插件 external 掉的那几个包在这里落回同一个实例。
 *
 * 少了这张表, 插件就会自带一份 React, hooks 立刻炸("Invalid hook call" 的根因永远是两份 React)。
 * 插件**只能**通过 `require('<id>')` 或构建期 external 拿到这里的东西, 没有第二条路。
 */
const SHARED: Record<string, unknown> = {
  react: React,
  'react/jsx-runtime': ReactJsxRuntime,
  '@meng/core': MengCore,
  '@meng/slots': MengSlots,
  '@meng/ui': MengUi,
  '@meng/web-react': MengWebReact,
}

/**
 * ws 模式下从 hello 帧拿 boot manifest → 插件行。
 *
 * **为什么要等**: manifest 决定装哪些插件。不等的话界面会先画出来, 然后被插件改一次
 * —— 侧栏、状态条、输入框全跳一遍。晚装的插件比晚到的消息更扰人。
 *
 * **为什么又要超时**: 后端没起、或协议不匹配时不能让用户对着启动画面干等。
 * 超时就用空列表照常启动 —— 「插件一个没装」和「界面打不开」是两种完全不同的失败。
 *
 * **为什么不是 GET /api/boot-manifest**: hello 已经在握手里把 manifest 带来了,
 * 再发一次请求是第二次往返, 而且两条路径迟早会不一致。
 */
async function fetchManifestPlugins(transport: Transport, timeoutMs = 2500): Promise<PluginRow[]> {
  // handshake 只有远端 transport 有, inproc/ipc 没有 —— 用能力检测而不是 instanceof,
  // 因为测试里塞的是假 transport
  type WithHandshake = { handshake?: () => { manifest?: unknown } | undefined }
  const remote = transport as Transport & WithHandshake
  if (typeof remote.handshake !== 'function') return []

  const rowsOf = (manifest: unknown): PluginRow[] => {
    const plugins = (manifest as { plugins?: unknown } | undefined)?.plugins
    return Array.isArray(plugins) ? toPluginRows(plugins as GraphNodeLike[]) : []
  }

  const first = remote.handshake?.()
  if (first) return rowsOf(first.manifest)

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = transport.onStateChange((state) => {
      if (state === 'online') finish()
    })
    const timer = setTimeout(finish, timeoutMs)
  })

  return rowsOf(remote.handshake?.()?.manifest)
}

async function bootstrap(report: (entries: EntryState[]) => void): Promise<Booted> {
  const mode = params.get('transport') ?? 'fixture'

  if (mode !== 'fixture' && mode !== 'ws') {
    throw new Error(`transport=${mode} 不支持 (只有 fixture 与 ws)`)
  }

  const slots = createSlotRegistry()
  for (const [name, def] of SLOT_DEFS) slots.declare(name, def)

  /**
   * 内置设置页 + 第一个分区, **走的是插件的同一条注册路径** ——
   * 不是「宿主特权」: 它们能被同 id 的运行时插件替换, 崩了也走同一套错误边界。
   *
   * 两个注册刻意分开:
   *   · `settings.view` = 整窗层（壳）。`select` 只认宿主的 `open` 状态 ——
   *     壳不知道也不该知道自己是"设置", 它只是"被打开时上台的整窗视图"。
   *   · `settings.section` = 右区的一个分区。加/删分区不需要碰壳, 也不需要碰这里
   *     之外的任何代码 —— 这就是「设置页面按插件形式集成」的实证。
   */
  slots.register('builtin.settings', {
    name: 'settings.view',
    component: SettingsView,
    priority: 0,
    select: (owner) => ((owner as { open?: boolean } | undefined)?.open ? {} : null),
  })
  slots.register('builtin.settings.appearance', {
    name: 'settings.section',
    component: AppearanceSection,
    order: 100,
    meta: { label: '外观', group: '界面', origin: 'local' },
  })

  let transport: Transport
  let fixture: ReturnType<typeof fixtureFromSearch> | null = null

  if (mode === 'ws') {
    // 同源: dev 下由 vite 代理 /api 与 /ws 到后端 4721, 生产由后端自己发静态资源
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    transport = createWsTransport({
      httpBase: '',
      wsUrl: `${proto}//${location.host}/ws`,
      store: localStorageSeqStore(),
      onFatal(err) {
        console.error('[meng] ws:', err.message)
      },
    })
  } else {
    fixture = fixtureFromSearch(location.search)
    // gap 18ms: node 里是 0 (测得快), 浏览器里留一点间隔才看得出"流式"。
    // ?gap=250 之类可以慢放 —— 验"运行中"这类一闪而过的中间态全靠它
    const kernel = createFixtureKernel(fixture, {
      gap: Math.max(0, Number(params.get('gap')) || 18),
    })
    transport = createInprocTransport(kernel)
  }

  const ctx = createContext('shell')
  ctx.set('slots', slots)
  ctx.set('transport', transport)
  /**
   * 主题控制器是**宿主提供的能力**, 不是插件各干各的。
   * 插件只 apply 自己那一层, 撤销由控制器重算 —— 这样两个皮肤同时开着也不会互相抹。
   *
   * ?strict-theme: dev 下把「对比度不过审」从"拒绝该 token + console.error"
   * 升级成直接抛异常 —— 人眼挑颜色永远挑不准, 让它在页面上当场炸出来。
   */
  ctx.set(
    'theme',
    createThemeController({
      strict: new URLSearchParams(location.search).has('strict-theme'),
    }),
  )

  // 真 bundle 走 modules/client; 两个 fixture 插件是进程内的假货, 用 url 前缀区分。
  // 这不是长久设计 —— 等 F6 的 ws 上来, manifest 会真的从 /api/boot-manifest 来,
  // 那时列表里只有真 url, 这个分支自然消失。
  const modules = createClientModuleSystem({ shared: SHARED, rows: PLUGIN_ROWS })

  // `?external=1` 把内置清单当成"运行时装进来的", 只为在无后端时也能观测到
  // 保守启动到底排除了什么。产品里用不到, 验收脚本用得到。
  const localRows: PluginRow[] =
    params.get('external') === '1'
      ? PLUGIN_ROWS.map((r) => ({ ...r, origin: 'external' as const }))
      : PLUGIN_ROWS

  const plugins: PluginRow[] = [
    // ws 模式下插件列表**来自后端** (hello 帧的 manifest), 不再手抄;
    // fixture 模式没有 handshake, 用下面这份假货
    ...(mode === 'ws' ? await fetchManifestPlugins(transport) : localRows),
    ...(mode === 'ws'
      ? []
      : [
          {
            id: DEMO_PLUGIN_ID,
            url: 'fixture:demo',
            platforms: ['web'] as const,
            inject: ['slots'],
            immediately: false,
            origin: 'builtin' as const,
          },
        ]),
  ]

  // 让 devtools 与验收脚本能拿到装载器 (invalidate / 重新装载都从这里发起)
  Object.assign(window, { __MENG_LOADER__: modules.bridge })

  // 只有在 ?skin=... 时才装载: 默认界面必须是不带"皮肤插件"的裸版本
  if (params.get('skin')) {
    plugins.push({
      id: DEMO_SKIN_ID,
      url: 'fixture:demo-skin',
      platforms: ['web'],
      inject: ['slots', 'theme'],
      immediately: false,
    })
  }

  /**
   * 保守启动 = **发版原始模式**: 60 秒内连崩两次, 说明刷新解决不了, 这次只装
   * 随发行版打包的插件 (`origin === 'builtin'`), 运行时装进来的一个不装。
   *
   * 为什么不是"什么都不装": 那会让界面缺胳膊少腿, 用户会以为应用坏了。
   * 原始模式的意思恰恰是**回到刚装好的样子** —— 正常功能全在, 少的只是扩展能力。
   * (dsh 的安全模式、VS Code 的 disable-extensions 都是同一件事。)
   *
   * 三条刻意的选择:
   *   - **自动**, 不问用户 —— "要不要进原始模式"是系统该做的决定, 不是用户的选择题
   *   - **静默**, 界面上不挂横幅 —— 用户只会觉得"这次少了个扩展", 不会觉得"出大事了"
   *   - **幂等**, 再崩再刷还是同一条路径 —— 不会越刷越降级, 也不会陷入死循环
   */
  const safe = shouldBootSafe()
  const bootPlugins = safe ? plugins.filter(isBuiltin) : plugins
  if (safe) {
    console.warn(
      `[meng] 原始模式: 近期连崩两次, 本次只装载内置插件 ${bootPlugins.length}/${plugins.length}`,
    )
  }

  const manifest: BootManifest = { version: 1, modules: [], plugins: bootPlugins }

  const progress = new Map<string, EntryState>()
  const handle = await bootShell({
    manifest,
    ctx,
    platform: 'web',
    onEntry(id, phase) {
      progress.set(id, { id, phase })
      report([...progress.values()])
    },
    loadModule: async (id, url) => {
      // fixture: 前缀 = 进程内假货, 不经过网络
      if (url.startsWith('fixture:')) {
        if (id === DEMO_PLUGIN_ID) return demoRuntime
        if (id === DEMO_SKIN_ID) return demoSkinRuntime
        throw new Error(`fixture: 没有这个 bundle (${id})`)
      }
      return modules.load({ id, url })
    },
  })

  if (handle.failures.length > 0) {
    console.warn('[meng] 启动未完全激活:', handle.failures)
  }

  // dev 出口: 浏览器验收脚本用它做 invalidate / 重新装载 / 断网
  Object.assign(window, { __meng: { modules, slots, ctx, transport, handle } })

  return { handle, transport, slots, fixture, modules }
}

function WebApp() {
  // boot 的 promise 缓存在 ref 里: AppRoot 的 start 会被调两次 (StrictMode),
  // 幂等性由这里保证, 而不是让 AppRoot 自己加"只跑一次"的守卫
  const booting = useRef<Promise<Booted> | null>(null)
  const [booted, setBooted] = useState<Booted | null>(null)

  const start = useCallback((report: (entries: EntryState[]) => void) => {
    booting.current ??= bootstrap(report)
    return booting.current.then((result) => {
      setBooted(result)
      return result.handle
    })
  }, [])

  return (
    <AppRoot
      start={start}
      renderApp={() =>
        booted ? (
          <>
            {/* ?crash=N 在渲染期炸 N 次, 用来验兜底界面 —— 炸够次数就恢复, 让 reset 路径可验 */}
            {params.get('crash') && <CrashBomb times={Number(params.get('crash')) || 1} />}
            <TransportProvider transport={booted.transport}>
              <App transport={booted.transport} slots={booted.slots} fixture={booted.fixture} auto={params.get('auto') ?? undefined} />
            </TransportProvider>
          </>
        ) : null
      }
    />
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('web: #root 不存在')

createRoot(root).render(
  <StrictMode>
    {/* 宿主最后一道闸: 里面任何东西渲染期崩了, 都不许变成白屏。
        包在 WebApp 外面而不是 App 里面 —— 连加载页崩了也要兜住。 */}
    <CrashBoundary fallback={<FallbackShell />}>
      <WebApp />
    </CrashBoundary>
  </StrictMode>,
)
