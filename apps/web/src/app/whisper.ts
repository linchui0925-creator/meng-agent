/**
 * 等待时的那一句「陪伴」。
 *
 * ── 为什么它只是**彩蛋**, 不是主状态 ──
 * 主状态是工具卡上的真实进度 (`read … 3s`)。有真东西可显示的时候,
 * 「请主人等待」是废话 —— 它唯一的作用是提醒"还没好", 而那件事一个 spinner 就够了,
 * 更糟的是它暗示"我也不知道要多久"。
 *
 * 所以这里的规则是:
 *   - **超过 8 秒**才出现 (200ms 就完成的调用弹一句"稍等"是打扰, 不是陪伴)
 *   - **一次等待只出一条**, 不轮换 (轮换 = 注意力被反复打断)
 *   - 淡入 200ms → 停 6 秒 → 淡出 300ms, 然后消失
 *   - 出现在输入框上方偏右, 不占布局、不挡点击
 *
 * ── 文案的两条自定规矩 ──
 *   1. 每句都得带一点**信息**（在等什么 / 没卡住 / 快好了），不能只有"请等待"。
 *      纯废话在等待场景里会放大焦躁, 这是用户明确否掉的那一版。
 *   2. 按**场景分组**, 不平铺。平铺会出"正在删除文件"配"努力加载中"这种不合时宜的组合。
 *
 * 词库是纯数据, 加一百条也不影响性能 —— 真正的成本在"什么时候说", 不在"有多少条"。
 */

import type { WaitScene } from './conversation.ts'

/** 超过这个时长才值得说一句。// 你来定: 8 秒是"人开始怀疑卡住了"的粗略阈值 */
export const WHISPER_DELAY_MS = 8_000

/** 一条气泡停留多久。太短读不完, 太长就成了背景噪音 */
export const WHISPER_HOLD_MS = 6_000

/** 淡出用的时间, 和 CSS 里的 transition 必须一致 */
export const WHISPER_FADE_MS = 300

/**
 * 词库。每组 14 条, 都是"像同事在旁边干活"的语气 ——
 * 有角色感, 但不谄媚（"请主人等待"式的话在等待里会放大焦躁）。
 */
export const WHISPERS: Readonly<Record<WaitScene, readonly string[]>> = {
  thinking: [
    '小梦在理思路，马上就说给你听',
    '这句得想清楚再说，别急',
    '正在挑一个不那么啰嗦的说法',
    '想到一半了，组织一下语言',
    '在翻刚才的上下文，找你说过的那句',
    '这个问题值得慢一点答',
    '在确认一个细节，免得说错',
    '快了，正在收尾这句',
    '先把话说准，再给你结论',
    '在权衡两种说法，选个更实在的',
    '还在想，没卡住',
    '已经想到答案了，正在缩短它',
    '在回顾你前面提的要求',
    '让我把这一步想完整',
  ],
  tool: [
    '命令还在跑，我盯着呢',
    '文件有点长，正在往里读',
    '还没回来，一有结果就叫你',
    '这个查询要扫的东西不少',
    '在等它输出，没卡住',
    '跑得比预想的久，我继续等',
    '正在收集结果，快好了',
    '这一步比较重，稍等一下',
    '它还在干活，我没走开',
    '有点慢，但还在动',
    '在等最后几行输出',
    '结果正在回来，再等等',
    '这一步耗时正常，不是出错',
    '盯着呢，有动静立刻说',
  ],
}

/**
 * 字符串 → 稳定的整数种子。
 *
 * 为什么要种子而不是 Math.random(): 气泡是**每次渲染都重算**的,
 * 随机的话同一句话会在每秒的 tick 里跳成另一句 —— 用户会看到文字在闪。
 * 用等待的 key 当种子, 同一次等待永远是同一句。
 */
export function seedOf(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function pickWhisper(scene: WaitScene, seed: number): string {
  const list = WHISPERS[scene]
  if (list.length === 0) return ''
  // 取绝对值再取模: 负数会让 list[-1] 拿到 undefined, 那一条气泡就变成空的 ——
  // 而且这种坏法是静默的 (界面上"什么都没有", 看起来像没到时间)
  const i = Math.abs(Math.trunc(seed)) % list.length
  return list[i] ?? ''
}

/**
 * 气泡此刻该是什么状态。
 *
 * `idle` 也包含"还没到点"和"已经说完了"两种 —— 组件只关心要不要挂载,
 * 分成四个状态会让调用方多写两个分支, 而它们的行为完全一样。
 */
export type WhisperPhase = 'idle' | 'in' | 'out'

export function whisperPhase(
  elapsedMs: number,
  delay = WHISPER_DELAY_MS,
  hold = WHISPER_HOLD_MS,
): WhisperPhase {
  if (!Number.isFinite(elapsedMs) || elapsedMs < delay) return 'idle'
  if (elapsedMs < delay + hold) return 'in'
  // 淡出的那一小段还要留在 DOM 里, 否则 transition 没机会播
  if (elapsedMs < delay + hold + WHISPER_FADE_MS) return 'out'
  return 'idle'
}
