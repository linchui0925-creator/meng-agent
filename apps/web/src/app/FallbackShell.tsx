/**
 * 宿主最后一道闸 —— 运行期崩溃时的兜底界面。
 *
 * 为什么不是错误页、也不是「安全模式」弹窗:
 *   把「重试还是仅内置启动」交给用户, 等于把系统内部状态变成用户的待办。
 *   用户不知道插件是什么, 他只想知道"还能不能继续用"。
 *
 * 所以这里只做三件事:
 *   1. 不白屏 —— 壳、侧栏、标题都还在, 只有内容区说一句人话
 *   2. 不解释技术原因 —— 错误原文只落 localStorage, 留给状态面板与排查
 *   3. **只给一个动作** —— 「重新加载」。不给二选一, 也不给"点了没反应"的重试
 *
 * 为什么连"再试一次"都不给:
 *   React 的边界在 reset 之后如果同一个位置立刻再抛, 它不会第二次交给边界,
 *   界面会**停在原地不动** —— 用户点了按钮, 屏幕毫无反应, 这是最糟的一种体验,
 *   比"刷新一下"差得多。所以这里不玩"轻量重试", 直接给真能生效的那个动作。
 *
 * 刷新之后怎么不陷入死循环: 见 `shouldBootSafe()` —— 短时间连崩就自动切成
 * **发版原始模式** (只装随发行版打包的插件, 运行时装进来的一个不装)。
 * **自动、不问、也不需要用户理解**: 它是系统的一个决定, 不是用户的一道选择题。
 *
 * 还有一条纪律: **兜底不能吞掉 bug**。componentDidCatch 必须记账 + 打 console,
 * 否则"看起来没崩"会变成最难查的一类故障。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import styles from './Fallback.module.css'

/** 崩溃记录只落本地: 不上报、不弹窗。给保守启动与状态面板用 */
export interface CrashInfo {
  at: number
  message: string
  stack: string
  /** 时间窗内的累计次数。1 = 偶发, >=2 = 反复崩 */
  count: number
}

const CRASH_KEY = 'meng.lastCrash'
/** 多久之内的崩算"同一轮"。60 秒: 短于"用户去泡杯咖啡", 长于"刷新重试的间隔" */
const CRASH_WINDOW = 60_000

export function readLastCrash(): CrashInfo | null {
  try {
    const raw = localStorage.getItem(CRASH_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as Partial<CrashInfo>
    if (typeof rec.at !== 'number' || typeof rec.message !== 'string') return null
    return {
      at: rec.at,
      message: rec.message,
      stack: typeof rec.stack === 'string' ? rec.stack : '',
      count: typeof rec.count === 'number' && rec.count > 0 ? rec.count : 1,
    }
  } catch {
    return null
  }
}

/**
 * 这次启动要不要「保守模式」= 连崩过两次、且还在时间窗内。
 *
 * 判据是**两次**而不是一次: 崩一次可能只是偶发, 直接降级会让用户莫名其妙少一半功能;
 * 崩两次说明刷新解决不了, 这时候降级才是对的。
 */
export function shouldBootSafe(): boolean {
  const rec = readLastCrash()
  if (!rec) return false
  return rec.count >= 2 && Date.now() - rec.at < CRASH_WINDOW
}

interface BoundaryProps {
  children: ReactNode
  /** 兜底界面。不给 reset —— 见文件头「为什么连再试一次都不给」 */
  fallback: ReactNode
}

interface BoundaryState {
  error: Error | null
}

export class CrashBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    consumeBomb()

    try {
      const prev = readLastCrash()
      const recent = prev !== null && Date.now() - prev.at < CRASH_WINDOW
      const record: CrashInfo = {
        at: Date.now(),
        message: error.message,
        stack: (error.stack ?? '').slice(0, 800),
        count: recent ? prev.count + 1 : 1,
      }
      localStorage.setItem(CRASH_KEY, JSON.stringify(record))
    } catch {
      // 隐私模式 / 配额满时 localStorage 会抛。在这里再崩一次是最蠢的失败方式
    }

    console.error('[meng] 界面崩溃 (已兜底):', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children
  }
}

/**
 * 最小可用界面。
 *
 * 刻意长得像正常界面、且**全中性色** —— 红色会把"某一块没起来"放大成
 * "整个应用坏了", 而这恰恰是我们最不想让用户得出的结论。
 */
export function FallbackShell() {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>梦</div>
        {/* 说人话: 不出现「插件」「槽位」「manifest」任何一个词 */}
        <p className={styles.sideNote}>有些功能暂时没起来。</p>
      </aside>

      <main className={styles.main}>
        <div className={styles.body}>
          <div className={styles.card}>
            <p className={styles.title}>这段对话暂时没能显示</p>
            <p className={styles.hint}>重新加载通常就能回来。</p>
            <button
              type="button"
              className={styles.action}
              onClick={() => globalThis.location.reload()}
            >
              重新加载
            </button>
          </div>
        </div>

        {/* 这句是安抚, 不是技术说明 —— 用户此刻最担心的是"我的对话是不是没了" */}
        <div className={styles.footer}>界面有一部分没能加载，你的对话没有丢</div>
      </main>
    </div>
  )
}

/* ────────────────────────── dev 验证用的炸弹 ────────────────────────── */

const BOMB_KEY = 'meng.bombFired'

function bombFired(): number {
  try {
    return Number(sessionStorage.getItem(BOMB_KEY) ?? '0') || 0
  } catch {
    return 0
  }
}

/**
 * dev 验证用: `?crash=N` 在渲染期抛 N 次（跨刷新累计）。
 *
 * 两个坑, 都不是理论问题, 是实测踩出来的:
 *   1. React 19 遇到并发渲染抛错会**先把整个 root 同步重渲一遍**再交给边界。
 *      所以计数不能在渲染时递增, 只能由边界接住那一刻递增 —— 否则那次内部重试
 *      就把子弹打光, 表现成"看起来没崩、其实崩过", 兜底路径永远验不到。
 *   2. 计数要放 sessionStorage 而不是模块变量: 「刷新之后不再炸」是必须能验的,
 *      否则验不到安全模式那条路径。
 */
export function CrashBomb({ times = 1 }: { times?: number }): ReactNode {
  if (!import.meta.env.DEV) return null
  if (bombFired() >= times) return null
  throw new Error('crash: 这是 ?crash=N 故意触发的渲染期错误')
}

/** 边界真接住一次, 才消耗一枚 */
function consumeBomb(): void {
  try {
    sessionStorage.setItem(BOMB_KEY, String(bombFired() + 1))
  } catch {
    // 存不了就算了: 验不了"刷新后不再炸", 但不会影响真实兜底
  }
}
