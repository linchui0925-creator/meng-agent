/**
 * Separator —— 分隔线。用 role="separator" + aria-orientation 而不是 <hr>:
 * hr 的默认语义在某些读屏里会被当成「内容分节」, 而这里只是视觉分隔。
 */

import { clsx } from 'clsx'
import type { HTMLAttributes } from 'react'

import styles from './Separator.module.css'

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
}

export function Separator({ orientation = 'horizontal', className, ...rest }: SeparatorProps) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={clsx(styles.root, styles[orientation], className)}
      {...rest}
    />
  )
}
