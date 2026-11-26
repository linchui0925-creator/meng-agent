/**
 * 插件自己的设置存储。
 *
 * **为什么不写进宿主的 `prefs`**:
 * 宿主 prefs 是**宿主的那一份** (`apps/web/src/prefs.ts` 的 `Prefs` 类型),
 * 插件往里塞自己的字段, 宿主既不认、也不会读, 而且下次宿主改 `Prefs`
 * 类型时插件会跟着炸。插件的状态归插件 —— 这是同一条规矩的另一面:
 * 宿主换肤靠 alias token, 插件偏好靠自己的存储。
 *
 * localStorage 存取一律 try/catch: 隐私模式 / 嵌入式 WebView 会禁掉它,
 * 读不到就用默认值, **不许白屏**。
 */

export interface AmbientSettings {
  /** 总开关 */
  enabled: boolean
  /** 强度 0~1 */
  strength: number
  /** 跟随速度 0~1 */
  responsiveness: number
  /** 呼吸幅度 0~1 */
  breathe: number
}

export const DEFAULT_SETTINGS: AmbientSettings = {
  enabled: true,
  strength: 0.55,
  responsiveness: 0.5,
  breathe: 0.6,
}

const KEY = 'meng.plugin.screen-ambient.settings'

/** 读设置。坏数据 / 存不下 → 默认值 */
export function readSettings(): AmbientSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AmbientSettings>
    return normalize(parsed)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写设置。存不下就静默失败 —— 界面不该因为存不下而崩 */
export function writeSettings(settings: AmbientSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalize(settings)))
  } catch {
    /* 存不下就当没存 */
  }
}

/**
 * 归一化 —— **每个字段都要夹紧**。
 *
 * 为什么: 设置是从 localStorage 读出来的, 而 localStorage 里什么都能被写
 * （别的脚本、手改、上一版插件留下的旧结构）。一个 `strength: 999` 会让
 * alpha 算出来爆掉, 一个 `enabled: "yes"` 会被当真值用。
 * 所以这里不信任任何值, 一律夹回合法区间。
 */
export function normalize(input: Partial<AmbientSettings>): AmbientSettings {
  return {
    enabled: input.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(input.enabled),
    strength: clamp(input.strength, DEFAULT_SETTINGS.strength, 0, 1),
    responsiveness: clamp(input.responsiveness, DEFAULT_SETTINGS.responsiveness, 0, 1),
    breathe: clamp(input.breathe, DEFAULT_SETTINGS.breathe, 0, 1),
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return n < min ? min : n > max ? max : n
}
