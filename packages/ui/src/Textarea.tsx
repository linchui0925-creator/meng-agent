/**
 * Textarea —— 默认不自动撑高, 但对话输入框必须撑 (否则打第三行就要手动拖)。
 *
 * autoGrow 用 ref + layout effect 实现: 先置 auto 再读 scrollHeight,
 * 不这么做的话每次输入都只会在上一次的高度上继续加。
 */

import { clsx } from 'clsx'
import { forwardRef, useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'

import styles from './Textarea.module.css'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 随内容增高, 上限由 CSS max-height 控制 */
  autoGrow?: boolean
  /**
   * bare: 去掉自带描边与背景, 用于嵌在 composer 容器里的场景。
   * 用变体而不是让调用方 className 覆盖 —— 两个 CSS Module 的优先级相同,
   * 谁生效取决于打包顺序, 那种"本地看着对、构建后错"的 bug 不值得踩。
   */
  variant?: 'default' | 'bare'
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autoGrow = false, variant = 'default', className, rows = 1, onInput, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null)

  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inner.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  const resize = useCallback(() => {
    const el = inner.current
    if (!el || !autoGrow) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [autoGrow])

  // 每次渲染后都量一次: 受控组件的内容可能来自外部 (比如发送后清空)
  useLayoutEffect(resize)

  return (
    <textarea
      ref={attach}
      rows={rows}
      className={clsx(
        styles.textarea,
        variant === 'bare' && styles.bare,
        autoGrow && styles.autoGrow,
        className,
      )}
      onInput={(event) => {
        resize()
        onInput?.(event)
      }}
      {...rest}
    />
  )
})
