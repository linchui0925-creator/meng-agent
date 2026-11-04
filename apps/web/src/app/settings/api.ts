/**
 * 设置页的**对外契约**（投给 `settings.view` 的 props / 分区拿到的 props）。
 *
 * 与 layout.ts 同一条规矩: 插件看到的必须是一份与内置实现无关的类型。
 * 设置页壳是内置的, 但分区是插件 —— 分区只认 SectionApi, 不认 App 的内部 state。
 */

import type { ComponentType } from 'react'

import type { Prefs } from '../../prefs.ts'

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
 * 分区拿到的 props。
 *
 * **为什么 `setPrefs` 接受 Partial 而不是「一个字段一个回调」**:
 * 曾经这里是 `themeMode` + `onThemeMode` 两个字段 —— 每加一项设置都要在
 * 契约上加一对, 三个分区之后这个类型会变成一张回调清单。
 * 改成「读一份 prefs / 写一个 patch」之后, 加设置项只动 prefs.ts 一处,
 * 契约和宿主都不用改。
 *
 * `Partial<Prefs>` 的形状由 Prefs 决定, 所以分区写错字段名会在这里报错,
 * 而不是静默写进 localStorage 一个没人读的键。
 */
export type SectionApi = {
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  /**
   * 内核 op 的**唯一入口**。
   *
   * 为什么给一个函数而不是整个 `Transport`: 分区要的是「问内核一件事」这一种能力。
   * 给 transport 就等于同时给了 `subscribe` —— 分区会顺手去监听会话事件流,
   * 而设置页与会话流是两条互不相干的路, 那条路一开就再也收不回去了。
   *
   * 所以这里刻意**不按 op 拆成 catalog()/setConfig() 这样的领域方法**:
   * 那样每加一个内核能力都要改一次这份契约, 等于把宿主当成 op 的路由表。
   * 一个 invoke, 后端加 op 前端零改动 —— 和 `setPrefs` 是同一条思路。
   */
  invoke: <T = unknown>(op: string, payload?: unknown) => Promise<T>
}

/**
 * 设置页壳收到的 props（`settings.view` 的 owner）。
 *
 * `close` 由宿主给: 关不关设置是**宿主的 view 状态**, 不是壳的。
 * 壳只负责「用户点了返回」这件事往上抛。
 *
 * 壳自己不读偏好、也不写 —— 它只是把 `prefs` 原样传给当前分区的组件。
 * 这样壳永远不用改: 加设置项改的是 prefs、画设置项改的是分区。
 */
export type SettingsViewApi = SectionApi & {
  open: boolean
  close: () => void
  sections: SectionEntry[]
}
