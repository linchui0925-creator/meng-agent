/**
 * 复制按钮。
 *
 * 看起来是二十行的小组件, 但有三件事不做对就是"点了没反应":
 *
 *  1. `navigator.clipboard` **只在 secure context 存在**。局域网 http 打开调试页面时它是
 *     undefined —— 不能直接 `.writeText()` 然后吃一个 TypeError。
 *  2. 写入是**异步**的。`await` 之后才敢说"成功"; 失败必须让用户看见, 静默失败比没有按钮更糟。
 *  3. 权限被拒要走 `document.execCommand('copy')` 回退 —— 它是废弃 API, 但也是唯一还能用的路。
 *
 * 状态复位用 ref 存 timer: 连续点两次不能让第一个 timer 在第二个还没结束时把图标复位。
 */

import { useEffect, useRef, useState } from 'react'

import { IconButton, Tooltip } from '@meng/ui'

import { CheckIcon, CopyIcon } from './icons.tsx'

type CopyState = 'idle' | 'done' | 'fail'

export interface CopyButtonProps {
  text: string
  /** 无障碍名。同类按钮在一屏出现多个时必须能区分 */
  label: string
}

async function writeClipboard(text: string): Promise<boolean> {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clip?.writeText) {
    try {
      await clip.writeText(text)
      return true
    } catch {
      // 落到回退路径, 不在这里返回 false —— 权限被拒时 execCommand 往往还能成
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 固定在视口内但不可见: 移出屏幕会让 Safari 滚回顶部
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyButton({ text, label }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  function schedule(next: CopyState) {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1600)
  }

  return (
    <Tooltip label={state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : label}>
      <IconButton
        aria-label={label}
        size="sm"
        variant="ghost"
        onClick={() => {
          void writeClipboard(text).then((ok) => schedule(ok ? 'done' : 'fail'))
        }}
      >
        {state === 'done' ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    </Tooltip>
  )
}
