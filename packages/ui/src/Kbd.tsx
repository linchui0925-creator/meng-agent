/**
 * Kbd —— 键位提示。<kbd> 是原生标签, 用它而不是 span 让语义正确。
 * 快捷键说明里最常见的错误是"⌘"在不同平台乱写, 这里只负责外观, 平台映射由调用方决定。
 */

import { clsx } from 'clsx'
import type { HTMLAttributes } from 'react'

import styles from './Kbd.module.css'

export type KbdProps = HTMLAttributes<HTMLElement>

export function Kbd({ className, ...rest }: KbdProps) {
  return <kbd className={clsx(styles.root, className)} {...rest} />
}
