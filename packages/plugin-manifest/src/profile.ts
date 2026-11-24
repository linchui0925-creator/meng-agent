import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ProfileValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface ProfilePluginRecord {
  enabled?: boolean
  [key: string]: unknown
}

export interface ProfilePackage {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  meng?: {
    profile?: {
      bundles?: string[]
      plugins?: Record<string, ProfilePluginRecord>
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function validateProfileManifest(input: unknown): ProfileValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const pkg = record(input)
  if (!pkg) return { ok: false, errors: ['profile package.json 顶层必须是对象'], warnings }
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) errors.push('profile 缺少 name')
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) errors.push('profile 缺少 version')

  const meng = record(pkg.meng)
  const profile = meng ? record(meng.profile) : undefined
  if (!profile) {
    errors.push('缺少 meng.profile')
    return { ok: false, errors, warnings }
  }

  const bundles = profile.bundles
  if (!Array.isArray(bundles) || bundles.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push('meng.profile.bundles 必须是字符串数组')
  }
  const names = Array.isArray(bundles)
    ? bundles.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const dependencies = record(pkg.dependencies) ?? {}
  for (const name of names) {
    if (typeof dependencies[name] !== 'string') errors.push(`meng.profile.bundles 中的 ${name} 未在 dependencies 声明`)
  }

  const plugins = profile.plugins
  if (plugins !== undefined) {
    const entries = record(plugins)
    if (!entries) errors.push('meng.profile.plugins 必须是对象')
    else {
      for (const name of Object.keys(entries)) {
        if (!names.includes(name)) errors.push(`meng.profile.plugins 中的 ${name} 不在 bundles 里`)
        const config = entries[name]
        if (config !== undefined && !record(config)) errors.push(`meng.profile.plugins.${name} 必须是对象`)
      }
    }
  }

  if (bundles === undefined || (Array.isArray(bundles) && bundles.length === 0)) {
    warnings.push('profile 当前未安装任何插件')
  }
  return { ok: errors.length === 0, errors, warnings }
}

export interface ProfileState {
  dir: string
  packageFile: string
  patchFile: string
  pkg: ProfilePackage
}

export interface InitProfileOptions {
  name?: string
  version?: string
}

/**
 * profile 存储只负责清单与原子写入；依赖安装由 package manager 完成。
 * 这样 profile 操作可以在测试/离线环境中运行，也不会偷偷联网。
 */
export class ProfileStore {
  readonly dir: string
  readonly packageFile: string
  readonly patchFile: string

  constructor(directory: string) {
    this.dir = resolve(directory)
    this.packageFile = join(this.dir, 'package.json')
    this.patchFile = join(this.dir, 'meng.patch.yml')
  }

  init(options: InitProfileOptions = {}): ProfileState {
    mkdirSync(this.dir, { recursive: true })
    if (existsSync(this.packageFile)) return this.read()
    const pkg: ProfilePackage = {
      name: options.name?.trim() || '@meng/profile-local',
      version: options.version?.trim() || '0.0.0',
      private: true,
      dependencies: {},
      meng: { profile: { bundles: [], plugins: {} } },
    }
    this.write(pkg)
    if (!existsSync(this.patchFile)) this.writeText(this.patchFile, '[]\n')
    return this.read()
  }

  read(): ProfileState {
    const pkg = JSON.parse(readFileSync(this.packageFile, 'utf8')) as ProfilePackage
    this.assert(pkg)
    return { dir: this.dir, packageFile: this.packageFile, patchFile: this.patchFile, pkg }
  }

  list(): Array<{ name: string; version: string; enabled: boolean; config: ProfilePluginRecord }> {
    const { pkg } = this.read()
    const profile = pkg.meng?.profile
    return (profile?.bundles ?? []).map((name) => {
      const config = profile?.plugins?.[name] ?? {}
      return {
        name,
        version: pkg.dependencies?.[name] ?? '',
        enabled: config.enabled !== false,
        config,
      }
    })
  }

  add(name: string, version: string, config: ProfilePluginRecord = {}): ProfileState {
    this.assertName(name)
    if (!version.trim()) throw new Error('插件版本不能为空')
    const pkg = this.read().pkg
    const profile = this.profile(pkg)
    pkg.dependencies ??= {}
    pkg.dependencies[name] = version.trim()
    if (!profile.bundles.includes(name)) profile.bundles.push(name)
    profile.plugins ??= {}
    profile.plugins[name] = { ...profile.plugins[name], ...config }
    this.write(pkg)
    return this.read()
  }

  remove(name: string): ProfileState {
    const pkg = this.read().pkg
    const profile = this.profile(pkg)
    if (!profile.bundles.includes(name)) throw new Error(`profile 未安装插件: ${name}`)
    profile.bundles = profile.bundles.filter((item) => item !== name)
    if (profile.plugins) delete profile.plugins[name]
    if (pkg.dependencies) delete pkg.dependencies[name]
    this.write(pkg)
    return this.read()
  }

  setEnabled(name: string, enabled: boolean): ProfileState {
    const pkg = this.read().pkg
    const profile = this.profile(pkg)
    if (!profile.bundles.includes(name)) throw new Error(`profile 未安装插件: ${name}`)
    profile.plugins ??= {}
    profile.plugins[name] = { ...profile.plugins[name], enabled }
    this.write(pkg)
    return this.read()
  }

  setConfig(name: string, config: ProfilePluginRecord): ProfileState {
    const pkg = this.read().pkg
    const profile = this.profile(pkg)
    if (!profile.bundles.includes(name)) throw new Error(`profile 未安装插件: ${name}`)
    profile.plugins ??= {}
    profile.plugins[name] = { ...config }
    this.write(pkg)
    return this.read()
  }

  private profile(pkg: ProfilePackage): { bundles: string[]; plugins?: Record<string, ProfilePluginRecord> } {
    pkg.meng ??= {}
    pkg.meng.profile ??= { bundles: [], plugins: {} }
    pkg.meng.profile.bundles ??= []
    return pkg.meng.profile as { bundles: string[]; plugins?: Record<string, ProfilePluginRecord> }
  }

  private assert(pkg: ProfilePackage): void {
    const report = validateProfileManifest(pkg)
    if (!report.ok) throw new Error(report.errors.join('\n'))
  }

  private assertName(name: string): void {
    if (!PACKAGE_NAME.test(name)) throw new Error(`不是合法 npm 包名: ${name}`)
  }

  private write(pkg: ProfilePackage): void {
    this.assert(pkg)
    mkdirSync(dirname(this.packageFile), { recursive: true })
    const tmp = `${this.packageFile}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`)
    renameSync(tmp, this.packageFile)
  }

  private writeText(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }
}

export function readProfile(directory: string): ProfileState {
  return new ProfileStore(directory).read()
}
