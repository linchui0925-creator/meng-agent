import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

const SPLASH_WIDTH = 500
const SPLASH_HEIGHT = 342
const MIN_VISIBLE_MS = 450

export interface StartupScreen {
  readonly window: BrowserWindow
  readonly ready: Promise<void>
  setStage(stage: string): Promise<void>
  setVersion(version: string): Promise<void>
  showError(message: string): Promise<void>
  reset(stage?: string): Promise<void>
  close(): void
}

export async function openStartupScreen(): Promise<StartupScreen> {
  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '梦',
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(app.getAppPath(), 'startup-preload.cjs'),
    },
  })
  win.setMenuBarVisibility(false)
  win.center()

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      win.show()
      resolve()
    }
    win.once('ready-to-show', done)
    win.webContents.once('did-finish-load', () => setTimeout(done, 30))
    win.webContents.once('did-fail-load', (_event, code, description) => {
      if (settled) return
      settled = true
      reject(new Error(`启动界面加载失败 (${code}): ${description}`))
    })
  })

  void win.loadFile(join(app.getAppPath(), 'startup.html'))
  await ready
  await setVersion(win, app.getVersion())
  await setStage(win, '准备内核')

  return {
    window: win,
    ready,
    setStage: (stage) => setStage(win, stage),
    setVersion: (version) => setVersion(win, version),
    showError: (message) => setStartupError(win, message),
    reset: (stage) => setStartupLoading(win, stage),
    close: () => {
      if (!win.isDestroyed()) win.close()
    },
  }
}

export async function revealMainWindow(startup: StartupScreen, main: BrowserWindow): Promise<void> {
  if (main.isDestroyed()) return
  try {
    main.setOpacity(0)
  } catch {
    // Linux 不一定支持窗口透明度；没有淡入也仍然能正常显示。
  }
  main.show()
  main.focus()
  await Promise.all([
    fade(startup.window, 1, 0, 150),
    fade(main, 0, 1, 190),
  ])
  startup.close()
}

export function minimumSplashWait(startedAt: number): Promise<void> {
  const remaining = MIN_VISIBLE_MS - (Date.now() - startedAt)
  return remaining > 0 ? delay(remaining) : Promise.resolve()
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function setStage(win: BrowserWindow, text: string): Promise<void> {
  await execute(win, `window.setStartupStage?.(${JSON.stringify(text)})`)
}

async function setVersion(win: BrowserWindow, text: string): Promise<void> {
  await execute(win, `window.setStartupVersion?.(${JSON.stringify(text)})`)
}

async function setStartupError(win: BrowserWindow, message: string): Promise<void> {
  await execute(win, `window.setStartupError?.(${JSON.stringify(message)})`)
}

async function setStartupLoading(win: BrowserWindow, text?: string): Promise<void> {
  await execute(win, `window.setStartupLoading?.(${JSON.stringify(text ?? '准备内核')})`)
}

async function execute(win: BrowserWindow, code: string): Promise<void> {
  if (win.isDestroyed()) return
  try {
    await win.webContents.executeJavaScript(code, true)
  } catch (error) {
    console.warn(`[desktop/startup] 更新启动界面失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function fade(win: BrowserWindow, from: number, to: number, duration: number): Promise<void> {
  if (process.platform === 'linux' || win.isDestroyed()) return
  const steps = Math.max(1, Math.round(duration / 16))
  for (let step = 0; step <= steps; step++) {
    if (win.isDestroyed()) return
    const progress = step / steps
    const value = from + (to - from) * progress
    try {
      win.setOpacity(value)
    } catch {
      return
    }
    if (step < steps) await delay(duration / steps)
  }
}
