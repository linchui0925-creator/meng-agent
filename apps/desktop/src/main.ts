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

import { IPC_EVENT, IPC_INVOKE, IPC_MANIFEST, IPC_STATE, IPC_STARTUP_QUIT, IPC_STARTUP_RETRY } from './channels.ts'
import { minimumSplashWait, openStartupScreen, revealMainWindow, type StartupScreen } from './startup.ts'
import { checkForDesktopUpdate, installStagedUpdate } from './updater.ts'

let kernel: Kernel | undefined
let web: WebService | undefined
let offEvents: (() => void) | undefined
let startupScreen: StartupScreen | undefined
let mainWindow: BrowserWindow | undefined
let booting = false
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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    show: false,
    opacity: 0,
    title: '梦',
    backgroundColor: '#eceef3',
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

async function startKernel(onStage?: (stage: string) => void): Promise<void> {
  const configuredWebUrl = process.env.MENG_WEB_URL
  onStage?.('准备内核')
  process.env.MENG_PORT = '0'
  process.env.MENG_HOST = '127.0.0.1'
  const root = webRoot()
  if (root) process.env.MENG_WEB_ROOT = root
  const plugins = pluginRoot()
  if (plugins) process.env.MENG_PLUGIN_ROOT = plugins

  // tsx 的 ESM loader 允许包内插件继续以 TypeScript 源码运行；
  // 打包后插件在 node_modules 里，Node 自带的 strip-types 会拒绝该路径。
  await import('tsx/esm')
  onStage?.('装载插件')
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
  onStage?.('恢复会话')
  process.env.MENG_WEB_URL = configuredWebUrl ?? withIpcTransport(`${web.url}/`)
  offEvents = web.subscribe((event: WebEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENT, event)
    }
  })
}

async function disposeKernel(): Promise<void> {
  offEvents?.()
  offEvents = undefined
  await kernel?.dispose()
  kernel = undefined
  web = undefined
}

async function dispose(): Promise<void> {
  startupScreen?.close()
  startupScreen = undefined
  mainWindow?.destroy()
  mainWindow = undefined
  await disposeKernel()
}

function waitForWindowReady(win: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    win.once('ready-to-show', done)
    win.webContents.once('did-fail-load', (_event, code, description) => {
      if (settled) return
      settled = true
      reject(new Error(`主界面加载失败 (${code}): ${description}`))
    })
  })
}

async function bootAndOpen(): Promise<void> {
  if (!startupScreen || booting) return
  booting = true
  const startedAt = Date.now()
  try {
    await startupScreen.reset('准备内核')
    await startKernel((stage) => {
      void startupScreen?.setStage(stage)
    })
    await minimumSplashWait(startedAt)
    await startupScreen.setStage('打开工作区')

    const win = createMainWindow()
    mainWindow = win
    await waitForWindowReady(win)

    const splash = startupScreen
    await revealMainWindow(splash, win)
    startupScreen = undefined
  } catch (error) {
    mainWindow?.destroy()
    mainWindow = undefined
    await disposeKernel()
    const message = error instanceof Error ? error.message : String(error)
    console.error('[desktop] 启动失败:', error)
    await startupScreen?.showError(message)
  } finally {
    booting = false
  }
}

async function retryStartup(): Promise<void> {
  if (booting || !startupScreen) return
  mainWindow?.destroy()
  mainWindow = undefined
  await disposeKernel()
  await startupScreen.reset('重新准备内核')
  await bootAndOpen()
}

async function quitFromStartup(): Promise<void> {
  if (quitting) return
  await dispose()
  quitting = true
  app.quit()
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

  ipcMain.on(IPC_STARTUP_RETRY, () => { void retryStartup() })
  ipcMain.on(IPC_STARTUP_QUIT, () => { void quitFromStartup() })

  await app.whenReady()
  startupScreen = await openStartupScreen()
  void bootAndOpen()

  // 打包版启动后后台检查更新；下载完成不会打断当前任务，退出梦时替换。
  void checkForDesktopUpdate()
  const updateTimer = setInterval(() => { void checkForDesktopUpdate() }, 6 * 60 * 60 * 1000)
  updateTimer.unref()

  app.on('activate', () => {
    const win = startupScreen?.window ?? mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.on('second-instance', () => {
    const win = startupScreen?.window ?? mainWindow
    if (!win || win.isDestroyed()) return
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
  if (startupScreen) {
    await startupScreen.showError(error instanceof Error ? error.message : String(error))
    return
  }
  await dispose().catch(() => {})
  app.quit()
})
