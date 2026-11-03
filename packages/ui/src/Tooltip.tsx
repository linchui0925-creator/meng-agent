/**
 * Tooltip —— Radix 管行为(延迟/键盘/定位/无障碍), 这里只管观感。
 *
 * 必须有一个 TooltipProvider 包在应用外: delayDuration 是全局策略,
 * 每个 tooltip 各写一份会出现「同一个界面里两个提示框弹出快慢不同」。
 */

import * as Radix from '@radix-ui/react-tooltip'
import { forwardRef, type ReactElement, type ReactNode } from 'react'

import styles from './Tooltip.module.css'

export const TooltipProvider = Radix.Provider

export interface TooltipProps {
  label: ReactNode
  /** 必须是单个可接收 ref 的元素 —— Radix 要往上挂事件 */
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 关掉时直接渲染 children, 不产生任何 DOM 包裹 (移动端没有 hover, 应该关掉) */
  disabled?: boolean
}

export function Tooltip({ label, children, side = 'top', disabled = false }: TooltipProps) {
  if (disabled) return children

  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content className={styles.content} side={side} sideOffset={6} collisionPadding={8}>
          {label}
          <Radix.Arrow className={styles.arrow} width={10} height={5} />
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  )
}

/**
 * 轻提示: 用于「复制成功」这类一次性反馈, 不是模态。
 * 用 Radix 的 Tooltip 原语实现是因为它已经有定位与消失时机;
 * 真正的 Toast (可堆叠、可 aria-live) 等有第一个真需求再加, 现在加就是过度设计。
 */
export interface HintProps {
  label: string
  children: ReactElement
}

export const Hint = forwardRef<HTMLDivElement, HintProps>(function Hint({ label, children }, ref) {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content ref={ref} className={styles.hint} side="top" sideOffset={4}>
          {label}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  )
})
