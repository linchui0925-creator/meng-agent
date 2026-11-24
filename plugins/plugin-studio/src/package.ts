import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInvariants, StatusGraph, type ToolServiceLike } from './runtime.ts'
import { buildPlugin } from './build.ts'
import type { PackResult, VerifyResult } from './types.ts'
import { validatePlugin } from './validate.ts'

export async function packPlugin(directory: string, destination: string): Promise<PackResult> {
  const dir = resolve(directory)
  await buildPlugin(dir)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string }
  const outDir = resolve(destination)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`)
  if (existsSync(file)) throw new Error(`分发包已存在: ${file}`)
  execFileSync('pnpm', ['pack', '--out', file], {
    cwd: dir,
    env: { ...process.env, CI: '1' },
    stdio: 'pipe',
    maxBuffer: 4 * 1024 * 1024,
  })
  return { file, name: pkg.name, version: pkg.version }
}

export async function verifyPlugin(directory: string): Promise<VerifyResult> {
  const dir = resolve(directory)
  const report = validatePlugin(dir)
  if (!report.ok) return { ok: false, details: report.errors }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    main: string
    meng: { plugin: { id: string } }
  }
  const ctx = createContext('plugin-studio-verify')
  const graph = new StatusGraph()
  const tools = new Map<string, unknown>()
  ctx.set('graph', graph)
  ctx.set('tools', {
    register(def: { name: string }) {
      if (tools.has(def.name)) throw new Error(`工具重复: ${def.name}`)
      tools.set(def.name, def)
      return () => { tools.delete(def.name) }
    },
    list: () => [...tools.keys()].map((name) => ({ name })),
  } satisfies ToolServiceLike)
  ctx.set('prompt', { section: () => () => {} })
  const webOps = new Map<string, unknown>()
  ctx.set('web', {
    op(name: string, handler: unknown) {
      if (webOps.has(name)) throw new Error(`op 重复: ${name}`)
      webOps.set(name, handler)
      return () => { webOps.delete(name) }
    },
  })
  const details: string[] = []
  try {
    const { loadPatch } = await import('@meng/core/loader')
    await loadPatch(ctx, graph, join(dir, 'meng.patch.yml'))
    const status = graph.get(pkg.meng.plugin.id)
    details.push(`装载状态: ${status?.status ?? 'missing'}`)
    if (status?.status !== 'active') return { ok: false, details: [...details, status?.error ?? '插件未激活'] }
    const mod = await import(pathToFileURL(join(dir, pkg.main)).href)
    if (mod.invariant) {
      const health = await runInvariants(ctx, [mod.invariant])
      details.push(...health.results.map((item) => `${item.id}: ${item.ok ? 'ok' : item.message}`))
      if (!health.ok) return { ok: false, details }
    }
    return {
      ok: true,
      details: [
        ...details,
        `工具: ${[...tools.keys()].join(', ') || '无'}`,
        `网页 op: ${[...webOps.keys()].join(', ') || '无'}`,
      ],
    }
  } catch (error) {
    return { ok: false, details: [...details, error instanceof Error ? error.message : String(error)] }
  } finally {
    await ctx.rollback(0)
  }
}

export async function verifyPluginPackage(archive: string): Promise<VerifyResult> {
  const file = resolve(archive)
  const root = mkdtempSync(join(tmpdir(), 'meng-plugin-verify-'))
  try {
    const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
    const entries = listing.split('\n').filter(Boolean)
    if (!entries.length || entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
      throw new Error('压缩包包含不安全路径')
    }
    execFileSync('tar', ['-xzf', file, '-C', root])
    const dir = join(root, 'package')
    if (!existsSync(join(dir, 'package.json'))) throw new Error('压缩包缺少 package/package.json')
    linkDependencies(dir)
    return await verifyPlugin(dir)
  } catch (error) {
    return { ok: false, details: [error instanceof Error ? error.message : String(error)] }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function linkDependencies(dir: string): void {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const required = new Set(Object.keys(pkg.dependencies ?? {}))
  const ids = new Set([...required, ...Object.keys(pkg.peerDependencies ?? {})])
  for (const id of ids) {
    try {
      linkPeer(dir, id)
    } catch (error) {
      if (required.has(id) || !pkg.peerDependenciesMeta?.[id]?.optional) throw error
    }
  }
}

function linkPeer(dir: string, id: string): void {
  const require = createRequire(import.meta.url)
  let entry = require.resolve(id)
  while (!existsSync(join(entry, 'package.json'))) {
    const parent = dirname(entry)
    if (parent === entry) throw new Error(`找不到宿主依赖: ${id}`)
    entry = parent
  }
  const dest = join(dir, 'node_modules', id)
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(entry, dest, 'dir')
}
