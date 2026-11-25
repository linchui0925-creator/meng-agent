/**
 * 平台能力面 · 桌面端 (Electron 主进程)。
 *
 * 这是三端里能力最全的一份：文件系统走 Node，对话框 / 通知 / 剪贴板走 Electron，
 * 多窗口只在桌面端存在。窗口创建参数由桌面壳注入，平台包不自己猜前端地址。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, Notification, safeStorage } from 'electron'

import type { PlatformFaces } from './index.ts'

export interface DesktopFaceOptions {
  preload?: string
  webUrl?: string
}

function rootOf(): string {
  return resolve(process.env.MENG_WORKSPACE ?? process.cwd())
}

function insideRoot(root: string, path: string): string {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界: ${path}`)
  return target
}

function windowUrl(route: string): string {
  const base = process.env.MENG_WEB_URL ?? 'http://127.0.0.1:4722/?transport=ipc'
  const url = new URL(base)
  if (route && route !== '/') {
    if (route.startsWith('?')) url.search = route
    else url.pathname = route
  }
  return url.toString()
}

async function secureFile(): Promise<string> {
  const dir = join(app.getPath('userData'), 'secure')
  await mkdir(dir, { recursive: true })
  return join(dir, 'store.json')
}

async function readSecure(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(await secureFile(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export function desktopFaces(options: DesktopFaceOptions = {}): PlatformFaces {
  const root = rootOf()

  return {
    app: {
      async restart() {
        app.relaunch()
        app.exit(0)
      },
    },
    fs: {
      limits: { scope: 'workspace', writable: true },
      async read(path) {
        return await readFile(insideRoot(root, path), 'utf8')
      },
      async write(path, content) {
        const target = insideRoot(root, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      },
      async list(path) {
        const target = insideRoot(root, path)
        const rows = await readdir(target, { withFileTypes: true })
        return rows.map((row) => ({ name: row.name, dir: row.isDirectory() }))
      },
    },
    dialog: {
      async open(opts) {
        const result = await dialog.showMessageBox({
          title: opts.title,
          message: opts.title,
          detail: opts.message,
          buttons: opts.actions,
          cancelId: 0,
          noLink: true,
        })
        return opts.actions[result.response] ?? opts.actions[0] ?? ''
      },
      async pickDirectory() {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
        return result.canceled ? undefined : result.filePaths[0]
      },
    },
    notify: {
      async send(title, body) {
        if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知')
        new Notification({ title, body }).show()
      },
    },
    window: {
      async open(route, opts) {
        const win = new BrowserWindow({
          width: opts?.width ?? 1100,
          height: opts?.height ?? 760,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            ...(options.preload === undefined ? {} : { preload: options.preload }),
          },
        })
        await win.loadURL(windowUrl(route))
        return win.id
      },
      setTitle(title) {
        BrowserWindow.getFocusedWindow()?.setTitle(title)
      },
      onClose(fn) {
        const win = BrowserWindow.getFocusedWindow()
        if (!win) return () => {}
        const listener = () => fn()
        win.on('closed', listener)
        return () => win.removeListener('closed', listener)
      },
    },
    clipboard: {
      async read() {
        return clipboard.readText()
      },
      async write(text) {
        clipboard.writeText(text)
      },
    },
    secureStore: {
      async get(key) {
        const encrypted = (await readSecure())[key]
        if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined
        try {
          return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        } catch {
          return undefined
        }
      },
      async set(key, value) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用')
        const rows = await readSecure()
        rows[key] = safeStorage.encryptString(value).toString('base64')
        await writeFile(await secureFile(), JSON.stringify(rows), { mode: 0o600 })
      },
    },
  }
}
