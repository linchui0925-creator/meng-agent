import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'

interface Transport {
  invoke<T>(op: string, payload?: unknown): Promise<T>
}

interface CatalogVersion {
  version: string
  channels?: string[]
  changelog?: string
  rollout?: number
  sha256?: string
}

interface CatalogPlugin {
  id: string
  name: string
  description?: string
  publisher?: { id: string; name: string }
  versions: CatalogVersion[]
}

interface SearchResult {
  catalog: { name: string; updatedAt?: number }
  plugins: CatalogPlugin[]
}

interface Update {
  pluginId: string
  name: string
  installed: string
  available: string
  channel: string
}

interface Publisher {
  id: string
  name: string
  keyId: string
  status: 'active' | 'suspended'
  roles: string[]
  createdAt: number
}

interface Source {
  id: string
  name: string
  catalog: string
  priority: number
  enabled: boolean
  mirrors?: string[]
}

interface Installed {
  name: string
  pluginId: string
  version: string
  enabled: boolean
}

interface LibraryPlugin extends Installed {
  id: string
  packageName: string
  source: 'builtin' | 'external'
  runtime: string
  restartRequired: boolean
  configurable: boolean
  client: boolean
}

type LayoutMode = 'cards' | 'rows' | 'split'

interface RestartRequest {
  title: string
  message: string
  unsupported?: boolean
}

interface TelemetrySummary {
  installs: number
  updates: number
  uninstalls: number
  workerCrashes: number
  feedback: number
  averageRating?: number
  compatibility: { ok: number; broken: number; unknown: number }
  byPlugin: Record<string, number>
}

interface TelemetryEvent {
  type: string
  at: number
  pluginId: string
  version?: string
  compatible?: string
  rating?: number
  note?: string
}

interface Dashboard {
  publishers: Publisher[]
  sources: Source[]
  primarySource?: Source
  installed: Installed[]
  library: LibraryPlugin[]
  telemetry: TelemetrySummary
}

interface TelemetryResult {
  summary: TelemetrySummary
  events: TelemetryEvent[]
}

const EMPTY_SUMMARY: TelemetrySummary = {
  installs: 0,
  updates: 0,
  uninstalls: 0,
  workerCrashes: 0,
  feedback: 0,
  compatibility: { ok: 0, broken: 0, unknown: 0 },
  byPlugin: {},
}

const TABS = [
  { id: 'discover', label: '插件库' },
  { id: 'publishers', label: '发布者' },
  { id: 'sources', label: '市场源' },
  { id: 'telemetry', label: '反馈与遥测' },
] as const

type Tab = typeof TABS[number]['id']

export function MarketPanel({ transport }: { transport?: Transport }) {
  const [tab, setTab] = useState<Tab>('discover')
  const [dashboard, setDashboard] = useState<Dashboard>({
    publishers: [],
    sources: [],
    installed: [],
    library: [],
    telemetry: EMPTY_SUMMARY,
  })
  const [telemetry, setTelemetry] = useState<TelemetryResult>({ summary: EMPTY_SUMMARY, events: [] })
  const [busy, setBusy] = useState('')
  const [output, setOutput] = useState('')

  const [sourceId, setSourceId] = useState('auto')
  const [customSource, setCustomSource] = useState(() => localStorage.getItem('meng.market.customSource') ?? '')
  const [channel, setChannel] = useState('stable')
  const [query, setQuery] = useState('')
  const [rolloutKey, setRolloutKey] = useState(() => localStorage.getItem('meng.market.rolloutKey') ?? '')
  const [plugins, setPlugins] = useState<CatalogPlugin[]>([])
  const [updates, setUpdates] = useState<Update[]>([])
  const [restartPrompt, setRestartPrompt] = useState<RestartRequest | null>(null)
  const [restarting, setRestarting] = useState(false)

  const [publisherId, setPublisherId] = useState('')
  const [publisherName, setPublisherName] = useState('')
  const [publisherKey, setPublisherKey] = useState('')
  const [sourceDraftId, setSourceDraftId] = useState('')
  const [sourceDraftName, setSourceDraftName] = useState('')
  const [sourceDraftCatalog, setSourceDraftCatalog] = useState('')
  const [sourceDraftSignature, setSourceDraftSignature] = useState('')
  const [sourceDraftTrustStore, setSourceDraftTrustStore] = useState('')
  const [sourceDraftMirrors, setSourceDraftMirrors] = useState('')
  const [sourceDraftPriority, setSourceDraftPriority] = useState('100')

  const [feedbackPluginId, setFeedbackPluginId] = useState('')
  const [feedbackVersion, setFeedbackVersion] = useState('')
  const [compatible, setCompatible] = useState<'ok' | 'broken' | 'unknown'>('ok')
  const [rating, setRating] = useState('5')
  const [note, setNote] = useState('')

  const reloadDashboard = useCallback(async () => {
    if (!transport) return
    try {
      const [nextDashboard, nextTelemetry] = await Promise.all([
        transport.invoke<Dashboard>('pluginMarket.dashboard'),
        transport.invoke<TelemetryResult>('pluginMarket.telemetry', { limit: 80 }),
      ])
      setDashboard(nextDashboard)
      setTelemetry(nextTelemetry)
    } catch (error) {
      setOutput(errorText(error))
    }
  }, [transport])

  useEffect(() => {
    void reloadDashboard()
  }, [reloadDashboard])

  useEffect(() => {
    if (!transport) return
    void search()
  }, [transport])

  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem('meng.market.customSource', customSource), 300)
    return () => clearTimeout(timer)
  }, [customSource])

  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem('meng.market.rolloutKey', rolloutKey), 300)
    return () => clearTimeout(timer)
  }, [rolloutKey])

  const sourcePayload = customSource.trim()
    ? { source: customSource.trim() }
    : { sourceId: sourceId === 'auto' ? undefined : sourceId }

  async function search() {
    if (!transport) return
    setBusy('search')
    setOutput('')
    try {
      const result = await transport.invoke<SearchResult>('pluginMarket.search', {
        ...sourcePayload,
        query,
      })
      setPlugins(result.plugins)
      setOutput(`目录：${result.catalog.name} · ${result.plugins.length} 个插件`)
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function checkUpdates() {
    if (!transport) return
    setBusy('updates')
    setOutput('')
    try {
      const result = await transport.invoke<{ updates: Update[] }>('pluginMarket.updates', {
        ...sourcePayload,
        channel,
        rolloutKey,
      })
      setUpdates(result.updates)
      setOutput(result.updates.length ? `发现 ${result.updates.length} 个更新` : '已是最新')
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function install(pluginId: string, version?: string) {
    if (!transport) return
    const label = version ? `${pluginId}@${version}` : pluginId
    setBusy(`install:${pluginId}`)
    setOutput('')
    try {
      const result = await transport.invoke<{ name: string; version: string }>('pluginMarket.install', {
        ...sourcePayload,
        pluginId,
        ...(version ? { version } : {}),
        channel,
        rolloutKey,
        confirm: true,
      })
      setOutput(`已安装 ${result.name}@${result.version}`)
      await reloadDashboard()
      setRestartPrompt({
        title: '插件已安装',
        message: `${result.name}@${result.version} 需要重启后才会生效。`,
      })
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function togglePlugin(plugin: LibraryPlugin, enabled: boolean) {
    if (!transport || !plugin.configurable) return
    setBusy(`toggle:${plugin.packageName}`)
    setOutput('')
    try {
      await transport.invoke('pluginMarket.plugin.set', {
        name: plugin.packageName,
        enabled,
        confirm: true,
      })
      setOutput(enabled ? `${plugin.id} 将在重启后启动` : `${plugin.id} 将在重启后关闭`)
      await reloadDashboard()
      setRestartPrompt({
        title: enabled ? '插件已启用' : '插件已关闭',
        message: `${plugin.id} 的状态需要重启后才会生效。`,
      })
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function restartNow() {
    if (!transport) return
    setRestarting(true)
    try {
      const result = await transport.invoke<{ ok: boolean; supported: boolean }>('pluginMarket.restart', { confirm: true })
      if (!result.supported) {
        setRestartPrompt((current) => current ? { ...current, unsupported: true } : current)
        setRestarting(false)
      }
    } catch (error) {
      setOutput(errorText(error))
      setRestarting(false)
    }
  }

  async function uninstall(name: string) {
    if (!transport) return
    if (!window.confirm(`卸载 ${name}？插件数据会保留。`)) return
    setBusy(`uninstall:${name}`)
    setOutput('')
    try {
      await transport.invoke('pluginMarket.uninstall', { name, confirm: true })
      setOutput(`已卸载 ${name}，数据已保留`)
      await reloadDashboard()
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function addPublisher() {
    if (!transport) return
    setBusy('publisher:add')
    setOutput('')
    try {
      const created = await transport.invoke<Publisher>('pluginMarket.publisher.add', {
        id: publisherId,
        name: publisherName,
        publicKey: publisherKey,
        confirm: true,
      })
      setPublisherId('')
      setPublisherName('')
      setPublisherKey('')
      setOutput(`发布者 ${created.name} 已登记，keyId ${created.keyId}`)
      await reloadDashboard()
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function setPublisher(publisher: Publisher, suspended: boolean) {
    if (!transport) return
    setBusy(`publisher:${publisher.id}`)
    try {
      await transport.invoke('pluginMarket.publisher.set', { id: publisher.id, suspended, confirm: true })
      setOutput(`${publisher.name} 已${suspended ? '暂停' : '恢复'}`)
      await reloadDashboard()
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function addSource() {
    if (!transport) return
    setBusy('source:add')
    try {
      const created = await transport.invoke<Source>('pluginMarket.source.add', {
        id: sourceDraftId,
        name: sourceDraftName || sourceDraftId,
        catalog: sourceDraftCatalog,
        priority: Number(sourceDraftPriority) || 100,
        ...(sourceDraftSignature.trim() ? { signature: sourceDraftSignature.trim() } : {}),
        ...(sourceDraftTrustStore.trim() ? { trustStore: sourceDraftTrustStore.trim() } : {}),
        ...(sourceDraftMirrors.split('\n').map((item) => item.trim()).filter(Boolean).length
          ? { mirrors: sourceDraftMirrors.split('\n').map((item) => item.trim()).filter(Boolean) }
          : {}),
        confirm: true,
      })
      setSourceDraftId('')
      setSourceDraftName('')
      setSourceDraftCatalog('')
      setSourceDraftSignature('')
      setSourceDraftTrustStore('')
      setSourceDraftMirrors('')
      setSourceDraftPriority('100')
      setSourceId(created.id)
      setOutput(`市场源 ${created.name} 已添加`)
      await reloadDashboard()
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function setSource(source: Source, patch: { enabled?: boolean; priority?: number }) {
    if (!transport) return
    setBusy(`source:${source.id}`)
    try {
      await transport.invoke('pluginMarket.source.set', { id: source.id, ...patch, confirm: true })
      await reloadDashboard()
      setOutput(`${source.name} 已更新`)
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function removeSource(source: Source) {
    if (!transport) return
    if (!window.confirm(`删除市场源 ${source.name}？`)) return
    setBusy(`source:${source.id}`)
    try {
      await transport.invoke('pluginMarket.source.remove', { id: source.id, confirm: true })
      if (sourceId === source.id) setSourceId('auto')
      await reloadDashboard()
      setOutput(`市场源 ${source.name} 已删除`)
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  async function submitFeedback() {
    if (!transport) return
    setBusy('feedback')
    try {
      await transport.invoke('pluginMarket.feedback', {
        pluginId: feedbackPluginId,
        version: feedbackVersion,
        compatible,
        rating: Number(rating),
        note,
      })
      setNote('')
      setOutput('反馈已记录到本机')
      await reloadDashboard()
    } catch (error) {
      setOutput(errorText(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="plugin-market">
      <header className="plugin-market__header">
        <div>
          <h3>插件中心</h3>
          <p className="plugin-market__muted">{dashboard.library.filter((item) => item.runtime === 'active').length} 个运行中 · {dashboard.library.length} 个已安装</p>
        </div>
        <button className="plugin-market__button" disabled={Boolean(busy)} onClick={() => void reloadDashboard()}>刷新</button>
      </header>

      {dashboard.library.some((item) => item.restartRequired) ? (
        <div className="plugin-center__restart">
          <span>有插件变更等待生效</span>
          <button type="button" className="plugin-center__restart-action" onClick={() => setRestartPrompt({ title: '需要重启', message: '插件状态已变更，重启后生效。' })}>查看</button>
        </div>
      ) : null}

      <nav className="plugin-market__tabs" aria-label="插件中心分区">
        {TABS.map((item) => (
          <button
            type="button"
            className={`plugin-market__tab${tab === item.id ? ' is-active' : ''}`}
            aria-current={tab === item.id ? 'page' : undefined}
            key={item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'discover' ? (
        <DiscoverPanel
          sources={dashboard.sources}
          installed={dashboard.installed}
          library={dashboard.library}
          plugins={plugins}
          updates={updates}
          busy={busy}
          sourceId={sourceId}
          customSource={customSource}
          channel={channel}
          query={query}
          rolloutKey={rolloutKey}
          setSourceId={setSourceId}
          setCustomSource={setCustomSource}
          setChannel={setChannel}
          setQuery={setQuery}
          setRolloutKey={setRolloutKey}
          search={search}
          checkUpdates={checkUpdates}
          install={install}
          uninstall={uninstall}
          togglePlugin={togglePlugin}
        />
      ) : null}

      {tab === 'publishers' ? (
        <PublishersPanel
          publishers={dashboard.publishers}
          busy={busy}
          publisherId={publisherId}
          publisherName={publisherName}
          publisherKey={publisherKey}
          setPublisherId={setPublisherId}
          setPublisherName={setPublisherName}
          setPublisherKey={setPublisherKey}
          addPublisher={addPublisher}
          setPublisher={setPublisher}
        />
      ) : null}

      {tab === 'sources' ? (
        <SourcesPanel
          sources={dashboard.sources}
          busy={busy}
          sourceDraftId={sourceDraftId}
          sourceDraftName={sourceDraftName}
          sourceDraftCatalog={sourceDraftCatalog}
          sourceDraftSignature={sourceDraftSignature}
          sourceDraftTrustStore={sourceDraftTrustStore}
          sourceDraftMirrors={sourceDraftMirrors}
          sourceDraftPriority={sourceDraftPriority}
          setSourceDraftId={setSourceDraftId}
          setSourceDraftName={setSourceDraftName}
          setSourceDraftCatalog={setSourceDraftCatalog}
          setSourceDraftSignature={setSourceDraftSignature}
          setSourceDraftTrustStore={setSourceDraftTrustStore}
          setSourceDraftMirrors={setSourceDraftMirrors}
          setSourceDraftPriority={setSourceDraftPriority}
          addSource={addSource}
          setSource={setSource}
          removeSource={removeSource}
        />
      ) : null}

      {tab === 'telemetry' ? (
        <TelemetryPanel
          telemetry={telemetry}
          busy={busy}
          pluginId={feedbackPluginId}
          version={feedbackVersion}
          compatible={compatible}
          rating={rating}
          note={note}
          setPluginId={setFeedbackPluginId}
          setVersion={setFeedbackVersion}
          setCompatible={setCompatible}
          setRating={setRating}
          setNote={setNote}
          submitFeedback={submitFeedback}
        />
      ) : null}

      {output ? <pre className="plugin-market__output">{output}</pre> : null}

      {restartPrompt ? (
        <div className="plugin-center__modal-backdrop" role="presentation">
          <div className="plugin-center__modal" role="dialog" aria-modal="true" aria-labelledby="plugin-restart-title">
            <div className="plugin-center__modal-mark" aria-hidden="true">↻</div>
            <h4 id="plugin-restart-title">{restartPrompt.title}</h4>
            <p>{restartPrompt.message}</p>
            {restartPrompt.unsupported ? <p className="plugin-center__modal-error">当前环境不能自动重启，请关闭并重新打开梦。</p> : null}
            <div className="plugin-center__modal-actions">
              <button type="button" className="plugin-market__button" onClick={() => setRestartPrompt(null)}>稍后</button>
              <button type="button" className="plugin-center__primary" disabled={restarting} onClick={() => restartPrompt.unsupported ? setRestartPrompt(null) : void restartNow()}>
                {restarting ? '正在重启…' : restartPrompt.unsupported ? '知道了' : '立即重启'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function DiscoverPanel(props: {
  sources: Source[]
  installed: Installed[]
  library: LibraryPlugin[]
  plugins: CatalogPlugin[]
  updates: Update[]
  busy: string
  sourceId: string
  customSource: string
  channel: string
  query: string
  rolloutKey: string
  setSourceId: (value: string) => void
  setCustomSource: (value: string) => void
  setChannel: (value: string) => void
  setQuery: (value: string) => void
  setRolloutKey: (value: string) => void
  search: () => Promise<void>
  checkUpdates: () => Promise<void>
  install: (pluginId: string, version?: string) => Promise<void>
  uninstall: (name: string) => Promise<void>
  togglePlugin: (plugin: LibraryPlugin, enabled: boolean) => Promise<void>
}) {
  const [layout, setLayout] = useState<LayoutMode>(() => {
    const saved = localStorage.getItem('meng.pluginCenter.layout')
    return saved === 'rows' || saved === 'split' || saved === 'cards' ? saved : 'cards'
  })
  const [category, setCategory] = useState<'all' | 'builtin' | 'external' | 'market'>('all')
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'restart' | 'off'>('all')
  const deferredQuery = useDeferredValue(props.query.trim().toLowerCase())

  useEffect(() => {
    localStorage.setItem('meng.pluginCenter.layout', layout)
  }, [layout])

  const library = useMemo(() => props.library.filter((plugin) => {
    if (deferredQuery && !`${plugin.id} ${plugin.packageName} ${plugin.name}`.toLowerCase().includes(deferredQuery)) return false
    if (category === 'builtin' && plugin.source !== 'builtin') return false
    if ((category === 'external' || category === 'market') && plugin.source !== 'external') return false
    if (stateFilter === 'active' && (plugin.runtime !== 'active' || !plugin.enabled)) return false
    if (stateFilter === 'restart' && !plugin.restartRequired) return false
    if (stateFilter === 'off' && plugin.enabled) return false
    return true
  }), [category, deferredQuery, props.library, stateFilter])

  const installedIds = useMemo(() => new Set(props.library.map((plugin) => plugin.id)), [props.library])
  const marketOnly = useMemo(() => {
    if (category === 'builtin') return []
    if (stateFilter !== 'all' && stateFilter !== 'off') return []
    return props.plugins.filter((plugin) => {
      if (installedIds.has(plugin.id)) return false
      return !deferredQuery || `${plugin.id} ${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(deferredQuery)
    })
  }, [category, deferredQuery, installedIds, props.plugins, stateFilter])

  const counts = useMemo(() => ({
    all: props.library.length,
    builtin: props.library.filter((plugin) => plugin.source === 'builtin').length,
    external: props.library.filter((plugin) => plugin.source === 'external').length,
    market: props.plugins.filter((plugin) => !installedIds.has(plugin.id)).length,
    active: props.library.filter((plugin) => plugin.runtime === 'active' && plugin.enabled).length,
    restart: props.library.filter((plugin) => plugin.restartRequired).length,
    off: props.library.filter((plugin) => !plugin.enabled).length,
  }), [installedIds, props.library, props.plugins])

  const filters = (
    <>
      <div className="plugin-center__filter-group">
        <span className="plugin-center__filter-label">来源</span>
        <div className="plugin-center__chips">
          {([
            ['all', '全部', counts.all],
            ['builtin', '内置', counts.builtin],
            ['external', '外部', counts.external],
            ['market', '可安装', counts.market],
          ] as const).map(([id, label, count]) => (
            <button type="button" key={id} className="plugin-center__chip" data-active={category === id ? '' : undefined} onClick={() => setCategory(id)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="plugin-center__filter-group">
        <span className="plugin-center__filter-label">状态</span>
        <div className="plugin-center__chips">
          {([
            ['all', '全部', counts.all],
            ['active', '已启用', counts.active],
            ['restart', '需重启', counts.restart],
            ['off', '已关闭', counts.off],
          ] as const).map(([id, label, count]) => (
            <button type="button" key={id} className="plugin-center__chip" data-active={stateFilter === id ? '' : undefined} onClick={() => setStateFilter(id)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )

  return (
    <div className={`plugin-center plugin-center--${layout}`}>
      <div className="plugin-center__toolbar">
        <div className="plugin-center__search">
          <input className="plugin-market__input" value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="搜索插件" />
          <button className="plugin-center__secondary" disabled={Boolean(props.busy)} onClick={() => void props.search()}>{props.busy === 'search' ? '搜索中…' : '搜索市场'}</button>
        </div>
        <div className="plugin-center__layout" role="group" aria-label="插件库布局">
          {([
            ['cards', '卡片'],
            ['rows', '列表'],
            ['split', '分栏'],
          ] as const).map(([id, label]) => (
            <button type="button" key={id} data-active={layout === id ? '' : undefined} onClick={() => setLayout(id)}>{label}</button>
          ))}
        </div>
      </div>

      <details className="plugin-center__market-tools">
        <summary>市场筛选</summary>
        <div className="plugin-market__row">
          <select className="plugin-market__input" value={props.sourceId} onChange={(event) => props.setSourceId(event.target.value)} aria-label="市场源">
            <option value="auto">自动选择主市场源</option>
            {props.sources.map((source) => (
              <option key={source.id} value={source.id} disabled={!source.enabled}>
                {source.name}{source.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
          <select className="plugin-market__input" value={props.channel} onChange={(event) => props.setChannel(event.target.value)} aria-label="发布通道">
            <option value="stable">stable</option>
            <option value="beta">beta</option>
          </select>
          <button className="plugin-center__secondary" disabled={Boolean(props.busy)} onClick={() => void props.checkUpdates()}>{props.busy === 'updates' ? '检查中…' : '检查更新'}</button>
        </div>
        <input className="plugin-market__input" value={props.customSource} onChange={(event) => props.setCustomSource(event.target.value)} placeholder="临时 catalog 地址或本地路径" />
        <input className="plugin-market__input" value={props.rolloutKey} onChange={(event) => props.setRolloutKey(event.target.value)} placeholder="灰度标识" />
      </details>

      {props.updates.length > 0 ? (
        <div className="plugin-center__updates">
          <strong>可用更新</strong>
          {props.updates.map((item) => (
            <div className="plugin-center__update" key={item.pluginId}>
              <span>{item.name}</span>
              <span>{item.installed} → {item.available}</span>
              <button className="plugin-center__primary" disabled={Boolean(props.busy)} onClick={() => void props.install(item.pluginId, item.available)}>更新</button>
            </div>
          ))}
        </div>
      ) : null}

      {layout === 'split' ? <aside className="plugin-center__rail">{filters}</aside> : null}

      <div className="plugin-center__content">
        {layout !== 'split' ? <div className="plugin-center__filters">{filters}</div> : null}

        <div className="plugin-center__list">
          {library.map((plugin) => (
            <PluginCard
              key={plugin.packageName}
              plugin={plugin}
              busy={props.busy}
              large={layout === 'cards'}
              toggle={(enabled) => void props.togglePlugin(plugin, enabled)}
              uninstall={() => void props.uninstall(plugin.packageName)}
            />
          ))}
          {marketOnly.map((plugin) => (
            <MarketCard
              key={plugin.id}
              plugin={plugin}
              channel={props.channel}
              busy={props.busy}
              install={(version) => void props.install(plugin.id, version)}
            />
          ))}
        </div>

        {library.length === 0 && marketOnly.length === 0 ? (
          <div className="plugin-center__empty">
            <strong>没有匹配的插件</strong>
            <button type="button" onClick={() => { props.setQuery(''); setCategory('all'); setStateFilter('all') }}>清除筛选</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PluginCard(props: {
  plugin: LibraryPlugin
  busy: string
  large: boolean
  toggle: (enabled: boolean) => void
  uninstall: () => void
}) {
  const { plugin } = props
  const status = pluginStatus(plugin)
  return (
    <article className="plugin-center__plugin" data-source={plugin.source} data-state={status.tone} data-large={props.large ? '' : undefined}>
      <div className="plugin-center__plugin-main">
        <div className="plugin-center__plugin-icon" aria-hidden="true">{plugin.source === 'builtin' ? '内' : '外'}</div>
        <div className="plugin-center__plugin-copy">
          <div className="plugin-center__plugin-title">
            <strong>{plugin.id}</strong>
            <span>{plugin.source === 'builtin' ? '系统内置' : '外部插件'}</span>
          </div>
          <span className="plugin-center__plugin-meta">{plugin.packageName}{plugin.version ? ` · ${plugin.version}` : ''}</span>
        </div>
        <PluginSwitch
          checked={plugin.enabled}
          disabled={!plugin.configurable || Boolean(props.busy)}
          label={`${plugin.id} ${plugin.enabled ? '已启用' : '已关闭'}`}
          title={plugin.configurable ? (plugin.enabled ? '关闭插件' : '启用插件') : '系统内置插件随应用启动'}
          onChange={props.toggle}
        />
      </div>
      <div className="plugin-center__plugin-foot">
        <span className="plugin-center__status" data-tone={status.tone}><i />{status.label}</span>
        {plugin.source === 'external' ? (
          <button type="button" className="plugin-center__text-button" disabled={Boolean(props.busy)} onClick={props.uninstall}>卸载</button>
        ) : <span className="plugin-center__locked">固定启用</span>}
      </div>
    </article>
  )
}

function MarketCard(props: {
  plugin: CatalogPlugin
  channel: string
  busy: string
  install: (version?: string) => void
}) {
  const versions = versionsForChannel(props.plugin, props.channel)
  return (
    <article className="plugin-center__plugin" data-source="market" data-state="available" data-large="">
      <div className="plugin-center__plugin-main">
        <div className="plugin-center__plugin-icon" aria-hidden="true">＋</div>
        <div className="plugin-center__plugin-copy">
          <div className="plugin-center__plugin-title">
            <strong>{props.plugin.name}</strong>
            <span>市场插件</span>
          </div>
          <span className="plugin-center__plugin-meta">{props.plugin.id}{props.plugin.publisher ? ` · ${props.plugin.publisher.name}` : ''}</span>
          {props.plugin.description ? <p>{props.plugin.description}</p> : null}
        </div>
      </div>
      <div className="plugin-center__plugin-foot">
        <span className="plugin-center__status" data-tone="available"><i />可安装</span>
        <button className="plugin-center__primary" disabled={Boolean(props.busy)} onClick={() => props.install(versions[0]?.version)}>
          {props.busy === `install:${props.plugin.id}` ? '安装中…' : `安装${versions[0] ? ` ${versions[0].version}` : ''}`}
        </button>
      </div>
    </article>
  )
}

function PluginSwitch(props: {
  checked: boolean
  disabled: boolean
  label: string
  title: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.title}
      className="plugin-center__switch"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    ><span /></button>
  )
}

function pluginStatus(plugin: LibraryPlugin): { label: string; tone: 'active' | 'restart' | 'off' | 'failed' } {
  if (plugin.runtime === 'failed') return { label: '启动失败', tone: 'failed' }
  if (plugin.restartRequired) {
    return { label: plugin.enabled ? '未激活（需重启）' : '已关闭（需重启）', tone: 'restart' }
  }
  if (plugin.enabled && plugin.runtime === 'active') return { label: '已启用', tone: 'active' }
  return { label: plugin.enabled ? '等待启动' : '已关闭', tone: 'off' }
}

function PublishersPanel(props: {
  publishers: Publisher[]
  busy: string
  publisherId: string
  publisherName: string
  publisherKey: string
  setPublisherId: (value: string) => void
  setPublisherName: (value: string) => void
  setPublisherKey: (value: string) => void
  addPublisher: () => Promise<void>
  setPublisher: (publisher: Publisher, suspended: boolean) => Promise<void>
}) {
  return (
    <div className="plugin-market__panel">
      <p className="plugin-market__muted">发布者公钥用于核对目录声明和插件签名。暂停后，该发布者的插件不能再从市场安装。</p>
      <div className="plugin-market__form">
        <input className="plugin-market__input" value={props.publisherId} onChange={(event) => props.setPublisherId(event.target.value)} placeholder="发布者 id，例如 acme" />
        <input className="plugin-market__input" value={props.publisherName} onChange={(event) => props.setPublisherName(event.target.value)} placeholder="显示名称" />
        <textarea className="plugin-market__input plugin-market__textarea" value={props.publisherKey} onChange={(event) => props.setPublisherKey(event.target.value)} placeholder="粘贴 Ed25519 公钥 PEM" />
        <button className="plugin-market__button" disabled={Boolean(props.busy) || !props.publisherId.trim() || !props.publisherKey.trim()} onClick={() => void props.addPublisher()}>登记发布者</button>
      </div>
      <div className="plugin-market__list">
        {props.publishers.map((publisher) => (
          <div className="plugin-market__card plugin-market__card--inline" key={publisher.id}>
            <span className="plugin-market__title">{publisher.name}</span>
            <span className="plugin-market__muted">{publisher.id} · {publisher.keyId}</span>
            <StatusBadge tone={publisher.status === 'active' ? 'ok' : 'warn'}>{publisher.status === 'active' ? '可用' : '已暂停'}</StatusBadge>
            <button
              className="plugin-market__button"
              disabled={Boolean(props.busy)}
              onClick={() => void props.setPublisher(publisher, publisher.status === 'active')}
            >
              {publisher.status === 'active' ? '暂停' : '恢复'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SourcesPanel(props: {
  sources: Source[]
  busy: string
  sourceDraftId: string
  sourceDraftName: string
  sourceDraftCatalog: string
  sourceDraftSignature: string
  sourceDraftTrustStore: string
  sourceDraftMirrors: string
  sourceDraftPriority: string
  setSourceDraftId: (value: string) => void
  setSourceDraftName: (value: string) => void
  setSourceDraftCatalog: (value: string) => void
  setSourceDraftSignature: (value: string) => void
  setSourceDraftTrustStore: (value: string) => void
  setSourceDraftMirrors: (value: string) => void
  setSourceDraftPriority: (value: string) => void
  addSource: () => Promise<void>
  setSource: (source: Source, patch: { enabled?: boolean; priority?: number }) => Promise<void>
  removeSource: (source: Source) => Promise<void>
}) {
  return (
    <div className="plugin-market__panel">
      <p className="plugin-market__muted">优先级越高越先被自动选中。多个来源可以并存，停用后不会参与自动选择。</p>
      <div className="plugin-market__form">
        <input className="plugin-market__input" value={props.sourceDraftId} onChange={(event) => props.setSourceDraftId(event.target.value)} placeholder="来源 id" />
        <input className="plugin-market__input" value={props.sourceDraftName} onChange={(event) => props.setSourceDraftName(event.target.value)} placeholder="显示名称" />
        <input className="plugin-market__input" value={props.sourceDraftCatalog} onChange={(event) => props.setSourceDraftCatalog(event.target.value)} placeholder="catalog 地址或本地路径" />
        <input className="plugin-market__input" value={props.sourceDraftPriority} onChange={(event) => props.setSourceDraftPriority(event.target.value)} placeholder="优先级，默认 100" inputMode="numeric" />
        <input className="plugin-market__input" value={props.sourceDraftSignature} onChange={(event) => props.setSourceDraftSignature(event.target.value)} placeholder="目录签名文件（可选）" />
        <input className="plugin-market__input" value={props.sourceDraftTrustStore} onChange={(event) => props.setSourceDraftTrustStore(event.target.value)} placeholder="信任库文件（有签名时必填）" />
        <textarea className="plugin-market__input plugin-market__textarea" value={props.sourceDraftMirrors} onChange={(event) => props.setSourceDraftMirrors(event.target.value)} placeholder="下载镜像，每行一个（可选）" />
        <button className="plugin-market__button" disabled={Boolean(props.busy) || !props.sourceDraftId.trim() || !props.sourceDraftCatalog.trim()} onClick={() => void props.addSource()}>添加市场源</button>
      </div>
      <div className="plugin-market__list">
        {props.sources.map((source) => (
          <div className="plugin-market__card" key={source.id}>
            <div className="plugin-market__card-heading">
              <span className="plugin-market__title">{source.name}</span>
              <StatusBadge tone={source.enabled ? 'ok' : 'warn'}>{source.enabled ? '启用' : '停用'}</StatusBadge>
              <span className="plugin-market__muted">优先级 {source.priority}</span>
            </div>
            <code className="plugin-market__code">{source.catalog}</code>
            {source.mirrors?.length ? <span className="plugin-market__muted">镜像 {source.mirrors.length} 个</span> : null}
            <div className="plugin-market__versions">
              <button className="plugin-market__button" disabled={Boolean(props.busy)} onClick={() => void props.setSource(source, { enabled: !source.enabled })}>
                {source.enabled ? '停用' : '启用'}
              </button>
              <button className="plugin-market__button" disabled={Boolean(props.busy)} onClick={() => void props.setSource(source, { priority: source.priority + 10 })}>提高优先级</button>
              <button className="plugin-market__button plugin-market__button--danger" disabled={Boolean(props.busy)} onClick={() => void props.removeSource(source)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TelemetryPanel(props: {
  telemetry: TelemetryResult
  busy: string
  pluginId: string
  version: string
  compatible: 'ok' | 'broken' | 'unknown'
  rating: string
  note: string
  setPluginId: (value: string) => void
  setVersion: (value: string) => void
  setCompatible: (value: 'ok' | 'broken' | 'unknown') => void
  setRating: (value: string) => void
  setNote: (value: string) => void
  submitFeedback: () => Promise<void>
}) {
  const summary = props.telemetry.summary
  return (
    <div className="plugin-market__panel">
      <div className="plugin-market__metrics">
        <Metric label="安装" value={summary.installs} />
        <Metric label="更新" value={summary.updates} />
        <Metric label="卸载" value={summary.uninstalls} />
        <Metric label="Worker 崩溃" value={summary.workerCrashes} />
        <Metric label="反馈" value={summary.feedback} />
        <Metric label="平均评分" value={summary.averageRating ?? '—'} />
      </div>
      <p className="plugin-market__muted">兼容结果：可用 {summary.compatibility.ok} · 有问题 {summary.compatibility.broken} · 未判断 {summary.compatibility.unknown}。数据只保存在本机。</p>

      <div className="plugin-market__form">
        <input className="plugin-market__input" value={props.pluginId} onChange={(event) => props.setPluginId(event.target.value)} placeholder="插件 id" />
        <input className="plugin-market__input" value={props.version} onChange={(event) => props.setVersion(event.target.value)} placeholder="版本，可选" />
        <select className="plugin-market__input" value={props.compatible} onChange={(event) => props.setCompatible(event.target.value as 'ok' | 'broken' | 'unknown')} aria-label="兼容结果">
          <option value="ok">可用</option>
          <option value="broken">有问题</option>
          <option value="unknown">未判断</option>
        </select>
        <select className="plugin-market__input" value={props.rating} onChange={(event) => props.setRating(event.target.value)} aria-label="评分">
          {[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{value} 分</option>)}
        </select>
        <textarea className="plugin-market__input plugin-market__textarea" value={props.note} onChange={(event) => props.setNote(event.target.value)} placeholder="遇到什么问题，或哪里做得不错（可选）" />
        <button className="plugin-market__button" disabled={Boolean(props.busy) || !props.pluginId.trim()} onClick={() => void props.submitFeedback()}>记录反馈</button>
      </div>

      <div className="plugin-market__list">
        <h4>最近事件</h4>
        {props.telemetry.events.length === 0 ? <p className="plugin-market__muted">还没有记录。</p> : null}
        {[...props.telemetry.events].reverse().map((event, index) => (
          <div className="plugin-market__event" key={`${event.at}-${event.type}-${index}`}>
            <StatusBadge tone={eventTone(event)}>{eventLabel(event)}</StatusBadge>
            <span>{event.pluginId}{event.version ? `@${event.version}` : ''}</span>
            <span className="plugin-market__muted">{formatTime(event.at)}</span>
            {event.note ? <span className="plugin-market__note">{event.note}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="plugin-market__metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function StatusBadge({ children, tone }: { children: string; tone: 'ok' | 'warn' | 'bad' }) {
  return <span className={`plugin-market__badge plugin-market__badge--${tone}`}>{children}</span>
}

function eventLabel(event: TelemetryEvent): string {
  if (event.type === 'feedback') {
    if (event.compatible === 'ok') return `可用${event.rating ? ` · ${event.rating} 分` : ''}`
    if (event.compatible === 'broken') return '有问题'
    return '兼容未知'
  }
  if (event.type === 'worker-crash') return '崩溃'
  if (event.type === 'install') return '安装'
  if (event.type === 'update') return '更新'
  if (event.type === 'uninstall') return '卸载'
  return event.type
}

function eventTone(event: TelemetryEvent): 'ok' | 'warn' | 'bad' {
  if (event.type === 'worker-crash' || event.compatible === 'broken') return 'bad'
  if (event.compatible === 'ok' || event.type === 'install' || event.type === 'update') return 'ok'
  return 'warn'
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

function versionsForChannel(plugin: CatalogPlugin, channel: string): CatalogVersion[] {
  return plugin.versions.filter((version) => {
    if (!version.channels || version.channels.length === 0) return channel === 'stable'
    return version.channels.includes(channel)
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
