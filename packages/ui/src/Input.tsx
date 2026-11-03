/**
 * Input —— 单行输入。样式挂在 wrapper 上而不是 <input> 上,
 * 因为将来要放前缀图标/后缀单位, 那时不想到处改调用点。
 */

import { clsx } from 'clsx'
import { forwardRef, type InputHTMLAttributes } from 'react'

import styles from './Input.module.css'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 输入无效时的描边。错误文案由调用方渲染 —— 组件不猜文案 */
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, ...rest },
  ref,
) {
  return (
    <span className={clsx(styles.wrap, invalid && styles.invalid, className)}>
      <input ref={ref} className={styles.input} aria-invalid={invalid || undefined} {...rest} />
    </span>
  )
})
