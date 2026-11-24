import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADAPTER_KINDS, RUNTIME_MODES, type AdapterKind } from './manifest.ts'
import type { PluginKind, ScaffoldOptions, ScaffoldResult } from './types.ts'

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const KINDS = new Set<PluginKind>(['backend', 'frontend', 'fullstack'])

export function scaffoldPlugin(options: ScaffoldOptions): ScaffoldResult {
  const id = options.id?.trim()
  const kind = options.kind ?? 'backend'
  const packageName = options.packageName?.trim() || `@meng/plugin-${id}`
  const output = resolve(options.output)
  if (!ID.test(id)) throw new Error('id 必须是小写 kebab-case')
  if (!PACKAGE.test(packageName)) throw new Error('packageName 不是合法 npm 包名')
  if (!KINDS.has(kind)) throw new Error(`不支持的插件类型: ${String(kind)}`)
  if (existsSync(output)) throw new Error(`输出目录已存在: ${output}`)

  const source = options.source ? resolve(options.source) : undefined
  if (source && !existsSync(source)) throw new Error(`外部源码不存在: ${source}`)

  const template = fileURLToPath(new URL(`../templates/${kind}/`, import.meta.url))
  const values: Record<string, string> = {
    id,
    packageName,
    kind,
    description: options.description?.trim() || `${id} 梦插件`,
    descriptionJson: JSON.stringify(options.description?.trim() || `${id} 梦插件`),
    toolName: `${id}_echo`,
  }
  const adapter = options.adapter
  if (adapter !== undefined && !ADAPTER_KINDS.includes(adapter)) {
    throw new Error(`不支持的适配器类型: ${adapter}`)
  }
  copyTemplate(template, output, values)
  if (adapter) addAdapterManifest(output, {
    id,
    adapter,
    packageName: options.sourcePackage?.trim() || packageName,
    source: source,
  })
  return { output, id, packageName, kind, ...(adapter ? { adapter } : {}), ...(source ? { source } : {}) }
}

function addAdapterManifest(
  output: string,
  input: { id: string; adapter: AdapterKind; packageName: string; source?: string },
): void {
  const pkgPath = join(output, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    files?: string[]
    meng?: Record<string, unknown>
  }
  pkg.files ??= []
  if (!pkg.files.includes('adapter.manifest.yml')) pkg.files.push('adapter.manifest.yml')
  pkg.meng ??= {}
  pkg.meng.adapter = { kind: input.adapter, source: input.packageName }
  pkg.meng.activationEvents = ['onToolCall']
  pkg.meng.compatibility = {
    host: '>=0.1.0 <1.0.0',
    platforms: ['web', 'desktop'],
  }
  pkg.meng.permissions = {
    network: [],
    fs: ['workspace'],
    exec: input.adapter === 'cli' || input.adapter === 'sidecar',
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}
`)

  const mode = runtimeMode(input.adapter)
  const sourceLine = input.source
    ? `  root: ${JSON.stringify(input.source)}`
    : `  package: ${JSON.stringify(input.packageName)}`
  const manifest = [
    'source:',
    `  kind: ${input.adapter}`,
    sourceLine,
    'runtime:',
    `  mode: ${mode}`,
    `  dataRoot: .meng/${input.id}`,
    'capabilities:',
    '  prompt: true',
    `  tools: [${input.id}_echo]`,
    'compatibility:',
    '  reusable: []',
    '  mapped: [prompt, tools]',
    '  unsupported: []',
    '',
  ].join('\n')
  writeFileSync(join(output, 'adapter.manifest.yml'), manifest, { flag: 'wx' })
}

function runtimeMode(kind: AdapterKind): typeof RUNTIME_MODES[number] {
  if (kind === 'cli' || kind === 'sidecar') return 'child-process'
  if (kind === 'http' || kind === 'mcp') return 'remote'
  return 'in-process'
}

function copyTemplate(source: string, output: string, values: Record<string, string>): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(output, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTemplate(from, to, values)
      continue
    }
    if (!entry.isFile()) continue
    mkdirSync(dirname(to), { recursive: true })
    const text = readFileSync(from, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '')
    writeFileSync(to, text, { flag: 'wx' })
  }
}
