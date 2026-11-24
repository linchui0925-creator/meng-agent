import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 网页端构建 (Vite 8 —— Rolldown 是唯一打包器, Oxc 做 transform, Lightning CSS 做 CSS minify)。
 *
 * 端口刻意避开旧项目的 4711/4712(那个后端还在跑), 梦用 4721/4722。
 *
 * **这份配置不设 external。** 原来它把 PLATFORM_MODULES 全列进 `build.rollupOptions.external`,
 * 但那是**插件 bundle** 该做的事 —— 主应用自己也 external 的后果是产物里 `import 'react'`
 * 原样留着, 浏览器里直接 "Failed to resolve module"。实测到的形状就是 22KB 的产物
 * (React 真打进去应该 190KB+)。
 *
 * 插件 bundle 的构建 (external 共享模块表 + 输出到 /plugins/<id>/client.js) 属于 F5 的
 * modules/client 装载链, 会有**单独一份** vite 配置, 不复用这一份。
 *
 * `/plugins` 的代理有个 bypass: **本地构建过的产物优先**。生产里插件 bundle 由后端
 * 的 `pluginRoot` 静态目录下发, 但 dev 时后端常常没起 —— 那时直接 502, 插件永远装不上,
 * 而且报错长得很像"路径错了"。本地有文件就让 vite 自己发, 没有才去后端。
 */
const PLUGIN_PUBLIC_DIR = join(import.meta.dirname ?? '.', 'public', 'plugins')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4722,
    proxy: {
      // ws: 必须显式开, 否则 WebSocket 的 upgrade 请求不会被代理 ——
      // 表现为前端一直 connecting(连的是前端的 4722, 那个端口上没有 /ws)
      '/api': { target: 'http://127.0.0.1:4721', changeOrigin: true, ws: true },
      '/ws': { target: 'http://127.0.0.1:4721', changeOrigin: true, ws: true },
      // 项目适配器可以使用自己的兼容路由；dsh-purge 原版面板就依赖这两组路径。
      '/dsh-purge': { target: 'http://127.0.0.1:4721', changeOrigin: true },
      '/redteam': { target: 'http://127.0.0.1:4721', changeOrigin: true },
      '/plugins': {
        target: 'http://127.0.0.1:4721',
        changeOrigin: true,
        bypass(req) {
          const rel = (req.url ?? '').replace(/^\/plugins\/?/, '').split('?')[0]
          if (!rel) return undefined
          return existsSync(join(PLUGIN_PUBLIC_DIR, rel)) ? req.url : undefined
        },
      },
    },
  },
})
