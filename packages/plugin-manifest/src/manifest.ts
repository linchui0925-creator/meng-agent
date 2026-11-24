import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

export const ADAPTER_KINDS = ['library', 'cli', 'http', 'sidecar', 'mcp', 'ui'] as const
export const RUNTIME_MODES = ['in-process', 'worker', 'child-process', 'remote'] as const
export const PLATFORMS = ['web', 'desktop', 'mobile'] as const

export type AdapterKind = (typeof ADAPTER_KINDS)[number]
export type AdapterRuntimeMode = (typeof RUNTIME_MODES)[number]

export interface ManifestReport {
  errors: string[]
  warnings: string[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) return undefined
  return value as string[]
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateMengExtensions(pkg: Record<string, unknown>, dir: string): ManifestReport {
  const errors: string[] = []
  const warnings: string[] = []
  const meng = record(pkg.meng)
  if (!meng) return { errors: ['缺少 meng 清单'], warnings }

  validateAdapter(meng.adapter, dir, errors, warnings)
  validateInstall(meng.install, errors)
  validateCompatibility(meng.compatibility, errors)
  validatePermissions(meng.permissions, errors)
  validateActivation(meng.activationEvents, errors)
  validateSharedPackages(meng.sharedPackages, errors)
  return { errors, warnings }
}

function validateAdapter(value: unknown, dir: string, errors: string[], warnings: string[]): void {
  if (value === undefined) return
  const adapter = record(value)
  if (!adapter) {
    errors.push('meng.adapter 必须是对象')
    return
  }
  if (!ADAPTER_KINDS.includes(adapter.kind as AdapterKind)) {
    errors.push(`meng.adapter.kind 必须是 ${ADAPTER_KINDS.join(' / ')} 之一`)
  }
  const source = adapter.source
  if (!nonEmpty(source) && !record(source)) errors.push('meng.adapter.source 必须是非空字符串或对象')

  const file = join(dir, 'adapter.manifest.yml')
  if (!existsSync(file)) {
    errors.push('声明 meng.adapter 时必须包含 adapter.manifest.yml')
    return
  }
  let raw: unknown
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`adapter.manifest.yml 无法解析: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const manifest = record(raw)
  if (!manifest) {
    errors.push('adapter.manifest.yml 顶层必须是对象')
    return
  }
  const sourceSpec = record(manifest.source)
  if (!sourceSpec) errors.push('adapter.manifest.yml 缺少 source')
  else if (!ADAPTER_KINDS.includes(sourceSpec.kind as AdapterKind)) {
    errors.push(`adapter.manifest.yml source.kind 必须是 ${ADAPTER_KINDS.join(' / ')} 之一`)
  }
  if (ADAPTER_KINDS.includes(adapter.kind as AdapterKind) && sourceSpec?.kind !== adapter.kind) {
    errors.push('adapter.manifest.yml source.kind 必须与 package.json meng.adapter.kind 一致')
  }
  const runtime = record(manifest.runtime)
  if (!runtime) errors.push('adapter.manifest.yml 缺少 runtime')
  else if (!RUNTIME_MODES.includes(runtime.mode as AdapterRuntimeMode)) {
    errors.push(`adapter.manifest.yml runtime.mode 必须是 ${RUNTIME_MODES.join(' / ')} 之一`)
  }
  if (!record(manifest.capabilities)) errors.push('adapter.manifest.yml 缺少 capabilities')
  const compatibility = record(manifest.compatibility)
  if (compatibility) {
    for (const key of ['reusable', 'mapped', 'unsupported']) {
      if (compatibility[key] !== undefined && strings(compatibility[key]) === undefined) {
        errors.push(`adapter.manifest.yml compatibility.${key} 必须是字符串数组`)
      }
    }
  } else {
    warnings.push('adapter.manifest.yml 未写 compatibility，建议列出 reusable / mapped / unsupported')
  }
}

function validateInstall(value: unknown, errors: string[]): void {
  if (value === undefined) return
  const install = record(value)
  if (!install) {
    errors.push('meng.install 必须是对象')
    return
  }
  if (install.preferred !== undefined && !['tarball', 'git', 'npm'].includes(String(install.preferred))) {
    errors.push('meng.install.preferred 必须是 tarball / git / npm 之一')
  }
  if (install.tarball !== undefined && !(nonEmpty(install.tarball) && /^https?:\/\//i.test(install.tarball))) {
    errors.push('meng.install.tarball 必须是 http(s) 地址')
  }
}

function validateCompatibility(value: unknown, errors: string[]): void {
  if (value === undefined) return
  const compatibility = record(value)
  if (!compatibility) {
    errors.push('meng.compatibility 必须是对象')
    return
  }
  if (compatibility.host !== undefined && !nonEmpty(compatibility.host)) {
    errors.push('meng.compatibility.host 必须是非空字符串')
  }
  if (compatibility.platforms !== undefined) {
    const platforms = strings(compatibility.platforms)
    if (!platforms) errors.push('meng.compatibility.platforms 必须是字符串数组')
    else {
      const unknown = platforms.filter((item) => !PLATFORMS.includes(item as (typeof PLATFORMS)[number]))
      if (unknown.length) errors.push(`meng.compatibility.platforms 含未知平台: ${unknown.join(', ')}`)
    }
  }
  if (compatibility.requires !== undefined && strings(compatibility.requires) === undefined) {
    errors.push('meng.compatibility.requires 必须是字符串数组')
  }
}

function validatePermissions(value: unknown, errors: string[]): void {
  if (value === undefined) return
  const permissions = record(value)
  if (!permissions) {
    errors.push('meng.permissions 必须是对象')
    return
  }
  if (permissions.network !== undefined && strings(permissions.network) === undefined) {
    errors.push('meng.permissions.network 必须是字符串数组')
  }
  if (permissions.fs !== undefined) {
    const fs = strings(permissions.fs)
    if (!fs) errors.push('meng.permissions.fs 必须是字符串数组')
    else {
      const unknown = fs.filter((item) => !['workspace', 'plugin-data', 'tmp', 'root'].includes(item))
      if (unknown.length) errors.push(`meng.permissions.fs 含未知值: ${unknown.join(', ')}`)
    }
  }
  if (permissions.exec !== undefined && typeof permissions.exec !== 'boolean' && strings(permissions.exec) === undefined) {
    errors.push('meng.permissions.exec 必须是布尔值或字符串数组')
  }
}

function validateActivation(value: unknown, errors: string[]): void {
  if (value !== undefined && strings(value) === undefined) {
    errors.push('meng.activationEvents 必须是字符串数组')
  }
}

function validateSharedPackages(value: unknown, errors: string[]): void {
  if (value !== undefined && strings(value) === undefined) {
    errors.push('meng.sharedPackages 必须是字符串数组')
  }
}
