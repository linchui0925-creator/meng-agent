/**
 * 「视觉偏好」落到 DOM 的那一层。
 *
 * 和 theme.ts 是同一条思路的两半: theme 决定**颜色**, 这里决定**松紧与动不动**。
 * 分成两个文件而不是一个, 是因为它们的失败方式不同 ——
 * 主题晚了会闪一下, 密度晚了会让整页跳一格, 而两者的修复位置都在 main.tsx 首帧。
 *
 * 为什么落在 <html> 上而不是给 App 传一个 context:
 *   密度和动效要作用到**所有**元素, 包括 packages/ui 里的组件和将来第三方插件画的东西。
 *   令牌是继承的, 挂在 html 上就是全站; 挂在某个容器上只有那个容器。
 *   context 属性只能传到 React 树里的组件, 传到不了 CSS。
 */

import type { Prefs } from './prefs.ts'

export function applyPresentation(p: Prefs): void {
  const root = document.documentElement
  /*
    两个属性都**显式写出取值**, 不靠"没有属性"来表达默认。
    这样界面上永远能读到当前状态 (验收脚本、调试、以及将来别的插件判断),
    而不必把"属性不存在"也当成一个有含义的状态去猜。
  */
  root.dataset.density = p.density === 'compact' ? 'compact' : 'standard'
  root.dataset.motion = p.motion === 'reduced' ? 'reduced' : 'system'
}
