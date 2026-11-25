import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

function patchAssets(): Plugin {
  const assets = new Map<string, Buffer>()
  return {
    name: 'meng-patch-assets',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('/src/') || !code.includes('import.meta.url')) return
      return code.replace(
        /fileURLToPath\(new URL\((["'])(.+?\.ya?ml)\1, import\.meta\.url\)\)/g,
        (full, _quote: string, rel: string) => {
          const source = resolve(dirname(id), rel)
          const hash = createHash('sha1').update(source).digest('hex').slice(0, 10)
          const asset = `patches/${hash}-${basename(source)}`
          if (!assets.has(asset)) assets.set(asset, readFileSync(source))
          return `fileURLToPath(new URL("./" + ${JSON.stringify(asset)}, import.meta.url))`
        },
      )
    },
    writeBundle(options) {
      const out = resolve(options.dir ?? 'dist')
      for (const [asset, source] of assets) {
        const target = resolve(out, asset)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, source)
      }
    },
  }
}

export default defineConfig({
  assetsInclude: ['**/*.yml', '**/*.yaml'],
  plugins: [patchAssets()],
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { format: 'esm', entryFileNames: 'main.js' },
    },
  },
  ssr: {
    noExternal: [/^@meng\//],
  },
})
