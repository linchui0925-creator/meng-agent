import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { publicKeyId, type TrustStore } from './signing.ts'

export interface PublisherRecord {
  id: string
  name: string
  keyId: string
  publicKey: string
  status: 'active' | 'suspended'
  roles: string[]
  createdAt: number
}

export interface PublisherFile {
  version: 1
  publishers: PublisherRecord[]
}

export class PublisherStore {
  readonly file: string

  constructor(file: string) {
    this.file = resolve(file)
  }

  read(): PublisherFile {
    if (!existsSync(this.file)) return { version: 1, publishers: [] }
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as PublisherFile
    if (raw.version !== 1 || !Array.isArray(raw.publishers)) throw new Error('发布者文件格式不合法')
    for (const publisher of raw.publishers) validatePublisher(publisher)
    return raw
  }

  list(): PublisherRecord[] {
    return this.read().publishers
  }

  get(id: string): PublisherRecord | undefined {
    return this.read().publishers.find((item) => item.id === id)
  }

  add(input: { id: string; name: string; publicKey: string; keyId?: string; roles?: string[] }): PublisherRecord {
    const id = input.id.trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error('发布者 id 不合法')
    const actualKeyId = publicKeyId(input.publicKey)
    const keyId = input.keyId?.trim() || actualKeyId
    if (keyId !== actualKeyId) throw new Error(`发布者 keyId 与公钥不匹配: ${keyId} != ${actualKeyId}`)
    const data = this.read()
    if (data.publishers.some((item) => item.id === id)) throw new Error(`发布者已存在: ${id}`)
    if (data.publishers.some((item) => item.keyId === keyId)) throw new Error(`发布者公钥已存在: ${keyId}`)
    const record: PublisherRecord = {
      id,
      name: input.name.trim() || id,
      keyId,
      publicKey: input.publicKey,
      status: 'active',
      roles: input.roles ?? ['publisher'],
      createdAt: Date.now(),
    }
    data.publishers.push(record)
    this.write(data)
    return record
  }

  suspend(id: string, suspended = true): PublisherRecord {
    const data = this.read()
    const publisher = data.publishers.find((item) => item.id === id)
    if (!publisher) throw new Error(`发布者不存在: ${id}`)
    publisher.status = suspended ? 'suspended' : 'active'
    this.write(data)
    return publisher
  }

  trustStore(options: { activeOnly?: boolean } = {}): TrustStore {
    return {
      version: 1,
      keys: Object.fromEntries(this.read().publishers
        .filter((publisher) => options.activeOnly !== true || publisher.status === 'active')
        .map((publisher) => [publisher.keyId, {
          publicKey: publisher.publicKey,
          name: publisher.name,
          addedAt: publisher.createdAt,
        }])),
    }
  }

  private write(data: PublisherFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmp, this.file)
  }
}

function validatePublisher(publisher: PublisherRecord): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(publisher.id)) throw new Error('发布者 id 不合法')
  if (!publisher.name.trim()) throw new Error('发布者名称不能为空')
  if (!publisher.publicKey.trim()) throw new Error('发布者公钥不能为空')
  if (publisher.keyId !== publicKeyId(publisher.publicKey)) throw new Error('发布者 keyId 与公钥不匹配')
  if (publisher.status !== 'active' && publisher.status !== 'suspended') throw new Error('发布者状态不合法')
  if (!Array.isArray(publisher.roles)) throw new Error('发布者 roles 必须是数组')
}
