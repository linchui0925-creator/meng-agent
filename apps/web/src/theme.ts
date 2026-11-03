/**
 * 主题解析。
 *
 * 为什么不在 CSS 里用 `@media (prefers-color-scheme)` 兜底: 那只能切 color-scheme,
 * 换不了 alias 赋值, 结果是浅色底配深色控件。**首帧前把 data-theme 写死**才是干净的做法,
 * 所以这段必须在 render 之前同步跑 (main.tsx 里第一行)。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'meng.theme'

export function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // 隐私模式 / 嵌入式 WebView 可能禁掉 localStorage, 不该因此白屏
  }
  return 'system'
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 存不下就算了, 本次会话仍然生效
  }
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
