/**
 * 内置输入框。**它不是内核, 只是 `composer` 这个空 slot 的 fallback。**
 *
 * 换成插件实现的唯一条件是: `slots.register('composer', { priority: 1 })`。
 * 之所以把它做成可替换而不是写死在 App 里, 是因为「换掉自带输入框」
 * 是 UI 插件最真实的一类需求(斜杠命令面板、多模态上传、语音),
 * 如果每次都要改内核, slot 系统就只是装饰。
 */

import { Button, Kbd, Spinner, Textarea } from '@meng/ui'

import { SendIcon } from './icons.tsx'
import type { ComposerApi } from './layout.ts'
import styles from './App.module.css'

export function BuiltinComposer({
  value,
  setValue,
  send,
  busy,
  error,
  status,
  online,
  Slot,
}: ComposerApi) {
  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        {/* 输入框工具条: 附件 / 模型选择 / 引用。空着时容器整体不占宽 (CSS :empty) */}
        <div className={styles.composerActions}>
          <Slot name="composer.actions" props={{ value, busy, online }} />
        </div>
        <Textarea
          variant="bare"
          autoGrow
          rows={1}
          value={value}
          placeholder="说点什么…"
          aria-label="输入消息"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          aria-label="发送"
          disabled={!value.trim() || busy}
          onClick={send}
        >
          {busy ? <Spinner label="发送中" /> : <SendIcon />}
        </Button>
      </div>

      {error && <div className={styles.sendError}>发送失败: {error}</div>}

      <div className={styles.hintRow}>
        <span>
          <Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行
        </span>
        <span>{online ? '事件流已连接' : status}</span>
      </div>
    </div>
  )
}
