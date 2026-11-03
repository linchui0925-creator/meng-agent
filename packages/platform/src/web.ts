/**
 * 平台能力面 · 网页端。
 *
 * 能力受限是**常态不是错误**: 没有 window(多窗口/菜单/托盘),
 * fs 只能走 File System Access API 且需用户授权。缺的面就是 undefined,
 * 插件要声明降级, 不许崩。
 */

import type { PlatformFaces } from './index.ts'

export function webFaces(): PlatformFaces {
  return {
    // fs: File System Access API, limits.scope = 'workspace', 需用户授权
    // dialog: 自绘 web 组件
    // notify: Notification API
    // clipboard: Async Clipboard API
    // window / haptics / secureStore: 不支持
  }
}
