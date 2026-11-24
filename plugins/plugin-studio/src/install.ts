import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { ProfileStore, type ProfilePackage } from '@meng/plugin-manifest'
import { readSignature, readTrustStore, verifyArchiveSignature } from './signing.ts'
import { validatePlugin } from './validate.ts'
import { verifyPluginPackage } from './package.ts'

export interface InstallResult {
  profile: string
  name: string
  version: string
  pluginId: string
  transactionId: string
  previousVersion?: string
  enabled: boolean
  sha256: string
}

export interface UninstallResult {
  profile: string
  name: string
  pluginId: string
  version: string
  transactionId: string
  dataPreserved: true
}

export interface RollbackResult {
  profile: string
  transactionId: string
  name: string
  restored: boolean
}

interface InstallMeta {
  id: string
  name: string
  pluginId: string
  version: string
  previousVersion?: string
  previousExists: boolean
  at: number
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const execFileAsync = promisify(execFile)
const LOCK_TTL_MS = 10 * 60 * 1000

/**
 * 安装自包含插件包：不联网、不解析第三方依赖。
 *
 * 适用前提：tgz 已经包含完整运行内容（dist/client/runtime 等）。
 * 有 dependencies 的包应交给后续 package-manager installer，而不是假装装成功。
 */
export interface InstallOptions {
  expectedSha256?: string
  signature?: string
  trustStore?: string
  requireSignature?: boolean
}

export async function installArchive(profileDir: string, archive: string, options: InstallOptions = {}): Promise<InstallResult> {
  return withProfileLock(profileDir, () => installArchiveUnlocked(profileDir, archive, options))
}

async function installArchiveUnlocked(profileDir: string, archive: string, options: InstallOptions): Promise<InstallResult> {
  const profile = resolve(profileDir)
  const file = resolve(archive)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`插件包不存在: ${file}`)
  const sha256 = verifyDigest(file, options.expectedSha256)
  verifySignatureIfNeeded(file, options)

  const verified = await verifyPluginPackage(file)
  if (!verified.ok) throw new Error(`插件包校验失败:\n${verified.details.join('\n')}`)

  const unpack = mkdtempSync(join(tmpdir(), 'meng-install-'))
  let transaction: string | undefined
  try {
    const packageDir = extractPackage(file, unpack)
    const pkg = readPackage(packageDir)
    const name = String(pkg.name ?? '')
    const version = String(pkg.version ?? '')
    if (!PACKAGE_NAME.test(name)) throw new Error(`插件包名非法: ${name || '(空)'}`)
    if (!version.trim()) throw new Error('插件包缺少 version')
    const pluginId = pluginIdOf(pkg)
    const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies as Record<string, unknown>)
      : []
    if (dependencies.length > 0) {
      throw new Error(`插件包含运行依赖 [${dependencies.join(', ')}]；请使用 package-manager installer，不能按自包含包安装`)
    }

    const store = new ProfileStore(profile)
    store.init()
    const before = store.list().find((item) => item.name === name)
    transaction = createTransaction(profile, {
      id: `${Date.now()}-${pluginId}`,
      name,
      pluginId,
      version,
      ...(before ? { previousVersion: before.version } : {}),
      previousExists: existsSync(targetOf(profile, name)),
      at: Date.now(),
    })
    backupProfile(profile, transaction)
    const target = targetOf(profile, name)
    if (existsSync(target)) renameSync(target, join(transaction, 'previous-package'))

    const staging = join(dirname(target), `.${basename(target)}.installing-${process.pid}-${Date.now()}`)
    mkdirSync(dirname(staging), { recursive: true })
    cpSync(packageDir, staging, { recursive: true })
    renameSync(staging, target)
    store.add(name, version, { enabled: true })
    return {
      profile,
      name,
      version,
      pluginId,
      transactionId: basename(transaction),
      ...(before ? { previousVersion: before.version } : {}),
      enabled: true,
      sha256,
    }
  } catch (error) {
    if (transaction) restoreTransaction(profile, transaction)
    throw error
  } finally {
    rmSync(unpack, { recursive: true, force: true })
  }
}

export interface PackageInstallOptions {
  allowNetwork?: boolean
  npmCache?: string
  packageManager?: 'npm' | 'pnpm'
  registry?: string
  expectedSha256?: string
  signature?: string
  trustStore?: string
  requireSignature?: boolean
}

/**
 * 包管理器安装：适合带 dependencies 的自包含产物。
 * 依赖先写入 profile，再交给 npm 安装；任何失败都恢复事务备份。
 */
export async function installPackage(
  profileDir: string,
  archive: string,
  options: PackageInstallOptions = {},
): Promise<InstallResult> {
  return withProfileLock(profileDir, () => installPackageUnlocked(profileDir, archive, options))
}

async function installPackageUnlocked(
  profileDir: string,
  archive: string,
  options: PackageInstallOptions,
): Promise<InstallResult> {
  const profile = resolve(profileDir)
  const file = resolve(archive)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`插件包不存在: ${file}`)
  const sha256 = verifyDigest(file, options.expectedSha256)
  verifySignatureIfNeeded(file, options)
  const unpack = mkdtempSync(join(tmpdir(), 'meng-install-pm-'))
  let transaction: string | undefined
  try {
    const packageDir = extractPackage(file, unpack)
    const pkg = readPackage(packageDir)
    const name = String(pkg.name ?? '')
    const version = String(pkg.version ?? '')
    if (!PACKAGE_NAME.test(name)) throw new Error(`插件包名非法: ${name || '(空)'}`)
    if (!version.trim()) throw new Error('插件包缺少 version')
    const pluginId = pluginIdOf(pkg)
    const deps = pkg.dependencies && typeof pkg.dependencies === 'object'
      ? Object.entries(pkg.dependencies as Record<string, unknown>)
      : []
    const needsNetwork = deps.some(([, spec]) => {
      const text = String(spec)
      return !text.startsWith('file:') && !text.startsWith('link:') && !text.startsWith('.') && !text.startsWith('/')
    })
    if (needsNetwork && options.allowNetwork !== true) {
      throw new Error('插件依赖需要联网安装；请显式设置 allowNetwork=true')
    }

    const store = new ProfileStore(profile)
    store.init()
    const before = store.list().find((item) => item.name === name)
    transaction = createTransaction(profile, {
      id: `${Date.now()}-pm-${pluginId}`,
      name,
      pluginId,
      version,
      ...(before ? { previousVersion: before.version } : {}),
      previousExists: existsSync(targetOf(profile, name)),
      at: Date.now(),
    })
    backupProfile(profile, transaction)
    const target = targetOf(profile, name)
    if (existsSync(target)) renameSync(target, join(transaction, 'previous-package'))

    const spec = `file:${file}`
    store.add(name, spec, { enabled: true, version })
    const env = { ...process.env, ...(options.npmCache ? { npm_config_cache: options.npmCache } : {}) }
    const manager = options.packageManager ?? 'npm'
    const args = manager === 'pnpm'
      ? ['--ignore-workspace', 'install', '--ignore-scripts', '--no-frozen-lockfile', '--reporter=silent', '--config.auto-install-peers=false']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']
    if (options.registry) args.push(`--registry=${options.registry}`)
    await execFileAsync(manager, args, {
      cwd: profile,
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    })
    const installedPkg = readPackage(target)
    if (installedPkg.name !== name || installedPkg.version !== version) {
      throw new Error(`安装结果不匹配: 期望 ${name}@${version}，实际 ${String(installedPkg.name)}@${String(installedPkg.version)}`)
    }
    store.add(name, spec, { enabled: true, version })
    return {
      profile,
      name,
      version,
      pluginId,
      transactionId: basename(transaction),
      ...(before ? { previousVersion: before.version } : {}),
      enabled: true,
      sha256,
    }
  } catch (error) {
    if (transaction) restoreTransaction(profile, transaction)
    throw error
  } finally {
    rmSync(unpack, { recursive: true, force: true })
  }
}

export function uninstallPlugin(profileDir: string, name: string): UninstallResult {
  return withProfileLockSync(profileDir, () => uninstallPluginUnlocked(profileDir, name))
}

function uninstallPluginUnlocked(profileDir: string, name: string): UninstallResult {
  if (!PACKAGE_NAME.test(name)) throw new Error(`不是合法 npm 包名: ${name}`)
  const profile = resolve(profileDir)
  const store = new ProfileStore(profile)
  const installed = store.list().find((item) => item.name === name)
  if (!installed) throw new Error(`profile 未安装插件: ${name}`)
  const target = targetOf(profile, name)
  const pkg = existsSync(join(target, 'package.json')) ? readPackage(target) : undefined
  const pluginId = pkg ? pluginIdOf(pkg) : name
  const transaction = createTransaction(profile, {
    id: `${Date.now()}-uninstall-${pluginId}`,
    name,
    pluginId,
    version: installed.version,
    previousExists: existsSync(target),
    at: Date.now(),
  })
  backupProfile(profile, transaction)
  if (existsSync(target)) renameSync(target, join(transaction, 'previous-package'))
  store.remove(name)
  return {
    profile,
    name,
    pluginId,
    version: installed.version,
    transactionId: basename(transaction),
    dataPreserved: true,
  }
}

export function rollbackLast(profileDir: string, transactionId?: string): RollbackResult {
  return withProfileLockSync(profileDir, () => rollbackLastUnlocked(profileDir, transactionId))
}

function rollbackLastUnlocked(profileDir: string, transactionId?: string): RollbackResult {
  const profile = resolve(profileDir)
  const root = transactionsOf(profile)
  if (!existsSync(root)) throw new Error('没有可回滚的插件安装事务')
  const candidates = readdirSync(root).sort().reverse()
  const id = transactionId ?? candidates[0]
  if (!id) throw new Error('没有可回滚的插件安装事务')
  const transaction = join(root, id)
  if (!existsSync(transaction)) throw new Error(`事务不存在: ${id}`)
  const meta = readMeta(transaction)
  restoreTransaction(profile, transaction)
  if (meta.previousExists && existsSync(join(transaction, 'previous-package'))) {
    rmSync(transaction, { recursive: true, force: true })
  }
  return { profile, transactionId: id, name: meta.name, restored: true }
}

export async function withProfileLock<T>(profileDir: string, fn: () => Promise<T> | T): Promise<T> {
  const release = acquireLock(profileDir)
  try { return await fn() } finally { release() }
}

export function withProfileLockSync<T>(profileDir: string, fn: () => T): T {
  const release = acquireLock(profileDir)
  try { return fn() } finally { release() }
}

function acquireLock(profileDir: string): () => void {
  const dir = resolve(profileDir)
  const lockDir = join(dir, '.meng')
  const file = join(lockDir, 'plugin-install.lock')
  mkdirSync(lockDir, { recursive: true })
  try {
    const fd = openSync(file, 'wx')
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    if (e.code !== 'EEXIST') throw error
    let stale = false
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { at?: number }
      stale = typeof raw.at !== 'number' || Date.now() - raw.at > LOCK_TTL_MS
    } catch {
      stale = true
    }
    if (!stale) throw new Error('profile 正在执行另一个安装事务，请稍后重试')
    rmSync(file, { force: true })
    return acquireLock(dir)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    rmSync(file, { force: true })
  }
}

function verifySignatureIfNeeded(
  file: string,
  options: { signature?: string; trustStore?: string; requireSignature?: boolean },
): void {
  if (!options.requireSignature && !options.signature && !options.trustStore) return
  if (!options.signature || !options.trustStore) {
    throw new Error('强制签名安装需要同时提供 signature 与 trustStore')
  }
  verifyArchiveSignature(file, readSignature(options.signature), readTrustStore(options.trustStore))
}

function verifyDigest(file: string, expected?: string): string {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  const wanted = expected?.trim().toLowerCase()
  if (wanted && wanted !== digest) {
    throw new Error(`插件包 SHA-256 不匹配: 期望 ${wanted}，实际 ${digest}`)
  }
  return digest
}

function targetOf(profile: string, name: string): string {
  const parts = name.split('/')
  return join(profile, 'node_modules', ...parts)
}

function transactionsOf(profile: string): string {
  return join(profile, '.meng', 'plugin-transactions')
}

function createTransaction(profile: string, meta: InstallMeta): string {
  const root = transactionsOf(profile)
  mkdirSync(root, { recursive: true })
  let id = meta.id
  let n = 1
  while (existsSync(join(root, id))) id = `${meta.id}-${n++}`
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return dir
}

function backupProfile(profile: string, transaction: string): void {
  for (const name of ['package.json', 'package-lock.json', 'meng.patch.yml']) {
    const from = join(profile, name)
    if (existsSync(from)) cpSync(from, join(transaction, name))
  }
}

function restoreTransaction(profile: string, transaction: string): void {
  const meta = readMeta(transaction)
  for (const name of ['package.json', 'package-lock.json', 'meng.patch.yml']) {
    const backup = join(transaction, name)
    const target = join(profile, name)
    if (existsSync(backup)) {
      rmSync(target, { recursive: true, force: true })
      cpSync(backup, target)
    } else {
      rmSync(target, { force: true })
    }
  }
  const target = targetOf(profile, meta.name)
  rmSync(target, { recursive: true, force: true })
  const previous = join(transaction, 'previous-package')
  if (existsSync(previous)) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(previous, target, { recursive: true })
  }
}

function readMeta(transaction: string): InstallMeta {
  const file = join(transaction, 'meta.json')
  if (!existsSync(file)) throw new Error(`事务缺少 meta.json: ${transaction}`)
  return JSON.parse(readFileSync(file, 'utf8')) as InstallMeta
}

function readPackage(dir: string): Record<string, unknown> & { dependencies?: Record<string, unknown> } {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) throw new Error(`插件包缺少 package.json: ${dir}`)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { dependencies?: Record<string, unknown> }
}

function pluginIdOf(pkg: Record<string, unknown>): string {
  const meng = pkg.meng && typeof pkg.meng === 'object' ? pkg.meng as Record<string, unknown> : undefined
  const plugin = meng?.plugin && typeof meng.plugin === 'object' ? meng.plugin as Record<string, unknown> : undefined
  const id = typeof plugin?.id === 'string' ? plugin.id.trim() : ''
  if (!id) throw new Error('插件包缺少 meng.plugin.id')
  return id
}

function extractPackage(archive: string, output: string): string {
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean)
  if (!listing.length || listing.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    throw new Error('插件包包含不安全路径')
  }
  execFileSync('tar', ['-xzf', archive, '-C', output])
  const dir = join(output, 'package')
  if (!existsSync(join(dir, 'package.json'))) throw new Error('插件包缺少 package/package.json')
  const built = validatePlugin(dir)
  if (!built.ok) throw new Error(`插件包结构校验失败:\n${built.errors.join('\n')}`)
  return dir
}
