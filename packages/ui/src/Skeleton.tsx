/**
 * Skeleton —— 等数据时的占位骨牌。
 *
 * 用透明度呼吸而不是经典的"灰色渐变扫光": 渐变要实现就得写死两个颜色,
 * 那正是 token 规矩要挡的东西。呼吸用 currentColor 的透明度, 深浅主题自动成立。
 */

import { clsx } from 'clsx'
import type { HTMLAttributes } from 'react'

import styles from './Skeleton.module.css'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** 行数 > 1 时渲染多行, 末行短一截 (看起来像段落而不是表格) */
  lines?: number
}

export function Skeleton({ lines = 1, className, ...rest }: SkeletonProps) {
  if (lines <= 1) return <div className={clsx(styles.line, className)} aria-hidden="true" {...rest} />

  return (
    <div className={clsx(styles.group, className)} aria-hidden="true" {...rest}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={clsx(styles.line, i === lines - 1 && styles.short)} />
      ))}
    </div>
  )
}
