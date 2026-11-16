/**
 * 「接口密钥」分区 —— 第三个内核腿分区。
 *
 * 一页回答一个问题: **哪家有钥匙, 用的是哪个环境变量**。
 *
 * ── 为什么是单页两段列表, 不是三栏 ──
 * 模型分区做三栏是因为一家有十几个字段（地址/协议/变量名/模型/温度…）,
 * 列表放不下才分左右。这里每家只有**一个可编辑字段**, 点进去看详情
 * 只多一次点击、不多一条信息。所以两段列表, 行内直接改。
 *
 * ── 为什么按「内置 / 自定义」分段, 不按「有 key / 没 key」 ──
 * 没有 key 是同一家的**一种处境**, 不是一种来路。升级成一级结构, 用户
 * 第一眼就看不出"这家是我加的, 还是内置的"—— 而那正是他来这一页要判断的。
 *
 * ── 三句必须说准的话 ──
 *   ① **存的是变量名, 不是密钥**。用户改变量名会以为自己换了 key。
 *   ② **改名立刻生效, 换值要重启**。两者不同步, 这是配置层刻意的不对称
 *      （值只能从 `process.env` 读）。说成"都要重启"会让人白重启一次。
 *   ③ **改了名等于换了一个变量**。原来那个变量里的值不会跟着搬过来 ——
 *      这是最常见的"我明明改好了却没生效"。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Group, Note } from './controls.tsx'
import {
  PRESENCE_TEXT,
  envNameError,
  keyRowsOf,
  splitRows,
  stampOf,
  writeOf,
  type KeyProvider,
  type KeyRow,
} from './keys.ts'
import styles from './KeysSection.module.css'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 每行下面那半句小字。**按状态换, 不写同一句** —— 三种处境要做的动作不同 */
function hintOf(row: KeyRow): string {
  if (row.present === 'no') return '这个变量里还没有值 —— 设好之后重启梦才会读进去。'
  if (row.present === 'unknown') {
    return row.notes.length > 0 ? row.notes.join('；') : '后端没有报告这一家的密钥状态。'
  }
  return '值已经读到了，这家可以直接发请求。'
}

export function KeysSection({ invoke }: SectionApi) {
  const [rows, setRows] = useState<KeyRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string>()

  /** 每行一个草稿。**保存一行不清其它行的草稿** —— 用户改到一半不该被冲掉 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [messages, setMessages] = useState<Record<string, { tone: 'ok' | 'error'; text: string } | undefined>>({})

  const load = useCallback(async () => {
    try {
      const providers = await invoke<KeyProvider[]>('llm.catalog')
      const next = Array.isArray(providers) ? keyRowsOf(providers) : []
      setRows(next)
      // 只补没有草稿的行: 已经改过、还没保存的那几行保持原样
      setDrafts((prev) => {
        const out: Record<string, string> = {}
        for (const r of next) out[r.id] = prev[r.id] ?? r.envName
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
    const next = (drafts[row.id] ?? '').trim()
    const bad = envNameError(next)
    if (bad) {
      setMessages((m) => ({ ...m, [row.id]: { tone: 'error', text: bad } }))
      return
    }

    setBusy(row.id)
    setMessages((m) => ({ ...m, [row.id]: undefined }))
    try {
      // 路由型在这里摊开整张字典再合回去（见 keys.ts writeOf）。
      // 算错一次就是"保存成功, 但顺手删掉了别的供应商"
      const step = writeOf(row, next)
      await invoke('config.set', { key: step.key, value: step.value })
      setMessages((m) => ({ ...m, [row.id]: { tone: 'ok', text: '已写入设置文件，下一次请求就用这个变量了。' } }))
      await load()
    } catch (err) {
      setMessages((m) => ({ ...m, [row.id]: { tone: 'error', text: errText(err) } }))
    } finally {
      setBusy(undefined)
    }
  }

  if (!loaded) return <div className={styles.loading}>正在读内核里的密钥绑定…</div>

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
    const draft = drafts[row.id] ?? row.envName
    const dirty = draft !== row.envName
    const bad = dirty ? envNameError(draft) : undefined
    const msg = messages[row.id]

    return (
      <div key={row.id} className={styles.row} data-key-row={row.id} data-presence={row.present}>
        <span className={styles.stamp} aria-hidden="true">
          {stampOf(row.name)}
        </span>

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
              value={draft}
              data-mono=""
              aria-label={`${row.name} 的密钥环境变量名`}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                setMessages((m) => ({ ...m, [row.id]: undefined }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty && !busy) void save(row)
              }}
            />
            {/* 没改脏时**占位但不显示**: 一直摆一个永远可点的保存按钮会让整页
                看着像"处处需要确认"; 而直接移除又会让行在改字时抖一下 */}
            <button
              type="button"
              className={styles.save}
              data-visible={dirty ? '' : undefined}
              disabled={!dirty || bad !== undefined || busy === row.id}
              onClick={() => void save(row)}
            >
              {busy === row.id ? '保存中' : '保存'}
            </button>
          </div>

          {msg ? (
            <p className={styles.msg} data-tone={msg.tone} role="status">
              {msg.text}
            </p>
          ) : bad ? (
            <p className={styles.msg} data-tone="error">
              {bad}
            </p>
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
        <div className={styles.heroTitle}>这里存的是变量名，不是密钥</div>
        <p className={styles.heroText}>
          每家填一个环境变量名，值是梦启动时从环境里读的 —— 所以<b>改名字立刻生效</b>，
          <b>换 key 的值要重启</b>。改名等于换一个变量：原来那个变量里的值不会跟过来。
        </p>
      </section>

      <Group title="内置供应商">
        {vendors.length > 0 ? (
          vendors.map(renderRow)
        ) : (
          <div className={styles.empty}>没有正在使用的内置供应商。去「模型」分区添加一家。</div>
        )}
      </Group>

      <Group title="自定义 API">
        {customs.length > 0 ? (
          customs.map(renderRow)
        ) : (
          <div className={styles.empty}>还没有自己加的接口。在「模型」分区加一家，它会出现在这里。</div>
        )}
      </Group>

      <Note>
        「变量是空的」只是说这个环境变量没设值，和密钥写错长得一样 —— 梦分不出这两种。
        设好之后重启一次，状态就会变。
      </Note>
    </div>
  )
}
