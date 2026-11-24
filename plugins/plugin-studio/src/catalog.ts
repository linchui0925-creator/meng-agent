import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ProfileStore } from '@meng/plugin-manifest'
import { installArchive, type InstallResult } from './install.ts'
import { readSignature, sha256Of, verifyArchiveSignature, verifyFileSignature, type SignatureEnvelope, readTrustStore } from './signing.ts'
import { PublisherStore } from './publishers.ts'
import { LocalPluginTelemetry } from './telemetry.ts'

export interface CatalogVersion {
  version: string
  download: string
  mirrors?: string[]
  channels?: string[]
  rollout?: number
  sha256?: string
  signature?: string | SignatureEnvelope
  changelog?: string
  compatibility?: {
    host?: string
    platforms?: string[]
  }
}

export interface CatalogPublisher {
  id: string
  name: string
  keyId?: string
}

export interface CatalogPlugin {
  id: string
  name: string
  description?: string
  tags?: string[]
  publisher?: CatalogPublisher
  versions: CatalogVersion[]
}

export interface RevocationEntry {
  pluginId?: string
  version?: string
  sha256?: string
  keyId?: string
  reason?: string
}

export interface RevocationList {
  version: 1
  updatedAt?: number
  entries: RevocationEntry[]
}

export interface PluginCatalog {
  version: 1
  name: string
  updatedAt?: number
  plugins: CatalogPlugin[]
}

export interface CatalogUpdate {
  pluginId: string
  name: string
  installed: string
  available: string
  download: string
  sha256?: string
  channel: string
}

export interface SignedCatalogOptions {
  signature?: string
  trustStore?: string
  requireSignature?: boolean
}

export function validateCatalog(input: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const catalog = input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined
  if (!catalog || catalog.version !== 1) errors.push('catalog.version 必须为 1')
  if (!nonEmpty(catalog?.name)) errors.push('catalog 缺少 name')
  if (!Array.isArray(catalog?.plugins)) errors.push('catalog.plugins 必须是数组')
  else {
    const ids = new Set<string>()
    for (const [index, raw] of catalog.plugins.entries()) {
      const plugin = raw as Record<string, unknown>
      if (!nonEmpty(plugin?.id)) errors.push(`plugins[${index}] 缺少 id`)
      else if (ids.has(plugin.id)) errors.push(`catalog 插件 id 重复: ${plugin.id}`)
      else ids.add(plugin.id)
      if (!nonEmpty(plugin?.name)) errors.push(`plugins[${index}] 缺少 name`)
      if (!Array.isArray(plugin?.versions) || plugin.versions.length === 0) {
        errors.push(`plugins[${index}].versions 必须是非空数组`)
        continue
      }
      const versions = new Set<string>()
      for (const [vIndex, value] of plugin.versions.entries()) {
        const version = value as Record<string, unknown>
        if (!nonEmpty(version?.version)) errors.push(`plugins[${index}].versions[${vIndex}] 缺少 version`)
        else if (versions.has(version.version)) errors.push(`plugins[${index}] 版本重复: ${version.version}`)
        else versions.add(version.version)
        if (!nonEmpty(version?.download)) errors.push(`plugins[${index}].versions[${vIndex}] 缺少 download`)
        if (version?.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(version.sha256))) {
          errors.push(`plugins[${index}].versions[${vIndex}] sha256 格式错误`)
        }
        const rollout = version?.rollout
        if (rollout !== undefined && (typeof rollout !== 'number' || !Number.isInteger(rollout) || rollout < 0 || rollout > 100)) {
          errors.push(`plugins[${index}].versions[${vIndex}] rollout 必须是 0-100 的整数`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export async function loadCatalog(source: string): Promise<PluginCatalog> {
  const raw = await readSource(source, 2 * 1024 * 1024)
  let data: unknown
  try { data = JSON.parse(raw) } catch { throw new Error('catalog 不是合法 JSON') }
  const report = validateCatalog(data)
  if (!report.ok) throw new Error(`catalog 校验失败:\n${report.errors.join('\n')}`)
  return data as PluginCatalog
}

export function searchCatalog(catalog: PluginCatalog, query: string): CatalogPlugin[] {
  const q = query.trim().toLowerCase()
  if (!q) return catalog.plugins
  return catalog.plugins.filter((plugin) => {
    const text = [plugin.id, plugin.name, plugin.description, ...(plugin.tags ?? [])].join('\n').toLowerCase()
    return text.includes(q)
  })
}

export function latestVersion(plugin: CatalogPlugin, channel = 'stable', rolloutKey = ''): CatalogVersion {
  const versions = plugin.versions
    .filter((item) => inChannel(item, channel))
    .filter((item) => {
      const rollout = typeof item.rollout === 'number' ? item.rollout : 100
      return rollout >= 100 || rolloutBucket(plugin.id, item.version, rolloutKey) < rollout
    })
    .sort((a, b) => compareVersions(b.version, a.version))
  const first = versions[0]
  if (!first) throw new Error(`插件 ${plugin.id} 在 ${channel} 通道没有可用版本`)
  return first
}

export function resolveVersion(plugin: CatalogPlugin, version?: string, channel = 'stable', rolloutKey = ''): CatalogVersion {
  if (!version) return latestVersion(plugin, channel, rolloutKey)
  const hit = plugin.versions.find((item) => item.version === version)
  if (!hit) throw new Error(`插件 ${plugin.id} 没有版本 ${version}`)
  if (!inChannel(hit, channel)) throw new Error(`插件 ${plugin.id}@${version} 不在 ${channel} 通道`)
  const rollout = typeof hit.rollout === 'number' ? hit.rollout : 100
  if (rollout < 100 && rolloutBucket(plugin.id, hit.version, rolloutKey) >= rollout) {
    throw new Error(`插件 ${plugin.id}@${version} 当前灰度 ${rollout}%，当前标识不在灰度范围`)
  }
  return hit
}

function inChannel(version: CatalogVersion, channel: string): boolean {
  if (!version.channels || version.channels.length === 0) return channel === 'stable'
  return version.channels.includes(channel)
}

export function findUpdates(profileDir: string, catalog: PluginCatalog, channel = 'stable', rolloutKey = profileDir): CatalogUpdate[] {
  const installed = new ProfileStore(profileDir).init().pkg.meng?.profile?.plugins ?? {}
  const bundles = new ProfileStore(profileDir).list()
  const out: CatalogUpdate[] = []
  for (const item of bundles) {
    const plugin = catalog.plugins.find((entry) => entry.id === item.name || entry.id === item.config.id)
    if (!plugin) continue
    const current = typeof item.config.version === 'string'
      ? item.config.version
      : (typeof item.version === 'string' && item.version ? item.version : installed[item.name]?.version)
    if (typeof current !== 'string' || !current) continue
    const selectedChannel = typeof item.config.channel === 'string' ? item.config.channel : channel
    const latest = latestVersion(plugin, selectedChannel, typeof item.config.rolloutKey === 'string' ? item.config.rolloutKey : rolloutKey)
    if (compareVersions(latest.version, current) <= 0) continue
    out.push({
      pluginId: plugin.id,
      name: plugin.name,
      installed: current,
      available: latest.version,
      download: latest.download,
      ...(latest.sha256 ? { sha256: latest.sha256 } : {}),
      channel: selectedChannel,
    })
  }
  return out
}

export interface CatalogInstallOptions {
  version?: string
  channel?: string
  rolloutKey?: string
  trustStore?: string
  requireSignature?: boolean
  catalogSignature?: SignatureEnvelope
  requireCatalogSignature?: boolean
  revocations?: RevocationList
  publisherStore?: string
  telemetryDir?: string
}

export async function installFromCatalog(
  profileDir: string,
  catalogSource: string,
  pluginId: string,
  options: CatalogInstallOptions = {},
): Promise<InstallResult> {
  const catalog = await loadCatalog(catalogSource)
  if (options.requireCatalogSignature || options.catalogSignature) {
    if (!options.catalogSignature || !options.trustStore) throw new Error('目录签名校验需要 catalogSignature 与 trustStore')
    verifyFileSignature(catalogSource, options.catalogSignature, readTrustStore(options.trustStore), 'catalog')
  }
  const plugin = catalog.plugins.find((entry) => entry.id === pluginId)
  if (!plugin) throw new Error(`catalog 中没有插件 ${pluginId}`)
  if (options.publisherStore) {
    if (!plugin.publisher) throw new Error(`插件 ${plugin.id} 未声明发布者`)
    const publisher = new PublisherStore(options.publisherStore).get(plugin.publisher.id)
    if (!publisher || publisher.status !== 'active') throw new Error(`发布者不可用: ${plugin.publisher.id}`)
    if (plugin.publisher.keyId && publisher.keyId !== plugin.publisher.keyId) throw new Error('发布者 keyId 与目录声明不一致')
  }
  const version = resolveVersion(plugin, options.version, options.channel ?? 'stable', options.rolloutKey ?? '')
  if (isRevoked(plugin, version, options.revocations)) throw new Error(`插件 ${plugin.id}@${version.version} 已被撤销`)
  const temp = mkdtempSync(join(tmpdir(), 'meng-catalog-'))
  try {
    const archive = join(temp, `${basename(version.download) || pluginId}.tgz`)
    await copyWithMirrors([version.download, ...(version.mirrors ?? [])], archive)
    let signatureFile: string | undefined
    if (version.signature) {
      signatureFile = join(temp, 'plugin.sig.json')
      if (typeof version.signature === 'string') {
        const text = await readSource(version.signature, 1024 * 1024)
        writeFileSync(signatureFile, text)
      } else {
        writeFileSync(signatureFile, `${JSON.stringify(version.signature, null, 2)}\n`)
      }
    }
    if (options.requireSignature && (!signatureFile || !options.trustStore)) {
      throw new Error('catalog 强制签名安装需要 signature 与 trustStore')
    }
    if (signatureFile && options.trustStore) {
      const envelope = readSignature(signatureFile)
      if (plugin.publisher?.keyId && envelope.keyId !== plugin.publisher.keyId) {
        throw new Error(`发布者 keyId 不匹配: catalog=${plugin.publisher.keyId} signature=${envelope.keyId}`)
      }
      verifyArchiveSignature(archive, envelope, readTrustStore(options.trustStore))
    }
    const installed = await installArchive(profileDir, archive, {
      ...(version.sha256 ? { expectedSha256: version.sha256 } : {}),
      ...(signatureFile ? { signature: signatureFile } : {}),
      ...(options.trustStore ? { trustStore: options.trustStore } : {}),
      ...(options.requireSignature ? { requireSignature: true } : {}),
    })
    if (options.telemetryDir) {
      new LocalPluginTelemetry(options.telemetryDir).record({
        type: installed.previousVersion ? 'update' : 'install',
        pluginId: plugin.id,
        version: installed.version,
        channel: options.channel ?? 'stable',
      })
    }
    return installed
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export async function loadSignedCatalog(source: string, options: SignedCatalogOptions): Promise<PluginCatalog> {
  if (options.requireSignature || options.signature) {
    if (!options.signature || !options.trustStore) throw new Error('目录签名校验需要 signature 与 trustStore')
    verifyFileSignature(source, readSignature(options.signature), readTrustStore(options.trustStore), 'catalog')
  }
  return await loadCatalog(source)
}

export function validateRevocations(input: unknown): { ok: boolean; errors: string[] } {
  const list = input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined
  const errors: string[] = []
  if (!list || list.version !== 1) errors.push('revocations.version 必须为 1')
  if (!Array.isArray(list?.entries)) errors.push('revocations.entries 必须是数组')
  else {
    for (const [index, raw] of list.entries.entries()) {
      const entry = raw as Record<string, unknown>
      if (!entry || (!nonEmpty(entry.pluginId) && !nonEmpty(entry.sha256) && !nonEmpty(entry.keyId))) {
        errors.push(`revocations.entries[${index}] 至少需要 pluginId / sha256 / keyId 之一`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export function isRevoked(plugin: CatalogPlugin, version: CatalogVersion, revocations?: RevocationList): boolean {
  if (!revocations) return false
  return revocations.entries.some((entry) => {
    if (entry.pluginId && entry.pluginId !== plugin.id) return false
    if (entry.version && entry.version !== version.version) return false
    if (entry.sha256 && entry.sha256.toLowerCase() !== (version.sha256 ?? '').toLowerCase()) return false
    if (entry.keyId && entry.keyId !== plugin.publisher?.keyId) return false
    return true
  })
}

export function rolloutBucket(pluginId: string, version: string, key: string): number {
  const input = `${pluginId}\0${version}\0${key}`
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 100
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const clean = value.trim().replace(/^v/, '').split('+')[0] ?? ''
    const parts = clean.split('-', 2)
    const core = parts[0] ?? ''
    const pre = parts[1] ?? ''
    return { core: core.split('.').map((n) => Number(n) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre.localeCompare(right.pre, undefined, { numeric: true })
}

async function readSource(source: string, maxBytes: number): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`读取 ${source} 失败: ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > maxBytes) throw new Error(`资源超过上限 ${maxBytes} bytes`)
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`资源超过上限 ${maxBytes} bytes`)
    return text
  }
  const file = source.startsWith('file:') ? new URL(source) : resolve(source)
  const path = typeof file === 'string' ? file : file
  if (!existsSync(path)) throw new Error(`文件不存在: ${String(path)}`)
  if (statSync(path).size > maxBytes) throw new Error(`资源超过上限 ${maxBytes} bytes`)
  return readFileSync(path, 'utf8')
}

async function copySource(source: string, output: string): Promise<void> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`下载 ${source} 失败: ${response.status}`)
    writeFileSync(output, Buffer.from(await response.arrayBuffer()))
    return
  }
  const file = source.startsWith('file:') ? new URL(source) : resolve(source)
  const path = typeof file === 'string' ? file : file
  if (!existsSync(path)) throw new Error(`文件不存在: ${String(path)}`)
  writeFileSync(output, readFileSync(path))
}

async function copyWithMirrors(sources: string[], output: string): Promise<void> {
  let last: unknown
  for (const source of sources.filter(Boolean)) {
    try {
      await copySource(source, output)
      return
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('所有下载镜像均失败')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
