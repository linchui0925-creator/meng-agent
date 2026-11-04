/**
 * 等待时的那一句「陪伴」。
 *
 * ── 为什么它只是**彩蛋**, 不是主状态 ──
 * 主状态是工具卡上的真实进度 (`read … 3s`)。有真东西可显示的时候,
 * 「请主人等待」是废话 —— 它唯一的作用是提醒"还没好", 而那件事一个 spinner 就够了。
 *
 * 所以这里的规则是:
 *   - **超过 8 秒**才出现 (200ms 就完成的调用弹一句"稍等"是打扰, 不是陪伴)
 *   - **一次等待只出一条**, 不轮换 (轮换 = 注意力被反复打断)
 *   - 探出来 → 停 6 秒 → 淡出, 然后离开 DOM
 *   - 出现在输入框上方偏右, 不占布局、不挡点击
 *
 * ── 文案: 为什么第一版被否掉 ──
 * 第一版写的是「小梦在理思路，马上就说给你听」「这句得想清楚再说，别急」。
 * 结构上每句都带信息, 但读起来**像 AI 在汇报自己的认知过程**:
 *   1. 每句都在有条理地解释"我在干什么" —— 真人等待时不会这么工整地汇报自己
 *   2. 每句都完整、都礼貌 —— 真人说话是碎的, 会自言自语, 会说到一半改口
 *   3. 情绪是平的 —— 全是安抚, 而人在等待时会烦、会怀疑、会拿自己开玩笑
 *
 * 所以改了三条规矩:
 *   1. **具体**。"有点久"是播报, "这文件比我人生还长"才是人在说话。
 *   2. **有情绪**。允许抱怨、自嘲、怀疑、跑神 —— 不必每句都体面。
 *   3. **吐槽对象只有三类: 工具 / 任务 / 自己**。
 *      绝不吐槽用户 —— 那是把机器的不耐烦甩给等它的人, 一次就翻车。
 *
 * ── 结构: 一句话 + 一张脸 ──
 * 文案拆成 say 和 face 两段, 不是拼成一个字符串, 因为**脸要单独动**:
 * 气泡先探出来, 落定之后表情再弹一下 —— 先有个人出现, 才露出表情。
 * 整块一起弹会像按钮抖了一下, 不像"有人说话"。
 *
 * 词库是纯数据, 加一百条也不影响性能 —— 真正的成本在"什么时候说", 不在"有多少条"。
 */

import type { WaitScene } from './conversation.ts'
import type { WhisperWhen } from '../prefs.ts'

/** 超过这个时长才值得说一句。// 你来定: 8 秒是"人开始怀疑卡住了"的粗略阈值 */
export const WHISPER_DELAY_MS = 8_000

/**
 * 设置页选的那三档 → 毫秒。
 *
 * 表放在这里而不是 prefs.ts: 毫秒是这个组件的知识 (阈值多少算"有点久"),
 * 偏好层只该知道有哪三个选项, 不该知道每个选项是几秒。
 * 将来调 8 秒这个值, 只动上面那个常量, 用户存下的 'normal' 自动跟着走。
 */
export const WHISPER_DELAY_BY_PREF: Readonly<Record<WhisperWhen, number>> = {
  soon: 5_000,
  normal: WHISPER_DELAY_MS,
  late: 12_000,
}

/** 一条气泡停留多久。太短读不完, 太长就成了背景噪音 */
export const WHISPER_HOLD_MS = 6_000

/** 淡出用的时间, 和 CSS 里的动画必须一致 */
export const WHISPER_FADE_MS = 300

export interface WhisperLine {
  /** 说的话。要具体、可以有情绪、可以不成句 */
  say: string
  /**
   * 脸上的表情。用颜文字而不是 emoji ——
   * emoji 是彩色贴纸, 会盖过文字; 颜文字是字符, 和句子同一层, 更贴"自言自语"。
   */
  face: string
}

/**
 * 词库。两组各 14 条。
 *
 * thinking 是**等模型开口**: 吐槽对象是自己和问题 (想不动了 / 跑神 / 差点说错)。
 * tool 是**等工具跑完**: 吐槽对象是工具 (慢 / 摸鱼 / 装死)。
 * 两组不能混 —— 混了会出现"正在删除文件"配"我在组织语言"这种不合时宜的组合。
 */
export const WHISPERS: Readonly<Record<WaitScene, readonly WhisperLine[]>> = {
  thinking: [
    { say: '这问题有点绕，我绕一下', face: '(￣▽￣)' },
    { say: '等等，我先把上一句想完', face: '(・_・)' },
    { say: '刚才那句好像理解偏了，重来', face: '(눈_눈)' },
    { say: '我组织一下语言，别急', face: '(￣～￣)' },
    { say: '有点意思，让我多琢磨一会儿', face: '(￣▽￣)' },
    { say: '脑子里翻资料呢，翻得有点乱', face: '(￣◇￣;)' },
    { say: '差点说错，收回来了', face: '(¬_¬)' },
    { say: '这题有坑，我绕开再答', face: '(눈_눈)' },
    { say: '想清楚了再说，免得你返工', face: '(￣ω￣)' },
    { say: '我能说很久，先挑重点', face: '(￣▽￣)' },
    { say: '唔……让我再想一遍', face: '(⊙_⊙)' },
    { say: '刚才想到一半跑神了', face: '(￣◇￣;)' },
    { say: '在数你前面提了几个要求', face: '(・_・)' },
    { say: '别催，催了更乱', face: '(￣へ￣)' },
  ],
  tool: [
    { say: '这文件比我人生还长', face: '(눈_눈)' },
    { say: '它还在跑，我开始怀疑它了', face: '(￣◇￣;)' },
    { say: 'grep 你是不是在摸鱼', face: '(눈_눈)' },
    { say: '不是我慢，是它慢，我说清楚', face: '(￣▽￣)' },
    { say: '行吧，我等，我很有耐心', face: '(￣ω￣)' },
    { say: '刚才谁说要读全部的？哦，是我', face: '(・_・)' },
    { say: '这命令跑得很有想法，就是慢', face: '(￣▽￣)' },
    { say: '我数着呢，它没卡，就是磨', face: '(눈_눈)' },
    { say: '它输出得很有节奏感', face: '(￣～￣)' },
    { say: '盯着呢，它一动我就叫', face: '(・_・)' },
    { say: '有点久，但还在动，别慌', face: '(￣ω￣)' },
    { say: '这步确实重，我认了', face: '(￣◇￣;)' },
    { say: '它好像动了，也可能是我的错觉', face: '(⊙_⊙)' },
    { say: '要不我先给你讲个笑话', face: 'ᕕ( ᐛ )ᕗ' },
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

export function pickWhisper(scene: WaitScene, seed: number): WhisperLine | null {
  const list = WHISPERS[scene]
  if (list.length === 0) return null
  // 取绝对值再取模: 负数会让 list[-1] 拿到 undefined, 那一条气泡就变成空的 ——
  // 而且这种坏法是静默的 (界面上"什么都没有", 看起来像没到时间)
  const i = Math.abs(Math.trunc(seed)) % list.length
  return list[i] ?? null
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
  // 淡出的那一小段还要留在 DOM 里, 否则动画没机会播
  if (elapsedMs < delay + hold + WHISPER_FADE_MS) return 'out'
  return 'idle'
}
