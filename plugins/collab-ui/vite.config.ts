import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { PLATFORM_MODULES } from '@meng/modules'

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'client',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: 'src/client-entry.tsx',
      external: [...PLATFORM_MODULES],
      output: {
        format: 'iife',
        entryFileNames: 'client.js',
        globals: Object.fromEntries(PLATFORM_MODULES.map((id) => [id, `__MENG_REQUIRE__(${JSON.stringify(id)})`])),
      },
    },
  },
})
