import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface PackageJson {
  name?: string
  version?: string
  type?: string
  main?: string
  exports?: unknown
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  meng?: {
    plugin?: {
      apiVersion?: unknown
      id?: unknown
      patch?: unknown
    }
    client?: {
      entry?: unknown
      [key: string]: unknown
    }
  }
}

interface ProfilePackageJson {
  dependencies?: Record<string, string>
  meng?: {
    profile?: {
      bundles?: unknown
      plugins?: Record<string, { enabled?: unknown; [key: string]: unknown }>
    }
  }
}

export interface ProfilePlugin {
  packageName: string
  version: string
  pluginId: string
  root: string
  patchFile: string
  clientDir?: string
}

export interface ProfileDiscovery {
  dir: string
  plugins: ProfilePlugin[]
  warnings: string[]
}

/**
 * 读取 profile/node_modules 中已安装且启用的插件。
 *
 * 这里只负责“发现 + 准备运行条件”，不执行插件。真正的 apply 仍交给内核装载器，
 * 这样插件依赖顺序、失败回滚和状态图语义不会被启动器复制一份。
 */
export function discoverProfilePlugins(profileDir: string, warn: (message: string) => void = () => {}): ProfileDiscovery {
  const dir = resolve(profileDir)
  const profileFile = join(dir, 'package.json')
  if (!existsSync(profileFile)) return { dir, plugins: [], warnings: [] }

  const warnings: string[] = []
  const report = (message: string): void => {
    warnings.push(message)
    warn(message)
  }

  let profile: ProfilePackageJson
  try {
    profile = JSON.parse(readFileSync(profileFile, 'utf8')) as ProfilePackageJson
  } catch (error) {
    report(`profile 清单无法读取: ${errorText(error)}`)
    return { dir, plugins: [], warnings }
  }

  const profileMeta = profile.meng?.profile
  const bundles = Array.isArray(profileMeta?.bundles)
    ? profileMeta.bundles.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const seen = new Set<string>()
  const plugins: ProfilePlugin[] = []

  for (const packageName of bundles) {
    const config = profileMeta?.plugins?.[packageName]
    if (config?.enabled === false) continue

    const root = join(dir, 'node_modules', ...packageName.split('/'))
    const packageFile = join(root, 'package.json')
    if (!existsSync(packageFile)) {
      report(`插件包不存在: ${packageName}`)
      continue
    }

    let pkg: PackageJson
    try {
      pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as PackageJson
    } catch (error) {
      report(`插件 ${packageName} 的 package.json 无法读取: ${errorText(error)}`)
      continue
    }

    const pluginMeta = pkg.meng?.plugin
    const pluginId = typeof pluginMeta?.id === 'string' ? pluginMeta.id.trim() : ''
    if (!pluginId || !/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) {
      report(`插件 ${packageName} 缺少合法 meng.plugin.id`)
      continue
    }
    if (seen.has(pluginId)) {
      report(`插件 id 重复，已跳过: ${pluginId}`)
      continue
    }

    const patchRaw = typeof pluginMeta?.patch === 'string' && pluginMeta.patch.trim()
      ? pluginMeta.patch.trim()
      : './meng.patch.yml'
    const patchFile = confinedPath(root, patchRaw)
    if (!patchFile || !isFile(patchFile)) {
      report(`插件 ${packageName} 的清单不存在: ${patchRaw}`)
      continue
    }

    try {
      ensurePeerLinks(dir, pkg)
    } catch (error) {
      report(`插件 ${packageName} 的宿主依赖不可用: ${errorText(error)}`)
      continue
    }

    const clientDir = resolveClientDir(root, pkg, packageName, report)
    seen.add(pluginId)
    plugins.push({
      packageName,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      pluginId,
      root,
      patchFile,
      ...(clientDir ? { clientDir } : {}),
    })
  }

  return { dir, plugins, warnings }
}

function ensurePeerLinks(profileDir: string, pkg: PackageJson): void {
  const peers = pkg.peerDependencies ?? {}
  const optional = pkg.peerDependenciesMeta ?? {}
  for (const peer of Object.keys(peers)) {
    const target = join(profileDir, 'node_modules', ...peer.split('/'))
    if (pathExists(target)) continue
    let hostRoot: string
    try {
      const entry = createRequire(import.meta.url).resolve(peer)
      hostRoot = packageRootOf(entry, peer)
    } catch (error) {
      if (optional[peer]?.optional === true) continue
      throw new Error(`找不到 ${peer}: ${errorText(error)}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(hostRoot, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

function resolveClientDir(root: string, pkg: PackageJson, packageName: string, report: (message: string) => void): string | undefined {
  const client = pkg.meng?.client
  if (!client) return undefined
  const entryRaw = typeof client.entry === 'string'
    ? client.entry
    : exportEntry(pkg.exports, './client') ?? './client/client.js'
  const entry = confinedPath(root, entryRaw)
  if (!entry || !isFile(entry)) {
    report(`插件 ${packageName} 声明了前端面但入口不存在: ${entryRaw}`)
    return undefined
  }
  if (entry.slice(entry.lastIndexOf(sep) + 1) !== 'client.js') {
    report(`插件 ${packageName} 的前端入口必须命名为 client.js: ${entryRaw}`)
    return undefined
  }
  return dirname(entry)
}

function exportEntry(exportsField: unknown, key: string): string | undefined {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return undefined
  const value = (exportsField as Record<string, unknown>)[key]
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = value as Record<string, unknown>
  for (const field of ['import', 'default', 'require']) {
    if (typeof out[field] === 'string') return out[field]
  }
  return undefined
}

function confinedPath(root: string, value: string): string | undefined {
  const target = resolve(root, value)
  const rel = relative(root, target)
  if (rel === '') return root
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return target
}

function packageRootOf(entry: string, expectedName: string): string {
  let dir = dirname(entry)
  for (let i = 0; i < 8; i++) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as PackageJson
      if (pkg.name === expectedName) return dir
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(`解析到 ${entry}，但没有找到 ${expectedName} 的 package.json`)
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}

function pathExists(file: string): boolean {
  try { lstatSync(file); return true } catch { return false }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
