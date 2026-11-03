/**
 * 原子层: Radix(行为 + 无障碍) + CVA(变体) + CSS Modules(作用域) + CSS 变量 token(主题)。
 *
 * 分工 (docs/05 §2 定稿):
 *   Radix      → 行为与无障碍, 不带样式
 *   CVA        → 变体组合, 输出类名字符串
 *   CSS Modules → 局部作用域, 随 bundle 走, 能按插件回收
 *   token       → 双层 CSS 变量, 运行时换主题
 *
 * 不引 Tailwind 的三条理由见 docs/05 §2, 核心是"插件 bundle 独立构建 + 运行时加载"
 * 与 Tailwind 的构建期按需生成冲突。
 *
 * 第一批只做第一版界面真用得上的 (docs/07 §F3)。Dialog / Tabs / DropdownMenu / Toast
 * 的 Radix 依赖已经装好了, 但**没有第一个真需求之前不写** —— 写了就是猜产品。
 */

export type { VariantProps } from 'class-variance-authority'
export { cva } from 'class-variance-authority'
export { clsx } from 'clsx'

/* ── 第一批原子 ── */
export { Button, type ButtonProps } from './Button.tsx'
export { IconButton, type IconButtonProps } from './IconButton.tsx'
export { Input, type InputProps } from './Input.tsx'
export { Textarea, type TextareaProps } from './Textarea.tsx'
export { ScrollArea, type ScrollAreaProps } from './ScrollArea.tsx'
export { Tooltip, TooltipProvider, Hint, type TooltipProps } from './Tooltip.tsx'
export { Badge, type BadgeProps } from './Badge.tsx'
export { Spinner, type SpinnerProps } from './Spinner.tsx'
export { Skeleton, type SkeletonProps } from './Skeleton.tsx'
export { Separator, type SeparatorProps } from './Separator.tsx'
export { Kbd, type KbdProps } from './Kbd.tsx'

/* ── 主题 ── */
export {
  createThemeController,
  type ThemeController,
  type ThemeControllerOptions,
  type ThemeLayer,
} from './theme.ts'

/**
 * token 双层结构 (抄 dsh 的 --dsw-* 分层):
 *
 *   --meng-alias-bg-surface      alias 层: 主题可变, 插件只许用这一层
 *   --meng-specific-sidebar-w    specific 层: 结构固定, 只有 shell/layout 能定义
 *
 * 主题 = 一组 alias 赋值, 挂在 :root[data-theme="x"]。切主题只改一个属性, 零重排类名。
 * 插件样式里出现硬编码色值 → scripts/lint-tokens.mjs 报错。
 */
export type TokenLayer = 'alias' | 'specific'

/** 主题本身也是一个插件: 贡献一组 alias 赋值 + 一张预览图 */
export interface ThemeContribution {
  id: string
  name: string
  /** data-theme 的值 */
  key: string
  /** alias → 色值 */
  tokens: Record<string, string>
}
