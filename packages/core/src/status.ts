/**
 * 插件状态机 + 状态图。
 *
 * 与 dsh 的差别: dsh 的 fiber 状态是容器内部细节, 只能靠日志猜;
 * 我们的 7 个状态是**一等公民**, 可以直接导出成 JSON / 表格,
 * 让 `meng inspect` 和未来的 UI 面板共用同一份真相。
 */

export type PluginStatus =
  | 'discovered' // 读到了行, 还没 import
  | 'pending' // 依赖缺失, 等着 (不是错误)
  | 'disabled' // 配置里显式关掉
  | 'loading' // apply 执行中
  | 'active' // 就绪
  | 'failed' // 装载失败 (可带原因)
  | 'disposed' // 已卸载

/**
 * 插件的**前端面**。没有它 = 这个插件只在内核里活着, 前端不需要下载任何东西。
 *
 * 为什么平台枚举这里写成 `string[]` 而不是 `PlatformName[]`:
 *   `PlatformName` 定义在 `@meng/slots`（前端侧），而 core 的规矩是"不认识任何东西"。
 *   缝这里给宽类型, 由 `@meng/modules` 在装载侧收口成 `PlatformName[]` ——
 *   枚举该由拥有它的一方校验, 不是让内核反向依赖前端包。
 *
 * url 刻意**不在**这里: 前端产物从哪个路径取是传输层的事实, 内核不该知道。
 * 约定钉在 docs/06 §3: `/plugins/<id>/client.js`, 两边各自按 id 推导。
 */
export interface ClientFace {
  /** 服务哪些端。缺省 = 全部。托管版可以在清单里覆盖成 ['web'] */
  platforms?: string[]
  /**
   * 立即层: 只需注册 factory 就得就位, 不等 slot 被渲染。
   * 因为同步 require 边无法被 inject 保护 —— 晚加载会拿到 undefined
   */
  immediately?: boolean
  /** 它将占用的 slot。声明 ≠ 占用, 只用于加载决策 */
  slots?: string[]
}

export interface NodeRecord {
  id: string
  name: string
  status: PluginStatus
  inject: string[]
  /** 有值 = 这个插件有前端面, 前端该去下载它 */
  client?: ClientFace
  missing?: string[]
  error?: string
  since: number
}

export class StatusGraph {
  private nodes = new Map<string, NodeRecord>()
  private order: string[] = []

  discovered(id: string, name: string): void {
    this.put({ id, name, status: 'discovered', inject: [], since: Date.now() })
  }

  pending(id: string, missing: string[]): void {
    this.patch(id, { status: 'pending', missing })
  }

  disabled(id: string): void {
    this.patch(id, { status: 'disabled' })
  }

  loading(id: string): void {
    this.patch(id, { status: 'loading' })
  }

  active(id: string, inject: string[] = [], client?: ClientFace): void {
    // client 缺省时**不写**, 否则会把先登记的 clientFace 覆盖成 undefined
    this.patch(id, {
      status: 'active',
      inject,
      missing: undefined,
      error: undefined,
      ...(client ? { client } : {}),
    })
  }

  /**
   * 登记前端面。单独一个方法而不是塞进 active():
   * 纯前端插件（只有产物、没有 apply）也要能进 manifest, 它们不走 active 那条路
   */
  clientFace(id: string, client: ClientFace): void {
    this.patch(id, { client })
  }

  failed(id: string, error: string): void {
    this.patch(id, { status: 'failed', error })
  }

  disposed(id: string): void {
    this.patch(id, { status: 'disposed' })
  }

  get(id: string): NodeRecord | undefined {
    return this.nodes.get(id)
  }

  snapshot(): NodeRecord[] {
    return this.order.map((id) => this.nodes.get(id)!).filter(Boolean)
  }

  /** 只列 active 的行, 顺序即解析顺序 */
  activeIds(): string[] {
    return this.snapshot()
      .filter((n) => n.status === 'active')
      .map((n) => n.id)
  }

  /** 机器可读: 给 `/api/runtime/graph` 与 `meng graph` 用 */
  toJSON(): { nodes: NodeRecord[] } {
    return { nodes: this.snapshot() }
  }

  /** 人读: 对齐的表格, 终端里直接看得懂 */
  table(): string {
    const rows = this.snapshot().map((n) => {
      const tail = n.missing?.length ? `缺 ${n.missing.join(',')}` : n.error ?? ''
      return `${pad(n.id, 18)} ${pad(n.status, 10)} ${tail}`
    })
    return ['ID                 状态        备注', ...rows].join('\n')
  }

  private put(node: NodeRecord): void {
    if (!this.nodes.has(node.id)) this.order.push(node.id)
    this.nodes.set(node.id, node)
  }

  private patch(id: string, next: Partial<NodeRecord>): void {
    const cur = this.nodes.get(id)
    if (!cur) throw new Error(`状态图里没有 ${id}`)
    this.nodes.set(id, { ...cur, ...next, since: Date.now() })
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
