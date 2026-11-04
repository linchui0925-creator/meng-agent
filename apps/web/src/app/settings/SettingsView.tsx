/**
 * 设置页壳。**它是 `settings.view` 的消费者, 不是一个 slot 座位。**
 *
 * 职责边界（docs/13 §6）:
 *   · 壳负责: 整窗结构、左导航（搜索/分组/选中）、右区容器、返回、Esc
 *   · 分区插件负责: 右区内容（表单行/卡片网格）
 *   · 宿主负责: 开不开（`open`）、关（`close`）、主题真值
 *
 * 为什么导航和内容都在壳里而不是各做各的: 左导航要「先知道所有分区叫什么」
 * 才能列出来, 而那时候组件还没渲染 —— 所以分区注册时必须带 meta.label
 * （docs/13 §6）。这也是 slots 包加 `meta` 字段的唯一原因。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { SectionEntry, SectionApi, SettingsViewApi } from './api.ts'
import styles from './SettingsView.module.css'

export function SettingsView(props: SettingsViewApi) {
  const { close, sections, prefs, setPrefs, invoke } = props

  /** 当前分区。空 = 还没选（首次进入落到导航第一项） */
  const [active, setActive] = useState<string>()
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  /** 搜索过滤: 只按标签匹配。设置项少的时候这就是够用的搜索 */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? sections.filter((s) => s.label.toLowerCase().includes(q)) : sections
  }, [sections, query])

  /**
   * 分组。**按 entries 的 order 后首次出现的顺序**排 —— 不写死组名表:
   * 将来加一个「实验」组, 壳不用改。
   */
  const groups = useMemo(() => {
    const out: Array<{ name: string; items: SectionEntry[] }> = []
    for (const s of visible) {
      const last = out[out.length - 1]
      if (last && last.name === s.group) last.items.push(s)
      else out.push({ name: s.group, items: [s] })
    }
    return out
  }, [visible])

  /**
   * 有效选中项。active 失效（分区插件被卸载 / 被搜掉）时回落到第一个可见项 ——
   * 否则右区会空白, 而用户会以为是设置页坏了。
   */
  const current = visible.find((s) => s.id === active) ?? visible[0]

  // 打开时把焦点放进搜索框: 键盘用户不用先 Tab 过整个导航
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Esc 关闭。设置页是整窗层, 没有「点外面」可点, 只能用键盘退
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const sectionProps: SectionApi = { prefs, setPrefs, invoke }

  return (
    <div className={styles.root} ref={rootRef} data-settings-view="">
      <nav className={styles.nav} aria-label="设置分区">
        <div className={styles.backRow}>
          <button className={styles.back} onClick={close} data-settings-back="">
            ← 返回对话
          </button>
        </div>

        <div className={styles.search}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            placeholder="搜索设置项"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索设置项"
            data-settings-search=""
          />
        </div>

        {groups.map((g) => (
          <div key={g.name}>
            <div className={styles.groupLabel}>{g.name}</div>
            {g.items.map((s) => (
              <button
                key={s.id}
                className={styles.navItem}
                data-active={s.id === current?.id ? '' : undefined}
                onClick={() => setActive(s.id)}
              >
                <span className={styles.navDot} data-origin={s.origin} aria-hidden="true" />
                <span className={styles.navText}>{s.label}</span>
              </button>
            ))}
          </div>
        ))}
        {visible.length === 0 ? <div className={styles.empty}>没有匹配的设置项</div> : null}

        <div className={styles.foot}>
          <span className={styles.ver}>梦 · v0.1</span>
        </div>
      </nav>

      <main className={styles.content} data-settings-content="">
        {current ? (
          <>
            <div className={styles.head}>
              <h2 className={styles.title}>
                {current.label}
                <span className={styles.origin} data-origin={current.origin}>
                  {current.origin === 'kernel' ? '内核' : '本机'}
                </span>
              </h2>
            </div>
            <current.Component {...sectionProps} />
          </>
        ) : (
          <div className={styles.empty}>没有可显示的设置分区</div>
        )}
      </main>
    </div>
  )
}
