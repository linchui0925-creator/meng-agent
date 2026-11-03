/**
 * 侧栏会话列表。
 *
 * 三件事刻在这块组件里：
 *
 * 1. **两行还是单行，由数据决定**。有 `preview` 就渲染第二行，没有就只渲染标题。
 *    后端 `session.list` 目前不给 preview —— 所以真实数据下这里会退化成单行列表，
 *    等后端补上字段自动变丰满。不写死两行高度，是因为留白比"永远空着的一行"诚实。
 *
 * 2. **列表项不是 button**。插件会在 `sidebar.item.actions` 里注册按钮（重命名/删除），
 *    button 套 button 是非法 HTML，浏览器会把内层那个拆出来 —— 表现是"点删除结果切换了会话"。
 *    所以外层用 div + role=option，键盘自己接（Enter/Space）。
 *
 * 3. **分组标题不参与点击**。它是导航，不是内容；让它可点会让人误以为能折叠。
 */

import type { SlotComponent } from './layout.ts'
import { groupSessions, type SessionSummary } from './sessions.ts'
import styles from './App.module.css'

export interface SidebarSessionsProps {
  sessions: SessionSummary[]
  activeId?: string
  /** 传进来而不是内部取 Date.now(): 分组纯函数的边界要能测 */
  now: number
  onSelect: (sessionId: string) => void
  Slot: SlotComponent
}

const HOUR = 60 * 60 * 1000

/** 今天/昨天显示时刻（组标题已经说明是哪天），更早显示月日 */
export function formatSessionTime(at: number, now: number): string {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const sameDay = at >= today.getTime()
  const yesterday = at >= today.getTime() - 24 * HOUR
  if (sameDay || yesterday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function SidebarSessions({ sessions, activeId, now, onSelect, Slot }: SidebarSessionsProps) {
  const groups = groupSessions(sessions, now)

  if (groups.length === 0) {
    return <div className={styles.sessionEmpty}>还没有会话</div>
  }

  return (
    <div role="listbox" aria-label="会话列表">
      {groups.map((group) => (
        <div key={group.key}>
          <div className={styles.sectionLabel}>{group.label}</div>
          {group.items.map((s) => {
            const active = s.sessionId === activeId
            return (
              <div
                key={s.sessionId}
                role="option"
                aria-selected={active}
                tabIndex={0}
                className={`${styles.sessionItem} ${active ? styles.sessionItemActive : ''}`}
                onClick={() => onSelect(s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(s.sessionId)
                  }
                }}
              >
                <span className={styles.sessionRow}>
                  <span className={styles.sessionTitle}>{s.title}</span>
                  <span className={styles.sessionMeta}>{formatSessionTime(s.at, now)}</span>
                </span>

                {s.preview && <span className={styles.sessionPreview}>{s.preview}</span>}

                {/* 会话项的操作位（重命名 / 删除 / 导出）。没插件注册时它不占宽度 */}
                <span className={styles.sessionSlot}>
                  <Slot name="sidebar.item.actions" props={{ sessionId: s.sessionId }} />
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
