/**
 * 「模型」分区 —— 第一个**真正读内核**的分区（`origin: 'kernel'`）。
 *
 * 数据只有一处来源: `llm.catalog`。一个 op 同时回答三个问题:
 *   ① 现在有哪些供应商活着 ② 每家缺什么 ③ 内置目录里还有哪些可以加
 *
 * 形态是**三栏**: 设置导航 | 供应商列表 | 选中那家的详情。
 *
 * 为什么不是一张长表, 也不是一个下拉:
 *   · 长表要滚 800px 才能看全, 而这一页只做一件事 —— 挑一家, 看它缺什么。
 *   · 下拉能省地方, 但**放不下自定义 API**: 它只能活在一个「＋ 新建」按钮里,
 *     用户看完这页不会知道"我的中转站该往哪儿填"。自定义 API 需要的不是一个
 *     按钮, 是列表里**一段真实存在的区域**。
 *
 * 所以列表分两段, 按**来路**分（内置目录 / 你自己填的地址）, 不按状态分:
 * 状态是同一家的三种处境, 升级成一级结构会让"这家到底是哪来的"看不出来。
 * 状态在列表里是一个小圆点, 在详情里是一个徽章。
 *
 * 四种态必须**各画各的**, 这是这一页最容易做错的地方:
 *   · 可用        有配置、有 key      → 可编辑表单 + 绿章
 *   · 未配置       加了、但缺 key     → 可编辑表单 + 黄章 + 后端原话
 *   · 可添加       装了、还没加进来    → **没有表单**, 只有「添加」+ 它会带来的模型
 *   · 不可配       装着就能用          → 连这一页都不出现（`shownProviders` 滤掉）
 * 把"可添加"画成"未配置", 用户会去翻环境变量找一个根本不存在的 key。
 *
 * 顺序 = 后端顺序（活着的在前, 可添加的在后）。**不排序** —— 排序会让
 * 供应商每次启动都可能换位置, 而用户靠位置认东西。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { SectionApi } from './api.ts'
import { Note } from './controls.tsx'
import {
  EMPTY_DRAFT,
  STATE_LABEL,
  draftErrors,
  formatTokens,
  messageOf,
  parseModelIds,
  profileOfDraft,
  routeDraftOf,
  routeIdOf,
  routeTargetOf,
  shownProviders,
  stampOf,
  stateOf,
  widestContext,
  writeStepsOf,
  type CatalogProvider,
  type ConfigEntry,
  type CustomDraft,
  type DraftErrors,
  type ModelInfo,
  type RouteDraft,
} from './model.ts'
import styles from './ModelSection.module.css'

export function ModelSection({ invoke }: SectionApi) {
  const [providers, setProviders] = useState<CatalogProvider[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  /** 正在添加的那一家。用 id 而不是布尔 —— 同时只能加一家, 但要加到哪家得看得出来 */
  const [busy, setBusy] = useState<string>()

  /** 选中谁。undefined 时回落到第一个 —— 不存"初始值", 目录刷新不用 effect 纠偏 */
  const [selectedId, setSelectedId] = useState<string>()
  /** 目录拉到第几次。**只用来重置编辑态**，别拿它参与显示逻辑 */
  const [revision, setRevision] = useState(0)

  const load = useCallback(async () => {
    try {
      setProviders(await invoke<CatalogProvider[]>('llm.catalog'))
      setError(undefined)
      // 每次成功拉到目录就 +1。**它只用来重置详情面板的编辑态**,
      // 不参与渲染逻辑 —— 见下面那个 effect 为什么需要它
      setRevision((r) => r + 1)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoaded(true)
    }
  }, [invoke])

  useEffect(() => {
    void load()
  }, [load])

  const shown = shownProviders(providers)
  const vendors = shown.filter((p) => !p.declared)
  const customs = shown.filter((p) => p.declared)
  const current = shown.find((p) => p.id === selectedId) ?? shown[0]

  // ── 详情面板的编辑态 ──────────────────────────────────────────────────────
  // `before` 留着是为了"只写改过的字段"（见 writeStepsOf）和"撤销"。
  const [draft, setDraft] = useState<RouteDraft>()
  const [before, setBefore] = useState<RouteDraft>()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()

  /**
   * 重置编辑态。两个触发点:
   *   · 换了一家 → 必须重置
   *   · 目录重新拉到（`revision` 变了）→ 也必须重置。添加完一家、保存完一次,
   *     后端的 parse 可能给值补了默认 / 改了形状, 界面要显示**回来之后的真值**,
   *     而不是用户刚才填的那一份
   *
   * 依赖里**没有整个对象** —— 挂上对象的话, 每来一片 token 让目录重新拉一次,
   * 用户正在打的字就会被重置。这个 bug 在会话页上踩过一次。
   */
  const currentId = current?.id
  useEffect(() => {
    if (!current) {
      setDraft(undefined)
      setBefore(undefined)
      return
    }
    const next = routeDraftOf(current)
    setDraft(next)
    setBefore(next)
    setSaveError(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在"换家"和"重新拉到"时重置
  }, [currentId, revision])

  const dirty =
    draft !== undefined && before !== undefined && JSON.stringify(draft) !== JSON.stringify(before)

  /**
   * 往路由字典里写一条。**读-改-写整张表** —— 后端只接受整张字典
   * （B-21 §5 的已知缺口: 没有"只写一条"的子路径）。
   *
   * 抽出来是因为「添加内置供应商」「新建自定义 API」写的是同一个地方、
   * 同一种形状。各写一遍的话, 两处对写入位置的解释迟早会分叉,
   * 而分叉的表现是"有一种加不进去"。
   */
  const putRoute = useCallback(
    async (target: { key: string; id: string }, profile: unknown) => {
      const entries = await invoke<ConfigEntry[]>('config.list')
      const cur = entries.find((e) => e.key === target.key)?.value
      const dict = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}
      await invoke('config.set', { key: target.key, value: { ...dict, [target.id]: profile } })
    },
    [invoke],
  )

  /**
   * 添加一家内置供应商 = 把它的 `template` 原样写进路由字典。
   *
   * 三个"不自己发明"的规矩:
   *   · key 用 `configScope + configPath[0]` 拼, **不硬编码 `llm.openai.routes`**
   *   · template **原样**写, 不补字段、不填默认值 —— 服务端 parse 会补, 补两遍就是两份规则
   *   · 写完重新拉一次 catalog, 而不是本地把这条改成"已添加":
   *     `dormant` 消失、`available` 由 key 决定、模型清单换成目录里的 —— 这些
   *     判断全在后端, 前端猜一遍必然和它不一致。
   */
  const add = useCallback(
    async (p: CatalogProvider) => {
      // 写入位置**从数据里推**（`routeTargetOf` 同时认 configPath 和后端没给
      // configPath 的已添加条目）。推不出来就不假装写成功。
      const target = routeTargetOf(p)
      if (!target || !p.template) return
      setBusy(p.id)
      setSaveError(undefined)
      try {
        await putRoute(target, p.template)
        setSelectedId(p.id)
        await load()
      } catch (err) {
        setSaveError(messageOf(err))
      } finally {
        setBusy(undefined)
      }
    },
    [load, putRoute],
  )

  /**
   * 保存详情面板的改动。
   *
   * **只写改过的字段**（`writeStepsOf` 决定写哪儿、写什么）, 然后重新拉目录 ——
   * 状态、missing、模型清单都是后端算的, 前端不猜。
   */
  const save = useCallback(async () => {
    if (!current || !draft || !before) return
    const steps = writeStepsOf(current, draft, before)
    if (steps.length === 0) return

    setSaving(true)
    setSaveError(undefined)
    try {
      for (const step of steps) {
        if (step.kind === 'single') {
          await invoke('config.set', { key: step.key, value: step.value })
          continue
        }
        // 路由字典: 读整张 → 改这一条 → 写回。`undefined` 表示删掉那个键
        const entries = await invoke<ConfigEntry[]>('config.list')
        const cur = entries.find((e) => e.key === step.key)?.value
        const dict = cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {}
        const one = dict[step.id]
        const nextOne = one !== null && typeof one === 'object' && !Array.isArray(one) ? { ...(one as object) } : {}
        for (const [k, v] of Object.entries(step.patch)) {
          if (v === undefined) delete (nextOne as Record<string, unknown>)[k]
          else (nextOne as Record<string, unknown>)[k] = v
        }
        await invoke('config.set', { key: step.key, value: { ...dict, [step.id]: nextOne } })
      }
      await load()
      // 编辑态由上面那个 effect 按新数据重置, 这里**不手动 setDraft** ——
      // 手动设的话用的是闭包里那份旧 `current`, 保存完界面会跳到旧值上
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }, [before, current, draft, invoke, load])

  // ── 新建自定义 API ───────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false)
  const [newDraft, setNewDraft] = useState<CustomDraft>(EMPTY_DRAFT)
  const [newErr, setNewErr] = useState<DraftErrors>({})
  const [newSaving, setNewSaving] = useState(false)
  const [newError, setNewError] = useState<string>()

  /**
   * 新建的自定义 API 往哪儿写。
   *
   * **找第一家住在字典里的**, 而不是「找 `configPath[0] === 'routes'` 的那家」——
   * 后者只在有"可添加"条目时才成立: 目录里的供应商全加完了, `configPath`
   * 就一条都没有了（后端只对 dormant 的下发它）, 那时新建按钮会静默失败。
   */
  const dictHost = shown.map((p) => routeTargetOf(p)).find((t) => t !== undefined)

  const openForm = useCallback(() => {
    setNewDraft(EMPTY_DRAFT)
    setNewErr({})
    setNewError(undefined)
    setCreating(true)
  }, [])

  const submit = useCallback(async () => {
    const errs = draftErrors(newDraft)
    setNewErr(errs)
    if (Object.keys(errs).length > 0) return
    if (!dictHost) {
      setNewError('后端没给出路由表的位置，没法写入')
      return
    }

    // 路由 id 从名字来。**取当前所有 id 去重** —— 撞名会静默覆盖掉已有的一家,
    // 那是"我新建了一个, 结果上一家没了"这种最难查的 bug。
    const id = routeIdOf(newDraft.name, providers.map((p) => p.id))

    setNewSaving(true)
    setNewError(undefined)
    try {
      await putRoute({ key: dictHost.key, id }, profileOfDraft(newDraft, id))
      setCreating(false)
      // 存完把选中切到刚建的那家 —— 否则用户看到的是自己刚填的表单消失了,
      // 而屏幕上还是上一家（会以为没存上）
      setSelectedId(id)
      await load()
    } catch (err) {
      setNewError(messageOf(err))
    } finally {
      setNewSaving(false)
    }
  }, [dictHost, load, newDraft, providers, putRoute])

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

      <div className={styles.split}>
        {/*
          中间一列: 两段 + 每行只有「章 · 名字 · 状态点」。
          行内不放按钮 —— 按钮属于详情面板。一行里塞两个可点区域,
          点偏了就会变成"我明明点的是添加, 却切走了"。
        */}
        <nav className={styles.rail} aria-label="供应商">
          <RailSection title="内置供应商" count={vendors.length}>
            {vendors.map((p) => (
              <RailRow
                key={p.id}
                provider={p}
                active={!creating && current?.id === p.id}
                onSelect={() => {
                  setCreating(false)
                  setSelectedId(p.id)
                }}
              />
            ))}
          </RailSection>

          <RailSection
            title="自定义 API"
            count={customs.length}
            action={
              <button type="button" className={styles.railAdd} onClick={openForm} title="新建自定义 API">
                ＋
              </button>
            }
          >
            {customs.length > 0 ? (
              customs.map((p) => (
                <RailRow
                  key={p.id}
                  provider={p}
                  active={!creating && current?.id === p.id}
                  onSelect={() => {
                    setCreating(false)
                    setSelectedId(p.id)
                  }}
                />
              ))
            ) : (
              <p className={styles.railEmpty}>
                还没有。中转站、局域网网关、公司内网的兼容接口都填在这里。
              </p>
            )}
            {customs.length > 0 ? (
              <button type="button" className={styles.railNew} onClick={openForm}>
                ＋ 新建自定义 API
              </button>
            ) : null}
          </RailSection>
        </nav>

        {/* 右侧: 选中那家的详情 —— 或正在填的新建表单 */}
        <section className={styles.detail}>
          {creating ? (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <h3 className={styles.formTitle}>新建自定义 API</h3>

              <Field label="名称" error={newErr.name} hint="界面上显示的名字；配置键由它生成">
                <input
                  className={styles.input}
                  value={newDraft.name}
                  onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })}
                  placeholder="我的中转站"
                  autoFocus
                />
              </Field>

              <Field label="接口地址" error={newErr.baseURL} hint="填到 /v1 为止，例如 https://api.example.com/v1">
                <input
                  className={styles.input}
                  value={newDraft.baseURL}
                  onChange={(e) => setNewDraft({ ...newDraft, baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  inputMode="url"
                  spellCheck={false}
                />
              </Field>

              <Field
                label="密钥变量名"
                error={newErr.apiKeyEnv}
                hint="这里只填变量名。密钥的值放在环境变量里，进程启动时读 —— 换值要重启"
              >
                <input
                  className={styles.input}
                  value={newDraft.apiKeyEnv}
                  onChange={(e) => setNewDraft({ ...newDraft, apiKeyEnv: e.target.value })}
                  placeholder="CUSTOM_API_KEY"
                  spellCheck={false}
                />
              </Field>

              <Field
                label="模型"
                error={newErr.models}
                hint={
                  parseModelIds(newDraft.models).length > 0
                    ? `会写进 ${parseModelIds(newDraft.models).length} 条模型`
                    : '逗号分隔，例如 gpt-4o, claude-sonnet-4；留空就用它默认那一条'
                }
              >
                <input
                  className={styles.input}
                  value={newDraft.models}
                  onChange={(e) => setNewDraft({ ...newDraft, models: e.target.value })}
                  placeholder="gpt-4o, gpt-4o-mini"
                  spellCheck={false}
                />
              </Field>

              {newError !== undefined ? (
                <p className={styles.formError} role="alert">
                  {newError}
                </p>
              ) : null}

              <div className={styles.actions}>
                <button type="button" className={styles.ghost} onClick={() => setCreating(false)} disabled={newSaving}>
                  取消
                </button>
                <button type="submit" className={styles.primary} disabled={newSaving}>
                  {newSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          ) : current ? (
            <Detail
              provider={current}
              draft={draft}
              dirty={dirty}
              busy={busy === current.id}
              saving={saving}
              error={saveError}
              onChange={setDraft}
              onReset={() => setDraft(before)}
              onSave={() => void save()}
              onAdd={() => void add(current)}
            />
          ) : !loaded ? null : (
            <p className={styles.empty}>供应商目录是空的。</p>
          )}
        </section>
      </div>

      {/*
        注脚对齐**详情面板**的左边缘, 不对齐整页 —— 它讲的是"改动写到内核配置里",
        那是面板里的事。贴着列表左边缘的话会读成"列表的注脚"。
      */}
      <div className={styles.noteWrap}>
        <Note>
          内置供应商点「添加」就接进来，它带的模型同时进「可用模型」清单；自定义 API 填的是你自己的地址。
          改动立刻生效，只有密钥的值是进程启动时读的 —— 换值要重启。
        </Note>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

/** 列表的一段。标题行 = 名字 + 数量 + 右侧动作 */
function RailSection({
  title,
  count,
  action,
  children,
}: {
  title: string
  count: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={styles.railSection} data-rail-section={title}>
      <div className={styles.railHead}>
        <span className={styles.railTitle}>{title}</span>
        <span className={styles.railCount}>{count}</span>
        {action}
      </div>
      <div className={styles.railList}>{children}</div>
    </div>
  )
}

/**
 * 列表里的一行: 字母章 + 名字 + 状态点。
 *
 * **状态用点不用字** —— 11 行右边各挂一个"未配置"徽章, 那一列字会变成
 * 另一列列表, 而且每一行看起来都一样重。点只有 6px, 颜色分得开, 扫一眼就
 * 知道哪几行是活的。具体是哪一种态, 右边详情里有字。
 */
function RailRow({
  provider: p,
  active,
  onSelect,
}: {
  provider: CatalogProvider
  active: boolean
  onSelect: () => void
}) {
  const state = stateOf(p)
  return (
    <button
      type="button"
      className={styles.railRow}
      data-rail={p.id}
      data-active={active ? '' : undefined}
      data-provider={p.id}
      data-state={state}
      onClick={onSelect}
    >
      <span className={styles.railStamp} data-state={state} aria-hidden="true">
        {stampOf(p.name)}
      </span>
      <span className={styles.railName}>{p.name}</span>
      <span className={styles.railDot} data-state={state} aria-hidden="true" />
    </button>
  )
}

/**
 * 右侧详情。
 *
 * 「可添加」和「已添加」在这里的差别不是颜色, 而是**有没有输入框**:
 * 还没加进来的那家, 地址和变量名都还不存在, 画成灰色不可编辑的框
 * 会让人以为"这一家坏了"。它只有一句话 + 一个按钮 + 它会带来的模型。
 */
function Detail({
  provider: p,
  draft,
  dirty,
  busy,
  saving,
  error,
  onChange,
  onReset,
  onSave,
  onAdd,
}: {
  provider: CatalogProvider
  draft?: RouteDraft
  dirty: boolean
  busy: boolean
  saving: boolean
  error?: string
  onChange: (next: RouteDraft) => void
  onReset: () => void
  onSave: () => void
  onAdd: () => void
}) {
  const state = stateOf(p)
  const dormant = state === 'dormant'
  const widest = formatTokens(widestContext(p.models))

  return (
    <div className={styles.panel} data-detail={p.id} data-provider={p.id} data-state={state}>
      <header className={styles.panelHead}>
        <span className={styles.panelStamp} data-state={state} aria-hidden="true">
          {stampOf(p.name)}
        </span>
        <div className={styles.panelTitleGroup}>
          <div className={styles.panelNameLine}>
            <h3 className={styles.panelName}>{p.name}</h3>
            {p.declared ? <span className={styles.tag}>自己加的</span> : null}
          </div>
          <div className={styles.panelSub}>
            {p.protocol !== undefined ? <code>{p.protocol}</code> : null}
            {widest !== undefined ? <span>最长 {widest}</span> : null}
          </div>
        </div>
        {dormant ? (
          <button type="button" className={styles.add} disabled={busy} onClick={onAdd}>
            {busy ? '添加中…' : '添加'}
          </button>
        ) : (
          <span className={styles.badge} data-state={state}>
            {STATE_LABEL[state]}
          </span>
        )}
      </header>

      {/*
        后端给的原话。别改写 —— 它比前端猜的措辞准（带着那条路由自己的变量名）。
        可添加的那类不显示: 它的 missing 是"还没添加", 而这句话上面已经用
        一个按钮说完了, 再说一遍就成了催。
      */}
      {!dormant && p.missing.length > 0 ? <p className={styles.missing}>{p.missing.join(' · ')}</p> : null}

      {dormant ? (
        <p className={styles.dormantNote}>
          还没接进来。点「添加」会按目录里的默认地址建好这条路由 —— 之后在这里填密钥变量名。
        </p>
      ) : draft !== undefined ? (
        <div className={styles.fields}>
          <Field label="接口地址">
            <input
              className={styles.input}
              value={draft.baseURL}
              onChange={(e) => onChange({ ...draft, baseURL: e.target.value })}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
            />
          </Field>

          <Field label="密钥变量名" hint="存的是变量名，值是进程启动时从环境变量读的">
            <input
              className={styles.input}
              value={draft.env}
              onChange={(e) => onChange({ ...draft, env: e.target.value })}
              spellCheck={false}
              placeholder="PROVIDER_API_KEY"
            />
          </Field>

          {/* 后端没声明温度这一项就不画 —— 画一个改了什么都不发生的框比不画糟 */}
          {draft.temperature !== undefined ? (
            <Field label="温度" hint="留空 = 用供应商默认。范围 0 – 2">
              <input
                className={styles.input}
                value={draft.temperature}
                onChange={(e) => onChange({ ...draft, temperature: e.target.value })}
                inputMode="decimal"
                placeholder="不设"
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {error !== undefined ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}

      {dirty ? (
        <div className={styles.actions}>
          <button type="button" className={styles.ghost} onClick={onReset} disabled={saving}>
            撤销
          </button>
          <button type="button" className={styles.primary} onClick={onSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      ) : null}

      <div className={styles.modelBlock}>
        <div className={styles.modelHead}>
          <span className={styles.modelTitle}>模型</span>
          <span className={styles.modelCount}>{p.models.length > 0 ? `${p.models.length} 款` : '目录里还没有'}</span>
        </div>
        {p.models.length > 0 ? (
          <ul className={styles.modelList}>
            {p.models.map((m) => (
              <ModelRow key={m.id} model={m} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 一款模型。**容量缺失就说不知道**（`—` 会读成"支持 0"，所以那一格直接不画）,
 * 两个容量都画出来: 只有上下文没有输出, 用户没法判断能不能塞一段长代码。
 */
function ModelRow({ model: m }: { model: ModelInfo }) {
  const ctx = formatTokens(m.contextWindow)
  const out = formatTokens(m.maxTokens)
  return (
    <li className={styles.modelRow}>
      <code className={styles.modelName}>{m.name || m.id}</code>
      <span className={styles.modelMeta}>
        {ctx !== undefined ? <span title="上下文窗口">{ctx}</span> : null}
        {out !== undefined ? <span title="单轮最大输出">{out} 输出</span> : null}
        {m.input?.includes('image') ? <span className={styles.modelFlag}>视觉</span> : null}
        {m.reasoning ? <span className={styles.modelFlag}>推理</span> : null}
      </span>
    </li>
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
