/**
 * WCAG 2.1 对比度计算 + 运行时审计的配对白名单。
 *
 * 为什么单独一个文件: 对比度的计算**只许有一份实现**。
 * `scripts/check-contrast.mjs` (构建期) 和主题控制器 (运行时) 都从这里拿 ——
 * 两份公式迟早漂移, 而漂移的表现是「脚本说合格、运行时拒绝」, 排查起来毫无头绪。
 *
 * 这个文件零依赖、不碰 DOM, node 和浏览器都能跑。
 */

export type Rgb = readonly [number, number, number]

/** #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()。解析不了返回 null —— 由调用方决定怎么处置 */
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase()

  if (value.startsWith('#')) {
    let h = value.slice(1)
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    // 忽略 alpha: token 层不允许半透明色参与正文对比
    const bytes = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
    // '#zzz' 这类输入 parseInt 给 NaN —— 必须在这里拦住, NaN 参与比较永远为 false,
    // 会把「明显的违规」漏成「合法」
    if (bytes.some((n) => !Number.isFinite(n))) return null
    return [bytes[0]!, bytes[1]!, bytes[2]!]
  }

  const m = value.match(/^rgba?\(([^)]+)\)$/)
  if (m && m[1] !== undefined) {
    const raw = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3)
    if (raw.length !== 3) return null
    const parts = raw.map(Number)
    if (parts.some((n) => !Number.isFinite(n))) return null
    const [r, g, b] = parts
    return [r!, g!, b!]
  }

  return null
}

/** WCAG 2.1 相对亮度。sRGB → 线性 → 加权 */
export function luminance(rgb: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  // 不用 sort + 解构: noUncheckedIndexedAccess 下解构出来是 number | undefined, 白送收窄税
  const la = luminance(a)
  const lb = luminance(b)
  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

/** WCAG 2.1 AA: 正文 4.5, 大字与图形 3.0; 描边只要「不隐形」 */
export const AA_TEXT = 4.5
export const AA_LARGE = 3.0

export interface ContrastPair {
  /** 前景 token, 完整变量名 */
  fg: string
  /** 它会叠在哪些背景上。全部都要过 min */
  bgs: string[]
  min: number
  /** 给构建期报告用 */
  label: string
}

/**
 * 配对白名单: 哪个 token 当前景时, 必须在哪些背景上读得清。
 *
 * 这是运行时审计的**依据** —— 控制器只审「本次被写的 token」参与的对,
 * 没进这张表的组合不审 (审全会表每帧都算, 没必要也没人看)。
 */
export const CONTRAST_PAIRS: ContrastPair[] = [
  {
    fg: '--meng-alias-fg-primary',
    bgs: [
      '--meng-alias-bg-canvas',
      '--meng-alias-bg-surface',
      '--meng-alias-bg-raised',
      '--meng-alias-bg-inset',
      '--meng-alias-bg-hover',
      '--meng-alias-bg-selected',
      // 错误块里还是要读正文: 错误卡片的正文也用 fg-primary
      '--meng-alias-danger-subtle',
    ],
    min: AA_TEXT,
    label: '正文',
  },
  {
    fg: '--meng-alias-fg-secondary',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-bg-canvas'],
    min: AA_TEXT,
    label: '次要文字',
  },
  {
    fg: '--meng-alias-fg-muted',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-bg-canvas', '--meng-alias-bg-inset'],
    min: AA_TEXT,
    label: '弱化文字',
  },
  { fg: '--meng-alias-fg-code', bgs: ['--meng-alias-bg-inset'], min: AA_TEXT, label: '代码正文' },
  {
    fg: '--meng-alias-fg-on-accent',
    bgs: ['--meng-alias-accent', '--meng-alias-accent-hover', '--meng-alias-accent-active'],
    min: AA_TEXT,
    label: '主按钮文字',
  },
  {
    fg: '--meng-alias-accent',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-bg-canvas'],
    min: AA_TEXT,
    label: '链接 / 强调文字',
  },
  {
    fg: '--meng-alias-live',
    bgs: [
      '--meng-alias-bg-surface',
      '--meng-alias-bg-canvas',
      '--meng-alias-bg-inset',
      '--meng-alias-live-subtle',
    ],
    min: AA_TEXT,
    label: '运行中',
  },
  {
    fg: '--meng-alias-positive',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-positive-subtle'],
    min: AA_TEXT,
    label: '成功',
  },
  {
    fg: '--meng-alias-warning',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-warning-subtle'],
    min: AA_TEXT,
    label: '警告',
  },
  {
    fg: '--meng-alias-danger',
    bgs: ['--meng-alias-bg-surface', '--meng-alias-danger-subtle'],
    min: AA_TEXT,
    label: '错误',
  },
  {
    fg: '--meng-alias-focus-ring',
    bgs: ['--meng-alias-bg-surface'],
    min: AA_LARGE,
    label: '焦点环',
  },
  { fg: '--meng-alias-border-l3', bgs: ['--meng-alias-bg-surface'], min: 1.4, label: '描边可见度' },
]

export interface ContrastViolation {
  fg: string
  bg: string
  ratio: number
  min: number
  label: string
}

/**
 * 审计一批「被写过的 token」。
 *
 * 只审 `written` 里出现过的名字参与的对 —— 内置 token 构建期已过审,
 * 每对都重算一遍纯属浪费。resolve(name) 负责给出**最终生效值**:
 * 先查写集, 查不到回落到当前样式 —— 这样「插件同时改 accent 和 bg-surface」
 * 时, 审计算的是它改完之后的真实组合, 不是新旧混杂的。
 */
export function auditContrast(
  written: Readonly<Record<string, string>>,
  resolve: (token: string) => string | undefined,
): ContrastViolation[] {
  const written_ = new Set(Object.keys(written))
  const violations: ContrastViolation[] = []
  const cache = new Map<string, Rgb | null>()

  const color = (name: string): Rgb | null => {
    if (cache.has(name)) return cache.get(name)!
    const value = resolve(name)
    const parsed = value ? parseColor(value) : null
    cache.set(name, parsed)
    return parsed
  }

  for (const pair of CONTRAST_PAIRS) {
    // fg 或 bg 任一被写过才需要重审
    if (!written_.has(pair.fg) && !pair.bgs.some((bg) => written_.has(bg))) continue

    const fgColor = color(pair.fg)
    if (!fgColor) continue

    for (const bg of pair.bgs) {
      const bgColor = color(bg)
      if (!bgColor) continue
      const ratio = contrastRatio(fgColor, bgColor)
      if (ratio < pair.min) {
        violations.push({ fg: pair.fg, bg, ratio, min: pair.min, label: pair.label })
      }
    }
  }

  return violations
}
