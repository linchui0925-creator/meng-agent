import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

export interface MarketDashboard {
  paths: MarketPaths
  publishers: PublisherRecord[]
  sources: OfficialSource[]
  primarySource?: OfficialSource
  installed: Array<{ name: string; pluginId: string; version: string; enabled: boolean }>
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

  constructor(profileDir: string, dataDir?: string) {
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
      telemetry: this.telemetry().summary,
    }
  }

  installed(): Array<{ name: string; pluginId: string; version: string; enabled: boolean }> {
    if (!existsSync(join(this.paths.profileDir, 'package.json'))) return []
    return new ProfileStore(this.paths.profileDir).list().map((item) => ({
      name: item.name,
      pluginId: typeof item.config.id === 'string' ? item.config.id : item.name,
      version: item.version,
      enabled: item.enabled,
    }))
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
