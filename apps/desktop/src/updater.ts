import { createHash, verify } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { app, Notification } from 'electron'

const UPDATE_MANIFESTS = [
  process.env['MENG_UPDATE_MANIFEST'] ?? '',
  'https://cdn.jsdelivr.net/gh/linchui0925-creator/meng-agent@main/desktop/latest.json',
  'https://raw.githubusercontent.com/linchui0925-creator/meng-agent/main/desktop/latest.json',
].filter(Boolean)

const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA24ijxUOlMHYB5HX92wv61ZMKlq4o1Kq0YGilp42kpMs=
-----END PUBLIC KEY-----`

export interface UpdateManifest {
  version: string
  download: string
  mirrors?: string[]
  sha256: string
  size?: number
  publishedAt?: number
  notes?: string
  arch?: string[]
  signature: string
}

interface StagedUpdate {
  version: string
  sourceApp: string
  targetApp: string
  workDir: string
}

let staged: StagedUpdate | undefined
let checking: Promise<{ status: string; version?: string }> | undefined

export function hasStagedUpdate(): boolean {
  return staged !== undefined
}

export async function checkForDesktopUpdate(): Promise<{ status: string; version?: string }> {
  if (!app.isPackaged || process.env['MENG_DISABLE_UPDATES'] === '1') return { status: 'disabled' }
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' }
  if (staged) return { status: 'staged', version: staged.version }

  checking ??= runCheck().finally(() => { checking = undefined })
  return await checking
}

export function installStagedUpdate(): boolean {
  if (!staged) return false
  const current = staged
  const script = join(current.workDir, 'install.sh')
  writeFileSync(script, installScript(), { mode: 0o700 })
  const child = spawn('/bin/sh', [script, current.targetApp, current.sourceApp, current.workDir], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  staged = undefined
  return true
}

async function runCheck(): Promise<{ status: string; version?: string }> {
  try {
    const manifest = await fetchManifest()
    if (!manifest) return { status: 'no-manifest' }
    if (!isNewer(manifest.version, app.getVersion())) return { status: 'current', version: app.getVersion() }
    if (manifest.arch && manifest.arch.length > 0 && !manifest.arch.includes(process.arch)) {
      return { status: 'incompatible-arch', version: manifest.version }
    }

    const root = join(app.getPath('userData'), 'updates', safeVersion(manifest.version))
    const archive = join(root, 'update.zip')
    const extracted = join(root, 'extracted')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(extracted, { recursive: true })

    await download(manifest, archive)
    verifySha256(archive, manifest.sha256)
    await extractZip(archive, extracted)

    const sourceApp = findAppBundle(extracted)
    if (!sourceApp) throw new Error('更新包中没有找到 .app')
    const packedVersion = bundleVersion(sourceApp)
    if (packedVersion && packedVersion !== manifest.version) {
      throw new Error(`更新包版本不一致: 清单 ${manifest.version}, 包内 ${packedVersion}`)
    }

    const targetApp = currentBundle()
    if (!targetApp) throw new Error('无法定位当前应用包')
    accessSync(dirname(targetApp), constants.W_OK)

    staged = { version: manifest.version, sourceApp, targetApp, workDir: root }
    notify('梦更新已下载', `版本 ${manifest.version} 将在退出梦时自动替换并重新打开。`)
    return { status: 'staged', version: manifest.version }
  } catch (error) {
    console.warn('[desktop/update] 检查失败:', error)
    return { status: 'error' }
  }
}

async function fetchManifest(): Promise<UpdateManifest | undefined> {
  let last: unknown
  for (const url of UPDATE_MANIFESTS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = await response.json() as UpdateManifest
      validateManifest(manifest)
      verifyManifest(manifest)
      return manifest
    } catch (error) {
      last = error
    }
  }
  if (last) console.warn('[desktop/update] 所有清单地址不可用:', last)
  return undefined
}

function validateManifest(value: UpdateManifest): void {
  if (!value || typeof value !== 'object') throw new Error('更新清单格式错误')
  if (!value.version || !value.download || !value.sha256 || !value.signature) throw new Error('更新清单缺少字段')
  if (!/^[a-f0-9]{64}$/i.test(value.sha256)) throw new Error('更新清单 SHA-256 非法')
  if (!/^https:\/\//i.test(value.download)) throw new Error('更新地址必须使用 HTTPS')
  for (const mirror of value.mirrors ?? []) {
    if (!/^https:\/\//i.test(mirror)) throw new Error('更新镜像必须使用 HTTPS')
  }
}

function verifyManifest(value: UpdateManifest): void {
  const payload = manifestPayload(value)
  if (!verify(null, Buffer.from(payload), UPDATE_PUBLIC_KEY, Buffer.from(value.signature, 'base64'))) {
    throw new Error('更新清单签名无效')
  }
}

export function manifestPayload(value: Pick<UpdateManifest, 'version' | 'download' | 'sha256' | 'size' | 'publishedAt' | 'arch'>): string {
  return JSON.stringify({
    version: value.version,
    download: value.download,
    sha256: value.sha256.toLowerCase(),
    size: value.size ?? null,
    publishedAt: value.publishedAt ?? null,
    arch: value.arch ?? null,
  })
}

async function download(manifest: UpdateManifest, target: string): Promise<void> {
  let last: unknown
  for (const source of [manifest.download, ...(manifest.mirrors ?? [])]) {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'meng-desktop-updater' }
      if (new URL(source).hostname === 'api.github.com') {
        headers['Accept'] = 'application/octet-stream'
        headers['X-GitHub-Api-Version'] = '2022-11-28'
      }
      const response = await fetch(source, { headers, signal: AbortSignal.timeout(180_000), redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      if (manifest.size !== undefined && data.byteLength !== manifest.size) {
        throw new Error(`下载大小不匹配: ${data.byteLength} != ${manifest.size}`)
      }
      writeFileSync(target, data, { mode: 0o600 })
      return
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('更新下载失败')
}

function verifySha256(file: string, expected: string): void {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA-256 不匹配: ${actual}`)
}

function extractZip(archive: string, target: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ditto', ['-x', '-k', archive, target], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`ditto 解压失败: ${code}`)))
  })
}

function currentBundle(): string | undefined {
  let path = app.getPath('exe')
  for (let i = 0; i < 5; i++) {
    if (path.endsWith('.app')) return path
    const parent = dirname(path)
    if (parent === path) break
    path = parent
  }
  return undefined
}

function findAppBundle(root: string): string | undefined {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.endsWith('.app')) return path
  }
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    try {
      const nested = findAppBundle(path)
      if (nested) return nested
    } catch { /* 忽略非目录 */ }
  }
  return undefined
}

function bundleVersion(bundle: string): string | undefined {
  try {
    const plist = join(bundle, 'Contents', 'Info.plist')
    const version = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return version || undefined
  } catch {
    return undefined
  }
}

function installScript(): string {
  return `#!/bin/sh
set -eu
sleep 1
target="$1"
source="$2"
stage="$3"
backup="\${target}.old-$$"
rm -rf "$backup"
if [ -e "$target" ]; then mv "$target" "$backup"; fi
if ditto "$source" "$target"; then
  rm -rf "$backup"
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  open "$target"
  rm -rf "$stage"
  exit 0
fi
rm -rf "$target"
if [ -e "$backup" ]; then mv "$backup" "$target"; fi
open "$target" 2>/dev/null || true
exit 1
`
}

function safeVersion(version: string): string {
  return version.replace(/[^0-9A-Za-z._-]/g, '_')
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

function parseVersion(value: string): number[] {
  return value.replace(/^v/, '').split('-')[0]?.split('.').map((part) => Number(part) || 0) ?? []
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}
