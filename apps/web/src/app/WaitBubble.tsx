/**
 * 等待气泡：等太久时, 在输入框上方冒一句人话, 自己淡出。
 *
 * ── 三个"不做" ──
 *   1. 不做逐字动画: 一句话包 20 个 span 只为好看, 换来的是流式期间每帧重排, 不值。
 *   2. 不占布局、不挡点击: absolute + pointer-events:none。它是旁白, 不是控件 ——
 *      绝不能出现"气泡正好盖住发送按钮"这种事。
 *   3. 不轮换: 一次等待只出一条。轮换等于每隔几秒敲一下用户的注意力。
 *
 * ── 出场: 先有人, 才有表情 ──
 * 整块淡入 + 上移是**通知**的动效 (toast 就这么做), 语义是"系统提醒你一件事", 所以它刻意做平。
 * 这里要的是"旁边有个人", 那就得有主体感:
 *   气泡从输入框边缘**探出来** (起点在下方, 过冲 4px 再落定) →
 *   落定 220ms 后, 脸自己弹一下。
 * 顺序很重要: 先出现一个人, 再露出表情。两者一起弹会像按钮抖了一下。
 * 全程只动 opacity / transform, 不触发 layout。
 *
 * 判断"这一次等待"用 state.key: 换工具 / 换轮次就是新的一次, 允许重新出;
 * 同一次里无论 tick 多少次, 文案都由 key 的哈希决定, 不会闪。
 *
 * 计时起点是 state.since (事件自带的 at), 不是"组件挂载那一刻" ——
 * 断线重放时后者会把一个已经跑了 40 秒的命令说成刚等 1 秒。
 */

import { useEffect, useState } from 'react'

import type { WaitState } from './conversation.ts'
import { pickWhisper, seedOf, whisperPhase, WHISPER_DELAY_MS, WHISPER_HOLD_MS } from './whisper.ts'
import styles from './App.module.css'

export interface WaitBubbleProps {
  state: WaitState | null
  /** 覆盖阈值, 只给验收用 (`?whisper=600` 让浏览器脚本不用真等 8 秒) */
  delayMs?: number
  holdMs?: number
}

export function WaitBubble({ state, delayMs = WHISPER_DELAY_MS, holdMs = WHISPER_HOLD_MS }: WaitBubbleProps) {
  const [now, setNow] = useState(() => Date.now())
  const active = state !== null
  const key = state?.key ?? ''

  /**
   * 只在"在等"的时候挂定时器。
   * 250ms 一跳: 气泡的精度要求是"秒级", 一秒一跳会在 8s 边界多等最多 1 秒,
   * 250ms 让出现时刻的误差不超过四分之一秒, 而成本只是每秒 4 次 setState。
   */
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [active, key])

  if (!state) return null

  const phase = whisperPhase(now - state.since, delayMs, holdMs)
  // 淡出结束后要真的离开 DOM, 不然"到底有没有说"这件事在调试时看不出来
  if (phase === 'idle') return null

  const line = pickWhisper(state.scene, seedOf(state.key))
  if (line === null) return null

  return (
    <div className={styles.whisper} data-phase={phase} data-scene={state.scene} role="status" aria-live="polite">
      {line.say}{' '}
      {/*
        脸 aria-hidden: 颜文字是一串符号, 读屏会逐字念成
        "左括号 全角上划线 三角 全角上划线 右括号" —— 对听得见界面的人毫无意义。
        它承担的是语气, 而语气已经在那句话里了。
      */}
      <span className={styles.whisperFace} aria-hidden="true">
        {line.face}
      </span>
    </div>
  )
}
