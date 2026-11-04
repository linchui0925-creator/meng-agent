/**
 * 「模型」分区 —— 第一个**真正读内核**的分区（`origin: 'kernel'`）。
 *
 * 数据只有一处来源: `llm.catalog`。一个 op 同时回答三个问题:
 *   ① 现在有哪些供应商活着 ② 每家缺什么 ③ 内置目录里还有哪些可以加
 *
 * 三种态必须**各画各的**, 这是这一页最容易做错的地方:
 *   · 可用        有配置、有 key      → 一行事实 + 绿章
 *   · 未配置       加了、但缺 key     → 一行事实 + 黄章 + 后端原话的红字
 *   · 可添加       装了、还没加进来    → 折成一行 + 添加按钮 (**不是**缺 key)
 *   · 不可配       装着就能用          → 一行事实 + "没有可配的东西"
 * 把"可添加"画成"未配置", 用户会去翻环境变量找一个根本不存在的 key。
 *
 * 顺序 = 后端顺序（活着的在前, 可添加的在后）。**不排序** —— 排序会让
 * 供应商每次启动都可能换位置, 而用户靠位置认东西。
 *
 * 这一刀的范围: 目录 + 添加。改单条配置（换绑变量 / 地址 / 温度）是下一刀,
 * 所以已添加的那几行只摆**事实**（地址、变量名、状态）, 不放假控件。
 * 假开关比没有开关更糟: 用户以为改了, 然后发现没生效。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Note } from './controls.tsx'
import {
  STATE_LABEL,
  endpointOf,
  formatTokens,
  messageOf,
  modelSummary,
  secretOf,
  stampOf,
  stateOf,
  widestContext,
  type CatalogProvider,
  type ConfigEntry,
} from './model.ts'
import styles from './ModelSection.module.css'

export function ModelSection({ invoke }: SectionApi) {
  const [providers, setProviders] = useState<CatalogProvider[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  /** 正在添加的那一家。用 id 而不是布尔 —— 同时只能加一家, 但要加到哪家得看得出来 */
  const [busy, setBusy] = useState<string>()
  /** 添加失败的**行内**原因。不用 alert: 后端的 message 是给人看的, 该留在原地 */
  const [rowError, setRowError] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      setProviders(await invoke<CatalogProvider[]>('llm.catalog'))
      setError(undefined)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoaded(true)
    }
  }, [invoke])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 添加一家内置供应商 = 把它的 `template` 原样写进路由字典。
   *
   * 三个"不自己发明"的规矩:
   *   · key 用 `configScope + configPath[0]` 拼, **不硬编码 `llm.openai.routes`** ——
   *     configPath 存在的意义就是告诉前端往哪儿写（见 B-21 §1）
   *   · template **原样**写, 不补字段、不填默认值 —— 服务端 parse 会补, 补两遍就是两份规则
   *   · 后端只接受**整张字典**, 所以先读再改再写（B-21 §5 的已知缺口）
   *
   * 写完之后重新拉一次 catalog, 而不是本地把这条改成"已添加":
   * `dormant` 消失、`available` 由 key 决定、模型清单换成目录里的 —— 这些
   * 判断全在后端, 前端猜一遍必然和它不一致。
   */
  const add = useCallback(
    async (p: CatalogProvider) => {
      if (!p.configScope || !p.configPath?.length || !p.template) return
      const key = `${p.configScope}.${p.configPath[0]}`
      const slot = p.configPath[1] ?? p.id

      setBusy(p.id)
      setRowError((prev) => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })

      try {
        const entries = await invoke<ConfigEntry[]>('config.list')
        const cur = entries.find((e) => e.key === key)?.value
        const dict = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}
        await invoke('config.set', { key, value: { ...dict, [slot]: p.template } })
        await load()
      } catch (err) {
        setRowError((prev) => ({ ...prev, [p.id]: messageOf(err) }))
      } finally {
        setBusy(undefined)
      }
    },
    [invoke, load],
  )

  return (
    <div>
      {error !== undefined ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.retry} onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {!loaded ? <div className={styles.loading}>正在读供应商目录…</div> : null}

      <div className={styles.list} data-model-list="">
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            busy={busy === p.id}
            error={rowError[p.id]}
            onAdd={() => void add(p)}
          />
        ))}
      </div>

      <Note>
        标「添加」的是内置目录里装好的供应商 —— 点一下就会出现在上面，它带来的模型同时进「可用模型」清单。
        改动写到内核的配置里，立刻生效；只有密钥的值是进程启动时读的，换值要重启。
      </Note>
    </div>
  )
}

function ProviderRow({
  provider: p,
  busy,
  error,
  onAdd,
}: {
  provider: CatalogProvider
  busy: boolean
  error?: string
  onAdd: () => void
}) {
  const state = stateOf(p)
  const dormant = state === 'dormant'
  const endpoint = endpointOf(p)
  const secret = secretOf(p)
  const widest = formatTokens(widestContext(p.models))

  return (
    <div className={styles.item} data-state={state} data-provider={p.id}>
      <div className={styles.head}>
        <span className={styles.stamp} data-state={state} aria-hidden="true">
          {stampOf(p.name)}
        </span>

        <div className={styles.titleGroup}>
          <div className={styles.nameLine}>
            <span className={styles.name}>{p.name}</span>
            {p.declared ? <span className={styles.tag}>自己加的</span> : null}
          </div>
          <div className={styles.modelLine} title={p.models.map((m) => m.name || m.id).join('、')}>
            {dormant && widest !== undefined
              ? `${p.models.length} 款模型 · 最长 ${widest}`
              : modelSummary(p.models)}
          </div>
        </div>

        {dormant ? (
          <button
            type="button"
            className={styles.add}
            disabled={busy}
            onClick={onAdd}
            aria-label={`添加 ${p.name}`}
          >
            {busy ? '添加中…' : '添加'}
          </button>
        ) : (
          <span className={styles.badge} data-state={state}>
            {STATE_LABEL[state]}
          </span>
        )}
      </div>

      {/*
        已添加的那几行摆事实, 不摆控件。
        「可添加」的那行什么都不摆 —— 它只有按钮, 折成一行才真的是一行。
      */}
      {dormant ? null : (
        <div className={styles.facts}>
          {endpoint !== undefined ? <code className={styles.fact}>{endpoint}</code> : null}
          {secret.env !== undefined ? (
            <span className={styles.fact} title={secret.present ? '这个变量里有值' : '这个变量里没有值'}>
              <span className={styles.dot} data-present={secret.present ? '' : undefined} aria-hidden="true" />
              {secret.env}
            </span>
          ) : null}
          {state === 'fixed' ? <span className={styles.quiet}>装着就能用，没有可配的东西</span> : null}
        </div>
      )}

      {/* 后端给的原话。别改写 —— 它比前端猜的措辞准（带着那条路由自己的变量名） */}
      {!dormant && p.missing.length > 0 ? <p className={styles.missing}>{p.missing.join(' · ')}</p> : null}
      {error !== undefined ? (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
