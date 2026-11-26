/**
 * 环境光驱动器 —— 把「屏幕主色」变成「宿主的环境光 token」。
 *
 * 这一层是插件的心脏, 但它刻意**只做一件事**: 算出该写哪三个 token 值,
 * 然后交给 `theme` 能力面。DOM、动画、时间轴全都不归它管。
 *
 * 为什么走 `theme` 能力面而不是自己写 `document.documentElement.style`:
 * 主题控制器维护的是**层栈**。提交一层之后, 别人提交的层照样在,
 * 自己撤销时 (`remove`) 下层的值自动重新露出来。
 * 自己写 inline style 就没这个性质 —— 卸载时得记得把旧值写回去,
 * 而「旧值」在多层覆盖下根本没有意义 (见 packages/ui/src/theme.ts 的注释)。
 *
 * **呼吸**为什么不在这里做:
 * 呼吸是**视觉**上的缓慢明暗起伏, 它的周期是秒级 —— 用 CSS 动画做,
 * CPU 占用是 0; 用 JS 定时器做, 每秒都要唤醒主线程。
 * 所以 JS 只负责**更新颜色**, 「亮一下暗一下」交给 CSS 的 @keyframes。
 * 但宿主的 `.shell::before` 用的是静态渐变, 没有动画 ——
 * 所以呼吸由本插件注入的一条 CSS 动画实现（见 ambient.css）。
 */

import { hslToRgb, smooth, smoothHue, toAmbientColors, toTokenValue, type DominantColor, type Hsl } from './color.ts'

/**
 * 宿主 `theme` 能力面的最小形状。
 *
 * **只声明用到的部分**, 不 import `@meng/ui` 的类型 —— 那是宿主的包,
 * 插件运行在浏览器里, 拿到的是宿主共享表里的那个实例。
 * 声明结构而不是依赖类型, 插件就能在没有宿主类型的环境里独立构建。
 */
export interface ThemeFace {
  apply(id: string, tokens: Record<string, string>): void
  remove(id: string): void
}

/** 三个环境光 token 名 —— 宿主 `.shell::before` 的三个径向渐变各取一个 */
export const AMBIENT_TOKENS = {
  a: '--meng-alias-ambient-a',
  b: '--meng-alias-ambient-b',
  c: '--meng-alias-ambient-c',
} as const

export interface AmbientConfig {
  /** 整体强度 0~1 */
  strength: number
  /** 跟随速度 0~1。越大追得越快 */
  responsiveness: number
  /** 深浅。决定环境光该亮还是该暗 */
  mode: 'light' | 'dark'
  /** 呼吸幅度 0~1 */
  breathe: number
}

/**
 * 当前生效的平滑状态。
 *
 * 为什么要存平滑后的值而不是直接用采样值:
 * 屏幕主色是**跳变**的 —— 你切窗口, 颜色瞬间变了。
 * 直接写 token 会让整个界面「啪」地闪一下。所以每帧把目标值往当前值推一点。
 */
interface Smoothed {
  h: number
  s: number
  l: number
  share: number
}

export class AmbientDriver {
  private smoothed: Smoothed | null = null
  private layerId: string
  private theme: ThemeFace
  private config: AmbientConfig

  /** 是否已经写过一次 */
  private committed = false

  constructor(layerId: string, theme: ThemeFace, config: AmbientConfig) {
    this.layerId = layerId
    this.theme = theme
    this.config = config
  }

  /**
   * 喂进一帧的主色, 返回是否真的更新了。
   *
   * 返回 false 表示「这次不值得写 DOM」—— 颜色几乎没变。
   * 写 DOM 是这个插件唯一的开销, 所以要挡掉无意义的更新。
   */
  update(color: DominantColor): boolean {
    const target: Hsl = {
      h: color.hsl.h,
      s: color.hsl.s,
      l: color.hsl.l,
    }

    const prev = this.smoothed
    if (!prev) {
      // 第一帧直接落到目标值, 不从黑里渐变上来 —— 那会看起来像「开机动画」
      this.smoothed = { h: target.h, s: target.s, l: target.l, share: color.share }
      this.commit(this.smoothed)
      return true
    }

    /**
     * 速度不是线性的: 变化越大追得越快。
     *
     * 理由: 小幅抖动就该被平滑吃掉 (屏幕上一闪而过的光标不该让背景闪),
     * 大幅变化就该快速跟上 (你换了个深色主题, 背景要立刻变, 不能慢吞吞地飘)。
     * 固定系数做不到两头兼顾。
     */
    const delta = hueDistance(prev.h, target.h)
    const speed = clamp01(this.config.responsiveness) * (0.15 + Math.min(delta / 90, 1) * 0.85)

    const next: Smoothed = {
      h: smoothHue(prev.h, target.h, speed),
      s: smooth(prev.s, target.s, speed),
      l: smooth(prev.l, target.l, speed),
      share: smooth(prev.share, color.share, speed),
    }

    // 变化太小就不动 DOM
    if (hueDistance(prev.h, next.h) < 0.35 && Math.abs(prev.s - next.s) < 0.004 && Math.abs(prev.l - next.l) < 0.004) {
      this.smoothed = next
      return false
    }

    this.smoothed = next
    this.commit(next)
    return true
  }

  /** 把平滑后的状态写成三个 token */
  private commit(state: Smoothed): void {
    const { a, b, c } = toAmbientColors(
      { h: state.h, s: state.s, l: state.l },
      this.config.mode,
      this.config.strength,
    )

    /**
     * 不透明度跟着**饱和度**走。
     *
     * 灰色为主色时（白底文档占了大半屏）光应该几乎看不见 —— 不然整片
     * 界面被蒙一层灰, 反而变脏。有彩色时才让光透出来。
     */
    const vividness = clamp01((state.s - 0.1) / 0.45)
    const baseAlpha = this.config.mode === 'dark' ? 26 : 20
    const alpha = baseAlpha * vividness * this.config.strength + 2

    /**
     * 呼吸在这里接进来。
     *
     * alpha 不是死数, 而是一个**带 CSS 变量的表达式** —— 颜色由 JS 写
     * (随屏幕变), 起伏由 CSS 动画乘上去 (随时间变)。两条线互不干扰。
     *
     * 幅度为 0 时因子恒为 1（光还在, 只是不呼吸）—— 不是把光关掉。
     */
    const breathe = this.config.breathe
    const factor = breathe <= 0 ? 1 : `(1 + (var(--sa-breath, 1) - 1) * ${breathe})`

    this.theme.apply(this.layerId, {
      [AMBIENT_TOKENS.a]: toTokenValue(a, `calc(${alpha.toFixed(2)}% * ${factor})`),
      [AMBIENT_TOKENS.b]: toTokenValue(b, `calc(${(alpha * 0.85).toFixed(2)}% * ${factor})`),
      [AMBIENT_TOKENS.c]: toTokenValue(c, `calc(${(alpha * 0.7).toFixed(2)}% * ${factor})`),
    })
    this.committed = true
  }

  /** 配置变了要重算一次 —— 否则要等到下一帧才生效 */
  reconfigure(config: AmbientConfig): void {
    this.config = config
    if (this.smoothed) this.commit(this.smoothed)
  }

  /** 撤销这一层。**卸载时必须调**, 否则环境光会一直留在页面上 */
  dispose(): void {
    if (!this.committed) return
    this.theme.remove(this.layerId)
    this.committed = false
    this.smoothed = null
  }

  /** 当前平滑状态。给设置页显示用 */
  current(): Smoothed | null {
    return this.smoothed
  }
}

/** 两个色相之间的最短距离（环形） */
function hueDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 导出给测试用: 由 hsl 反推 rgb */
export { hslToRgb }
