import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { BuildResult } from './types.ts'
import { validatePlugin } from './validate.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

export async function buildPlugin(directory: string): Promise<BuildResult> {
  const dir = resolve(directory)
  assertValid(dir, false)
  const linked = linkCoreIfMissing(dir)
  try {
    await exec(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', join(dir, 'tsconfig.json')], {
      cwd: dir,
      env: { ...process.env, CI: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
  } finally {
    linked?.()
  }

  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    meng?: { client?: unknown }
  }
  if (pkg.meng?.client) await buildClient(dir)
  assertValid(dir, true)
  return { output: dir, backend: true, client: Boolean(pkg.meng?.client) }
}

async function buildClient(dir: string): Promise<void> {
  const { build } = await importLocal<{ build(options: Record<string, unknown>): Promise<unknown> }>('vite')
  const { default: react } = await importLocal<{ default(): unknown }>('@vitejs/plugin-react')
  const { PLATFORM_MODULES } = await importLocal<{ PLATFORM_MODULES: readonly string[] }>('@meng/modules')
  await build({
    root: dir,
    configFile: false,
    publicDir: false,
    plugins: [react()],
    build: {
      outDir: 'client',
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: join(dir, 'src/client-entry.tsx'),
        external: [...PLATFORM_MODULES],
        output: {
          format: 'iife',
          entryFileNames: 'client.js',
          globals: Object.fromEntries(PLATFORM_MODULES.map((id: string) => [id, `__MENG_REQUIRE__(${JSON.stringify(id)})`])),
        },
      },
    },
  })
}

async function importLocal<T>(id: string): Promise<T> {
  return import(pathToFileURL(resolveBuildDependency(id)).href) as Promise<T>
}

function resolveBuildDependency(id: string): string {
  try {
    return require.resolve(id)
  } catch (original) {
    let dir = import.meta.dirname
    while (true) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        const web = createRequire(join(dir, 'apps/web/package.json'))
        try {
          return web.resolve(id)
        } catch {
          break
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    throw original
  }
}

function linkCoreIfMissing(dir: string): (() => void) | undefined {
  const targetRequire = createRequire(join(dir, 'package.json'))
  try {
    targetRequire.resolve('@meng/core')
    return undefined
  } catch {}
  let core = require.resolve('@meng/core')
  while (!existsSync(join(core, 'package.json'))) {
    const parent = dirname(core)
    if (parent === core) throw new Error('找不到宿主 @meng/core')
    core = parent
  }
  const scope = join(dir, 'node_modules/@meng')
  const dest = join(scope, 'core')
  mkdirSync(scope, { recursive: true })
  symlinkSync(core, dest, 'dir')
  return () => {
    unlinkSync(dest)
    try { rmdirSync(scope) } catch {}
    try { rmdirSync(join(dir, 'node_modules')) } catch {}
  }
}

function assertValid(dir: string, built: boolean): void {
  const report = validatePlugin(dir, { built })
  if (!report.ok) throw new Error(report.errors.join('\n'))
}
