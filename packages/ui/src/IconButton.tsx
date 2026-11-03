/**
 * IconButton —— 只有图标时必须有 aria-label, 否则读屏用户拿到一个无名的按钮。
 * 所以 aria-label 是必填 prop, 不是可选的 "记得加"。
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import { forwardRef, type ButtonHTMLAttributes } from 'react'

import styles from './IconButton.module.css'

const iconButton = cva(styles.base, {
  variants: {
    variant: {
      ghost: styles.ghost,
      secondary: styles.secondary,
    },
    size: {
      md: styles.md,
      sm: styles.sm,
    },
  },
  defaultVariants: { variant: 'ghost', size: 'md' },
})

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>,
    VariantProps<typeof iconButton> {
  /** 必填: 图标按钮没有可见文字, 读屏只能靠这个 */
  'aria-label': string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant, size, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={clsx(iconButton({ variant, size }), className)} {...rest} />
  )
})
