/**
 * Spinner —— 有 role="status", 所以屏幕阅读器能读到「正在处理」。
 * 纯装饰的转圈不该被读, 所以 label 缺省是"处理中"而不是空字符串。
 */

import { clsx } from 'clsx'
import type { HTMLAttributes } from 'react'

import styles from './Spinner.module.css'

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: 'sm' | 'md'
  /** 读屏播报的文案 */
  label?: string
}

export function Spinner({ size = 'sm', label = '处理中', className, ...rest }: SpinnerProps) {
  return (
    <span role="status" className={clsx(styles.root, styles[size], className)} {...rest}>
      <svg viewBox="0 0 16 16" className={styles.svg} aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" className={styles.track} />
        <circle cx="8" cy="8" r="6.5" className={styles.head} />
      </svg>
      <span className={styles.srOnly}>{label}</span>
    </span>
  )
}
