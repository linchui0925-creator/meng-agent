/**
 * ScrollArea —— 只是把滚动条的观感收口到一处。
 *
 * 不用 Radix 的 ScrollArea: 它为了自绘滚动条会接管溢出容器, 在「流式输出时自动贴底」
 * 这种场景下反而要绕过它。原生的 overflow 已经够用, 先把 token 化的滚动条统一。
 */

import { clsx } from 'clsx'
import { forwardRef, type HTMLAttributes } from 'react'

import styles from './ScrollArea.module.css'

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** 只纵向滚 / 双向滚 */
  axis?: 'y' | 'both'
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { axis = 'y', className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx(styles.root, axis === 'both' && styles.both, className)} {...rest} />
})
