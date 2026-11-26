/**
 * 屏幕取色与颜色映射 —— **纯函数, 不碰 DOM**。
 *
 * 为什么单独一个文件: 这里面每一行都是「算错了会静默难看」的逻辑
 * （色相怎么量化、亮度怎么压、和底色怎么混）。把它们从 DOM 纠缠里剥出来,
 * 就能在 node 里直接断言 —— 浏览器里验证颜色是拿眼睛看, 靠不住。
 *
 * 三条设计约束:
 *
 * 1. **不追平均色, 追主色。**
 *    屏幕上一半是白底文档、一半是深色代码框, 算出来的平均值是**灰**的。
 *    灰的环境光等于没有环境光。所以这里用**色相聚类投票**:
 *    把像素按色相分桶, 取人最多的那一桶, 再算它的平均色。
 *    这是「屏幕此刻的主色调」, 不是「所有像素的均值」。
 *
 * 2. **亮度必须自己压住。**
 *    屏幕上可能正开着一个白到刺眼的窗口。主色若真是白的, 环境光就白到看不见。
 *    所以亮度有个**上限**, 且最终值还和宿主底色做一次混合, 保证永远看得见。
 *
 * 3. **同色系要分三束。**
 *    宿主的环境光本来就是三块 (ambient-a/b/c)。若三块同色, 渐变就没了层次。
 *    所以同一个主色被**拆成三个色相邻近、明度略不同**的变体,
 *    分别喂给 a/b/c —— 于是渐变还在, 但整片背景跟着屏幕走。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** hsl 分量。h ∈ [0,360), s/l ∈ [0,1] */
export interface Hsl {
  h: number
  s: number
  l: number
}

/** 采样结果 */
export interface DominantColor {
  rgb: Rgb
  hsl: Hsl
  /** 该色相桶里的像素数 / 有彩色像素总数 */
  share: number
}

/** 色相桶宽度。36 = 10° 一个桶, 共 36 桶 */
const HUE_BUCKETS = 36
/** 桶宽度（度） */
const BUCKET_DEG = 360 / HUE_BUCKETS

/**
 * 灰色像素的饱和度上限。
 *
 * 低于这个值算「无彩色」—— 白底、灰底、黑底都归这里。
 * 它们**不参与投票**, 但**不计入分母**: 否则一张纯白桌面会让唯一有彩色的
 * 一个小图标独占 100% 票数, 环境光跟着那个图标跳。
 */
const GRAY_SAT_THRESHOLD = 0.12

/** 单个桶至少要有这么多像素才算是「一个色」 */
const MIN_BUCKET_PIXELS = 4

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2

  if (d === 0) return { h: 0, s: 0, l }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4

  h *= 60
  if (h < 0) h += 360

  return { h, s, l }
}

export function hslToRgb(hsl: Hsl): Rgb {
  const h = ((hsl.h % 360) + 360) % 360
  const s = clamp01(hsl.s)
  const l = clamp01(hsl.l)

  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let rp = 0
  let gp = 0
  let bp = 0

  if (h < 60) {
    rp = c
    gp = x
  } else if (h < 120) {
    rp = x
    gp = c
  } else if (h < 180) {
    gp = c
    bp = x
  } else if (h < 240) {
    gp = x
    bp = c
  } else if (h < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }

  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 夹到 [min, max] 区间 */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * 从 RGB 像素里找主色。
 *
 * @param pixels 扁平数组 [r,g,b,r,g,b,...]
 */
export function dominantColor(pixels: Uint8ClampedArray | number[]): DominantColor | null {
  const count = Math.floor(pixels.length / 3)
  if (count === 0) return null

  // 每个桶存四样: 像素数、r 累加、g 累加、b 累加
  const bucketCount = new Int32Array(HUE_BUCKETS)
  const bucketR = new Float64Array(HUE_BUCKETS)
  const bucketG = new Float64Array(HUE_BUCKETS)
  const bucketB = new Float64Array(HUE_BUCKETS)

  let colorful = 0

  for (let i = 0; i < count; i++) {
    const r = pixels[i * 3] ?? 0
    const g = pixels[i * 3 + 1] ?? 0
    const b = pixels[i * 3 + 2] ?? 0

    const hsl = rgbToHsl({ r, g, b })

    // 无彩色不投票, 也不计入分母
    if (hsl.s < GRAY_SAT_THRESHOLD || hsl.l < 0.03 || hsl.l > 0.97) continue

    colorful++
    const idx = Math.min(HUE_BUCKETS - 1, Math.floor(hsl.h / BUCKET_DEG))
    bucketCount[idx] = (bucketCount[idx] ?? 0) + 1
    bucketR[idx] = (bucketR[idx] ?? 0) + r
    bucketG[idx] = (bucketG[idx] ?? 0) + g
    bucketB[idx] = (bucketB[idx] ?? 0) + b
  }

  // 整屏没有有彩色的像素（纯黑白桌面）—— 没有主色可言
  if (colorful === 0) return null

  /**
   * 找票最多的桶。
   *
   * **关键: 相邻桶先合并, 再比票数。**
   *
   * 为什么不能逐桶比完再合并: 色相量化有边界, 两种很接近的蓝 (h=217 和
   * h=220) 正好落在边界两侧, 逐桶比时它们各占一半 —— 明明是同一个色,
   * 却被当成两个色, 票数被腰斩, 环境光会不稳。
   *
   * 所以这里对每个桶, 取它**和左右邻居**的总票数来比。取最大的是哪个桶,
   * 就以哪个桶为中心取这一组三桶的均值。
   */
  let bestIdx = -1
  let bestVotes = 0
  for (let i = 0; i < HUE_BUCKETS; i++) {
    const prev = bucketCount[(i - 1 + HUE_BUCKETS) % HUE_BUCKETS] ?? 0
    const self = bucketCount[i] ?? 0
    const next = bucketCount[(i + 1) % HUE_BUCKETS] ?? 0
    const votes = prev + self + next
    if (votes > bestVotes) {
      bestVotes = votes
      bestIdx = i
    }
  }

  if (bestIdx < 0 || bestVotes < MIN_BUCKET_PIXELS) return null

  // 相邻桶一起算进均值 —— 色相量化边界上不至于突然变色
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  for (let d = -1; d <= 1; d++) {
    const i = (bestIdx + d + HUE_BUCKETS) % HUE_BUCKETS
    const c = bucketCount[i] ?? 0
    if (c === 0) continue
    n += c
    sr += bucketR[i] ?? 0
    sg += bucketG[i] ?? 0
    sb += bucketB[i] ?? 0
  }

  if (n === 0) return null

  const rgb: Rgb = {
    r: Math.round(sr / n),
    g: Math.round(sg / n),
    b: Math.round(sb / n),
  }

  return {
    rgb,
    hsl: rgbToHsl(rgb),
    /** 这一组三桶的像素数占全部有彩色像素的比例 */
    share: n / colorful,
  }
}

/**
 * 把主色映射成三个环境光色。
 *
 * @param base     主色
 * @param mode     深浅 —— 深色底要更亮的光, 浅色底要更暗的光, 否则看不见
 * @param strength 0~1, 整体强度
 */
export function toAmbientColors(
  base: Hsl,
  mode: 'light' | 'dark',
  strength: number,
): { a: Rgb; b: Rgb; c: Rgb } {
  const s = clamp01(strength)

  // 饱和度: 取屏幕主色的饱和度, 但压到温和区间 —— 环境光太艳会吵
  const sat = clamp(base.s * 0.85, 0.12, 0.62)

  // 亮度上限。深色底上光要亮, 浅色底上光要暗, 都要封顶
  const lightL = mode === 'dark' ? 0.62 : 0.52
  const l = Math.min(base.l * 0.5 + 0.28, lightL)

  /**
   * 三束的色相偏移。用**色相差**而不是随机数:
   * 相邻色相 (而不是互补色) 看起来才像「同一盏灯的三次折射」,
   * 互补色会让背景花掉。
   */
  const a = hslToRgb({ h: base.h - 14, s: sat, l: l * 1.0 })
  const b = hslToRgb({ h: base.h + 12, s: sat * 0.9, l: l * 0.82 })
  const c = hslToRgb({ h: base.h + 26, s: sat * 0.78, l: l * 0.66 })

  return { a, b, c }
}

/**
 * 把 RGB 转成 token 要的 `rgb(r g b / a)` 形式。
 *
 * **为什么用百分比不透明度而不是十六进制 alpha**:
 * 宿主 token 表里 ambient 三项就是这么写的 (`rgb(112 146 255 / 20%)`),
 * 保持同一记法, 换肤与审计那套逻辑读起来才一致。
 *
 * @param alpha 数字 = 百分比; 字符串 = 原样嵌入的 CSS 表达式 (如 calc(...))
 */
export function toTokenValue(rgb: Rgb, alpha: number | string): string {
  const r = Math.round(clamp01(rgb.r / 255) * 255)
  const g = Math.round(clamp01(rgb.g / 255) * 255)
  const b = Math.round(clamp01(rgb.b / 255) * 255)
  const a =
    typeof alpha === 'number' ? `${Math.round(clamp01(alpha / 100) * 100)}%` : alpha
  return `rgb(${r} ${g} ${b} / ${a})`
}

/**
 * 指数平滑 —— 让颜色渐变而不是跳变。
 *
 * @param alpha 0~1, 越大跟得越快
 */
export function smooth(current: number, target: number, alpha: number): number {
  return current + (target - current) * clamp01(alpha)
}

/**
 * 插值角度。色相是环形的 —— 350° → 10° 应该走 20° 而不是 -340°。
 */
export function smoothHue(current: number, target: number, alpha: number): number {
  const diff = ((target - current + 540) % 360) - 180
  return (current + diff * clamp01(alpha) + 360) % 360
}
