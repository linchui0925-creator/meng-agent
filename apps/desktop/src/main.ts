/**
 * Electron 主进程。
 *
 * 为什么是 Electron 而不是 Tauri (docs/05 §0 决策 5):
 *   我们的内核是 Node/TS。Electron 的**主进程就是 Node**, 内核直接跑在里面,
 *   插件宿主和内核在同一个进程, 没有 sidecar / 没有语言边界。
 *   Tauri 2 虽然一套 Rust 核心覆盖桌面+移动, 但它的后端是 Rust —— 内核要 sidecar,
 *   移动端更是只能连远端, 反而多一层。
 *   代价是体积 (90-150MB), 与 VS Code / dsh Desktop 同量级, 接受。
 *
 * 主进程职责:
 *   1. 起本地内核 (@meng/server) —— 这是桌面端的核心价值: 本地文件、隐私、离线可用
 *   2. 提供 platform/desktop 能力面 (fs / dialog / notify / window)
 *   3. 通过 preload + contextBridge 暴露 transport-ipc
 *   4. 加载 apps/web 的产物 (dev 走 4722, prod 走打包产物)
 */

import { app, BrowserWindow } from 'electron'

/** 本地内核句柄; 由 @meng/server 提供 */
let kernel: { dispose(): Promise<void> } | undefined

async function bootKernel(): Promise<{ dispose(): Promise<void> }> {
  throw new Error('desktop: 未实现 (M5)')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      // 上下文隔离: 渲染进程拿不到 node, 只能通过 preload 白名单
      contextIsolation: true,
      nodeIntegration: false,
      preload: new URL('./preload.ts', import.meta.url).pathname,
    },
  })
  const devUrl = process.env['MENG_WEB_URL'] ?? 'http://127.0.0.1:4722'
  void win.loadURL(devUrl)
}

void app.whenReady().then(async () => {
  kernel = await bootKernel()
  createWindow()
})

app.on('before-quit', async () => {
  await kernel?.dispose()
})
