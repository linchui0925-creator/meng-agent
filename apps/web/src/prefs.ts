/**
 * 用户偏好。设置页里能改的东西都从这里出。
 *
 * ── 为什么一个键存全部, 而不是每项一个键 ──
 *   1. 脏值**逐字段**回落: `{"theme":"purple"}` 只是主题退回默认, 不会连累同一块里的
 *      其它字段。(每项一个键也能做到, 但那样"读一次"要写六遍 try/catch)
 *   2. 加字段 = 表里加一行 + 一个默认值, 不用再起键名、不用管老数据的缺字段问题。
 *   代价: 写入是整块覆盖。设置操作频率极低, 换这点简单值得。
 *
 * ── 两处必须记住的约束 ──
 *   · **纯解析和读写分开**: `parsePrefs` 是纯函数(输入两串文本, 输出一定完整合法),
 *     所以能在 node 里单测, 不需要浏览器。
 *   · **存不下不能白屏**: 隐私模式 / 嵌入式 WebView 会禁掉 localStorage。
 *     全部 try/catch, 失败即用默认值 —— 用户的偏好丢了是小事, 界面打不开是大事。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

export interface Prefs {
  theme: ThemeMode
}

const KEY = 'meng.prefs'

/**
 * 旧版本把主题单独存在 `meng.theme`。
 * 读新键读不到时把它并进来, 否则老用户会发现"我明明选了深色, 怎么变回来了"。
 * 旧键**不删也不写** —— 万一要回滚到旧版本, 那边还能用。
 */
const LEGACY_THEME_KEY = 'meng.theme'

const DEFAULT_PREFS: Prefs = { theme: 'system' }

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system'
}

/**
 * 解析成一份完整合法的偏好。
 *
 * 优先级: 新键里的合法值 > 旧键里的合法值 > 默认值。
 * 任何一步拿到不认识的东西都**只影响那一个字段**, 不通篇放弃 ——
 * 手工改坏一个字段就整份重置, 是最容易让人骂"设置自己变回去了"的做法。
 */
export function parsePrefs(raw: string | null, legacyTheme: string | null = null): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS }

  let parsed: unknown
  if (raw !== null && raw !== '') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 坏 JSON 不是"没有偏好" —— 继续往下试旧键
      parsed = undefined
    }
  }

  if (parsed !== null && typeof parsed === 'object') {
    const theme = (parsed as Record<string, unknown>).theme
    if (isThemeMode(theme)) out.theme = theme
  }

  // 新键没有可用主题时, 才回头看旧键
  if (out.theme === DEFAULT_PREFS.theme && isThemeMode(legacyTheme)) out.theme = legacyTheme

  return out
}

export function readPrefs(): Prefs {
  try {
    return parsePrefs(localStorage.getItem(KEY), localStorage.getItem(LEGACY_THEME_KEY))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(next: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 存不下就算了, 本次会话仍然生效
  }
}

/** 改一个字段: 读 -> 合 -> 写。调用方不必自己拼整份对象 */
export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch }
  savePrefs(next)
  return next
}
