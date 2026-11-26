/**
 * 侧栏「主题导航」的选项表。
 *
 * 为什么单独一份, 而不是把三个按钮直接写死在组件里:
 *   这张表是**纯数据** —— 项目里的规矩是「能测的部分别塞进组件」
 *   (见 sessions.ts + sessions.test.ts)。组件只负责画这张表。
 *
 * 为什么只有三个:
 *   主题的真相是 `prefs.theme`, 它只有 light / dark / system 三个值
 *   (prefs.ts 的 ThemeMode)。设置页里那张「敬请期待」的卡是**将来**的占位,
 *   不是现在的一个模式 —— 侧栏列一个点不动的项只会让人以为坏了。
 *
 * 顺序有讲究: 「跟随系统」排第一, 因为它是默认值 (DEFAULT_PREFS.theme)。
 * 默认值排第一 = 列表第一项就是什么都不用管的那项。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

/** 三种主题各配一个图标: 显示器=跟随系统, 太阳=浅色, 月亮=深色 */
export type ThemeNavIcon = 'system' | 'sun' | 'moon'

export interface ThemeNavOption {
  id: ThemeMode
  label: string
  icon: ThemeNavIcon
}

/** 「跟随系统」。单独提出来是因为它是兜底值, themeNavOption 要拿它当默认 */
const SYSTEM: ThemeNavOption = { id: 'system', label: '跟随系统', icon: 'system' }

export const THEME_NAV_OPTIONS: readonly ThemeNavOption[] = [
  SYSTEM,
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
]

/**
 * 某个主题模式对应哪个选项。
 *
 * 兜底回「跟随系统」而不是抛异常: 侧栏是**常驻**界面, 它崩了整屏都不可用。
 * 而不认识的模式本来就只可能来自脏数据 (prefs.ts 已经逐字段回落过,
 * 这里是第二道保险 —— 万一有别处塞进来一个 'purple', 侧栏照样能画)。
 */
export function themeNavOption(mode: ThemeMode): ThemeNavOption {
  return THEME_NAV_OPTIONS.find((o) => o.id === mode) ?? SYSTEM
}
