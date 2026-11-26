/**
 * 侧栏「计算器」。
 *
 * 它是独立前端插件，通过 `sidebar.utility` slot 挂进侧栏；
 * 核心 `SidebarNav` 只留座位，不直接 import 这个组件。
 *
 * ── 交互上的三个决定 ──
 *   1. **边打边算**: 每敲一键就更新结果。用户不用点「计算」才看到答案 ——
 *      那是老式计算器的做法, 而现在的用户期待输入框本身就是答案区。
 *   2. **折叠默认收起**: 侧栏 264px 宽, 一个展开的计算器会把会话列表挤没。
 *      收起时只占一行标题。
 *   3. **结果可复制**: 算出来的数八成是要贴走的, 一键复制比手抄靠谱。
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import { IconButton, Tooltip } from '@meng/ui'

import { previewResult } from './calculator.ts'
// 插件样式由 client-entry 以字符串注入；这里用稳定的前缀，避免和宿主类名冲突。
const styles = {
  wrap: 'calc-wrap',
  head: 'calc-head',
  icon: 'calc-icon',
  peek: 'calc-peek',
  chevron: 'calc-chevron',
  body: 'calc-body',
  screen: 'calc-screen',
  expression: 'calc-expression',
  result: 'calc-result',
  resultValue: 'calc-result-value',
  resultEmpty: 'calc-result-empty',
  error: 'calc-error',
  copy: 'calc-copy',
  pad: 'calc-pad',
  key: 'calc-key',
} as const

/** 面板里的按钮布局。0 是显示位, = 单独一行。 */
const KEYS: readonly (readonly string[])[] = [
  ['C', '(', ')', '/'],
  ['7', '8', '9', '*'],
  ['4', '5', '6', '-'],
  ['1', '2', '3', '+'],
  ['0', '.', '±', '='],
]

export function Calculator() {
  const [open, setOpen] = useState(false)
  const [expression, setExpression] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const preview = useMemo(() => previewResult(expression), [expression])

  const append = useCallback((key: string) => {
    setExpression((current) => {
      switch (key) {
        case 'C':
          return ''
        case '±': {
          // 正负号: 加在最前面。只在最前面有意义 —— 3±4 没人这么写。
          const trimmed = current.trim()
          if (trimmed === '') return current
          if (trimmed.startsWith('-')) return trimmed.slice(1)
          return `-${trimmed}`
        }
        case '=': {
          // 按 = 就把结果固化进输入框, 方便接着算或复制
          if (!preview.ok || preview.value === '') return current
          return preview.value
        }
        case '(':
        case ')': {
          // 括号不许连着来: "1((" 是写错的
          const last = current.trim().slice(-1)
          if (last === '(' || last === ')') {
            // 紧跟在数字后面加左括号 = 隐式乘法, 这个计算器不支持, 拦掉
            if (key === '(' && /[0-9)]$/.test(last)) return current
          }
          return current + key
        }
        default: {
          // 数字/小数点/运算符直接追加
          if (key === '.' && /[.]$/.test(current.trim())) return current
          return current + key
        }
      }
    })
  }, [preview])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        append('=')
        return
      }
      // 面板开着的时候, 键盘上的数字不该打进聊天输入框
      if (/^[0-9+\-*/().]$/.test(event.key) && event.key.length === 1) {
        event.preventDefault()
        append(event.key)
      }
    },
    [append],
  )

  const copyResult = useCallback(() => {
    if (!preview.ok || preview.value === '') return
    void navigator.clipboard?.writeText(preview.value)
  }, [preview])

  return (
    <div className={styles.wrap} data-calculator="">
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-calculator-toggle=""
      >
        <span className={styles.icon} aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <rect x="3" y="2" width="10" height="12" rx="1.6" />
            <path d="M5.5 5.5h5" />
            <path d="M6 8.5h.01M10 8.5h.01M6 11.5h.01M10 11.5h.01" />
          </svg>
        </span>
        计算器
        {/*
          收起时标题右边直接给出结果 —— 不用展开就知道算出来多少。
          展开时不显示: 那时结果就在下面的屏幕区里, 显示两遍是浪费宽度。
        */}
        {!open && preview.ok && preview.value !== '' && (
          <span className={styles.peek} data-calculator-peek="">
            {preview.value}
          </span>
        )}
        <span className={styles.chevron} data-open={open ? '' : undefined} aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div className={styles.body} data-calculator-body="">
          <div className={styles.screen}>
            <input
              ref={inputRef}
              className={styles.expression}
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="算式"
              aria-label="算式"
              inputMode="text"
              spellCheck={false}
              autoComplete="off"
              data-calculator-input=""
            />
            <div className={styles.result} data-calculator-result="">
              {preview.ok ? (
                preview.value === '' ? (
                  <span className={styles.resultEmpty} aria-hidden="true">—</span>
                ) : (
                  <>
                    <span className={styles.resultValue}>{preview.value}</span>
                    <Tooltip label="复制结果">
                      <IconButton
                        size="sm"
                        aria-label="复制结果"
                        onClick={copyResult}
                        className={styles.copy}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                          <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 11h1" />
                        </svg>
                      </IconButton>
                    </Tooltip>
                  </>
                )
              ) : (
                <span className={styles.error} role="alert">
                  {preview.message}
                </span>
              )}
            </div>
          </div>

          <div className={styles.pad} role="group" aria-label="计算器按键">
            {KEYS.flat().map((key) => (
              <button
                key={key}
                type="button"
                className={styles.key}
                data-key={key}
                data-variant={
                  key === '=' ? 'primary' : 'C' === key || key === '±' ? 'muted' : 'plain'
                }
                onClick={() => append(key)}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
