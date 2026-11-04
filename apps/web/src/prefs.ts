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
 *
 * ── 这里只有「本机腿」 ──
 *   凡是需要重启进程、需要后端知道的东西, 一律不在这里 (那是 config 那条腿)。
 *   判据很简单: **只影响这台机器上这个浏览器的观感** → 进这里。
 *   所以「工作区根目录」「API 密钥」不在这里, 而「气泡冒不冒」在这里。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

/** 布局密度。standard = 正文有呼吸感; compact = 全站按控件高度收紧 */
export type Density = 'standard' | 'compact'

/**
 * 动效。
 *   system  —— 跟随操作系统的「减少动态效果」偏好 (默认)
 *   reduced —— 无条件关掉动画
 *
 * 没有 'full' 这个值: 系统没要求减动效时本来就是全量, 多一个档位只是让
 * 默认值有一个可以从头错到尾的机会。
 */
export type MotionMode = 'system' | 'reduced'

/**
 * 等待气泡出现得多早。
 * 存的是**语义**而不是毫秒 —— 以后想调「8 秒」这个阈值, 不用去改用户已经存下的数字。
 */
export type WhisperWhen = 'soon' | 'normal' | 'late'

export interface Prefs {
  theme: ThemeMode
  density: Density
  motion: MotionMode
  /** 等待气泡总开关。关掉后等多久都不冒 */
  whisper: boolean
  whisperWhen: WhisperWhen
  /** 工具卡跑完后自动折叠 (false = 默认展开, 输出直接摊着) */
  foldTools: boolean
}

const KEY = 'meng.prefs'

/**
 * 旧版本把主题单独存在 `meng.theme`。
 * 读新键读不到时把它并进来, 否则老用户会发现"我明明选了深色, 怎么变回来了"。
 * 旧键**不删也不写** —— 万一要回滚到旧版本, 那边还能用。
 */
const LEGACY_THEME_KEY = 'meng.theme'

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  density: 'standard',
  motion: 'system',
  whisper: true,
  whisperWhen: 'normal',
  foldTools: true,
}

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
const DENSITIES: readonly Density[] = ['standard', 'compact']
const MOTION_MODES: readonly MotionMode[] = ['system', 'reduced']
const WHISPER_WHENS: readonly WhisperWhen[] = ['soon', 'normal', 'late']

function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && (THEME_MODES as readonly string[]).includes(v)
}

/**
 * 枚举字段: 认识就用, 不认识退回默认。
 *
 * 三个枚举字段共用这一个函数, 是为了让"加一个枚举设置项"变成
 * 「表里加一行 + 调一次 pick」—— 而不是复制三段几乎相同的 if。
 */
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/** 布尔字段: 只认真正的 boolean。`"false"` / `0` 一律算脏值 → 默认 */
function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
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

  const obj =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined

  if (obj) {
    out.density = pick(obj.density, DENSITIES, DEFAULT_PREFS.density)
    out.motion = pick(obj.motion, MOTION_MODES, DEFAULT_PREFS.motion)
    out.whisper = pickBool(obj.whisper, DEFAULT_PREFS.whisper)
    out.whisperWhen = pick(obj.whisperWhen, WHISPER_WHENS, DEFAULT_PREFS.whisperWhen)
    out.foldTools = pickBool(obj.foldTools, DEFAULT_PREFS.foldTools)
  }

  /*
    主题的回落链比其它字段多一级 (旧键), 所以单独写。

    这里**不能用** `pick(obj.theme, ..., 默认)` 再判「等于默认就看旧键」——
    那样用户主动选了"跟随系统", 会被旧键里的 dark 顶掉, 于是"我明明选了跟随系统,
    它却一直深色"。判据必须是「新键里有没有一个合法值」, 而不是「值等不等于默认」。
  */
  if (obj && isThemeMode(obj.theme)) out.theme = obj.theme
  else if (isThemeMode(legacyTheme)) out.theme = legacyTheme

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
