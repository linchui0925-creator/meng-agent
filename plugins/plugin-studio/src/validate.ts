import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { ValidationResult } from './types.ts'
import { validateMengExtensions } from './manifest.ts'

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  exports?: Record<string, unknown>
  files?: string[]
  engines?: { node?: string }
  peerDependencies?: Record<string, string>
  meng?: {
    plugin?: { apiVersion?: number; id?: string; patch?: string }
    client?: { platforms?: string[]; slots?: string[] }
  }
}

export function validatePlugin(directory: string, options: { built?: boolean } = {}): ValidationResult {
  const dir = resolve(directory)
  const built = options.built ?? true
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (message: string) => errors.push(message)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return { ok: false, errors: ['缺少 package.json'], warnings }

  let pkg: Manifest
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Manifest
  } catch (error) {
    return { ok: false, errors: [`package.json 无法解析: ${text(error)}`], warnings }
  }

  if (!pkg.name) fail('缺少 name')
  if (!pkg.version) fail('缺少 version')
  if (pkg.private === true) fail('分发包不能 private=true')
  if (pkg.type !== 'module') fail('type 必须为 module')
  if (!pkg.main) fail('缺少 main')
  if (!pkg.types) fail('缺少 types')
  if (pkg.main && !packagePath(pkg.main)) fail('main 必须是包内相对路径')
  if (pkg.types && !packagePath(pkg.types)) fail('types 必须是包内相对路径')
  if (!pkg.exports?.['.']) fail('exports 必须导出 "."')
  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) fail('files 必须包含 dist')
  if (pkg.files?.some((item) => item === 'src' || item === 'test' || item.startsWith('src/') || item.startsWith('test/'))) {
    fail('files 不得包含 src 或 test')
  }
  if (!pkg.engines?.node) fail('缺少 engines.node')
  if (!pkg.peerDependencies?.['@meng/core']) fail('peerDependencies 必须声明 @meng/core')
  if (pkg.meng?.plugin?.apiVersion !== 1) fail('meng.plugin.apiVersion 必须为 1')
  if (!pkg.meng?.plugin?.id) fail('缺少 meng.plugin.id')
  if (pkg.meng?.plugin?.patch !== './meng.patch.yml') fail('meng.plugin.patch 必须为 ./meng.patch.yml')

  const main = pkg.main ? join(dir, pkg.main) : ''
  const types = pkg.types ? join(dir, pkg.types) : ''
  if (built && pkg.main && !existsSync(main)) fail(`缺少后端产物: ${pkg.main}`)
  if (built && pkg.types && !existsSync(types)) fail(`缺少类型产物: ${pkg.types}`)

  const patchPath = join(dir, 'meng.patch.yml')
  if (!existsSync(patchPath)) {
    fail('缺少 meng.patch.yml')
  } else {
    try {
      const rows = parse(readFileSync(patchPath, 'utf8')) as Array<{ insert?: Array<{ id?: string; name?: string }> }>
      const inserted = rows.flatMap((row) => row.insert ?? [])
      const row = inserted.find((item) => item.id === pkg.meng?.plugin?.id)
      if (!row) fail('meng.patch.yml 未声明插件 id')
      else if (row.name !== pkg.name) fail('meng.patch.yml 的 name 必须与 package.json 一致')
    } catch (error) {
      fail(`meng.patch.yml 无法解析: ${text(error)}`)
    }
  }

  if (pkg.meng?.client) {
    if (!pkg.meng.client.slots?.length) fail('前端插件必须声明 meng.client.slots')
    if (!pkg.files?.includes('client')) fail('前端插件 files 必须包含 client')
    if (built && !existsSync(join(dir, 'client/client.js'))) fail('缺少前端产物 client/client.js')
  }
  const extensions = validateMengExtensions(pkg as Record<string, unknown>, dir)
  errors.push(...extensions.errors)
  warnings.push(...extensions.warnings)
  if (!existsSync(join(dir, 'README.md'))) warnings.push('建议补充 README.md')
  return { ok: errors.length === 0, errors, warnings }
}

function packagePath(value: string): boolean {
  return value.startsWith('./') && !value.split('/').includes('..')
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
