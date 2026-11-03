/**
 * 平台能力面 (docs/05 §3.2 定稿: 平台即插件)。
 *
 * 三端的差异全部收敛到这里。业务插件只写 ctx.get('fs'), **拿不到不是错误, 是要声明的降级**
 * —— 所以每个面都是 optional, 插件 manifest 用 `platforms` 声明自己服务哪些端。
 *
 * 硬规则: 业务插件里不允许出现 if (platform === 'mobile') 这类分支。
 * 平台差异只许出现在 layout 插件和下面这些实现里, 由 lint 强制。
 */

import type { PlatformName } from '@meng/slots'

export type { PlatformName }

export interface FsFace {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(path: string): Promise<{ name: string; dir: boolean }[]>
  /** 能力降级说明, 给 UI 显示"此端不支持"用 */
  readonly limits: { scope: 'workspace' | 'all'; writable: boolean }
}

export interface DialogFace {
  open(opts: { title: string; message: string; actions: string[] }): Promise<string>
  pickDirectory(): Promise<string | undefined>
}

export interface NotifyFace {
  send(title: string, body: string): Promise<void>
}

/** 只有 desktop 有: 多窗口 / 菜单 / 托盘 / 快捷键 */
export interface WindowFace {
  open(route: string, opts?: { width?: number; height?: number }): Promise<number>
  setTitle(title: string): void
  onClose(fn: () => void): () => void
}

export interface ClipboardFace {
  read(): Promise<string>
  write(text: string): Promise<void>
}

/** 只有 mobile 有 */
export interface HapticsFace {
  tap(): Promise<void>
}

export interface SecureStoreFace {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

/** 平台插件提供的全部能力面。缺哪个就是哪个不支持 */
export interface PlatformFaces {
  fs?: FsFace
  dialog?: DialogFace
  notify?: NotifyFace
  window?: WindowFace
  clipboard?: ClipboardFace
  haptics?: HapticsFace
  secureStore?: SecureStoreFace
}

export const PLATFORM_FACE_NAMES = [
  'fs',
  'dialog',
  'notify',
  'window',
  'clipboard',
  'haptics',
  'secureStore',
] as const

export type PlatformFaceName = (typeof PLATFORM_FACE_NAMES)[number]
