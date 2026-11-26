import { useState } from 'react'

import type { SlotComponent } from './layout.ts'
import type { ThemeMode } from '../prefs.ts'
import styles from './SidebarNav.module.css'

export function SidebarNav({
  pluginCount,
  Slot,
  plugins,
  activeView,
  onViewChange,
  themeMode,
  onThemeChange,
}: {
  pluginCount: number
  Slot: SlotComponent
  plugins: unknown
  activeView: 'chat' | 'tasks'
  onViewChange: (view: 'chat' | 'tasks') => void
  /** 主题的**模式** (light/dark/system), 不是解析后的深浅 */
  themeMode: ThemeMode
  /** 写主题。归宿主 —— 侧栏自己不碰 localStorage */
  onThemeChange: (mode: ThemeMode) => void
}) {
  const [openPlugins, setOpenPlugins] = useState(true)

  return (
    <nav className={styles.nav} aria-label="侧栏导航" data-sidebar-nav="">
      <div className={styles.caption}>导航</div>
      <button
        type="button"
        className={styles.item}
        data-active={activeView === 'chat' ? '' : undefined}
        aria-current={activeView === 'chat' ? 'page' : undefined}
        onClick={() => onViewChange('chat')}
      >
        <span className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M3 3h10v7H7l-3 3v-3H3z" /></svg>
        </span>
        对话
      </button>
      <button
        type="button"
        className={styles.item}
        data-active={activeView === 'tasks' ? '' : undefined}
        aria-current={activeView === 'tasks' ? 'page' : undefined}
        onClick={() => onViewChange('tasks')}
        data-task-nav=""
      >
        <span className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" /><path d="M8 4.8V8l2.2 1.4" /></svg>
        </span>
        定时任务
      </button>

      {/* 通用工具位：主题、计算器等独立前端插件从这里挂入，核心不 import 具体实现。 */}
      <Slot name="sidebar.utility" props={{ themeMode, onThemeChange }} />

      {pluginCount > 0 && (
        <div className={styles.pluginGroup} data-plugin-nav-group="">
          <button
            type="button"
            className={styles.groupHead}
            aria-expanded={openPlugins}
            onClick={() => setOpenPlugins((current) => !current)}
          >
            <span>插件后台</span>
            <span className={styles.count}>{pluginCount}</span>
            <span className={styles.chevron} data-open={openPlugins ? '' : undefined} aria-hidden="true">⌄</span>
          </button>
          {openPlugins && (
            <div className={styles.pluginItems} data-plugin-nav-items="">
              <Slot name="sidebar.nav" props={{ plugins }} />
            </div>
          )}
        </div>
      )}
    </nav>
  )
}
