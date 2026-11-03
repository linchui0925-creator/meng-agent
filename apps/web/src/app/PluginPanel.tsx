/**
 * 插件状态面板。
 *
 * 数据只有一处来源: `plugin.graph` op 返回的 `{ nodes }` —— 与 `meng graph` 终端命令、
 * `/api/runtime/graph` 是**同一份真相**。面板不做任何推断, 不拼装、不"美化"状态,
 * 否则排障时看到的东西和内核实际认为的东西会分家。
 *
 * 排序不是按 id: **出问题的排前面**。一个 30 个插件的系统, 26 个 active 是背景噪音,
 * 用户打开这个面板 99% 是为了看"哪个没起来"。所以 failed > pending > loading > active。
 * 同组内按 id, 保证两次刷新行序稳定 (不然 diff 眼睛会漏)。
 *
 * 颜色语义 (与 tokens.css 对齐, 不要各自发明):
 *   active  = live   「在跑」不是「成功」。positive 留给一次性结果, 常驻状态用 live。
 *   loading = live + 脉冲   也在跑, 只是还没跑起来
 *   pending = warning 等依赖, 不是错误 —— 这是本面板最容易被画错的一格
 *   failed  = danger
 *   其余     = fg-muted (discovered/disabled/disposed 都是"不在场上")
 */

import { useState } from 'react'

import { Badge, IconButton, ScrollArea, Spinner, Tooltip } from '@meng/ui'

import { CopyButton } from './CopyButton.tsx'
import { CloseIcon, RefreshIcon } from './icons.tsx'
import styles from './App.module.css'

/** 与 core/status.ts 的 PluginStatus 逐字对应。宽类型 + 运行期兜底, 不到前端崩 */
export type PluginStatus =
  | 'discovered'
  | 'pending'
  | 'disabled'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'

export interface GraphNode {
  id: string
  name: string
  status: PluginStatus
  inject?: string[]
  /** 有值 = 有前端面。面板只读不下载 —— 下载是 modules 的活 */
  client?: { platforms?: string[]; immediately?: boolean; slots?: string[] }
  /** pending 专属: 缺哪些依赖。这是这一行最有价值的信息 */
  missing?: string[]
  error?: string
  since?: number
}

export interface PluginGraphState {
  nodes: GraphNode[]
  /** 拉取失败的原因。**必须与"零插件"区分开** —— 一个是没配, 一个是查询不出去 */
  error?: string
  /** 上次成功拉取的时间 */
  at?: number
  loading: boolean
}

const STATUS_TEXT: Record<PluginStatus, string> = {
  discovered: '已发现',
  pending: '等依赖',
  disabled: '已禁用',
  loading: '装载中',
  active: '运行中',
  failed: '装载失败',
  disposed: '已卸载',
}

/** 问题优先。数字越小越靠前 */
const STATUS_RANK: Record<PluginStatus, number> = {
  failed: 0,
  pending: 1,
  loading: 2,
  active: 3,
  discovered: 4,
  disabled: 5,
  disposed: 6,
}

const STATUS_TONE: Record<PluginStatus, string> = {
  failed: 'danger',
  pending: 'warning',
  loading: 'live',
  active: 'live',
  discovered: 'idle',
  disabled: 'idle',
  disposed: 'idle',
}

export interface PluginPanelProps {
  graph: PluginGraphState
  onRefresh: () => void
  onClose: () => void
}

export function PluginPanel({ graph, onRefresh, onClose }: PluginPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const nodes = [...graph.nodes].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.id.localeCompare(b.id),
  )
  const active = nodes.filter((n) => n.status === 'active').length
  const broken = nodes.filter((n) => n.status === 'failed' || n.status === 'pending').length

  return (
    <aside className={styles.panel} aria-label="插件状态">
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>插件</span>
        {/* 计数用「运行中/总数」而不是只给总数: 一眼能判断"全起来了没有" */}
        <span className={styles.panelCount}>
          {active}/{nodes.length}
        </span>
        {broken > 0 && <Badge tone="warning">{broken} 个未就绪</Badge>}
        <span className={styles.panelSpacer} />
        <Tooltip label="刷新">
          <IconButton aria-label="刷新插件状态" size="sm" onClick={onRefresh} disabled={graph.loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Tooltip label="关闭面板">
          <IconButton aria-label="关闭插件面板" size="sm" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </div>

      <ScrollArea className={styles.panelBody}>
        {graph.error ? (
          /*
            查询失败 ≠ 没有插件。这两种情况在界面上长得像, 但处理方式完全相反:
            前者要去查内核, 后者要去查配置。所以文案必须点明「拿不到」。
          */
          <div className={styles.panelError}>
            <div className={styles.panelErrorTitle}>拿不到插件状态</div>
            <div className={styles.panelErrorBody}>{graph.error}</div>
            <CopyButton label="复制错误" text={graph.error} />
          </div>
        ) : nodes.length === 0 ? (
          <div className={styles.panelEmpty}>{graph.loading ? '读取中…' : '内核里没有装载任何插件'}</div>
        ) : (
          <ul className={styles.nodeList}>
            {nodes.map((node) => {
              const open = expanded === node.id
              const tone = STATUS_TONE[node.status] ?? 'idle'
              return (
                <li key={node.id} className={styles.nodeRow}>
                  <button
                    type="button"
                    className={styles.nodeMain}
                    // 可点的是「展开细节」这件事本身, 所以这里用 accent hover 而不是变色
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : node.id)}
                  >
                    <span className={`${styles.nodeDot} ${styles[`dot-${tone}`]}`} aria-hidden="true" />
                    <span className={styles.nodeId}>{node.id}</span>
                    <span className={styles.nodeStatus}>
                      {node.status === 'loading' && <Spinner label="" />}
                      {STATUS_TEXT[node.status] ?? node.status}
                    </span>
                  </button>

                  {open && (
                    <div className={styles.nodeDetail}>
                      <Detail label="名称" value={node.name} />
                      {node.missing?.length ? (
                        <Detail label="缺少依赖" value={node.missing.join(', ')} tone="warning" />
                      ) : null}
                      {node.error ? (
                        <div className={styles.detailRow}>
                          <span className={styles.detailLabel}>错误</span>
                          <span className={styles.detailError}>{node.error}</span>
                        </div>
                      ) : null}
                      {node.inject?.length ? (
                        <Detail label="依赖" value={node.inject.join(', ')} />
                      ) : null}
                      {node.client ? (
                        <Detail
                          label="前端面"
                          value={[
                            node.client.immediately ? '立即加载' : '按需加载',
                            node.client.platforms?.join('/') ?? '全平台',
                            node.client.slots?.length ? `占 ${node.client.slots.join(', ')}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        />
                      ) : null}
                      {node.since ? <Detail label="状态变更" value={timeAgo(node.since)} /> : null}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>

      <div className={styles.panelFoot}>
        {graph.at ? `更新于 ${new Date(graph.at).toLocaleTimeString()}` : '尚未读取'}
      </div>
    </aside>
  )
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={tone === 'warning' ? styles.detailWarn : styles.detailValue}>{value}</span>
    </div>
  )
}

function timeAgo(at: number): string {
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return `${Math.floor(delta / 3_600_000)} 小时前`
}
