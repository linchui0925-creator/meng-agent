/**
 * **插件 bundle** 的构建 —— 与主应用那份 vite.config.ts **刻意分开**。
 *
 * 差别在一个词: external。
 *   主应用: 不许 external, React 必须真打进产物(否则浏览器里 import 'react' 无法解析)。
 *   插件:   必须 external, React 从宿主的共享表拿 —— 插件自带一份 React 会让
 *           hooks 直接炸("Invalid hook call": 两份 React 就是两个 dispatcher)。
 *
 * external 落地的形式由 `output.globals` 决定: 这里统一映射成
 * `__MENG_REQUIRE__("<id>")`, 于是**构建期 external 和运行期 require 是同一条解析链**
 * (modules/client 的 evaluate 注入这个标识符)。不这么接, 插件就会悄悄长出第二张模块表。
 *
 * CSS 走 `?inline`: 变成字符串常量而不是独立 .css 文件,
 * 这样"注入 <style data-plugin>"这件事能留在 factory 里(docs/08 §1), 而不是在 bundle 顶层。
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { PLATFORM_MODULES } from '@meng/modules'

const ENTRY = '../../plugins/demo-ui/src/client-entry.tsx'
const OUT = 'public/plugins/demo-ui'

export default defineConfig({
  plugins: [react()],
  /*
   * **必须关掉 publicDir。**
   *
   * outDir（`public/plugins/demo-ui`）就在 publicDir（`public`）里面 ——
   * vite 默认会把 publicDir 整个复制进 outDir，于是它复制自己进自己：
   * `public/plugins/demo-ui/plugins/demo-ui/plugins/demo-ui/…` 无限递归，
   * 最后 ENAMETOOLONG 崩掉。而且崩之前 `emptyOutDir` 已经先把旧的 client.js
   * 删了 —— 表现是「构建失败 + 产物凭空消失」，看起来像插件坏了。
   *
   * 插件构建只需要 rollup 的输出，没有要复制的静态文件。
   */
  publicDir: false,
  build: {
    outDir: OUT,
    emptyOutDir: true,
    // 插件产物给人看也给人 debug, 不压缩
    minify: false,
    rollupOptions: {
      input: ENTRY,
      external: [...PLATFORM_MODULES],
      output: {
        format: 'iife',
        entryFileNames: 'client.js',
        globals: Object.fromEntries(
          PLATFORM_MODULES.map((id) => [id, `__MENG_REQUIRE__(${JSON.stringify(id)})`]),
        ),
      },
    },
  },
})
