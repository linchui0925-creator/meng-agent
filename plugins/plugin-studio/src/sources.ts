import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface OfficialSource {
  id: string
  name: string
  catalog: string
  signature?: string
  trustStore?: string
  priority: number
  enabled: boolean
  mirrors?: string[]
}

export interface SourceFile {
  version: 1
  sources: OfficialSource[]
}

export interface OfficialSourcePatch {
  name?: string
  catalog?: string
  signature?: string
  trustStore?: string
  priority?: number
  enabled?: boolean
  mirrors?: string[]
}

export class OfficialSourceStore {
  readonly file: string

  constructor(file: string) {
    this.file = resolve(file)
  }

  read(): SourceFile {
    if (!existsSync(this.file)) return { version: 1, sources: [] }
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SourceFile
    if (raw.version !== 1 || !Array.isArray(raw.sources)) throw new Error('官方源文件格式不合法')
    for (const source of raw.sources) validateSource(source)
    return raw
  }

  add(input: Omit<OfficialSource, 'enabled' | 'priority'> & { enabled?: boolean; priority?: number }): OfficialSource {
    validateSource({ ...input, priority: input.priority ?? 100, enabled: input.enabled !== false })
    const data = this.read()
    if (data.sources.some((item) => item.id === input.id)) throw new Error(`官方源已存在: ${input.id}`)
    const source: OfficialSource = {
      id: input.id,
      name: input.name || input.id,
      catalog: input.catalog,
      ...(input.signature ? { signature: input.signature } : {}),
      ...(input.trustStore ? { trustStore: input.trustStore } : {}),
      priority: input.priority ?? 100,
      enabled: input.enabled !== false,
      ...(input.mirrors ? { mirrors: [...input.mirrors] } : {}),
    }
    data.sources.push(source)
    this.write(data)
    return source
  }

  set(id: string, patch: OfficialSourcePatch): OfficialSource {
    const data = this.read()
    const source = data.sources.find((item) => item.id === id)
    if (!source) throw new Error(`官方源不存在: ${id}`)
    if (patch.name !== undefined) source.name = patch.name
    if (patch.catalog !== undefined) source.catalog = patch.catalog
    if (patch.signature !== undefined) source.signature = patch.signature
    if (patch.trustStore !== undefined) source.trustStore = patch.trustStore
    if (patch.priority !== undefined) source.priority = patch.priority
    if (patch.enabled !== undefined) source.enabled = patch.enabled
    if (patch.mirrors !== undefined) source.mirrors = [...patch.mirrors]
    validateSource(source)
    this.write(data)
    return source
  }

  remove(id: string): void {
    const data = this.read()
    const next = data.sources.filter((item) => item.id !== id)
    if (next.length === data.sources.length) throw new Error(`官方源不存在: ${id}`)
    data.sources = next
    this.write(data)
  }

  get(id: string): OfficialSource | undefined {
    return this.read().sources.find((item) => item.id === id)
  }

  list(): OfficialSource[] {
    return this.read().sources.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  primary(): OfficialSource | undefined {
    return this.list().find((item) => item.enabled)
  }

  private write(data: SourceFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmp, this.file)
  }
}

function validateSource(source: OfficialSource): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(source.id)) throw new Error('官方源 id 不合法')
  if (!source.name.trim()) throw new Error('官方源名称不能为空')
  if (!source.catalog.trim()) throw new Error('官方源 catalog 不能为空')
  if (!Number.isFinite(source.priority)) throw new Error('官方源 priority 必须是数字')
  if (typeof source.enabled !== 'boolean') throw new Error('官方源 enabled 必须是布尔值')
  if (source.mirrors?.some((item) => !item.trim())) throw new Error('官方源镜像地址不能为空')
}
