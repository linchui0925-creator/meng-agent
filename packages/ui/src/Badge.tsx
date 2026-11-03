/**
 * Badge —— 状态标签。tone 是语义而不是颜色名:
 * 哪天想把 positive 从绿改成蓝, 改 token 即可, 调用点不用动。
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { clsx } from 'clsx'
import type { HTMLAttributes } from 'react'

import styles from './Badge.module.css'

const badge = cva(styles.base, {
  variants: {
    tone: {
      neutral: styles.neutral,
      accent: styles.accent,
      positive: styles.positive,
      warning: styles.warning,
      danger: styles.danger,
    },
    /** 实心用于「当前状态」, 描边用于「元信息」 */
    solid: {
      true: styles.solid,
      false: '',
    },
  },
  defaultVariants: { tone: 'neutral', solid: false },
})

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ tone, solid, className, ...rest }: BadgeProps) {
  return <span className={clsx(badge({ tone, solid }), className)} {...rest} />
}
