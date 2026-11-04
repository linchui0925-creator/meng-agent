/**
 * 设置页的**对外契约**（投给 `settings.view` 的 props / 分区拿到的 props）。
 *
 * 与 layout.ts 同一条规矩: 插件看到的必须是一份与内置实现无关的类型。
 * 设置页壳是内置的, 但分区是插件 —— 分区只认 SectionApi, 不认 App 的内部 state。
 */

import type { ComponentType } from 'react'

import type { ThemeMode } from '../../prefs.ts'

/** 一个已注册的分区。由宿主从 `slots.entries('settings.section')` 投影出来 */
export type SectionEntry = {
  /** 注册者 id（pluginId）。同时是导航项的 React key 与激活标识 */
  id: string
  /** 左导航文字；同时是搜索过滤的匹配源 */
  label: string
  /** 导航分组标题（「界面」/「内核」）；同组连续排列 */
  group: string
  /** 两条腿的显性标记: local = 本机偏好, kernel = 内核配置 */
  origin: 'local' | 'kernel'
  Component: ComponentType<Record<string, unknown>>
}

/**
 * 设置页壳收到的 props（`settings.view` 的 owner）。
 *
 * `close` 由宿主给: 关不关设置是**宿主的 view 状态**, 不是壳的。
 * 壳只负责「用户点了返回」这件事往上抛。
 */
export type SettingsViewApi = {
  open: boolean
  close: () => void
  sections: SectionEntry[]
  themeMode: ThemeMode
  onThemeMode: (mode: ThemeMode) => void
}

/** 分区组件收到的 props。所有分区拿同一份, 用不到的就不取 */
export type SectionApi = {
  themeMode: ThemeMode
  onThemeMode: (mode: ThemeMode) => void
}
