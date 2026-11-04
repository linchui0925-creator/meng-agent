/**
 * 设置页的三种基础控件。分区之间共享, 不各写一套。
 *
 * 为什么不用 packages/ui 里的现成组件: 那套是**聊天界面**的控件
 * (按钮、徽章、spinner), 尺寸和语义都偏"操作"; 设置页要的是
 * 「一行一个设置项, 控件永远靠右对齐」这种表单节奏。
 * 硬把两套揉在一起, 结果是两边都不合适。
 *
 * 全部用原生 button + aria, 不用 div 装样子:
 * 开关是 `role="switch"`, 分段是 `role="radiogroup"` + `aria-checked` ——
 * 这样读屏和键盘 Tab 是免费的, 而自己写 div 要再补一遍还不一定对。
 */

import type { ReactNode } from 'react'

import styles from './controls.module.css'

/**
 * 一个设置项。
 *
 * `desc` 是可选的第二行小字 —— 它的位置是有讲究的: **在标签下面, 不在控件下面**。
 * 放在控件下方会让人以为那是控件的状态提示; 放在标签下方, 读起来才是
 * 「这个设置项是什么意思」。
 */
export function Row({
  title,
  desc,
  children,
  disabled = false,
  htmlFor,
}: {
  title: string
  desc?: ReactNode
  children: ReactNode
  /** 整行失效。只用于「上一个开关把它关掉了」这种**因果明确**的情况 */
  disabled?: boolean
  /** 给 label 指到控件上, 点文字也能改 */
  htmlFor?: string
}) {
  return (
    <div className={styles.row} data-disabled={disabled ? '' : undefined}>
      <div className={styles.rowText}>
        <label className={styles.rowTitle} htmlFor={htmlFor}>
          {title}
        </label>
        {desc !== undefined && <p className={styles.rowDesc}>{desc}</p>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/** 一组设置项的标题。分组之间的视觉分隔靠它, 不靠卡片套卡片 */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.groupBody}>{children}</div>
    </section>
  )
}

/**
 * 分区末尾的一句注脚。
 *
 * 存在理由只有一个: 说明**这条腿是什么**（存哪、什么时候生效、要不要重启）。
 * 「设置为什么没生效」这个问题的答案, 一半在这里。
 */
export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>
}

/**
 * 开关。
 *
 * 用 `<button role="switch">` 而不是 `<input type="checkbox">`:
 * checkbox 的 `checked` 是 React 受控属性, 而 iOS Safari 上它的 :checked 样式
 * 有个老问题 (点击时的过渡会闪)。按钮 + aria-checked 行为等价, 样式完全可控。
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** 读屏念的那句话。视觉上不显示 —— 旁边的 Row 已经有文字了 */
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.switch}
      data-on={checked ? '' : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchKnob} aria-hidden="true" />
    </button>
  )
}

/**
 * 分段选择。选项少 (2-4 个)、互斥、且**每个选项都该被看见**时用它。
 *
 * 不用 `<select>`: 下拉把选项藏起来了, 而设置页里"有哪几个档"本身就是信息
 * (用户看到有 5/8/12 秒三档, 才知道自己现在选的是哪一档)。
 * 超过 4 个选项就该换成下拉 —— 那时候分段会挤成一条看不清的按钮带。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (next: T) => void
  /** 整组的读屏名称 */
  label: string
  disabled?: boolean
}) {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={label} data-disabled={disabled ? '' : undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={styles.segItem}
          data-on={o.value === value ? '' : undefined}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
