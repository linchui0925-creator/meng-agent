/**
 * Electron 主进程。
 *
 * 本地内核直接运行在主进程里；渲染进程不拿 Node，只通过 preload 暴露的
 * invoke / event / state / manifest 四件事访问内核。HTTP 只绑定 127.0.0.1，
 * 作为 op 执行的内部通道，不对外暴露。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'
import { desktopFaces } from '@meng/platform/desktop'
import { bootKernel, mockPatch, providersPatch, type Kernel } from '@meng/server'
import type { WebEvent, WebService } from '@meng/web'

import { IPC_EVENT, IPC_INVOKE, IPC_MANIFEST, IPC_STATE } from './channels.ts'
import { checkForDesktopUpdate, installStagedUpdate } from './updater.ts'

let kernel: Kernel | undefined
let web: WebService | undefined
let offEvents: (() => void) | undefined
let quitting = false

function preloadPath(): string {
  return join(app.getAppPath(), 'preload.cjs')
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((item): item is string => item !== undefined && item !== '' && existsSync(item))
}

function webRoot(): string | undefined {
  return firstExisting([
    process.env.MENG_WEB_ROOT,
    join(app.getAppPath(), 'web'),
    join(app.getAppPath(), '..', 'web', 'dist'),
    join(process.resourcesPath, 'web'),
  ])
}

function pluginRoot(): string | undefined {
  return firstExisting([
    process.env.MENG_PLUGIN_ROOT,
    join(app.getAppPath(), 'plugins'),
    join(app.getAppPath(), '..', 'web', 'public', 'plugins'),
    join(process.resourcesPath, 'plugins'),
  ])
}

function withIpcTransport(url: string): string {
  const parsed = new URL(url)
  if (!parsed.searchParams.has('transport')) parsed.searchParams.set('transport', 'ipc')
  return parsed.toString()
}

function windowUrl(): string {
  if (process.env.MENG_WEB_URL) return withIpcTransport(process.env.MENG_WEB_URL)
  if (!web) throw new Error('本地内核 web 能力面未就绪')
  return withIpcTransport(`${web.url}/`)
}

async function invoke(op: string, payload: unknown): Promise<unknown> {
  if (!web) throw new Error('本地内核尚未就绪')
  const response = await fetch(`${web.url}/api/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const body = await response.json() as { error?: { message?: string; code?: string } }
  if (!response.ok) {
    throw new Error(body.error?.message ?? `op ${op} 失败 (${response.status})`)
  }
  return body
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    title: '梦',
    backgroundColor: '#f5f4f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath(),
    },
  })
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(IPC_STATE, 'online')
  })
  void win.loadURL(windowUrl())
  return win
}

async function startKernel(): Promise<void> {
  const configuredWebUrl = process.env.MENG_WEB_URL
  process.env.MENG_PORT = '0'
  process.env.MENG_HOST = '127.0.0.1'
  const root = webRoot()
  if (root) process.env.MENG_WEB_ROOT = root
  const plugins = pluginRoot()
  if (plugins) process.env.MENG_PLUGIN_ROOT = plugins

  // tsx 的 ESM loader 允许包内插件继续以 TypeScript 源码运行；
  // 打包后插件在 node_modules 里，Node 自带的 strip-types 会拒绝该路径。
  await import('tsx/esm')
  kernel = await bootKernel({
    web: true,
    dataDir: join(app.getPath('userData'), 'data'),
    patches: [providersPatch(), mockPatch()],
    setup(ctx) {
      ctx.set('platform', desktopFaces({ preload: preloadPath() }))
    },
  })
  web = kernel.ctx.get<WebService>('web')
  if (!web) throw new Error('本地内核没有 web 能力面')
  process.env.MENG_WEB_URL = configuredWebUrl ?? withIpcTransport(`${web.url}/`)
  offEvents = web.subscribe((event: WebEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event)
    }
  })
}

async function dispose(): Promise<void> {
  offEvents?.()
  offEvents = undefined
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  await kernel?.dispose()
  kernel = undefined
  web = undefined
}

async function main(): Promise<void> {
  app.setName('梦')
  // GUI 应用启动时 PATH 往往不含 /bin；bash 工具需要它。
  const pathParts = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const part of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!pathParts.includes(part)) pathParts.push(part)
  }
  process.env.PATH = pathParts.join(':')

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  ipcMain.handle(IPC_INVOKE, (_event, op: string, payload: unknown) => invoke(op, payload))
  ipcMain.on(IPC_MANIFEST, (event) => {
    event.returnValue = web?.manifest()
  })

  await app.whenReady()
  await startKernel()
  createWindow()

  // 打包版启动后后台检查更新；下载完成不会打断当前任务，退出梦时替换。
  void checkForDesktopUpdate()
  const updateTimer = setInterval(() => { void checkForDesktopUpdate() }, 6 * 60 * 60 * 1000)
  updateTimer.unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void dispose().finally(() => {
    // 脚本会等当前进程退出后再替换 .app，成功后自动打开新版本。
    if (installStagedUpdate()) app.exit(0)
    else app.quit()
  })
})

void main().catch(async (error) => {
  console.error('[desktop] 启动失败:', error)
  await dispose().catch(() => {})
  app.quit()
})
