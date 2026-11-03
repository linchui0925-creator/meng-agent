/**
 * 主题解析。
 *
 * 为什么不在 CSS 里用 `@media (prefers-color-scheme)` 兜底: 那只能切 color-scheme,
 * 换不了 alias 赋值, 结果是浅色底配深色控件。**首帧前把 data-theme 写死**才是干净的做法,
 * 所以这段必须在 render 之前同步跑 (main.tsx 里第一行)。
 *
 * 存储不在这里: 主题是用户偏好的一项, 存在 prefs.ts 的统一容器里。
 * 这里只负责"模式 -> 实际深浅"的推导与落地。
 */

import { readPrefs, updatePrefs } from './prefs.ts'
import type { ThemeMode } from './prefs.ts'

export type { ThemeMode }

export type ResolvedTheme = 'light' | 'dark'

export function readThemeMode(): ThemeMode {
  return readPrefs().theme
}

export function saveThemeMode(mode: ThemeMode): void {
  updatePrefs({ theme: mode })
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 把主题落到 <html data-theme>, 返回实际生效的深浅 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  return resolved
}

/** 手动切换只在 light/dark 之间来回; system 只作为初始值 */
export function toggleTheme(current: ResolvedTheme): ResolvedTheme {
  return current === 'dark' ? 'light' : 'dark'
}
