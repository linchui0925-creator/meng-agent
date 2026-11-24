import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type SignatureDomain = 'plugin' | 'catalog' | 'revocations'

export interface SignatureEnvelope {
  version: 1
  algorithm: 'ed25519'
  domain?: SignatureDomain
  keyId: string
  sha256: string
  createdAt: number
  signature: string
}

export interface TrustStore {
  version: 1
  keys: Record<string, {
    publicKey: string
    name?: string
    addedAt?: number
  }>
}

export interface SigningKey {
  keyId: string
  privateKey: string
  publicKey: string
}

export function publicKeyId(publicKey: string): string {
  return keyIdOf(publicKey)
}

export function generateSigningKey(comment = 'meng plugin signing key'): SigningKey {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return {
    keyId: keyIdOf(pair.publicKey),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  }
}

export function signArchive(archive: string, privateKey: string, keyId?: string): SignatureEnvelope {
  return signFile(archive, privateKey, keyId, 'plugin')
}

export function signFile(
  file: string,
  privateKey: string,
  keyId?: string,
  domain: SignatureDomain = 'plugin',
): SignatureEnvelope {
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
  const sha256 = sha256Of(path)
  const createdAt = Date.now()
  const payload = payloadOf(sha256, createdAt, domain)
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64')
  return {
    version: 1,
    algorithm: 'ed25519',
    domain,
    keyId: keyId?.trim() || keyIdOfPublicFromPrivate(privateKey),
    sha256,
    createdAt,
    signature,
  }
}

export function writeSignature(archive: string, envelope: SignatureEnvelope, output?: string): string {
  const file = output ? resolve(output) : `${resolve(archive)}.sig.json`
  writeAtomic(file, `${JSON.stringify(envelope, null, 2)}\n`)
  return file
}

export function readSignature(file: string): SignatureEnvelope {
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as SignatureEnvelope
  if (raw.version !== 1 || raw.algorithm !== 'ed25519') throw new Error('签名文件版本或算法不受支持')
  if (!raw.keyId || !raw.sha256 || !raw.signature) throw new Error('签名文件缺少 keyId / sha256 / signature')
  return raw
}

export function readTrustStore(file: string): TrustStore {
  if (!existsSync(file)) return { version: 1, keys: {} }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as TrustStore
  if (raw.version !== 1 || !raw.keys || typeof raw.keys !== 'object') throw new Error('信任密钥库格式不合法')
  return raw
}

export function addTrustedKey(file: string, publicKey: string, options: { keyId?: string; name?: string } = {}): string {
  const store = readTrustStore(file)
  const id = options.keyId?.trim() || keyIdOf(publicKey)
  store.keys[id] = {
    publicKey,
    ...(options.name ? { name: options.name } : {}),
    addedAt: Date.now(),
  }
  writeAtomic(resolve(file), `${JSON.stringify(store, null, 2)}\n`)
  return id
}

export function verifyArchiveSignature(archive: string, envelope: SignatureEnvelope, store: TrustStore): void {
  verifyFileSignature(archive, envelope, store, 'plugin')
}

export function verifyFileSignature(
  file: string,
  envelope: SignatureEnvelope,
  store: TrustStore,
  domain: SignatureDomain = 'plugin',
): void {
  const path = resolve(file)
  const actual = sha256Of(path)
  if (actual !== envelope.sha256) throw new Error(`签名文件 SHA-256 不匹配: 期望 ${envelope.sha256}，实际 ${actual}`)
  if ((envelope.domain ?? 'plugin') !== domain) throw new Error(`签名域不匹配: 期望 ${domain}，实际 ${envelope.domain ?? 'plugin'}`)
  const key = store.keys[envelope.keyId]
  if (!key) throw new Error(`签名 keyId ${envelope.keyId} 不在信任密钥库中`)
  const ok = verify(
    null,
    Buffer.from(payloadOf(envelope.sha256, envelope.createdAt, domain)),
    key.publicKey,
    Buffer.from(envelope.signature, 'base64'),
  )
  if (!ok) throw new Error(`${domain} 签名校验失败: keyId ${envelope.keyId}`)
}

export function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function keyIdOf(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16)
}

function keyIdOfPublicFromPrivate(privateKey: string): string {
  const publicKey = createPublicKey({ key: privateKey, format: 'pem' }).export({ type: 'spki', format: 'pem' }).toString()
  return keyIdOf(publicKey)
}

function payloadOf(sha256: string, createdAt: number, domain: SignatureDomain): string {
  return `meng-${domain}\nv1\ned25519\n${sha256}\n${createdAt}`
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
