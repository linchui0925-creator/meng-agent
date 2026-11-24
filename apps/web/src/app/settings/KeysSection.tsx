/**
 * 「接口密钥」分区 —— 直接填写 API Key。
 *
 * 密钥只保存在本机 `.meng/credentials.json`（0600），页面永远不回显已保存的
 * 明文。环境变量仍作为兼容回退：本机密钥优先，其次才是进程环境。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Group, Note } from './controls.tsx'
import {
  PRESENCE_TEXT,
  keyRowsOf,
  splitRows,
  stampOf,
  type KeyProvider,
  type KeyRow,
} from './keys.ts'
import styles from './KeysSection.module.css'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hintOf(row: KeyRow): string {
  if (row.present === 'no') return `还没有保存 API Key。内部引用名：${row.envName}；也兼容同名环境变量。`
  if (row.present === 'unknown') {
    return row.notes.length > 0 ? row.notes.join('；') : '后端没有报告这一家的密钥状态。'
  }
  return `API Key 已保存在本机。内部引用名：${row.envName}。重新填写可替换。`
}

export function KeysSection({ invoke }: SectionApi) {
  const [rows, setRows] = useState<KeyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [messages, setMessages] = useState<Record<string, { tone: 'ok' | 'error'; text: string } | undefined>>({})

  const load = useCallback(async () => {
    try {
      const providers = await invoke<KeyProvider[]>('llm.catalog')
      const next = Array.isArray(providers) ? keyRowsOf(providers) : []
      setRows(next)
      setDrafts((prev) => {
        const out: Record<string, string> = {}
        for (const row of next) out[row.id] = prev[row.id] ?? ''
        return out
      })
      setLoadError(undefined)
    } catch (err) {
      setLoadError(errText(err))
    } finally {
      setLoaded(true)
    }
  }, [invoke])

  useEffect(() => {
    void load()
  }, [load])

  async function save(row: KeyRow) {
    const value = (drafts[row.id] ?? '').trim()
    if (!value) {
      setMessages((m) => ({ ...m, [row.id]: { tone: 'error', text: '请先填写 API Key' } }))
      return
    }
    setBusy(row.id)
    setMessages((m) => ({ ...m, [row.id]: undefined }))
    try {
      await invoke('credential.set', { ref: row.envName, value })
      setDrafts((d) => ({ ...d, [row.id]: '' }))
      setMessages((m) => ({ ...m, [row.id]: { tone: 'ok', text: 'API Key 已保存到本机，下一次请求立即生效。' } }))
      await load()
    } catch (err) {
      setMessages((m) => ({ ...m, [row.id]: { tone: 'error', text: errText(err) } }))
    } finally {
      setBusy(undefined)
    }
  }

  async function clear(row: KeyRow) {
    if (!window.confirm(`清除 ${row.name} 的本机 API Key？环境变量如果仍存在，会继续作为回退。`)) return
    setBusy(row.id)
    setMessages((m) => ({ ...m, [row.id]: undefined }))
    try {
      await invoke('credential.unset', { ref: row.envName })
      setMessages((m) => ({ ...m, [row.id]: { tone: 'ok', text: '本机 API Key 已清除。' } }))
      await load()
    } catch (err) {
      setMessages((m) => ({ ...m, [row.id]: { tone: 'error', text: errText(err) } }))
    } finally {
      setBusy(undefined)
    }
  }

  if (!loaded) return <div className={styles.loading}>正在读本机 API Key 状态…</div>

  if (loadError) {
    return (
      <div className={styles.problem} role="alert">
        <p className={styles.problemTitle}>读不到供应商目录</p>
        <p className={styles.problemText}>{loadError}</p>
        <p className={styles.problemText}>这不影响聊天：已经配好的供应商照常工作，等内核恢复后再回来改。</p>
      </div>
    )
  }

  const { vendors, customs } = splitRows(rows)

  const renderRow = (row: KeyRow) => {
    const draft = drafts[row.id] ?? ''
    const dirty = draft.trim() !== ''
    const msg = messages[row.id]

    return (
      <div key={row.id} className={styles.row} data-key-row={row.id} data-presence={row.present}>
        <span className={styles.stamp} aria-hidden="true">{stampOf(row.name)}</span>
        <div className={styles.main}>
          <div className={styles.head}>
            <span className={styles.name}>{row.name}</span>
            <span className={styles.state} data-presence={row.present}>
              <i className={styles.dot} aria-hidden="true" />
              {PRESENCE_TEXT[row.present]}
            </span>
            {row.declared && <span className={styles.tag}>自己加的</span>}
          </div>

          <div className={styles.line}>
            <input
              className={styles.input}
              type="password"
              value={draft}
              aria-label={`${row.name} 的 API Key`}
              spellCheck={false}
              autoComplete="new-password"
              placeholder={row.present === 'yes' ? '已保存，重新填写可替换' : '粘贴 API Key'}
              onChange={(e) => {
                setDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                setMessages((m) => ({ ...m, [row.id]: undefined }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty && !busy) void save(row)
              }}
            />
            <button
              type="button"
              className={styles.save}
              data-visible={dirty ? '' : undefined}
              disabled={!dirty || busy === row.id}
              onClick={() => void save(row)}
            >
              {busy === row.id ? '保存中' : '保存'}
            </button>
            {row.present === 'yes' && !dirty ? (
              <button
                type="button"
                className={styles.clear}
                disabled={busy === row.id}
                onClick={() => void clear(row)}
              >
                清除
              </button>
            ) : null}
          </div>

          {msg ? (
            <p className={styles.msg} data-tone={msg.tone} role="status">{msg.text}</p>
          ) : (
            <p className={styles.hint}>{hintOf(row)}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <section className={styles.hero} data-keys-hero="">
        <div className={styles.heroTitle}>API Key 只保存在本机</div>
        <p className={styles.heroText}>
          直接粘贴 Key 即可。梦会写入 <b>.meng/credentials.json</b>，文件权限固定为 <b>0600</b>，
          页面不会回显明文；环境变量仍作为兼容回退。
        </p>
      </section>

      <Group title="内置供应商">
        {vendors.length > 0 ? vendors.map(renderRow) : <div className={styles.empty}>没有正在使用的内置供应商。去「模型」分区添加一家。</div>}
      </Group>

      <Group title="自定义 API">
        {customs.length > 0 ? customs.map(renderRow) : <div className={styles.empty}>还没有自己加的接口。在「模型」分区加一家，它会出现在这里。</div>}
      </Group>

      <Note>
        如果同一个引用名同时存在本机 Key 和环境变量，本机 Key 优先。清除本机 Key 后会回退到环境变量。
      </Note>
    </div>
  )
}
