/**
 * 模块系统 —— 双半, 但**零依赖**(连 core 都不依赖)。
 *
 * 理由写在 dsh 的注释里, 我们照抄: "模块系统不能通过自己到达"。
 * 它是 shell 静态打包的一部分, 不可能是插件。
 *
 * 与 dsh 的关键差别 (docs/05 §5):
 *   dsh 的扫描在构建期/启动期读 package.json, 且"包元数据缓存永不过期" → 装插件要重启+重建。
 *   我们把扫描放在 **server 进程**(装载 patch 时顺手产出), BootManifest 由 `/api/boot-manifest`
 *   下发 → 装插件只重启后端, 前端不用重建。
 */

/** 共享模块表: 由 shell 提供, 插件 bundle 标 external, 防多实例 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@meng/core',
  '@meng/slots',
  '@meng/web-react',
  '@meng/ui',
] as const

export interface ModuleRow {
  id: string
  /** 静态模块则无 url */
  url?: string
}

export interface PluginRow {
  id: string
  /**
   * 产物地址。**可选** —— 后端**不下发** url (分发路径是传输层的事实:
   * vite 代理 / 本地文件 / CDN 各有各的), 约定是 `/plugins/<id>/client.js`,
   * 由前端按 id 拼出来。见 `clientUrlOf` 与 `toPluginRows`。
   */
  url?: string
  /** 服务哪些端; shell 按当前平台过滤 */
  platforms: ('web' | 'desktop' | 'mobile')[]
  /**
   * 依赖的能力面, 装载期校验; 缺失则 pending 并在 sweep 里报出缺哪个。
   *
   * ⚠️ 这里装的是**后端能力面名** (`ctx.tools` / `ctx.fs` ...), 不是前端 service 名。
   * 别把它当成前端的依赖声明去校验 —— 名字相同的两套东西不是一回事 (docs/11 §3.3)。
   */
  inject: string[]
  /** 立即层: 必须等它注册完, 才能创建其他 entry (同步 require 边无法被 inject 保护) */
  immediately: boolean
  /**
   * 这个插件是**随发行版一起打包的** (builtin), 还是**运行时装进来的** (external)。
   *
   * 它只有一个用途: 保守启动时决定谁的座位保留。
   *   builtin  = 发版原始模式 —— 就算出事也照装, 因为它是"正常功能"的一部分
   *   external = 出事后本次不装, 掉的是扩展能力, 不是主功能
   *
   * 缺省按 **external** 算: 来源不明的东西不该在保守模式下被信任。
   * 也就是说, 忘了打标的代价是"安全模式下少一块", 而不是"安全模式失效" ——
   * 失败方向选对了。
   */
  origin?: PluginOrigin
}

export type PluginOrigin = 'builtin' | 'external'

/** 缺省 = external (见 PluginRow.origin 的注释: 来源不明按不被信任处理) */
export function isBuiltin(row: PluginRow): boolean {
  return row.origin === 'builtin'
}

/**
 * 前端产物的默认分发路径。
 *
 * 为什么是约定而不是下发: 后端不该知道自己的产物会被 vite 代理到 `/plugins/x/client.js`
 * 还是 CDN 上 —— 那是部署形状, 传输层的事。写死在前端这一侧, 换部署方式时
 * 改的是前端的一行 (或 vite 的代理配置), 不动协议。
 */
export function clientUrlOf(id: string): string {
  return `/plugins/${id}/client.js`
}

/**
 * 状态图节点 (`NodeRecord`) → 插件行。
 *
 * **只挑带 `client` 的节点**: 没声明前端面的插件只在内核里活着, 前端不该为它
 * 发一次注定 404 的请求, 也不该把它算进启动进度里。
 *
 * 参数刻意用宽松的 duck type 而不是 import `NodeRecord`: 本包必须保持零依赖,
 * 而且后端与前端是两次独立部署, 字段可能真的缺 —— 所以每个字段都单独兜底。
 */
export interface GraphNodeLike {
  id?: unknown
  /** 前端面自述 (core.ClientFace) */
  client?: {
    platforms?: unknown
    immediately?: unknown
    slots?: unknown
    /** 发版自带 = 原始模式保留; 没声明按外置处理 */
    builtin?: unknown
  } | null
  inject?: unknown
  status?: unknown
}

const ALL_PLATFORMS = ['web', 'desktop', 'mobile'] as const

export function toPluginRows(nodes: readonly GraphNodeLike[]): PluginRow[] {
  if (!Array.isArray(nodes)) return []
  const rows: PluginRow[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    if (!node.client) continue // 无前端面 = 只在内核里活着
    if (typeof node.id !== 'string' || node.id === '') continue

    const platforms = Array.isArray(node.client.platforms)
      ? ((node.client.platforms as unknown[]).filter(
          (p): p is 'web' | 'desktop' | 'mobile' => p === 'web' || p === 'desktop' || p === 'mobile',
        ) as ('web' | 'desktop' | 'mobile')[])
      : [...ALL_PLATFORMS] // 缺省 = 三端都要, 不是"一端都不要"

    rows.push({
      id: node.id,
      url: clientUrlOf(node.id),
      platforms: platforms.length > 0 ? platforms : [...ALL_PLATFORMS],
      // 后端 inject 描述的是 node 侧能力面（tools / prompt / fs…），
      // 和浏览器 service 同名不同义。前端依赖只认 bundle 自己的 inject。
      inject: [],
      immediately: node.client.immediately === true,
      // 后端可以声明"这个是发版自带的"(client.builtin) —— 它比前端更清楚哪些插件
      // 是发行版的一部分、哪些是后天装的。**没声明就算外置**: 原始模式宁可少留一个,
      // 也不能把来路不明的代码留在崩溃现场。
      origin: node.client.builtin === true ? 'builtin' : 'external',
    })
  }
  return rows
}

export interface BootManifest {
  version: 1
  modules: ModuleRow[]
  plugins: PluginRow[]
}

/**
 * 插件 bundle 的出口形状。所有端通用。
 *
 * modules 包是**零依赖**的 (docs/05 §5: 模块系统不能通过自己到达),
 * 所以这里不能 import `@meng/core` 的 Disposer, 只能把签名摊开写。
 * 这两份签名必须保持一致 —— 由 `packages/shell/test/boot.ts` 的第 0 条断言兜底。
 */
export type PluginDisposer = () => void | Promise<void>

export interface PluginRuntime<Config = Record<string, unknown>> {
  /**
   * 干活的地方。**不会**被调用第二次: 重复注册同 id 在装载期就 throw 了。
   * 返回值是卸载钩, 由调用方 (core.loader / shell) 统一收进 disposer 栈,
   * 插件自己不要保存它。
   */
  apply(ctx: any, config: Config): void | PluginDisposer | Promise<void | PluginDisposer>
  /** bundle 侧重复声明的依赖, 装载期再校验一次 */
  inject?: string[]
  name?: string
}

/** server 半: 由装载后的 patch 产出 manifest */
export function buildManifest(entries: PluginRow[]): BootManifest {
  return { version: 1, modules: [], plugins: entries }
}

export function parseBootManifest(raw: unknown): BootManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('modules: __MENG_BOOT__ 缺失')
  const m = raw as BootManifest
  if (m.version !== 1) throw new Error(`modules: manifest 版本不支持 (${m.version})`)
  return m
}
