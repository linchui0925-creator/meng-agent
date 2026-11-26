/**
 * 平台能力面 · 网页端。
 *
 * 能力受限是常态：没有多窗口、没有可信的本地文件系统。
 * 这里只提供浏览器稳定支持的剪贴板、通知、对话框和震动；缺的面保持 undefined。
 */

import type { PlatformFaces } from './index.ts'

type BrowserNavigator = {
  clipboard?: { readText?: () => Promise<string>; writeText?: (text: string) => Promise<void> }
  vibrate?: (pattern: number | number[]) => boolean
}

type BrowserWindow = {
  alert?: (message: string) => void
  confirm?: (message: string) => boolean
  showDirectoryPicker?: () => Promise<{ name: string }>
}

type BrowserNotificationCtor = {
  new (title: string, options?: { body?: string }): { close(): void }
  permission?: string
  requestPermission?: () => Promise<string>
}

function nav(): BrowserNavigator | undefined {
  return (globalThis as unknown as { navigator?: BrowserNavigator }).navigator
}

function browserWindow(): BrowserWindow | undefined {
  return (globalThis as unknown as { window?: BrowserWindow }).window
}

export function webFaces(): PlatformFaces {
  const navigator = nav()
  const win = browserWindow()
  const NotificationCtor = (globalThis as unknown as { Notification?: BrowserNotificationCtor }).Notification

  return {
    dialog: win === undefined ? undefined : {
      async open(opts) {
        if (opts.actions.length <= 1) {
          win.alert?.(`${opts.title}\n\n${opts.message}`)
          return opts.actions[0] ?? '确定'
        }
        if (opts.actions.length === 2) {
          const ok = win.confirm?.(`${opts.title}\n\n${opts.message}`) ?? false
          return ok ? (opts.actions[1] ?? opts.actions[0] ?? '') : (opts.actions[0] ?? '')
        }
        const answer = (globalThis as unknown as { prompt?: (message: string, value?: string) => string | null }).prompt?.(
          `${opts.title}\n\n${opts.message}\n\n${opts.actions.join(' / ')}`,
          opts.actions[0],
        )
        return opts.actions.includes(answer ?? '') ? (answer ?? '') : (opts.actions[0] ?? '')
      },
      async pickDirectory() {
        if (!win.showDirectoryPicker) return undefined
        const handle = await win.showDirectoryPicker()
        return handle.name
      },
    },
    notify: NotificationCtor === undefined ? undefined : {
      async send(title, body) {
        if (NotificationCtor.permission === 'denied') return
        if (NotificationCtor.permission !== 'granted' && NotificationCtor.requestPermission) {
          const permission = await NotificationCtor.requestPermission()
          if (permission !== 'granted') return
        }
        new NotificationCtor(title, { body })
      },
    },
    clipboard: navigator?.clipboard === undefined ? undefined : {
      async read() {
        return await navigator.clipboard?.readText?.() ?? ''
      },
      async write(text) {
        await navigator.clipboard?.writeText?.(text)
      },
    },
    haptics: navigator?.vibrate === undefined ? undefined : {
      async tap() {
        navigator.vibrate?.(12)
      },
    },
  }
}
