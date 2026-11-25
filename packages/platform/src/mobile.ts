/**
 * 平台能力面 · 移动端 (Capacitor)。
 *
 * 每个面包装一个 Capacitor 插件；在纯 web 容器里由 Capacitor 自己回退到 web 实现。
 * 没有目录选择器、没有多窗口，缺的面保持 undefined。
 */

import { Clipboard } from '@capacitor/clipboard'
import { Dialog } from '@capacitor/dialog'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Preferences } from '@capacitor/preferences'

import type { PlatformFaces } from './index.ts'

function textOf(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object' && 'text' in data && typeof (data as { text?: unknown }).text === 'function') {
    return String((data as { text(): string }).text())
  }
  return ''
}

export function mobileFaces(): PlatformFaces {
  return {
    fs: {
      limits: { scope: 'workspace', writable: true },
      async read(path) {
        const result = await Filesystem.readFile({ path, encoding: Encoding.UTF8, directory: Directory.Data })
        return textOf(result.data)
      },
      async write(path, content) {
        await Filesystem.writeFile({
          path,
          data: content,
          encoding: Encoding.UTF8,
          directory: Directory.Data,
          recursive: true,
        })
      },
      async list(path) {
        const result = await Filesystem.readdir({ path, directory: Directory.Data })
        return result.files.map((entry) => ({ name: entry.name, dir: entry.type === 'directory' }))
      },
    },
    dialog: {
      async open(opts) {
        if (opts.actions.length <= 1) {
          await Dialog.alert({ title: opts.title, message: opts.message })
          return opts.actions[0] ?? '确定'
        }
        if (opts.actions.length === 2) {
          const result = await Dialog.confirm({
            title: opts.title,
            message: opts.message,
            okButtonTitle: opts.actions[1],
            cancelButtonTitle: opts.actions[0],
          })
          return result.value ? (opts.actions[1] ?? opts.actions[0] ?? '') : (opts.actions[0] ?? '')
        }
        const result = await Dialog.prompt({
          title: opts.title,
          message: `${opts.message}\n\n${opts.actions.join(' / ')}`,
          inputPlaceholder: opts.actions[0],
        })
        return opts.actions.includes(result.value) ? result.value : (opts.actions[0] ?? '')
      },
      async pickDirectory() {
        return undefined
      },
    },
    notify: {
      async send(title, body) {
        let permission = await LocalNotifications.checkPermissions()
        if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions()
        if (permission.display !== 'granted') throw new Error('通知权限未开启')
        await LocalNotifications.schedule({
          notifications: [{
            id: Math.floor(Date.now() % 2_147_483_647),
            title,
            body,
            schedule: { at: new Date(Date.now() + 250) },
          }],
        })
      },
    },
    clipboard: {
      async read() {
        return (await Clipboard.read()).value ?? ''
      },
      async write(text) {
        await Clipboard.write({ string: text })
      },
    },
    haptics: {
      async tap() {
        await Haptics.impact({ style: ImpactStyle.Light })
      },
    },
    secureStore: {
      async get(key) {
        return (await Preferences.get({ key })).value ?? undefined
      },
      async set(key, value) {
        await Preferences.set({ key, value })
      },
    },
  }
}
