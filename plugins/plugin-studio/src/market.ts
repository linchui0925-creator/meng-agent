import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { StatusGraph } from '@meng/core'
import { ProfileStore } from '@meng/plugin-manifest'
import {
  findUpdates,
  installFromCatalog,
  loadCatalog,
  loadSignedCatalog,
  searchCatalog,
  type CatalogPlugin,
  type CatalogUpdate,
  type PluginCatalog,
} from './catalog.ts'
import { uninstallPlugin, type InstallResult, type UninstallResult } from './install.ts'
import { PublisherStore, type PublisherRecord } from './publishers.ts'
import { readSignature } from './signing.ts'
import { OfficialSourceStore, type OfficialSource, type OfficialSourcePatch } from './sources.ts'
import { LocalPluginTelemetry, type PluginEvent, type TelemetrySummary } from './telemetry.ts'

const DEFAULT_OFFICIAL_SOURCE: OfficialSource = {
  id: 'meng-official',
  name: '梦官方市场',
  catalog: 'https://cdn.jsdelivr.net/gh/linchui0925-creator/meng-agent@main/market/catalog.json',
  mirrors: ['https://raw.githubusercontent.com/linchui0925-creator/meng-agent/main/market/catalog.json'],
  priority: 100,
  enabled: true,
}

export interface MarketPaths {
  profileDir: string
  dataDir: string
  publishersFile: string
  sourcesFile: string
  telemetryDir: string
}

export interface MarketLibraryPlugin {
  id: string
  name: string
  packageName: string
  version: string
  source: 'builtin' | 'external'
  enabled: boolean
  runtime: string
  restartRequired: boolean
  configurable: boolean
  client: boolean
}

export interface MarketDashboard {
  paths: MarketPaths
  publishers: PublisherRecord[]
  sources: OfficialSource[]
  primarySource?: OfficialSource
  installed: Array<{ name: string; pluginId: string; version: string; enabled: boolean }>
  library: MarketLibraryPlugin[]
  telemetry: TelemetrySummary
}

export interface MarketSearchResult {
  catalog: Pick<PluginCatalog, 'name' | 'updatedAt'>
  source: OfficialSource | { id: 'custom'; name: '自定义地址'; catalog: string; priority: 0; enabled: true }
  plugins: CatalogPlugin[]
}

export interface MarketInstallInput {
  source?: string
  sourceId?: string
  pluginId: string
  version?: string
  channel?: string
  rolloutKey?: string
  trustStore?: string
  requireSignature?: boolean
  revocations?: unknown
}

export class MarketOperations {
  readonly paths: MarketPaths
  private readonly graph?: Pick<StatusGraph, 'snapshot'>
  private readonly externalIds: ReadonlySet<string>

  constructor(profileDir: string, dataDir?: string, graph?: Pick<StatusGraph, 'snapshot'>, externalIds: ReadonlySet<string> = new Set()) {
    this.graph = graph
    this.externalIds = externalIds
    const profile = resolve(profileDir)
    const root = resolve(dataDir || process.env['MENG_DATA_DIR'] || join(profile, '..'))
    const marketData = join(root, 'plugins', 'plugin-studio', 'data')
    this.paths = {
      profileDir: profile,
      dataDir: marketData,
      publishersFile: join(marketData, 'publishers.json'),
      sourcesFile: join(marketData, 'sources.json'),
      telemetryDir: join(marketData, 'telemetry'),
    }
  }

  dashboard(): MarketDashboard {
    this.ensureDefaultSource()
    const sources = this.sourceStore().list()
    const primarySource = sources.find((source) => source.enabled)
    return {
      paths: this.paths,
      publishers: this.publisherStore().list(),
      sources,
      ...(primarySource ? { primarySource } : {}),
      installed: this.installed(),
      library: this.library(),
      telemetry: this.telemetry().summary,
    }
  }

  installed(): Array<{ name: string; pluginId: string; version: string; enabled: boolean }> {
    if (!existsSync(join(this.paths.profileDir, 'package.json'))) return []
    return new ProfileStore(this.paths.profileDir).list().map((item) => ({
      name: item.name,
      pluginId: typeof item.config.id === 'string' ? item.config.id : this.pluginIdOf(item.name),
      version: item.version,
      enabled: item.enabled,
    }))
  }

  private pluginIdOf(packageName: string): string {
    try {
      const file = join(this.paths.profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { meng?: { plugin?: { id?: unknown } } }
      return typeof pkg.meng?.plugin?.id === 'string' && pkg.meng.plugin.id.trim() ? pkg.meng.plugin.id.trim() : packageName
    } catch {
      return packageName
    }
  }

  library(): MarketLibraryPlugin[] {
    const installed = this.installed()
    const nodes = this.graph?.snapshot() ?? []
    const externalIds = new Set<string>(this.externalIds)
    const installedIds = new Set<string>()
    const rows: MarketLibraryPlugin[] = []

    for (const item of installed) {
      const node = nodes.find((entry) => entry.id === item.pluginId || entry.name === item.name)
      const externalId = node?.id ?? item.pluginId
      externalIds.add(externalId)
      installedIds.add(externalId)
      const runtime = node?.status ?? 'discovered'
      const active = runtime === 'active'
      const restartRequired = runtime === 'failed' || runtime === 'pending' || item.enabled !== active
      rows.push({
        id: node?.id ?? item.pluginId,
        name: node?.id ?? item.pluginId,
        packageName: item.name,
        version: item.version,
        source: 'external',
        enabled: item.enabled,
        runtime,
        restartRequired,
        configurable: true,
        client: Boolean(node?.client),
      })
    }

    for (const externalId of externalIds) {
      if (installedIds.has(externalId)) continue
      const node = nodes.find((entry) => entry.id === externalId)
      if (!node) continue
      rows.push({
        id: node.id,
        name: node.id,
        packageName: node.name || node.id,
        version: '',
        source: 'external',
        enabled: false,
        runtime: node.status,
        restartRequired: true,
        configurable: false,
        client: Boolean(node.client),
      })
    }

    for (const node of nodes) {
      if (externalIds.has(node.id) || node.id === 'kernel') continue
      rows.push({
        id: node.id,
        name: node.name || node.id,
        packageName: node.name || node.id,
        version: '',
        source: 'builtin',
        enabled: true,
        runtime: node.status,
        restartRequired: false,
        configurable: false,
        client: Boolean(node.client),
      })
    }

    return rows.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  }

  addPublisher(input: {
    id: string
    name: string
    publicKey: string
    keyId?: string
    roles?: string[]
  }): PublisherRecord {
    return this.publisherStore().add(input)
  }

  setPublisher(id: string, suspended: boolean): PublisherRecord {
    return this.publisherStore().suspend(id, suspended)
  }

  addSource(input: {
    id: string
    name?: string
    catalog: string
    signature?: string
    trustStore?: string
    priority?: number
    enabled?: boolean
    mirrors?: string[]
  }): OfficialSource {
    this.ensureDefaultSource()
    return this.sourceStore().add({ ...input, name: input.name || input.id })
  }

  setSource(id: string, patch: OfficialSourcePatch): OfficialSource {
    this.ensureDefaultSource()
    return this.sourceStore().set(id, patch)
  }

  removeSource(id: string): void {
    this.ensureDefaultSource()
    this.sourceStore().remove(id)
  }

  async search(input: { source?: string; sourceId?: string; query?: string } = {}): Promise<MarketSearchResult> {
    const source = this.resolveSource(input)
    const catalog = await this.loadCatalog(source)
    return {
      catalog: { name: catalog.name, ...(catalog.updatedAt === undefined ? {} : { updatedAt: catalog.updatedAt }) },
      source,
      plugins: searchCatalog(catalog, input.query ?? ''),
    }
  }

  async updates(input: {
    source?: string
    sourceId?: string
    channel?: string
    rolloutKey?: string
  } = {}): Promise<{ source: OfficialSource | CustomSource; updates: CatalogUpdate[] }> {
    const source = this.resolveSource(input)
    const catalog = await this.loadCatalog(source)
    return {
      source,
      updates: findUpdates(
        this.paths.profileDir,
        catalog,
        input.channel ?? 'stable',
        input.rolloutKey || this.paths.profileDir,
      ),
    }
  }

  async install(input: MarketInstallInput): Promise<InstallResult> {
    const source = this.resolveSource(input)
    const publisherStore = this.publisherStore()
    const publishers = publisherStore.list()
    const trustStore = input.trustStore || (isOfficialSource(source) ? source.trustStore : undefined)
    const signature = isOfficialSource(source) && source.signature
      ? readSignature(source.signature)
      : undefined
    const result = await installFromCatalog(
      this.paths.profileDir,
      source.catalog,
      input.pluginId,
      {
        ...(input.version ? { version: input.version } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
        rolloutKey: input.rolloutKey || this.paths.profileDir,
        ...(trustStore ? { trustStore } : {}),
        ...(input.requireSignature === true ? { requireSignature: true } : {}),
        ...(signature ? { catalogSignature: signature, requireCatalogSignature: true } : {}),
        ...(isRevocationList(input.revocations) ? { revocations: input.revocations } : {}),
        ...(publishers.length > 0 ? { publisherStore: this.paths.publishersFile } : {}),
        telemetryDir: this.paths.telemetryDir,
      },
    )
    return result
  }

  setPlugin(name: string, enabled: boolean): { name: string; enabled: boolean; restartRequired: true } {
    const store = new ProfileStore(this.paths.profileDir)
    const item = store.list().find((entry) => entry.name === name)
    if (!item) throw new Error(`外部插件不存在: ${name}`)
    store.setEnabled(name, enabled)
    return { name, enabled, restartRequired: true }
  }

  uninstall(name: string): UninstallResult {
    const installed = this.installed().find((item) => item.name === name)
    const result = uninstallPlugin(this.paths.profileDir, name)
    this.telemetryClient().record({
      type: 'uninstall',
      pluginId: installed?.pluginId ?? result.pluginId,
      version: installed?.version ?? result.version,
    })
    return result
  }

  recordFeedback(input: {
    pluginId: string
    version?: string
    compatible?: 'ok' | 'broken' | 'unknown'
    rating?: number
    note?: string
  }): PluginEvent {
    return this.telemetryClient().record({
      type: 'feedback',
      pluginId: input.pluginId,
      ...(input.version ? { version: input.version } : {}),
      compatible: input.compatible ?? 'unknown',
      ...(input.rating === undefined ? {} : { rating: Math.max(1, Math.min(5, Math.round(input.rating))) }),
      ...(input.note ? { note: input.note } : {}),
    })
  }

  telemetry(input: { limit?: number; pluginId?: string } = {}): { summary: TelemetrySummary; events: PluginEvent[] } {
    const client = this.telemetryClient()
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)))
    return {
      summary: client.summary(input.pluginId),
      events: client.list(limit, input.pluginId),
    }
  }

  private resolveSource(input: { source?: string; sourceId?: string }): OfficialSource | CustomSource {
    if (input.source?.trim()) return customSource(input.source.trim())
    this.ensureDefaultSource()
    const store = this.sourceStore()
    if (input.sourceId?.trim()) {
      const selected = store.get(input.sourceId.trim())
      if (!selected) throw new Error(`市场源不存在: ${input.sourceId}`)
      if (!selected.enabled) throw new Error(`市场源已停用: ${input.sourceId}`)
      return selected
    }
    const primary = store.primary()
    if (!primary) throw new Error('没有启用的市场源，请先在插件市场里添加并启用一个来源')
    return primary
  }

  private async loadCatalog(source: OfficialSource | CustomSource): Promise<PluginCatalog> {
    const catalogs = [source.catalog, ...(isOfficialSource(source) ? source.mirrors ?? [] : [])]
    let last: unknown
    for (const catalog of catalogs) {
      try {
        if (isOfficialSource(source) && (source.signature || source.trustStore)) {
          if (!source.signature || !source.trustStore) throw new Error('市场源签名必须同时配置 signature 与 trustStore')
          return await loadSignedCatalog(catalog, {
            signature: source.signature,
            trustStore: source.trustStore,
            requireSignature: true,
          })
        }
        return await loadCatalog(catalog)
      } catch (error) {
        last = error
      }
    }
    throw last instanceof Error ? last : new Error(`市场源 ${source.id} 的所有 catalog 地址均不可用`)
  }

  private ensureDefaultSource(): void {
    if (existsSync(this.paths.sourcesFile)) return
    this.sourceStore().add(DEFAULT_OFFICIAL_SOURCE)
  }

  private publisherStore(): PublisherStore {
    return new PublisherStore(this.paths.publishersFile)
  }

  private sourceStore(): OfficialSourceStore {
    return new OfficialSourceStore(this.paths.sourcesFile)
  }

  private telemetryClient(): LocalPluginTelemetry {
    return new LocalPluginTelemetry(this.paths.telemetryDir)
  }
}

interface CustomSource {
  id: 'custom'
  name: '自定义地址'
  catalog: string
  priority: 0
  enabled: true
}

function customSource(catalog: string): CustomSource {
  return { id: 'custom', name: '自定义地址', catalog, priority: 0, enabled: true }
}

function isOfficialSource(source: OfficialSource | CustomSource): source is OfficialSource {
  return source.id !== 'custom'
}

function isRevocationList(value: unknown): value is { version: 1; entries: Array<Record<string, unknown>> } {
  return value !== null
    && typeof value === 'object'
    && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { entries?: unknown }).entries)
}
