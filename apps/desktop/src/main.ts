/**
 * Electron 主进程。
 *
 * 本地内核直接运行在主进程里；渲染进程不拿 Node，只通过 preload 暴露的
 * invoke / event / state / manifest 四件事访问内核。HTTP 只绑定 127.0.0.1，
 * 作为 op 执行的内部通道，不对外暴露。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { app, BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences } from 'electron'
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

function looksLikeDreamWorkspace(path: string): boolean {
  return existsSync(join(path, 'apps', 'desktop', 'package.json'))
    && existsSync(join(path, 'apps', 'web', 'package.json'))
    && existsSync(join(path, 'packages', 'session', 'package.json'))
}

/**
 * 没选工作区时，梦默认回到自己的源码目录。
 *
 * 开发态在 apps/desktop；打包态在 .app/Contents/Resources/app。
 * 不写死某一个绝对路径，而是从应用位置向上找 Dream monorepo 标记，
 * 这样同一份包从仓库内或 /Applications 启动都能找到正确目录。
 */
function defaultWorkspace(): string | undefined {
  const explicit = (process.env['MENG_DEFAULT_WORKSPACE'] ?? process.env['MENG_WORKSPACE'] ?? '').trim()
  if (explicit && looksLikeDreamWorkspace(resolve(explicit))) return resolve(explicit)

  let current = resolve(app.getAppPath())
  for (let depth = 0; depth < 12; depth++) {
    if (looksLikeDreamWorkspace(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  const cwd = process.cwd()
  if (looksLikeDreamWorkspace(cwd)) return resolve(cwd)

  const documents = join(app.getPath('home'), 'Documents', '梦')
  return looksLikeDreamWorkspace(documents) ? documents : undefined
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

/**
 * 屏幕捕获 —— 让渲染进程里的 `getDisplayMedia` 能用。
 *
 * **为什么必须做这件事**:
 * 渲染进程跑的是普通网页, `navigator.mediaDevices.getDisplayMedia` 在那里
 * **永远失败** —— Chromium 在浏览器里靠系统自带的捕获器, 而 Electron 里
 * 这条路要主进程放行。没设这个 handler 时, 插件调用抓屏会拿到
 * `NotAllowedError`, 而且没有任何办法从渲染进程绕过。
 *
 * **为什么优先用系统选择器**:
 * `useSystemPicker: true` 时 Electron 调起 macOS 原生的屏幕选择面板 ——
 * 用户看到的是系统自己的 UI, 有权限提示、有「只共享某个窗口」的选项。
 * 这是最不越界的一种做法: **授权的语义由系统定义, 不是我们定义的**。
 *
 * 但它有两个限制, 所以不能只靠它:
 *   1. Electron 文档标明这是**实验性**功能, 且**只支持 macOS 15+**。
 *   2. 系统选择器可用时, **handler 根本不会被调用** —— 我们没有插手的机会。
 *
 * 所以这里做的是两层:
 *   · 系统选择器可用 → 直接交给系统, handler 里什么都不做
 *   · 不可用 (Linux / Windows / 老 macOS) → handler 兜底:
 *     用 `desktopCapturer` 拿到屏幕列表, **自动选主屏幕**返回
 *
 * 兜底选主屏幕是刻意的: 插件要的是「整片画面的主色调」, 选哪块屏幕
 * 差别不大, 而弹一个自制的选择框反而要多写一套 UI、多一条 IPC 通道。
 * 想换屏幕的用户可以在插件里看画面不满意再调。
 *
 * **权限状态**: macOS 的「屏幕录制」权限由用户在系统设置里授予。
 * 这里查一次状态, 没给权限就**明确拒掉**并说明原因 ——
 * 静默失败会让用户以为插件坏了。
 */
function installDisplayMediaHandler(win: BrowserWindow): void {
  win.webContents.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        // 音频我们用不上, 明确拒绝 —— 少要一样东西就少一份权限
        if (!desktopCapturer) {
          callback({})
          return
        }

        // macOS 上没给「屏幕录制」权限时, 抓到的是黑屏而不是报错。
        // 与其给用户一块黑屏, 不如明确说清楚缺什么权限。
        if (process.platform === 'darwin') {
          const status = systemPreferences.getMediaAccessStatus('screen')
          if (status === 'denied' || status === 'restricted') {
            callback({})
            return
          }
        }

        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            // 不要缩略图 —— 它会把每块屏幕的内容抓成图片, 慢且没用
            thumbnailSize: { width: 0, height: 0 },
          })

          if (sources.length === 0) {
            callback({})
            return
          }

          // 优先选**当前窗口所在的那块屏幕** —— 它多半就是用户正在看的那块
          const display = screen.getDisplayMatching(win.getBounds())
          const primary = screen.getPrimaryDisplay()

          /**
           * `Display.id` 是 number, 而 `DesktopCapturerSource.display_id` 是 string。
           * 所以比较时要统一成字符串 —— 直接比大小永远不相等, 会一路落到
           * `sources[0]`, 于是兜底逻辑永远选第一块屏幕, 而不是用户在看的那块。
           */
          const wanted = String(display.id || primary.id)

          const picked =
            sources.find((source) => source.display_id === wanted) ?? sources[0]

          if (!picked) {
            callback({})
            return
          }

          callback({ video: picked, audio: undefined })
        } catch {
          callback({})
        }
      })()
    },
    {
      /**
       * 交给系统原生选择器。
       *
       * 可用时 handler 不会被调用 —— 整个授权流程由 macOS 负责。
       * 不可用时上面的兜底逻辑接管。
       */
      useSystemPicker: true,
    },
  )
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
  installDisplayMediaHandler(win)
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

  const workspace = defaultWorkspace()
  if (workspace) {
    process.env.MENG_DEFAULT_WORKSPACE = workspace
    process.env.MENG_WORKSPACE = workspace
  }

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
