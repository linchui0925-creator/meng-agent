/**
 * 「模型」分区 —— **已接入的供应商 + 一个添加按钮**（用户 2026-11-16 第二轮拍板）。
 *
 * 这一页之前是三栏（导航 | 35 家目录 | 详情）。问题不是难看，是**答非所问**:
 * 用户来这儿只想知道"我现在接了谁、通不通"，而屏幕上 90% 的面积是"我还没接的
 * 34 家"。所以整页收成两件东西:
 *
 *   · 一张**只含已接入**的列表（每行 = 状态点 + 名字 + 摘要 + 测试连接）
 *   · 一个「＋ 添加模型」按钮 → 卡片（下拉选内置供应商 / 自定义 API，内容跟着变）
 *
 * 三种连接状态（用户点名要的）:
 *   · 绿 = 上一次测试连上了
 *   · 红 = 上一次测试没连上（原话在展开区里，不吞）
 *   · 白 = 没测过 / 测完超过半小时（外部事实会变，旧的绿灯比没有更糟）
 *
 * 状态是**本地事实**，存 localStorage，不进内核配置 —— 内核里没有"通不通"这个
 * 概念，它只知道"配齐没配齐"（那是 available / missing）。两者经常不一致:
 * key 配了但过期 → 配置齐、连接断。所以这一页两个都画，但主次分明:
 * **点看连接，徽章看配置**。
 *
 * 编辑是**行内展开**，不是第二栏: 一次只看一家，展开的就是"这一家的全部"。
 * 参数（温度 / 默认容量 / 模态）和每个模型的覆盖都在里面，一个「保存」写全部 ——
 * 两个保存按钮会让人不知道哪个生效了。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { SectionApi } from './api.ts'
import { Note } from './controls.tsx'
import {
  EMPTY_DRAFT,
  LINK_LABEL,
  addManualProviderModels,
  addModelIds,
  addOptionsOf,
  addedProviders,
  builtinOf,
  discoverPayloadOf,
  draftErrors,
  formatTokens,
  freshProbeOf,
  linkStateOf,
  mergePulledModels,
  messageOf,
  modelsForProvider,
  modelsWriteOf,
  offeredProtocols,
  providerIsEnabled,
  removeManualProviderModel,
  resetProviderModels,
  toggleProviderEnabled,
  paramErrorsOf,
  paramStepsOf,
  paramsOf,
  parseProbeStore,
  probeTargetOf,
  profileFromTemplate,
  profileOfDraft,
  routeDraftOf,
  routeIdOf,
  routeProfileOf,
  routeTargetOf,
  tuningsOf,
  withoutRoute,
  writeStepsOf,
  type CatalogProvider,
  type ConfigEntry,
  type CustomDraft,
  type DiscoverTarget,
  type DraftErrors,
  type LinkState,
  type ModelInfo,
  type ModelTuning,
  type ProbeRecord,
  type ProtocolInfo,
  type RouteDraft,
  type RouteParams,
} from './model.ts'
import styles from './ModelSection.module.css'

/** 连接状态的存储键。**界面事实**，不进内核配置（见文件头） */
const PROBE_STORE_KEY = 'meng.probes.v1'

function readProbes(): Record<string, ProbeRecord> {
  try {
    return parseProbeStore(localStorage.getItem(PROBE_STORE_KEY))
  } catch {
    // 隐私模式 / 存储被禁：状态退化成"只在这一次会话里记得"
    return {}
  }
}

/** 卡片里那一次探测的临时结果（不落盘 —— 那时这条路由还不存在） */
type Probe =
  | { state: 'running' }
  | { state: 'ok'; count: number; ms: number }
  | { state: 'fail'; message: string }

/** 展开区的"打开时是什么样"。撤销和"只写改过的"都靠它 */
interface Snapshot {
  draft: RouteDraft
  params: RouteParams
  tunings: Record<string, ModelTuning>
}

export function ModelSection({ invoke, prefs, setPrefs }: SectionApi) {
  const [providers, setProviders] = useState<CatalogProvider[]>([])
  const [protocols, setProtocols] = useState<ProtocolInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()

  /** 每家最近一次连接结果（持久化） */
  const [probes, setProbes] = useState<Record<string, ProbeRecord>>(readProbes)
  /** 正在测哪一家。`'*'` = 全部测试在跑 */
  const [testing, setTesting] = useState<string>()
  /** 页面打开的时刻。只用来判"结果太旧了"，不参与重渲染 */
  const [openedAt] = useState(() => Date.now())

  /** 目录拉到第几次。**只用来重置展开区的编辑态** */
  const [revision, setRevision] = useState(0)

  const load = useCallback(async () => {
    try {
      // 两个 op 一起拉: 目录回答"有哪几家", 协议表回答"新建时能选什么"。
      // 分开 try 的话, 协议表挂掉会表现成"页面正常, 但下拉是空的"——
      // 那种半死状态比整页报错难查得多
      const [list, protos] = await Promise.all([
        invoke<CatalogProvider[]>('llm.catalog'),
        invoke<ProtocolInfo[]>('llm.protocols'),
      ])
      setProviders(list)
      setProtocols(protos)
      setError(undefined)
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

  const rows = addedProviders(providers)
  const options = addOptionsOf(providers)

  /**
   * 往哪张字典里写。
   *
   * **从 `providers` 找, 不是从 `rows`** —— `rows` 滤掉了还没添加的那些, 也滤掉了
   * 隐藏的 `openai` 默认路由; 而"路由表住在哪儿"这件事恰恰只能从它们身上读出来
   * （已接入的那几家如果全是扁平配置, `rows` 里一个路由目标都没有）。
   * 极端情况: 一家都没接 → 这一页还得能"添加", 所以不能依赖 rows 非空。
   */
  const dictHost = providers.map(routeTargetOf).find((t) => t !== undefined)

  // ── 连接测试 ─────────────────────────────────────────────────────────────
  const remember = useCallback((id: string, rec: ProbeRecord) => {
    setProbes((cur) => {
      const next = { ...cur, [id]: rec }
      try {
        localStorage.setItem(PROBE_STORE_KEY, JSON.stringify(next))
      } catch {
        // 存不了就只在内存里活着 —— 状态是锦上添花, 不该因此让整页报错
      }
      return next
    })
  }, [])

  /**
   * 忘掉一家的状态。移除供应商时调 —— 否则下次把同一家加回来, 它会**继承**上一次
   * 那个绿灯, 而那个绿灯是上一份地址/密钥测出来的。
   */
  const forget = useCallback((id: string) => {
    setProbes((cur) => {
      const next = { ...cur }
      delete next[id]
      try {
        localStorage.setItem(PROBE_STORE_KEY, JSON.stringify(next))
      } catch {
        /* 同上 */
      }
      return next
    })
  }, [])

  /**
   * 测一次, 把结果记下来。
   *
   * **`source: 'endpoint'`** 是必须的: 默认那条路命中目录时零网络, 拿它当
   * "连接测试"会给出一个永远成功的假绿灯。这个参数同时验了三件事 ——
   * 地址通不通、协议对不对、密钥有没有效。
   */
  const runProbe = useCallback(
    async (target: DiscoverTarget, id: string): Promise<void> => {
      try {
        const found = await invoke<ModelInfo[]>(
          'llm.discoverModels',
          discoverPayloadOf(target, { source: 'endpoint' }),
        )
        remember(id, { state: 'ok', at: Date.now(), count: found.length })
      } catch (err) {
        remember(id, { state: 'fail', at: Date.now(), message: messageOf(err) })
      }
    },
    [invoke, remember],
  )

  const testOne = useCallback(
    async (p: CatalogProvider) => {
      const target = probeTargetOf(p)
      if (!target) {
        remember(p.id, { state: 'fail', at: Date.now(), message: '这一家没有可测的接口地址' })
        return
      }
      setTesting(p.id)
      await runProbe(target, p.id)
      setTesting(undefined)
    },
    [remember, runProbe],
  )

  /**
   * 全部测试。**逐家串行** —— 并发会对同一个网关同时甩 N 个请求,
   * 而这一页通常只有两三家, 串行的总耗时也就多一两秒。
   */
  const testAll = useCallback(async () => {
    setTesting('*')
    for (const p of rows) {
      const target = probeTargetOf(p)
      if (target) await runProbe(target, p.id)
    }
    setTesting(undefined)
  }, [rows, runProbe])

  // ── 写配置 ───────────────────────────────────────────────────────────────
  /**
   * 往路由字典里写一条（整条写）。**读-改-写整张表** —— 后端只接受整张字典。
   *
   * TODO(B-24 §3): 后端已给 `config.set` 的 `path`, 换掉就没有整表覆盖的窗口。
   * 这一轮没换的理由写在 HANDOFF §2 里（后端自动写还没上线 + `path` 不能删子键）。
   */
  const putRoute = useCallback(
    async (target: { key: string; id: string }, profile: unknown) => {
      const entries = await invoke<ConfigEntry[]>('config.list')
      const cur = entries.find((e) => e.key === target.key)?.value
      const dict = isDict(cur) ? cur : {}
      await invoke('config.set', { key: target.key, value: { ...dict, [target.id]: profile } })
    },
    [invoke],
  )

  /** 只改一条路由里的几个字段。`undefined` = 删掉那个键 */
  const patchRoute = useCallback(
    async (target: { key: string; id: string }, patch: Record<string, unknown>) => {
      const entries = await invoke<ConfigEntry[]>('config.list')
      const cur = entries.find((e) => e.key === target.key)?.value
      const dict = isDict(cur) ? cur : {}
      const one = dict[target.id]
      const nextOne: Record<string, unknown> = isDict(one) ? { ...one } : {}
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete nextOne[k]
        else nextOne[k] = v
      }
      await invoke('config.set', { key: target.key, value: { ...dict, [target.id]: nextOne } })
    },
    [invoke],
  )

  /**
   * 拉一次模型并**写回这条路由的 `models`**。
   *
   * 两个细节容易漏:
   *   · 用户可能已经给某几款调过参数（在 `modelOverrides` 里）。直接整份替换会
   *     把那些调整抹掉, 所以先 `mergePulledModels` 合进去, 再把 `modelOverrides`
   *     **清空** —— 后端规定这两个字段互斥, 同时写会让整条路由不可用。
   *   · 拉不到不算失败: 路由已经写进去了, 只是清单还是空的。
   */
  const pullInto = useCallback(
    async (target: { scope: string; key: string; id: string }, keep?: Record<string, ModelTuning>) => {
      const found = await invoke<ModelInfo[]>(
        'llm.discoverModels',
        discoverPayloadOf({ kind: 'route', scope: target.scope, provider: target.id }),
      )
      if (found.length === 0) return 0
      const models = keep === undefined ? found.map((m) => ({ id: m.id })) : mergePulledModels(found, keep)
      await patchRoute(target, { models, modelOverrides: {} })
      return found.length
    },
    [invoke, patchRoute],
  )

  const [pulling, setPulling] = useState(false)

  const repull = useCallback(
    async (p: CatalogProvider) => {
      const target = routeTargetOf(p)
      if (!target) return
      setPulling(true)
      setSaveError(undefined)
      try {
        const n = await pullInto(target, tuningsOf(p))
        if (n === 0) setSaveError('这个地址没回任何模型 —— 清单还是空的')
        await load()
      } catch (err) {
        setSaveError(messageOf(err))
      } finally {
        setPulling(false)
      }
    },
    [load, pullInto],
  )

  // ── 移除一家 ─────────────────────────────────────────────────────────────
  const [removing, setRemoving] = useState(false)

  /**
   * 移除 = **整表写回时少一个键**。
   *
   * 后端没有"删一条路由"的子路径（`config.set` 的 `path` 只支持 set）,
   * 所以只能读回来、去掉那一家、整张写回。`withoutRoute` 保证其余每一条都还在 ——
   * 漏一条就是"我删了一家, 结果另一家也没了", 而那种事故在界面上看不出来。
   */
  const remove = useCallback(
    async (p: CatalogProvider) => {
      const target = routeTargetOf(p)
      if (!target) return
      setSaving(true)
      setSaveError(undefined)
      try {
        const entries = await invoke<ConfigEntry[]>('config.list')
        const cur = entries.find((e) => e.key === target.key)?.value
        const dict = isDict(cur) ? cur : {}
        await invoke('config.set', { key: target.key, value: withoutRoute(dict, target.id) })
        setOpenId(undefined)
        setRemoving(false)
        forget(p.id)
        await load()
      } catch (err) {
        setSaveError(messageOf(err))
      } finally {
        setSaving(false)
      }
    },
    [forget, invoke, load],
  )

  // ── 行内展开的编辑态 ─────────────────────────────────────────────────────
  const [openId, setOpenId] = useState<string>()
  const [draft, setDraft] = useState<RouteDraft>()
  const [params, setParams] = useState<RouteParams>()
  const [tunings, setTunings] = useState<Record<string, ModelTuning>>()
  const [before, setBefore] = useState<Snapshot>()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  /** 展开的是哪一款模型的参数 */
  const [tuningId, setTuningId] = useState<string>()

  const open = rows.find((p) => p.id === openId)

  /**
   * 重置展开区。两个触发点: 换了一家 / 目录重新拉到（保存完、拉取完）。
   *
   * 依赖里**没有整个对象** —— 挂上对象的话, 每来一片 token 让目录重拉一次,
   * 用户正在打的字就会被重置。这个 bug 在会话页上踩过一次。
   */
  useEffect(() => {
    if (open === undefined) {
      setDraft(undefined)
      setParams(undefined)
      setTunings(undefined)
      setBefore(undefined)
      return
    }
    const snap: Snapshot = { draft: routeDraftOf(open), params: paramsOf(open), tunings: tuningsOf(open) }
    setDraft(snap.draft)
    setParams(snap.params)
    setTunings(snap.tunings)
    setBefore(snap)
    setSaveError(undefined)
    setTuningId(undefined)
    setRemoving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在"换家"和"重新拉到"时重置
  }, [openId, revision])

  const dirty =
    draft !== undefined && params !== undefined && tunings !== undefined && before !== undefined
      ? JSON.stringify([draft, params, tunings]) !== JSON.stringify([before.draft, before.params, before.tunings])
      : false

  const paramErrs = params === undefined ? {} : paramErrorsOf(params)

  /**
   * 保存展开区的全部改动: 地址/变量名/温度 + 默认容量 + 每个模型的覆盖。
   *
   * **一次保存写三处, 但只写改过的**: `writeStepsOf` / `paramStepsOf` 各自只产出
   * 变化了的那几项; 模型那边由 `modelsWriteOf` 决定写 `models` 还是
   * `modelOverrides`（两者互斥, 由数据决定, 不由界面决定）。
   */
  const save = useCallback(async () => {
    if (!open || !draft || !params || !tunings || !before) return
    if (Object.keys(paramErrs).length > 0) {
      setSaveError('参数里有不合法的值，先改一下')
      return
    }
    const steps = [...writeStepsOf(open, draft, before.draft), ...paramStepsOf(open, params, before.params)]
    const modelPatch = modelsWriteOf(open, tunings, before.tunings)
    if (steps.length === 0 && Object.keys(modelPatch).length === 0) return

    setSaving(true)
    setSaveError(undefined)
    try {
      for (const step of steps) {
        if (step.kind === 'single') {
          await invoke('config.set', { key: step.key, value: step.value })
          continue
        }
        if (step.kind === 'unset') {
          await invoke('config.unset', { key: step.key })
          continue
        }
        await patchRoute(step, step.patch)
      }
      const target = routeTargetOf(open)
      if (Object.keys(modelPatch).length > 0 && target) await patchRoute(target, modelPatch)
      await load()
      // 编辑态由上面那个 effect 按新数据重置, 这里**不手动 setDraft** ——
      // 手动设的话用的是闭包里那份旧 `open`, 保存完界面会跳到旧值上
    } catch (err) {
      setSaveError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }, [before, draft, invoke, load, open, paramErrs, params, patchRoute, tunings])

  // ── 「＋ 添加模型」卡片 ───────────────────────────────────────────────────
  const [adding, setAdding] = useState(false)
  /** 下拉选的是哪一项: `custom` 或 `builtin:<id>` */
  const [pick, setPick] = useState('custom')
  const [form, setForm] = useState<CustomDraft>(EMPTY_DRAFT)
  const [formErr, setFormErr] = useState<DraftErrors>({})
  const [formError, setFormError] = useState<string>()
  const [formSaving, setFormSaving] = useState(false)
  const [formApiKey, setFormApiKey] = useState('')
  const [formProbe, setFormProbe] = useState<Probe>()
  const [discovering, setDiscovering] = useState(false)
  const [found, setFound] = useState<ModelInfo[]>()
  const [picked, setPicked] = useState<readonly string[]>([])
  const [discoverError, setDiscoverError] = useState<string>()
  const [modelInput, setModelInput] = useState('')

  const builtin = builtinOf(providers, pick)
  const offered = offeredProtocols(protocols)
  const chosen = offered.find((p) => p.id === form.protocol)
  /** 地址没填就没得测; 协议没有列表端点也测不了 */
  const canProbe = dictHost !== undefined && form.baseURL.trim() !== '' && chosen?.listable !== false

  const resetTransient = useCallback(() => {
    setFormProbe(undefined)
    setDiscoverError(undefined)
    setFound(undefined)
    setPicked([])
    setModelInput('')
  }, [])

  const openAdd = useCallback(() => {
    setPick('custom')
    setForm(EMPTY_DRAFT)
    setFormErr({})
    setFormError(undefined)
    setFormApiKey('')
    resetTransient()
    setAdding(true)
  }, [resetTransient])

  /**
   * 换了下拉项 = 换了一整套表单内容。
   *
   * 内置那家**不是空白表单**: 地址、协议、变量名都是目录里登记好的, 直接填进去
   * 让用户看见"我要写的是什么"。他改坏了也能改回来 —— 但空白表单会让"添加"
   * 变成一个需要自己填三格地址的动作, 而这三格我们明明知道。
   */
  const chooseVendor = useCallback(
    (value: string) => {
      setPick(value)
      setFormErr({})
      resetTransient()
      const b = builtinOf(providers, value)
      if (b === undefined) {
        setForm(EMPTY_DRAFT)
        return
      }
      const t = b.template ?? {}
      setForm({
        name: typeof t.displayName === 'string' && t.displayName !== '' ? t.displayName : b.name,
        protocol: typeof t.protocol === 'string' ? t.protocol : EMPTY_DRAFT.protocol,
        baseURL: typeof t.baseURL === 'string' ? t.baseURL : '',
        apiKeyEnv: typeof t.apiKeyEnv === 'string' ? t.apiKeyEnv : EMPTY_DRAFT.apiKeyEnv,
        models: [],
      })
    },
    [providers, resetTransient],
  )

  const persistFormApiKey = useCallback(async (ref: string): Promise<void> => {
    const value = formApiKey.trim()
    if (!value) return
    await invoke('credential.set', { ref, value })
  }, [formApiKey, invoke])

  const patchForm = useCallback((patch: Partial<CustomDraft>) => {
    setForm((cur) => ({ ...cur, ...patch }))
    // 改地址/协议/变量名 → 上一次的测试结果作废（它验的是改之前那一组值）
    if ('baseURL' in patch || 'protocol' in patch || 'apiKeyEnv' in patch) setFormProbe(undefined)
  }, [])

  const addModels = useCallback(() => {
    const next = addModelIds(form.models, modelInput)
    if (next.length === form.models.length) {
      setFormErr((cur) => ({ ...cur, models: '这几个已经在列表里了' }))
      return
    }
    setForm({ ...form, models: next })
    setModelInput('')
    setFormErr((cur) => ({ ...cur, models: undefined }))
  }, [form, modelInput])

  const removeModel = useCallback(
    (id: string) => setForm({ ...form, models: form.models.filter((m) => m !== id) }),
    [form],
  )

  const testDraft = useCallback(async () => {
    if (!dictHost) {
      setDiscoverError('后端没给出路由表的位置，没法测这家')
      return
    }
    setFormProbe({ state: 'running' })
    const started = Date.now()
    try {
      const credentialRef = credentialRefForDraft(builtin, form, providers)
      await persistFormApiKey(credentialRef)
      const list = await invoke<ModelInfo[]>(
        'llm.discoverModels',
        discoverPayloadOf(
          {
            kind: 'draft',
            scope: dictHost.scope,
            baseURL: form.baseURL,
            protocol: form.protocol,
            apiKeyEnv: credentialRef,
          },
          { source: 'endpoint' },
        ),
      )
      setFormProbe({ state: 'ok', count: list.length, ms: Date.now() - started })
    } catch (err) {
      setFormProbe({ state: 'fail', message: messageOf(err) })
    }
  }, [builtin, dictHost, form, invoke, persistFormApiKey, providers])

  /**
   * 「获取可用模型」—— 和「测试连接」问的是同一个地址, 但**默认那条路**
   * （目录认识就零网络直接答）。两个按钮并排是有意的: 一个快、可能过时,
   * 一个慢、答的是"现在真的有什么"。
   */
  const discover = useCallback(async () => {
    if (!dictHost) {
      setDiscoverError('后端没给出路由表的位置，没法问这家有哪些模型')
      return
    }
    setDiscovering(true)
    setDiscoverError(undefined)
    try {
      const credentialRef = credentialRefForDraft(builtin, form, providers)
      await persistFormApiKey(credentialRef)
      const list = await invoke<ModelInfo[]>(
        'llm.discoverModels',
        discoverPayloadOf({
          kind: 'draft',
          scope: dictHost.scope,
          baseURL: form.baseURL,
          protocol: form.protocol,
          apiKeyEnv: credentialRef,
        }),
      )
      setFound(list)
      setPicked(list.map((m) => m.id))
    } catch (err) {
      setFound(undefined)
      setPicked([])
      setDiscoverError(messageOf(err))
    } finally {
      setDiscovering(false)
    }
  }, [builtin, dictHost, form, invoke, persistFormApiKey, providers])

  /**
   * 勾上的写进模型列表 —— **替换，不是合并**。
   *
   * 顺序取**清单里的顺序**，不是点击顺序: 先勾 A 再勾 B 再取消 A 又勾回来，
   * 点击顺序会得到 `B, A`，而屏幕上明明 A 在上面。
   */
  const applyFound = useCallback(() => {
    const ids = (found ?? []).map((m) => m.id).filter((id) => picked.includes(id))
    setForm((cur) => ({ ...cur, models: ids }))
    setFound(undefined)
    setPicked([])
    setDiscoverError(undefined)
  }, [found, picked])

  const submitAdd = useCallback(async () => {
    const errs = draftErrors(form)
    setFormErr(errs)
    if (Object.keys(errs).length > 0) return
    if (!dictHost) {
      setFormError('后端没给出路由表的位置，没法写入')
      return
    }
    /*
     * 路由 id。
     *
     * 内置那家**必须用目录里的 id**（`groq`），不能拿名字 slug 一个 ——
     * 后端是按路由 id 去认目录的（`modelsOf` / `catalogProvider`）: id 变成
     * `groq-2` 之后它就认不出这是 Groq, 模型清单掉到兜底那一条, 而界面上
     * 看起来"添加成功了"。
     * 自定义那家才需要 slug + 去重: 名字是用户自己起的, 撞名会静默覆盖已有的一家。
     */
    const taken = providers.map((p) => p.id)
    const id = builtin !== undefined ? builtin.id : routeIdOf(form.name, taken)
    const credentialRef = credentialRefForDraft(builtin, form, providers)
    const profile =
      builtin === undefined
        ? { ...profileOfDraft(form, id), apiKeyEnv: credentialRef }
        : profileFromTemplate(builtin.template ?? {}, {
            displayName: form.name,
            baseURL: form.baseURL,
            apiKeyEnv: credentialRef,
          })

    setFormSaving(true)
    setFormError(undefined)
    try {
      await persistFormApiKey(credentialRef)
      await putRoute({ key: dictHost.key, id }, profile)
      /*
       * **内置那家不拉、也不写 `models`**（B-26）。
       *
       * `models` 非空 = **整体替换内置目录**。把目录抄进配置等于把快照冻住:
       * 目录更新了它也不会变, 而用户在 settings.json 里多了一份自己不知道的旧清单。
       * 内置那家的模型由目录供, 后端本来就会合进来 —— 用户看到的照样是 12 款。
       *
       * 自建网关（自定义 API）**要拉**: 它不在目录里, 不写 `models` 就只剩一条兜底。
       * 后端在配置变化时也会拉一次, 这里先拉是为了"加完立刻看得见" ——
       * 两次写的是同一份数据。
       */
      if (builtin === undefined) {
        try {
          await pullInto({ scope: dictHost.scope, key: dictHost.key, id })
        } catch {
          // 软失败: 路由已经写进去了, 清单空着不影响添加成功
        }
      }
      setAdding(false)
      setFormApiKey('')
      setOpenId(id)
      await load()
      // 加完立刻测一次 —— 状态点马上是绿/红, 而不是让人自己去点一下才知道
      setTesting(id)
      await runProbe({ kind: 'route', scope: dictHost.scope, provider: id }, id)
      setTesting(undefined)
    } catch (err) {
      setFormError(messageOf(err))
    } finally {
      setFormSaving(false)
    }
  }, [builtin, dictHost, form, load, persistFormApiKey, providers, pullInto, putRoute, runProbe])

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  return (
    <div data-model-list="">
      {error !== undefined ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.ghost} onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {!loaded ? <div className={styles.loading}>正在读供应商目录…</div> : null}

      <div className={styles.top}>
        <div className={styles.topText}>
          <span className={styles.topCount}>已接入 {rows.length} 家</span>
          <span className={styles.topHint}>
            {rows.length === 0
              ? '还没有接入任何供应商。点右上角「添加模型」从内置目录挑一家，或者填自己的地址。'
              : '点一行展开参数；状态是上一次测试的结果（超过半小时算未连接）'}
          </span>
        </div>
        <div className={styles.topActions}>
          <button
            type="button"
            className={styles.ghost}
            data-test-all=""
            onClick={() => void testAll()}
            disabled={rows.length === 0 || testing !== undefined}
          >
            {testing === '*' ? '正在测…' : '全部测试'}
          </button>
          <button type="button" className={styles.primary} data-add-model="" onClick={openAdd}>
            ＋ 添加模型
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        loaded && error === undefined ? (
          <div className={styles.empty} data-empty="">
            <p className={styles.emptyTitle}>还没有模型供应商</p>
            <p className={styles.emptyHint}>
              内置目录里有 35 家（DeepSeek / Moonshot / Groq / OpenRouter …），点「＋ 添加模型」选一家即可；
              中转站和公司内网网关选「自定义 API」。
            </p>
          </div>
        ) : null
      ) : (
        <ul className={styles.list}>
          {rows.map((p) => {
            const rec = freshProbeOf(probes[p.id], openedAt)
            return (
              <ProviderRow
                key={p.id}
                provider={p}
                enabled={providerIsEnabled(p.id, prefs.disabledProviders)}
                manualModels={prefs.manualModels[p.id]}
                link={linkStateOf(rec)}
                record={rec}
                testing={testing === p.id || testing === '*'}
                open={openId === p.id}
                edit={
                  openId === p.id && draft !== undefined && params !== undefined && tunings !== undefined
                    ? { draft, params, tunings, before, tuningId, paramErrs }
                    : undefined
                }
                saving={saving}
                pulling={pulling}
                saveError={openId === p.id ? saveError : undefined}
                onToggle={() => setOpenId((cur) => (cur === p.id ? undefined : p.id))}
                onToggleEnabled={() =>
                  setPrefs({ disabledProviders: toggleProviderEnabled(prefs.disabledProviders, p.id) })
                }
                onAddManualModel={(input) =>
                  setPrefs({ manualModels: addManualProviderModels(p, prefs.manualModels, input) })
                }
                onRemoveManualModel={(id) =>
                  setPrefs({ manualModels: removeManualProviderModel(p, prefs.manualModels, id) })
                }
                onResetManualModels={() =>
                  setPrefs({ manualModels: resetProviderModels(prefs.manualModels, p.id) })
                }
                onTest={() => void testOne(p)}
                onDraft={setDraft}
                onParams={setParams}
                onTuning={(id, next) => setTunings((cur) => ({ ...(cur ?? {}), [id]: next }))}
                onOpenTuning={setTuningId}
                onSave={() => void save()}
                onReset={() => {
                  if (before === undefined) return
                  setDraft(before.draft)
                  setParams(before.params)
                  setTunings(before.tunings)
                }}
                onPull={() => void repull(p)}
                onSaveKey={async (ref, value) => {
                  await invoke('credential.set', { ref, value })
                  await load()
                }}
                dirty={dirty}
                canRemove={routeProfileOf(p) !== undefined}
                removing={removing}
                onAskRemove={() => setRemoving(true)}
                onCancelRemove={() => setRemoving(false)}
                onRemove={() => void remove(p)}
              />
            )
          })}
        </ul>
      )}

      {adding ? (
        <AddCard
          options={options}
          pick={pick}
          builtin={builtin}
          form={form}
          formErr={formErr}
          formError={formError}
          apiKey={formApiKey}
          onApiKey={setFormApiKey}
          saving={formSaving}
          offered={offered}
          chosen={chosen}
          probe={formProbe}
          canProbe={canProbe}
          probing={formProbe?.state === 'running'}
          discovering={discovering}
          found={found}
          picked={picked}
          discoverError={discoverError}
          modelInput={modelInput}
          onPick={chooseVendor}
          onForm={patchForm}
          onModelInput={setModelInput}
          onAddModels={addModels}
          onRemoveModel={removeModel}
          onTest={() => void testDraft()}
          onDiscover={() => void discover()}
          onTogglePicked={(id) =>
            setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
          }
          onApply={applyFound}
          onCancelDiscover={() => {
            setFound(undefined)
            setPicked([])
            setDiscoverError(undefined)
          }}
          onSubmit={() => void submitAdd()}
          onClose={() => setAdding(false)}
        />
      ) : null}

      <div className={styles.noteWrap}>
        <Note>
          这一页只列已经接入的供应商。添加时可以从内置目录挑一家（地址和协议已预填好），
          也可以填自己的地址。绿色是上次测试连上了，红色是没连上，白色是还没测或太久没测。
          API Key 直接保存在本机，测试连接和保存路由时都会自动写入。
        </Note>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

/** 配置项的值是"一张字典"吗。路由表那一项是对象, 别的一律不是 */
function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function credentialRefForDraft(
  builtin: CatalogProvider | undefined,
  form: CustomDraft,
  providers: readonly CatalogProvider[],
): string {
  if (builtin !== undefined) {
    const fromTemplate = typeof builtin.template?.apiKeyEnv === 'string' ? builtin.template.apiKeyEnv : ''
    return fromTemplate || form.apiKeyEnv || `MENG_KEY_${builtin.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  }
  const id = routeIdOf(form.name, providers.map((item) => item.id))
  return `MENG_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/**
 * 枚举值的说法。**只影响显示** —— 写回配置的永远是那个英文 id。
 * 不认识的照样显示原值（后端加一个新档位不该让界面显示空白）。
 */
const ENUM_TEXT: Record<string, string> = {
  off: '关闭',
  high: '高',
  max: '最高',
  enabled: '开启',
  disabled: '关闭',
}

function enumText(v: string): string {
  return ENUM_TEXT[v] ?? v
}

/**
 * 一行 = 一家已接入的供应商。
 *
 * 折叠时只有三样东西: 状态点、名字、一句摘要。**没有输入框** —— 一屏五家的
 * 输入框会让人以为每一格都要填。展开之后才是"这一家的全部"。
 */
function ProviderRow({
  provider: p,
  enabled,
  manualModels,
  link,
  record,
  testing,
  open,
  edit,
  dirty,
  saving,
  pulling,
  saveError,
  onToggle,
  onToggleEnabled,
  onAddManualModel,
  onRemoveManualModel,
  onResetManualModels,
  onTest,
  onDraft,
  onParams,
  onTuning,
  onOpenTuning,
  onSave,
  onReset,
  onPull,
  onSaveKey,
  canRemove,
  removing,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  provider: CatalogProvider
  enabled: boolean
  /** 有值 = 这家用过前端手动清单，空数组也算手动过 */
  manualModels?: readonly string[]
  link: LinkState
  record?: ProbeRecord
  testing: boolean
  open: boolean
  edit?: {
    draft: RouteDraft
    params: RouteParams
    tunings: Record<string, ModelTuning>
    before?: Snapshot
    tuningId?: string
    paramErrs: Record<string, string>
  }
  dirty: boolean
  saving: boolean
  pulling: boolean
  saveError?: string
  onToggle: () => void
  onToggleEnabled: () => void
  onAddManualModel: (input: string) => void
  onRemoveManualModel: (id: string) => void
  onResetManualModels: () => void
  onTest: () => void
  onDraft: (next: RouteDraft) => void
  onParams: (next: RouteParams) => void
  onTuning: (id: string, next: ModelTuning) => void
  onOpenTuning: (id?: string) => void
  onSave: () => void
  onReset: () => void
  onPull: () => void
  onSaveKey: (ref: string, value: string) => Promise<void>
  /** 能不能移除。只有住在路由字典里的那家能（扁平那家是插件声明的配置项, 删不掉） */
  canRemove: boolean
  removing: boolean
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMessage, setKeyMessage] = useState<string>()
  const [manualInput, setManualInput] = useState('')

  async function saveApiKey() {
    const value = apiKey.trim()
    if (!edit || !value) return
    setKeyBusy(true)
    setKeyMessage(undefined)
    try {
      await onSaveKey(edit.draft.env, value)
      setApiKey('')
      setKeyMessage('API Key 已保存到本机，下一次请求立即生效。')
    } catch (error) {
      setKeyMessage(messageOf(error))
    } finally {
      setKeyBusy(false)
    }
  }

  /**
   * **可添加的那几家现在不带模型清单**（B-26 目录瘦身）。`?? []` 是必须的:
   * 少了它这里会 `TypeError: models is not iterable`, 整个设置页掉进兜底界面。
   *
   * 空数组不是"没有模型", 只是"还没拉"。真要看就展开时调一次
   * `llm.discoverModels({ scope, provider })` —— 目录命中 0ms、不联网。
   */
  const models = modelsForProvider(p, manualModels === undefined ? {} : { [p.id]: manualModels })
  const widest = formatTokens(widestOf(models))
  /**
   * 能不能逐模型调参数。
   *
   * 只有**住在路由字典里**的那家能: 它的 profile 有 `models` / `modelOverrides`
   * 两个字段。扁平那家（deepseek）的模型清单是一串**字符串**（`llm.deepseek.models`）,
   * 一个模型一个 id, 没有地方放容量。给它画一排参数框等于画了一排"改了不生效"。
   */
  const tunable = routeProfileOf(p) !== undefined

  return (
    <li
      className={styles.row}
      data-provider={p.id}
      data-link={link}
      data-provider-enabled={enabled ? '' : 'false'}
      data-open={open ? '' : undefined}
    >
      <div className={styles.rowHead}>
        {/*
          整行可点 = 展开。测试连接是**行内另一个按钮**, 不是行的一部分 ——
          点偏了就变成"我明明点的是测试, 却展开了"。
        */}
        <button
          type="button"
          className={styles.rowMain}
          data-row-toggle={p.id}
          aria-expanded={open}
          onClick={onToggle}
        >
          <StatusDot link={link} />
          <span className={styles.rowName}>{p.name}</span>
          <span className={styles.rowMeta}>
            {p.protocol !== undefined ? <code className={styles.rowProto}>{p.protocol}</code> : null}
            <span className={styles.rowCount}>{models.length > 0 ? `${models.length} 款` : '没有模型'}</span>
            {widest !== undefined ? <span className={styles.rowCount}>最长 {widest}</span> : null}
          </span>
          <span className={styles.rowLink} data-link-label={enabled ? link : 'disabled'}>
            {!enabled ? '已停用' : testing ? '正在测…' : LINK_LABEL[link]}
          </span>
          <span className={styles.chev} aria-hidden="true" data-open={open ? '' : undefined} />
        </button>
        <button
          type="button"
          className={styles.activation}
          data-provider-activate={p.id}
          aria-pressed={enabled}
          onClick={onToggleEnabled}
          title={enabled ? '停用后不会出现在模型选择器里' : '启用后才会出现在模型选择器里'}
        >
          {enabled ? '已启用' : '已停用'}
        </button>
        <button
          type="button"
          className={styles.rowTest}
          data-row-test={p.id}
          onClick={onTest}
          disabled={testing || !enabled}
          title={enabled ? '真的出一次网（读它的模型列表）—— 地址、协议、密钥一起验' : '先启用这家供应商'}
        >
          {testing ? '…' : '测试连接'}
        </button>
      </div>

      {/*
        失败时把后端的原话放在折叠状态下也看得见的地方。
        展开才看得见等于"红了但不知道为什么", 而红的原因只有后端知道
        （401 / 连不上 / 地址 404 —— 三种要做的动作完全不同）。
      */}
      {link === 'fail' && record?.message !== undefined && !open ? (
        <p className={styles.rowFail} data-row-message={p.id}>
          {record.message}
        </p>
      ) : null}

      {open && edit !== undefined ? (
        <div className={styles.body} data-row-body={p.id}>
          {/*
            展开时也把失败原话放进来。**两处都要有**: 折叠时它在行下面,
            展开时行下面那块被 body 的边框隔开了, 只看 body 会以为"红了但没有原因"。
          */}
          {link === 'fail' && record?.message !== undefined ? (
            <p className={styles.bodyFail} role="alert">
              {record.message}
            </p>
          ) : null}
          <div className={styles.fields}>
            <Field label="接口地址">
              <input
                className={styles.input}
                value={edit.draft.baseURL}
                onChange={(e) => onDraft({ ...edit.draft, baseURL: e.target.value })}
                spellCheck={false}
                placeholder="https://api.example.com/v1"
                data-param="baseURL"
              />
            </Field>
            <Field label="API Key" hint={`只保存在本机；内部引用名 ${edit.draft.env}`}>
              <div className={styles.addRow}>
                <input
                  className={styles.input}
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setKeyMessage(undefined)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && apiKey.trim() && !keyBusy) void saveApiKey()
                  }}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="已保存，重新填写可替换"
                  data-param="apiKey"
                />
                <button
                  type="button"
                  className={styles.mini}
                  disabled={!apiKey.trim() || keyBusy}
                  onClick={() => void saveApiKey()}
                >
                  {keyBusy ? '保存中…' : '保存 Key'}
                </button>
              </div>
              {keyMessage ? <span className={styles.fieldHint}>{keyMessage}</span> : null}
            </Field>
          </div>

          {/* ── 路由参数（哪些行出现由后端声明决定） ── */}
          {edit.params.rows.length > 0 ? (
            <div className={styles.block}>
              <div className={styles.blockHead}>
                <span className={styles.blockTitle}>参数</span>
                <span className={styles.blockHint}>留空 = 用后端默认</span>
              </div>
              <div className={styles.grid}>
                {edit.params.rows
                  .filter((row) => row.kind !== 'modes')
                  .map((row) => (
                    <Field key={row.name} label={row.label} error={edit.paramErrs[row.name]} hint={row.hint}>
                      {row.kind === 'enum' ? (
                        <select
                          className={styles.select}
                          value={row.value}
                          onChange={(e) =>
                            onParams({
                              rows: edit.params.rows.map((r) =>
                                r.name === row.name ? { ...r, value: e.target.value } : r,
                              ),
                            })
                          }
                          data-param={row.name}
                        >
                          <option value="">不设</option>
                          {(row.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {enumText(o)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={styles.input}
                          value={row.value}
                          onChange={(e) =>
                            onParams({
                              rows: edit.params.rows.map((r) =>
                                r.name === row.name ? { ...r, value: e.target.value } : r,
                              ),
                            })
                          }
                          inputMode={row.kind === 'number' ? 'decimal' : undefined}
                          placeholder="不设"
                          spellCheck={false}
                          data-param={row.name}
                        />
                      )}
                    </Field>
                  ))}
              </div>
              {edit.params.rows
                .filter((row) => row.kind === 'modes')
                .map((row) => (
                  <div key={row.name} className={styles.modes} data-param={row.name}>
                    <span className={styles.fieldLabel}>{row.label}</span>
                    <div className={styles.toggles}>
                      {(['text', 'image'] as const).map((m) => {
                        const on = (row.modes ?? []).includes(m)
                        return (
                          <button
                            key={m}
                            type="button"
                            className={styles.toggle}
                            aria-pressed={on}
                            data-mode={m}
                            onClick={() =>
                              onParams({
                                rows: edit.params.rows.map((r) =>
                                  r.name === row.name
                                    ? {
                                        ...r,
                                        modes: on
                                          ? (r.modes ?? []).filter((x) => x !== m)
                                          : [...(r.modes ?? []), m],
                                      }
                                    : r,
                                ),
                              })
                            }
                          >
                            {m === 'text' ? '文本' : '图像'}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
            </div>
          ) : null}

          {/* ── 模型清单 + 每个模型的参数 ── */}
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <span className={styles.blockTitle}>模型</span>
              <span className={styles.blockCount}>
                {models.length > 0
                  ? `${models.length} 款`
                  : p.modelCount
                    ? `${p.modelCount} 款（未拉取）`
                    : '目录里还没有'}
              </span>
              <button
                type="button"
                className={styles.mini}
                data-repull=""
                onClick={onPull}
                disabled={pulling || !enabled}
                title={enabled ? '按现在的地址和密钥再问一次端点，把清单写回这条路由' : '先启用这家供应商'}
              >
                {pulling ? '拉取中…' : '重新拉取'}
              </button>
            </div>

            {models.length === 0 ? (
              <p className={styles.blockHint}>
                {p.modelCount
                  ? `目录里收录了 ${p.modelCount} 款，点「重新拉取」看清单。`
                  : '端点没回模型。可以先点上面的「测试连接」看看通不通。'}
              </p>
            ) : (
              <ul className={styles.models}>
                {models.map((m) => (
                  <ModelLine
                    key={m.id}
                    model={m}
                    tuning={edit.tunings[m.id]}
                    tunable={tunable}
                    open={edit.tuningId === m.id}
                    onOpen={() => onOpenTuning(edit.tuningId === m.id ? undefined : m.id)}
                    onChange={(next) => onTuning(m.id, next)}
                    onRemove={enabled ? () => onRemoveManualModel(m.id) : undefined}
                  />
                ))}
              </ul>
            )}
            {enabled ? (
              <div className={styles.manualModels} data-manual-models={p.id}>
                <input
                  className={styles.input}
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (manualInput.trim() === '') return
                    onAddManualModel(manualInput)
                    setManualInput('')
                  }}
                  placeholder="手动添加模型 ID，例如 glm-4.6"
                  spellCheck={false}
                  data-manual-model-input={p.id}
                />
                <button
                  type="button"
                  className={styles.mini}
                  data-manual-model-add={p.id}
                  disabled={manualInput.trim() === ''}
                  onClick={() => {
                    onAddManualModel(manualInput)
                    setManualInput('')
                  }}
                >
                  ＋ 添加
                </button>
                {manualModels !== undefined ? (
                  <button
                    type="button"
                    className={styles.ghost}
                    data-manual-model-reset={p.id}
                    onClick={onResetManualModels}
                    title="恢复成后端目录 / 端点返回的清单"
                  >
                    恢复自动清单
                  </button>
                ) : null}
              </div>
            ) : (
              <p className={styles.blockHint} data-manual-model-disabled={p.id}>
                已停用。启用后可以在这里添加或移除模型。
              </p>
            )}
            {!tunable ? (
              <p className={styles.blockHint} data-no-tuning="">
                这一家的配置形状里没有逐模型参数（模型是一串名字），只能调上面的路由级参数。
              </p>
            ) : null}
          </div>

          {saveError !== undefined ? (
            <p className={styles.formError} role="alert">
              {saveError}
            </p>
          ) : null}

          {dirty ? (
            <div className={styles.actions}>
              <button type="button" className={styles.ghost} onClick={onReset} disabled={saving}>
                撤销
              </button>
              <button type="button" className={styles.primary} data-save="" onClick={onSave} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          ) : null}

          {/*
            移除放在**最底下、最左边**, 而且要点两下。
            理由: 它是一个不可撤销的动作（后端没有"删一条路由"的子路径, 删了就是
            整表写回时少一个键, 恢复只能重新添加一遍）。放在「保存」旁边会让它
            看起来是同一类操作 —— 而它们的后果差一个数量级。
          */}
          {canRemove ? (
            <div className={styles.removeRow} data-remove-row="">
              {removing ? (
                <>
                  <span className={styles.removeWarn}>移除后这家就没了，模型和参数一起丢。要重新添加才能回来。</span>
                  <button type="button" className={styles.ghost} onClick={onCancelRemove} disabled={saving}>
                    取消
                  </button>
                  <button type="button" className={styles.danger} data-remove-confirm="" onClick={onRemove} disabled={saving}>
                    {saving ? '移除中…' : '确认移除'}
                  </button>
                </>
              ) : (
                <button type="button" className={styles.removeBtn} data-remove-ask="" onClick={onAskRemove}>
                  移除这一家
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * 一款模型 + 它的参数。
 *
 * 参数面板默认收起: 一家 12 款模型全摊开就是 48 个输入框, 而用户通常只想改其中
 * 一款。收起时显示的是**当前生效值**（目录给的或上次改的）, 不是空白。
 */
function ModelLine({
  model: m,
  tuning,
  tunable,
  open,
  onOpen,
  onChange,
  onRemove,
}: {
  model: ModelInfo
  tuning?: ModelTuning
  tunable: boolean
  open: boolean
  onOpen: () => void
  onChange: (next: ModelTuning) => void
  onRemove?: () => void
}) {
  const ctx = formatTokens(m.contextWindow)
  const out = formatTokens(m.maxTokens)
  const t = tuning ?? {}

  const head = (
    <>
      <code className={styles.modelName}>{m.name || m.id}</code>
      <span className={styles.modelMeta}>
        {ctx !== undefined ? <span title="上下文窗口">{ctx}</span> : null}
        {out !== undefined ? <span title="单轮最大输出">{out} 输出</span> : null}
        {m.input?.includes('image') ? <span className={styles.flag}>视觉</span> : null}
        {m.reasoning ? (
          <span
            className={styles.flag}
            title={m.reasoningEfforts?.length
              ? `档位：${m.reasoningEfforts.join(' / ')}${m.defaultReasoningEffort ? ` · 默认 ${m.defaultReasoningEffort}` : ''}`
              : '支持推理'}
          >推理</span>
        ) : null}
      </span>
      {tunable ? <span className={styles.modelEdit}>{open ? '收起' : '参数'}</span> : null}
    </>
  )

  return (
    <li className={styles.model} data-model-row={m.id}>
      <div className={styles.modelTop}>
        {tunable ? (
          <button
            type="button"
            className={styles.modelHead}
            data-model-open={m.id}
            aria-expanded={open}
            onClick={onOpen}
          >
            {head}
          </button>
        ) : (
          <div className={styles.modelHead}>{head}</div>
        )}
        {onRemove ? (
          <button
            type="button"
            className={styles.modelRemove}
            data-model-remove={m.id}
            aria-label={`移除模型 ${m.id}`}
            title="从这家的前端模型清单移除"
            onClick={onRemove}
          >
            ×
          </button>
        ) : null}
      </div>

      {open ? (
        <div className={styles.modelBody} data-tuning={m.id}>
          <div className={styles.grid}>
            <Field label="上下文窗口" hint="token。留空 = 不覆盖">
              <input
                className={styles.input}
                value={t.contextWindow ?? ''}
                onChange={(e) => onChange({ ...t, contextWindow: e.target.value })}
                inputMode="numeric"
                placeholder={m.contextWindow === undefined ? '不知道' : String(m.contextWindow)}
                data-tuning-field="contextWindow"
              />
            </Field>
            <Field label="最大输出" hint="token。留空 = 不覆盖">
              <input
                className={styles.input}
                value={t.maxTokens ?? ''}
                onChange={(e) => onChange({ ...t, maxTokens: e.target.value })}
                inputMode="numeric"
                placeholder={m.maxTokens === undefined ? '不知道' : String(m.maxTokens)}
                data-tuning-field="maxTokens"
              />
            </Field>
          </div>

          <div className={styles.modes}>
            <span className={styles.fieldLabel}>推理档</span>
            {/*
              三态。**不能做成开关**: "未知"是真实的一态（目录里没登记），
              开关只有两态, 逼着用户对不知道的事表态, 而 falsy 会被当成
              "确定不支持"写进配置。
            */}
            <select
              className={styles.select}
              value={t.reasoning === undefined ? 'unknown' : t.reasoning ? 'yes' : 'no'}
              onChange={(e) =>
                onChange({
                  ...t,
                  reasoning: e.target.value === 'unknown' ? undefined : e.target.value === 'yes',
                })
              }
              data-tuning-field="reasoning"
            >
              <option value="unknown">未知</option>
              <option value="yes">支持</option>
              <option value="no">不支持</option>
            </select>
          </div>

          <div className={styles.modes}>
            <span className={styles.fieldLabel}>输入模态</span>
            <div className={styles.toggles}>
              {(['text', 'image'] as const).map((mod) => {
                const on = (t.input ?? []).includes(mod)
                return (
                  <button
                    key={mod}
                    type="button"
                    className={styles.toggle}
                    aria-pressed={on}
                    data-tuning-mode={mod}
                    onClick={() =>
                      onChange({
                        ...t,
                        input: on ? (t.input ?? []).filter((x) => x !== mod) : [...(t.input ?? []), mod],
                      })
                    }
                  >
                    {mod === 'text' ? '文本' : '图像'}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 「＋ 添加模型」卡片。
 *
 * 一个下拉、两套内容:
 *   · 自定义 API → 协议从两项里选, 地址/变量名/模型全自己填
 *   · 内置供应商 → 协议和地址来自目录（**协议不给选** —— 那家登记的就是那种
 *     wire, 换一种就发不出去）, 模型由「添加」之后的自动拉取填
 *
 * 卡片是**遮罩上的浮层**而不是页内展开: 添加是一次"决定", 不是浏览。
 * 用页内展开的话, 用户滚到一半会分不清自己在填哪一家的东西。
 */
function AddCard({
  options,
  pick,
  builtin,
  form,
  formErr,
  formError,
  apiKey,
  onApiKey,
  saving,
  offered,
  chosen,
  probe,
  canProbe,
  probing,
  discovering,
  found,
  picked,
  discoverError,
  modelInput,
  onPick,
  onForm,
  onModelInput,
  onAddModels,
  onRemoveModel,
  onTest,
  onDiscover,
  onTogglePicked,
  onApply,
  onCancelDiscover,
  onSubmit,
  onClose,
}: {
  options: ReturnType<typeof addOptionsOf>
  pick: string
  builtin?: CatalogProvider
  form: CustomDraft
  formErr: DraftErrors
  formError?: string
  apiKey: string
  onApiKey: (value: string) => void
  saving: boolean
  offered: ProtocolInfo[]
  chosen?: ProtocolInfo
  probe?: Probe
  canProbe: boolean
  probing: boolean
  discovering: boolean
  found?: ModelInfo[]
  picked: readonly string[]
  discoverError?: string
  modelInput: string
  onPick: (value: string) => void
  onForm: (patch: Partial<CustomDraft>) => void
  onModelInput: (v: string) => void
  onAddModels: () => void
  onRemoveModel: (id: string) => void
  onTest: () => void
  onDiscover: () => void
  onTogglePicked: (id: string) => void
  onApply: () => void
  onCancelDiscover: () => void
  onSubmit: () => void
  onClose: () => void
}) {
  const custom = builtin === undefined

  return (
    <div
      className={styles.scrim}
      data-add-card=""
      onMouseDown={(e) => {
        // 只有点**遮罩本身**才关。点在卡片里冒泡上来的 mousedown 不能关 ——
        // 否则拖选一段文字松手就没了
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="添加模型">
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>添加模型</h3>
          <button type="button" className={styles.cardClose} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className={styles.cardBody}>
          <Field label="供应商" hint={custom ? '填自己的地址：中转站、局域网网关、公司内网' : '来自内置目录，地址和协议已预填'}>
            <select className={styles.select} value={pick} onChange={(e) => onPick(e.target.value)} data-add-pick="">
              <optgroup label="自定义">
                {options
                  .filter((o) => o.group === 'custom')
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={`内置供应商（${options.filter((o) => o.group === 'builtin').length} 家）`}>
                {options
                  .filter((o) => o.group === 'builtin')
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </optgroup>
            </select>
          </Field>

          <Field label="名称" error={formErr.name} hint="界面上显示的名字；配置键由它生成">
            <input
              className={styles.input}
              value={form.name}
              onChange={(e) => onForm({ name: e.target.value })}
              placeholder="我的中转站"
              data-add-field="name"
            />
          </Field>

          {/*
            协议: 自定义那家**必须能选**（两种 wire 的地址不通用）; 内置那家
            **不给选** —— 目录登记的就是那种协议, 换成另一种等于拿 OpenAI 的
            格式去发 Anthropic 的端点。
          */}
          {custom ? (
            <Field label="协议" error={formErr.protocol} hint="大部分中转站选第一项；Claude 官方那套用第二项">
              <select
                className={styles.select}
                value={form.protocol}
                onChange={(e) => onForm({ protocol: e.target.value })}
                data-add-field="protocol"
              >
                {offered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className={styles.readonly}>
              <span className={styles.fieldLabel}>协议</span>
              <code className={styles.readonlyValue} data-add-protocol="">
                {form.protocol}
              </code>
              <span className={styles.hint}>内置目录登记的 wire 协议，不可改</span>
            </div>
          )}

          <Field label="接口地址" error={formErr.baseURL} hint="填到 /v1 为止">
            <input
              className={styles.input}
              value={form.baseURL}
              onChange={(e) => onForm({ baseURL: e.target.value })}
              placeholder="https://api.example.com/v1"
              inputMode="url"
              spellCheck={false}
              data-add-field="baseURL"
            />
          </Field>

          <Field label="API Key" error={formErr.apiKeyEnv} hint="保存在本机，页面不会回显；测试连接和添加时会自动保存">
            <input
              className={styles.input}
              type="password"
              value={apiKey}
              onChange={(e) => onApiKey(e.target.value)}
              placeholder="粘贴 API Key"
              spellCheck={false}
              autoComplete="new-password"
              data-add-field="apiKey"
            />
          </Field>

          {/*
            模型那一格: 自定义那家是**逐条列表**（用户第 4 条）; 内置那家不给编辑 ——
            添加之后自动从端点拉一次, 清单是真的。
          */}
          {custom ? (
            <div className={styles.field} data-model-editor="">
              <span className={styles.fieldLabel}>模型</span>
              {form.models.length > 0 ? (
                <ul className={styles.modelEdit}>
                  {form.models.map((id) => (
                    <li key={id} className={styles.modelEditRow} data-model-id={id}>
                      <code className={styles.modelEditId}>{id}</code>
                      <button
                        type="button"
                        className={styles.modelEditDel}
                        onClick={() => onRemoveModel(id)}
                        aria-label={`删掉 ${id}`}
                        title={`删掉 ${id}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.hint}>还没加模型。可以手填，也可以点下面的「获取可用模型」。</p>
              )}
              <div className={styles.addRow}>
                <input
                  className={styles.input}
                  value={modelInput}
                  onChange={(e) => onModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      onAddModels()
                    }
                  }}
                  placeholder="模型 id，例如 gpt-4o（可一次粘一串）"
                  spellCheck={false}
                  data-model-input=""
                />
                <button
                  type="button"
                  className={styles.mini}
                  onClick={onAddModels}
                  disabled={modelInput.trim() === ''}
                  data-model-add=""
                >
                  ＋ 添加
                </button>
              </div>
              {formErr.models !== undefined ? (
                <span className={styles.fieldError} role="alert">
                  {formErr.models}
                </span>
              ) : (
                <span className={styles.hint}>
                  {form.models.length > 0 ? `会写进 ${form.models.length} 条模型` : '留空就用它默认那一条'}
                </span>
              )}
            </div>
          ) : (
            <div className={styles.readonly}>
              <span className={styles.fieldLabel}>模型</span>
              <span className={styles.hint}>
                {/*
                  内置那家的模型**由目录供**, 不写进配置（B-26）。
                  写成"添加后自动拉一次"会让人以为 settings.json 里多了一份清单 ——
                  而那份清单一旦写下, 就再也不会跟着目录更新了。
                */}
                由内置目录提供（{builtin?.models?.length ?? builtin?.modelCount ?? 0} 款），不用自己填
              </span>
            </div>
          )}

          <div className={styles.discover}>
            <div className={styles.discoverRow}>
              <button
                type="button"
                className={styles.mini}
                onClick={onTest}
                disabled={probing || !canProbe}
                title={canProbe ? '真的出一次网, 验地址 + 协议 + 密钥' : '先填接口地址'}
                data-add-test=""
              >
                {probing ? '正在连…' : '测试连接'}
              </button>
              {custom ? (
                <button
                  type="button"
                  className={styles.mini}
                  onClick={onDiscover}
                  disabled={discovering || form.baseURL.trim() === '' || chosen?.listable === false}
                  data-add-discover=""
                >
                  {discovering ? '正在问…' : '获取可用模型'}
                </button>
              ) : null}
              <ProbeNote probe={probe} />
            </div>

            {discoverError !== undefined ? (
              <p className={styles.formError} role="alert">
                {discoverError}
              </p>
            ) : null}

            {found !== undefined ? (
              found.length === 0 ? (
                <p className={styles.hint} data-discovered-empty="">
                  这个地址没回任何模型 —— 可能要先填对地址，也可能它就不提供清单。
                </p>
              ) : (
                <div className={styles.discoverList} data-discovered="">
                  <div className={styles.discoverItems}>
                    {found.map((m) => (
                      <label key={m.id} className={styles.discoverItem} data-model-option={m.id}>
                        <input
                          type="checkbox"
                          checked={picked.includes(m.id)}
                          onChange={() => onTogglePicked(m.id)}
                        />
                        <code className={styles.discoverId}>{m.id}</code>
                        <span className={styles.discoverCap}>
                          {formatTokens(m.contextWindow) ?? ''}
                          {formatTokens(m.maxTokens) !== undefined
                            ? ` · ${formatTokens(m.maxTokens)} 输出`
                            : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className={styles.discoverFoot}>
                    <span className={styles.hint}>
                      勾上的会替换上面的列表（现在是 {form.models.length} 条）
                    </span>
                    <button type="button" className={styles.ghost} onClick={onCancelDiscover}>
                      取消
                    </button>
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={onApply}
                      disabled={picked.length === 0}
                    >
                      写入 {picked.length} 款
                    </button>
                  </div>
                </div>
              )
            ) : null}
          </div>

          {formError !== undefined ? (
            <p className={styles.formError} role="alert">
              {formError}
            </p>
          ) : null}
        </div>

        <div className={styles.cardFoot}>
          <button type="button" className={styles.ghost} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className={styles.primary} data-add-submit="" onClick={onSubmit} disabled={saving}>
            {saving ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 状态点。三种态各有各的形状, 不只靠颜色 —— 色盲用户看到的是实心/实心/空心。
 * 绿 = 实心 + 一圈淡光, 红 = 实心, 白 = **空心环**（"什么都没发生"）。
 */
function StatusDot({ link }: { link: LinkState }) {
  return <span className={styles.dot} data-link-dot={link} aria-hidden="true" />
}

/** 一次连接测试的结果, 一行话 */
function ProbeNote({ probe }: { probe?: Probe }) {
  if (probe === undefined) return <span className={styles.hint}>还没测过</span>
  if (probe.state === 'running') return <span className={styles.hint}>正在连…</span>
  if (probe.state === 'ok') {
    return (
      <span className={styles.probeOk} data-probe="ok">
        连上了 · {probe.count} 款模型 · {probe.ms}ms
      </span>
    )
  }
  return (
    <span className={styles.probeFail} data-probe="fail">
      {probe.message}
    </span>
  )
}

/** 最宽的那一档上下文。全都没容量就返回 undefined（**别显示 0**） */
function widestOf(models: ModelInfo[]): number | undefined {
  let max: number | undefined
  for (const m of models) {
    if (m.contextWindow !== undefined && (max === undefined || m.contextWindow > max)) max = m.contextWindow
  }
  return max
}

/**
 * 一个格子。**错误和提示占同一个位置** —— 提示是有空时说的, 错误是它说错时说的,
 * 同时出现会让格子长高一截、整张表跟着跳。
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
