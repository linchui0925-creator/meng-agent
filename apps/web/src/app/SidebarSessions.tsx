/**
 * 侧栏会话列表：普通任务按时间分组，工作区会话按目录分组。
 * 列表项不是 button，归档、恢复、删除和插件动作才不会形成按钮嵌套。
 * 归档只是本机隐藏；只有行内二次确认后才调用宿主的删除操作。
 */

import { useState } from 'react'

import type { SlotComponent } from './layout.ts'
import { activityAtOf, groupSessions, previewTasks, type SessionSummary } from './sessions.ts'
import { splitByWorkspace, type Workspace } from './workspaces.ts'
import { ArchiveIcon, CheckIcon, ChevronIcon, CloseIcon, FolderIcon, TrashIcon } from './icons.tsx'
import { RenameSessionDialog } from './RenameSessionDialog.tsx'
import styles from './App.module.css'

export interface SidebarSessionsProps {
  sessions: SessionSummary[]
  /** 工作区列表。空 = 后端还没有这个 op（那时全部会话都落在「任务」里） */
  workspaces: Workspace[]
  activeId?: string
  /** 传进来而不是内部取 Date.now(): 分组纯函数的边界要能测 */
  now: number
  onSelect: (sessionId: string) => void
  archivedIds: string[]
  onArchive: (sessionId: string, archived: boolean) => void
  onDelete: (sessionId: string) => Promise<void>
  onRename: (sessionId: string, title: string) => Promise<void>
  onNewWorkspace: () => void
  onNewWorkspaceSession: (workspaceId: string) => void
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

export function SidebarSessions({
  sessions,
  workspaces,
  activeId,
  now,
  onSelect,
  archivedIds,
  onArchive,
  onDelete,
  onRename,
  onNewWorkspace,
  onNewWorkspaceSession,
  Slot,
}: SidebarSessionsProps) {
  const [showArchived, setShowArchived] = useState(false)
  const [showAllTasks, setShowAllTasks] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [deletingId, setDeletingId] = useState<string>()
  const [renaming, setRenaming] = useState<SessionSummary>()
  const archived = new Set(archivedIds)
  const visibleSessions = sessions.filter((session) => !archived.has(session.sessionId))
  const archivedSessions = sessions.filter((session) => archived.has(session.sessionId))
  const { tasks, groups } = splitByWorkspace(visibleSessions, workspaces)
  const taskPreview = previewTasks(tasks, activeId)
  const visibleTasks = showAllTasks ? tasks : taskPreview.items

  const confirmAndDelete = async (sessionId: string): Promise<void> => {
    setDeletingId(sessionId)
    try {
      await onDelete(sessionId)
      setConfirmDelete((current) => (current === sessionId ? undefined : current))
    } catch {
      // 宿主已在输入框下方展示失败原因，保留确认态便于重试。
    } finally {
      setDeletingId((current) => (current === sessionId ? undefined : current))
    }
  }

  const row = (session: SessionSummary, isArchived = false) => {
    const active = session.sessionId === activeId
    const confirming = confirmDelete === session.sessionId
    const deleting = deletingId === session.sessionId
    return (
      <div
        key={session.sessionId}
        role="option"
        aria-selected={active}
        tabIndex={0}
        data-session-row={session.sessionId}
        data-delete-confirming={confirming ? '' : undefined}
        className={`${styles.sessionItem} ${active ? styles.sessionItemActive : ''}`}
        onClick={() => onSelect(session.sessionId)}
        onDoubleClick={(event) => {
          event.preventDefault()
          setRenaming(session)
        }}
        onKeyDown={(event) => {
          if (event.key === 'F2') {
            event.preventDefault()
            setRenaming(session)
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(session.sessionId)
          }
        }}
      >
        <span className={styles.sessionRow}>
          <span className={styles.sessionTitle} title="双击重命名">
            {session.title}
          </span>
          <span className={styles.sessionMeta}>{formatSessionTime(activityAtOf(session), now)}</span>
        </span>

        {session.preview && <span className={styles.sessionPreview}>{session.preview}</span>}

        <span
          className={styles.sessionSlot}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {confirming ? (
            <>
              <button
                type="button"
                className={`${styles.sessionAction} ${styles.sessionDeleteConfirm}`}
                data-session-delete-confirm={session.sessionId}
                aria-label={`确认删除 ${session.title}`}
                disabled={deleting}
                onClick={() => void confirmAndDelete(session.sessionId)}
              >
                <CheckIcon />
                {deleting ? '删除中' : '确认删除'}
              </button>
              <button
                type="button"
                className={styles.sessionAction}
                data-session-delete-cancel={session.sessionId}
                aria-label="取消删除"
                title="取消删除"
                disabled={deleting}
                onClick={() => setConfirmDelete(undefined)}
              >
                <CloseIcon />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.sessionAction}
                data-session-archive={isArchived ? undefined : session.sessionId}
                data-session-unarchive={isArchived ? session.sessionId : undefined}
                aria-label={isArchived ? `恢复 ${session.title}` : `归档 ${session.title}`}
                title={isArchived ? '恢复到会话列表' : '归档（仅隐藏，不删除）'}
                onClick={() => onArchive(session.sessionId, !isArchived)}
              >
                <ArchiveIcon restored={isArchived} />
              </button>
              <button
                type="button"
                className={`${styles.sessionAction} ${styles.sessionDelete}`}
                data-session-delete={session.sessionId}
                aria-label={`删除 ${session.title}`}
                title="删除会话"
                onClick={() => setConfirmDelete(session.sessionId)}
              >
                <TrashIcon />
              </button>
              <Slot
                name="sidebar.item.actions"
                props={{ sessionId: session.sessionId, title: session.title, archived: isArchived }}
              />
            </>
          )}
        </span>
      </div>
    )
  }

  return (
    <div role="listbox" aria-label="会话列表">
      {visibleSessions.length === 0 && (
        <div className={styles.sessionEmpty}>{archivedSessions.length > 0 ? '没有未归档会话' : '还没有会话'}</div>
      )}
      {tasks.length > 0 && (
        <div data-section="tasks">
          <button
            type="button"
            className={styles.taskToggle}
            data-task-toggle=""
            aria-expanded={tasks.length <= taskPreview.items.length ? true : showAllTasks}
            disabled={taskPreview.hidden === 0}
            onClick={() => setShowAllTasks((current) => !current)}
          >
            <span className={styles.sectionLabel} data-count={tasks.length}>任务 ({tasks.length})</span>
            {taskPreview.hidden > 0 && (
              <span className={styles.taskToggleHint}>
                {showAllTasks ? '收起' : `最近 ${taskPreview.items.length} 条`}
                <span className={styles.taskChevron} data-open={showAllTasks ? '' : undefined} aria-hidden="true">⌄</span>
              </span>
            )}
          </button>
          <div className={styles.taskList} data-expanded={showAllTasks ? '' : undefined}>
            {groupSessions(visibleTasks, now).map((group) => (
              <div key={group.key}>
                <div className={styles.subLabel}>{group.label}</div>
                {group.items.map((session) => row(session))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div data-section="workspaces">
        <div className={styles.workspaceTitleRow}>
          <div className={styles.sectionLabel} data-count={groups.length}>
            工作区 ({groups.length})
          </div>
          <button
            type="button"
            className={styles.workspaceAdd}
            data-workspace-add=""
            aria-label="新建工作区"
            title="选择本机文件夹作为工作区"
            onClick={onNewWorkspace}
          >
            ＋
          </button>
        </div>
        {groups.map(({ workspace, items }) => (
          <div key={workspace.id} data-workspace-group={workspace.id}>
            <div className={styles.workspaceHead} title={workspace.path}>
              <span className={styles.workspaceIcon} aria-hidden="true">
                <FolderIcon />
              </span>
              <span className={styles.workspaceName}>{workspace.name}</span>
              <span className={styles.sessionMeta}>{items.length}</span>
              <button
                type="button"
                className={styles.workspaceSessionAdd}
                data-workspace-session-add={workspace.id}
                aria-label={`在 ${workspace.name} 新建会话`}
                title={`在 ${workspace.name} 新建会话`}
                onClick={() => onNewWorkspaceSession(workspace.id)}
              >＋</button>
            </div>
            <div className={styles.wsItems}>{items.map((session) => row(session))}</div>
          </div>
        ))}
      </div>

      {renaming && (
        <RenameSessionDialog
          key={renaming.sessionId}
          session={renaming}
          onClose={() => setRenaming(undefined)}
          onRename={onRename}
        />
      )}

      {archivedSessions.length > 0 && (
        <div className={styles.archiveSection} data-section="archived">
          <button
            type="button"
            className={styles.archiveToggle}
            data-archive-toggle=""
            aria-expanded={showArchived}
            onClick={() => setShowArchived((current) => !current)}
          >
            <ArchiveIcon />
            <span>已归档</span>
            <span className={styles.archiveCount}>{archivedSessions.length}</span>
            <span className={styles.archiveChevron} data-open={showArchived ? '' : undefined} aria-hidden="true">
              <ChevronIcon />
            </span>
          </button>
          {showArchived && <div className={styles.archiveItems}>{archivedSessions.map((session) => row(session, true))}</div>}
        </div>
      )}
    </div>
  )
}
