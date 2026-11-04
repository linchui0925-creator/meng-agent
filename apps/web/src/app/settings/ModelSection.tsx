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

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { SectionApi } from './api.ts'
import { Note } from './controls.tsx'
import {
  EMPTY_DRAFT,
  STATE_LABEL,
  draftErrors,
  endpointOf,
  formatTokens,
  messageOf,
  modelSummary,
  parseModelIds,
  profileOfDraft,
  routeIdOf,
  secretOf,
  shownProviders,
  stampOf,
  stateOf,
  widestContext,
  type CatalogProvider,
  type ConfigEntry,
  type CustomDraft,
  type DraftErrors,
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
   * 往路由字典里写一条。**读-改-写整张表** —— 后端只接受整张字典
   * （B-21 §5 的已知缺口: 没有"只写一条"的子路径）。
   *
   * 抽出来是因为「添加内置供应商」和「新建自定义 API」写的是同一个地方、
   * 同一种形状。各写一遍的话, 两处对 `configScope`/`configPath` 的解释
   * 迟早会分叉, 而分叉的表现是"有一种加不进去"。
   */
  const putRoute = useCallback(
    async (scope: string, slotKey: string, slot: string, profile: unknown) => {
      const key = `${scope}.${slotKey}`
      const entries = await invoke<ConfigEntry[]>('config.list')
      const cur = entries.find((e) => e.key === key)?.value
      const dict = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}
      await invoke('config.set', { key, value: { ...dict, [slot]: profile } })
    },
    [invoke],
  )

  /**
   * 添加一家内置供应商 = 把它的 `template` 原样写进路由字典。
   *
   * 三个"不自己发明"的规矩:
   *   · key 用 `configScope + configPath[0]` 拼, **不硬编码 `llm.openai.routes`** ——
   *     configPath 存在的意义就是告诉前端往哪儿写（见 B-21 §1）
   *   · template **原样**写, 不补字段、不填默认值 —— 服务端 parse 会补, 补两遍就是两份规则
   *   · 写完重新拉一次 catalog, 而不是本地把这条改成"已添加":
   *     `dormant` 消失、`available` 由 key 决定、模型清单换成目录里的 —— 这些
   *     判断全在后端, 前端猜一遍必然和它不一致。
   */
  const add = useCallback(
    async (p: CatalogProvider) => {
      if (!p.configScope || !p.configPath?.length || !p.template) return

      setBusy(p.id)
      setRowError((prev) => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })

      try {
        await putRoute(p.configScope, p.configPath[0]!, p.configPath[1] ?? p.id, p.template)
        await load()
      } catch (err) {
        setRowError((prev) => ({ ...prev, [p.id]: messageOf(err) }))
      } finally {
        setBusy(undefined)
      }
    },
    [load, putRoute],
  )

  /**
   * 「新建自定义 API」的四个格子。
   *
   * 这一块**后端不需要任何新接口**: `routes` 是 `z.record(string, RouteSchema)`,
   * 写一个新的键就是多一家供应商。之前这里是空的, 用户在这页上根本看不到
   * "我该往哪儿填自己的中转站" —— 数据通路一直是通的, 只是没有入口。
   */
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<CustomDraft>(EMPTY_DRAFT)
  const [draftErr, setDraftErr] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()

  /**
   * 往哪儿写。**从目录里读, 不硬编码 `llm.openai`** —— 哪一天换一个插件管路由表,
   * 这里跟着数据走就行。`configPath[0]` 是字典名（`routes`）, `[1]` 是键。
   */
  const routeSlot = providers.find((p) => p.configScope !== undefined && p.configPath?.[0] === 'routes')

  const openForm = useCallback(() => {
    setDraft(EMPTY_DRAFT)
    setDraftErr({})
    setSaveError(undefined)
    setCreating(true)
  }, [])

  const submit = useCallback(async () => {
    const errs = draftErrors(draft)
    setDraftErr(errs)
    if (Object.keys(errs).length > 0) return
    if (!routeSlot?.configScope || !routeSlot.configPath?.length) {
      setSaveError('后端没给出路由表的位置，没法写入')
      return
    }

    // 路由 id 从名字来。**取当前所有 id 去重** —— 撞名会静默覆盖掉已有的一家,
    // 那是"我新建了一个, 结果上一家没了"这种最难查的 bug。
    const id = routeIdOf(draft.name, providers.map((p) => p.id))

    setSaving(true)
    setSaveError(undefined)
    try {
      await putRoute(routeSlot.configScope, routeSlot.configPath[0]!, id, profileOfDraft(draft, id))
      setCreating(false)
      await load()
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }, [draft, load, providers, putRoute, routeSlot])

  /**
   * 两段: **自定义 API** 和 **供应商**。
   *
   * 这不是"已添加 / 可添加"那种按状态分的段 —— 状态是同一条列表里靠形状区分的
   * （可添加的行矮一半、右边是按钮）。段是按**这家的来路**分的:
   *   · 自定义 API = 用户自己填地址的网关（`declared: true`，不在目录里）
   *   · 供应商 = 内置目录里的（有品牌、有默认地址，用户只需要给个 key）
   * 分开的理由: 用户想接自己的中转站时, 要一眼看见"我该往哪儿填"，
   * 而不是在十几个品牌名字里找。
   *
   * **自定义在前**是因为它是短的那一段（空态一行 / 或几条自己加的），
   * 而内置目录是十来条的长表 —— 长表在后面才不会把入口推到折叠线以下。
   */
  const shown = shownProviders(providers)
  const vendors = shown.filter((p) => !p.declared)
  const customs = shown.filter((p) => p.declared)

  return (
    <div data-model-list="">
      {error !== undefined ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.retry} onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {!loaded ? <div className={styles.loading}>正在读供应商目录…</div> : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>自定义 API</h3>
          {creating ? null : (
            <button type="button" className={styles.newButton} onClick={openForm}>
              ＋ 新建
            </button>
          )}
        </div>

        {customs.length > 0 ? (
          <div className={styles.list}>
            {customs.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                busy={busy === p.id}
                error={rowError[p.id]}
                onAdd={() => void add(p)}
              />
            ))}
          </div>
        ) : creating ? null : (
          <p className={styles.empty}>
            还没有自定义 API。中转站、局域网网关、公司内网的兼容接口都填在这里 —— 一个地址加一个环境变量名就能用。
          </p>
        )}

        {creating ? (
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Field label="名称" error={draftErr.name} hint="界面上显示的名字；配置键由它生成">
              <input
                className={styles.input}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="我的中转站"
                autoFocus
              />
            </Field>

            <Field label="接口地址" error={draftErr.baseURL} hint="填到 /v1 为止，例如 https://api.example.com/v1">
              <input
                className={styles.input}
                value={draft.baseURL}
                onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
                placeholder="https://api.example.com/v1"
                inputMode="url"
                spellCheck={false}
              />
            </Field>

            <Field
              label="密钥变量名"
              error={draftErr.apiKeyEnv}
              hint="这里只填变量名。密钥的值放在环境变量里，进程启动时读 —— 换值要重启"
            >
              <input
                className={styles.input}
                value={draft.apiKeyEnv}
                onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value })}
                placeholder="CUSTOM_API_KEY"
                spellCheck={false}
              />
            </Field>

            <Field
              label="模型"
              error={draftErr.models}
              hint={
                parseModelIds(draft.models).length > 0
                  ? `会写进 ${parseModelIds(draft.models).length} 条模型`
                  : '逗号分隔，例如 gpt-4o, claude-sonnet-4；留空就用它默认那一条'
              }
            >
              <input
                className={styles.input}
                value={draft.models}
                onChange={(e) => setDraft({ ...draft, models: e.target.value })}
                placeholder="gpt-4o, gpt-4o-mini"
                spellCheck={false}
              />
            </Field>

            {saveError !== undefined ? (
              <p className={styles.formError} role="alert">
                {saveError}
              </p>
            ) : null}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => setCreating(false)}
                disabled={saving}
              >
                取消
              </button>
              <button type="submit" className={styles.primary} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {/*
        「供应商」在下面 —— 顺序是**按这一段的长度排的**, 不是按重要性。
        内置目录有十来家, 一张长表放在上面会把自定义入口推到折叠线以下
        （实测 1180×1000 要滚 800px 才看得见）。自定义段是带表单的那个,
        它必须第一眼就在, 所以它在上面。
      */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>供应商</h3>
        <div className={styles.list}>
          {vendors.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              busy={busy === p.id}
              error={rowError[p.id]}
              onAdd={() => void add(p)}
            />
          ))}
        </div>
      </section>

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

/**
 * 表单里的一个格子。**错误和提示占同一个位置** —— 提示是有空时说的,
 * 错误是它说错时说的, 同时出现会让格子长高一截、整张表单跟着跳。
 */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {error !== undefined ? (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : hint !== undefined ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </label>
  )
}
