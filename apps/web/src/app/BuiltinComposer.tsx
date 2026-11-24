/**
 * 内置输入框。**它不是内核, 只是 `composer` 这个空 slot 的 fallback。**
 *
 * 换成插件实现的唯一条件是: `slots.register('composer', { priority: 1 })`。
 * 之所以把它做成可替换而不是写死在 App 里, 是因为「换掉自带输入框」
 * 是 UI 插件最真实的一类需求(斜杠命令面板、多模态上传、语音),
 * 如果每次都要改内核, slot 系统就只是装饰。
 *
 * ── 形状（2026-11-17 重做）──
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ＋   说点什么…                                        │   ← 打字区
 *   │                                                      │
 *   │ 🛡 帮我批准   ⎇ main ●  ‖  deepseek-chat ⌄   ▬18K  ⬤ │   ← 环境栏 + 发送
 *   └──────────────────────────────────────────────────────┘
 *
 * 三处改动，都是为了让它看起来像"一个可以说话的地方"，而不是"一张填了六个
 * 按钮的表单"：
 *   1. **＋ 挪到最左侧**（`ComposerPlus`）。它是"往这条消息里加东西"，属于输入，
 *      不属于下面那条"这段会话在什么环境里跑"。
 *   2. **发送键改成圆的**。它和左边那些"选一下就不管了"的胶囊是两类东西：
 *      胶囊是状态，发送是一次性动作。方形按钮夹在一排胶囊里会被当成第七个设置项。
 *   3. **上下两行各有自己的内边距**（容器不再统一 padding）。这样打字区的左右留白
 *      可以比环境栏大一点 —— 文字需要呼吸，控件不需要。
 */

import { useEffect, useRef, useState, type DragEvent } from 'react'

import { Kbd, Spinner, Textarea, Tooltip } from '@meng/ui'

import { AttachmentStrip } from './AttachmentStrip.tsx'
import { ComposerBar } from './ComposerBar.tsx'
import { ComposerPlus } from './ComposerPlus.tsx'
import { BackgroundCommandDialog } from './BackgroundCommandDialog.tsx'
import { ModelSwitchDialog } from './ModelSwitchDialog.tsx'
import { ReferencePicker } from './ReferencePicker.tsx'
import { CheckIcon, CloseIcon, EditIcon, InsertNowIcon, SendIcon, StopIcon } from './icons.tsx'
import type { ComposerApi } from './layout.ts'
import styles from './App.module.css'

type QueueStyle = 'stack' | 'orbit' | 'paper' | 'rail'

function queueStyleOf(search: string): QueueStyle {
  const raw = new URLSearchParams(search).get('queueStyle')
  return raw === 'orbit' || raw === 'paper' || raw === 'rail' ? raw : 'stack'
}

export function BuiltinComposer({
  value,
  setValue,
  send,
  sendNow,
  stop,
  stopping,
  busy,
  queued,
  queuedEditingId,
  queuedInsertingId,
  beginQueuedEdit,
  cancelQueuedEdit,
  saveQueuedEdit,
  removeQueued,
  insertQueued,
  error,
  status,
  online,
  controls,
  question,
  attachments,
  addFiles,
  removeAttachment,
  referenceRoot,
  listFiles,
  insertReference,
  onStartBackgroundCommand,
  Slot,
}: ComposerApi) {
  /**
   * 有问题挂着时输入框让位。
   *
   * 那一轮是**挂起**的: 发新消息不会让它继续 (回答只有 `question.answer` 一条路)。
   * 与其让用户对着一个卡住的 agent 继续打字, 不如直接把它锁住, 并在占位文字里
   * 说明要先回答什么。
   */
  const blocked = question !== undefined
  const uploading = attachments.some((item) => item.status === 'uploading')
  const hasReady = attachments.some((item) => item.status === 'ready' && item.attachmentId !== undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const queueStyle = queueStyleOf(location.search)

  useEffect(() => {
    if (queuedEditingId === undefined) {
      setEditDraft('')
      return
    }
    setEditDraft(queued.find((message) => message.id === queuedEditingId)?.text ?? '')
  }, [queuedEditingId, queued])

  function filesOf(list: FileList | readonly File[]): File[] {
    return Array.from(list)
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = filesOf(event.dataTransfer.files)
    if (files.length > 0) addFiles(files)
  }

  return (
    <div
      className={styles.composerWrap}
      data-dragging={dragging ? '' : undefined}
      data-queue-style={queueStyle}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        className={styles.fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = filesOf(event.target.files ?? [])
          if (files.length > 0) addFiles(files)
          event.target.value = ''
        }}
      />
      {dragging && <div className={styles.dropOverlay}>松开上传图片</div>}
      {queued.length > 0 && (
        <div className={styles.queueList} aria-label="等待发送的消息">
          {queued.map((message, index) => {
            const editing = queuedEditingId === message.id
            const inserting = queuedInsertingId === message.id
            const actionsLocked = !editing && queuedEditingId !== undefined
            return (
              <div key={message.id} className={styles.queueItem} data-editing={editing ? '' : undefined}>
                <span className={styles.queueIndex} aria-hidden="true">{index + 1}</span>
                {editing ? (
                  <div className={styles.queueEditor}>
                    <textarea
                      autoFocus
                      className={styles.queueTextarea}
                      value={editDraft}
                      rows={2}
                      aria-label="编辑等待消息"
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelQueuedEdit()
                          return
                        }
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          saveQueuedEdit(message.id, editDraft)
                        }
                      }}
                    />
                    <div className={styles.queueActions}>
                      <Tooltip label="保存修改">
                        <button
                          type="button"
                          className={`${styles.queueActionPrimary} ${styles.queueActionIcon}`}
                          aria-label="保存修改"
                          disabled={!editDraft.trim()}
                          onClick={() => saveQueuedEdit(message.id, editDraft)}
                        >
                          <CheckIcon />
                        </button>
                      </Tooltip>
                      <Tooltip label="取消编辑">
                        <button
                          type="button"
                          className={styles.queueActionIcon}
                          aria-label="取消编辑"
                          onClick={cancelQueuedEdit}
                        >
                          <CloseIcon />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.queueBody}>
                      <div className={styles.queueText}>{message.text || '图片消息'}</div>
                      <span className={styles.queueMeta}>
                        {inserting ? '插入中' : '待发'}
                        {message.attachments.length > 0 ? ` · 附件 ${message.attachments.length}` : ''}
                      </span>
                    </div>
                    <div className={styles.queueActions}>
                      <Tooltip label={inserting ? '正在插入' : '立即插入'}>
                        <button
                          type="button"
                          className={`${styles.queueActionPrimary} ${styles.queueActionIcon}`}
                          aria-label={inserting ? '正在插入' : '立即插入'}
                          disabled={queuedInsertingId !== undefined || actionsLocked}
                          onClick={() => insertQueued(message.id)}
                        >
                          {inserting ? <Spinner label="正在插入" /> : <InsertNowIcon />}
                        </button>
                      </Tooltip>
                      <Tooltip label="编辑消息">
                        <button
                          type="button"
                          className={styles.queueActionIcon}
                          aria-label="编辑消息"
                          disabled={inserting || actionsLocked}
                          onClick={() => beginQueuedEdit(message.id)}
                        >
                          <EditIcon />
                        </button>
                      </Tooltip>
                      <Tooltip label="取消消息">
                        <button
                          type="button"
                          className={styles.queueActionIcon}
                          aria-label="取消消息"
                          disabled={inserting || actionsLocked}
                          onClick={() => removeQueued(message.id)}
                        >
                          <CloseIcon />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div className={styles.composer}>
        <div className={styles.composerInputRow}>
          <ComposerPlus
            onPickFiles={() => fileInput.current?.click()}
            onPickReference={() => setPickerOpen(true)}
            {...(onStartBackgroundCommand === undefined ? {} : { onBackgroundCommand: () => setBackgroundOpen(true) })}
          />
          {/* 输入框工具条: 附件 / 引用。空着时容器整体不占宽 (CSS :empty) */}
          <div className={styles.composerActions}>
            <Slot name="composer.actions" props={{ value, busy, online }} />
          </div>
          <Textarea
            variant="bare"
            autoGrow
            rows={1}
            value={value}
            disabled={blocked}
            placeholder={blocked ? '先回答上面的问题' : busy ? '继续输入，回车排队…' : '说点什么…'}
            aria-label="输入消息"
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              const files = filesOf(event.clipboardData.files)
              if (files.length === 0) return
              event.preventDefault()
              addFiles(files)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && busy) {
                event.preventDefault()
                stop()
                return
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (busy && (event.metaKey || event.ctrlKey)) sendNow()
                else send()
              }
            }}
          />
        </div>

        <AttachmentStrip items={attachments} remove={removeAttachment} />

        <div className={styles.composerBottom}>
          {controls !== undefined ? <ComposerBar controls={controls} /> : null}
          <button
            type="button"
            className={styles.send}
            aria-label={busy ? '停止当前轮' : '发送'}
            disabled={busy ? false : (blocked || uploading || (!value.trim() && !hasReady))}
            onClick={busy ? stop : send}
          >
            {busy ? (stopping ? <Spinner label="正在停止" /> : <StopIcon />) : <SendIcon />}
          </button>
        </div>
      </div>

      {error && <div className={styles.sendError}>发送失败: {error}</div>}

      <div className={styles.hintRow}>
        <span>
          {busy ? (
            <><Kbd>Enter</Kbd> 排队 · <Kbd>Ctrl/⌘</Kbd>+<Kbd>Enter</Kbd> 立即插入 · <Kbd>Esc</Kbd> 停止</>
          ) : (
            <><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行 · 可拖入图片</>
          )}
        </span>
        <span>{online ? '事件流已连接' : status}</span>
      </div>

      <ReferencePicker
        open={pickerOpen}
        root={referenceRoot}
        listFiles={listFiles}
        onSelect={insertReference}
        onClose={() => setPickerOpen(false)}
      />
      <ModelSwitchDialog prompt={controls?.modelSwitch} />
      {onStartBackgroundCommand && (
        <BackgroundCommandDialog
          open={backgroundOpen}
          onClose={() => setBackgroundOpen(false)}
          onSubmit={onStartBackgroundCommand}
        />
      )}
    </div>
  )
}
