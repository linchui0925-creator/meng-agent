/**
 * Button —— 变体用 CVA, 样式用 CSS Modules, 颜色只用 alias token。
 *
 * 为什么不带 loading 参数: 「按钮在等结果」和「按钮被禁用」在交互上是两件事,
 * 但视觉上应该是同一件事 (不可点 + 有进度)。所以等结果的地方用 <Spinner> 放进 children,
 * 而不是给 Button 加一个只改图标的状态位 —— 状态位一多, 组件就变成配置驱动的怪物。
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes } from 'react'

import styles from './Button.module.css'

const button = cva(styles.base, {
  variants: {
    variant: {
      primary: styles.primary,
      secondary: styles.secondary,
      ghost: styles.ghost,
      danger: styles.danger,
    },
    size: {
      md: styles.md,
      sm: styles.sm,
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
})

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={clsx(button({ variant, size }), className)} {...rest} />
})
