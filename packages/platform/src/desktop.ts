/**
 * 平台能力面 · 桌面端 (Electron 主进程)。
 *
 * 这是三端里能力最全的一份。fs 走 node, dialog/notify 走原生,
 * window 面只有这一端有(多窗口 / 菜单 / 托盘 / 全局快捷键)。
 */

import type { PlatformFaces } from './index.ts'

export function desktopFaces(): PlatformFaces {
  throw new Error('platform/desktop: 未实现 (M6)')
}
