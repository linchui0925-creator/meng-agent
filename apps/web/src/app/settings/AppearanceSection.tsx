/**
 * 「外观」分区 —— 第一个真实的分区插件（`settings.section`）。
 *
 * 它演示分区插件的最小合法形状（docs/13 §6）:
 *   · 只拿 SectionApi, 不碰壳、不碰整窗开关
 *   · 注册时带 meta { label, group, origin } —— 左导航靠它列项
 *
 * 数据归本机腿: 主题 / 密度 / 动效都写 prefs（localStorage），
 * 即改即生效、断线也能改。这也是「两条腿」在界面上的第一个实例 —— 右上角徽章写「本机」。
 *
 * 为什么密度和动效在这里而不是「对话」分区: 它们改的是**整屏**的观感
 * （全站间距、所有动画），而对话分区只管会话流里的东西。判据是影响范围, 不是直觉。
 */

import type { SectionApi } from './api.ts'
import type { Density, MotionMode, ThemeMode } from '../../prefs.ts'
import { Group, Note, Row, Segmented } from './controls.tsx'
import styles from './AppearanceSection.module.css'

type ThemeOption = {
  id: ThemeMode | 'soon'
  label: string
  /** 缩略图画的是哪个主题。system = 左右各一半 */
  thumb: 'light' | 'dark' | 'system' | 'soon'
}

const THEMES: ThemeOption[] = [
  { id: 'system', label: '跟随系统', thumb: 'system' },
  { id: 'light', label: '浅色', thumb: 'light' },
  { id: 'dark', label: '深色', thumb: 'dark' },
  { id: 'soon', label: '敬请期待', thumb: 'soon' },
]

const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'compact', label: '紧凑' },
]

const MOTION_OPTIONS: ReadonlyArray<{ value: MotionMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少动效' },
]

/**
 * 主题缩略图。
 *
 * `data-theme` 是**局部作用域**（tokens.css 里 alias 层的选择器不限 :root）:
 * 浅色主题下也要显示「深色」卡片长什么样, 靠的就是把深色那套变量挂在卡片上。
 * 不这么做就只能把色值抄进组件 —— 抄一遍就多一份跟令牌漂移的副本。
 */
function Thumb({ kind }: { kind: ThemeOption['thumb'] }) {
  if (kind === 'soon') {
    return <div className={styles.thumbSoon}>敬请期待</div>
  }
  if (kind === 'system') {
    return (
      <div className={styles.thumbSplit}>
        <div className={styles.thumb} data-theme="light">
          <ThumbBody />
        </div>
        <div className={styles.thumb} data-theme="dark">
          <ThumbBody />
        </div>
      </div>
    )
  }
  return (
    <div className={styles.thumb} data-theme={kind}>
      <ThumbBody />
    </div>
  )
}

/** 缩略图里的「迷你界面」: 侧栏三条 + 两条消息 + 输入条。纯 div, 没有文字 */
function ThumbBody() {
  return (
    <>
      <div className={styles.thumbSide}>
        <i />
        <i />
        <i />
      </div>
      <div className={styles.thumbMain}>
        <i className={styles.bubble} />
        <i className={styles.bubbleUser} />
        <i className={styles.bar} />
      </div>
    </>
  )
}

export function AppearanceSection({ prefs, setPrefs }: SectionApi) {
  return (
    <div>
      {/* 预览卡: 用当前主题的真颜色画一个迷你会话, 选主题时当场变 */}
      <div className={styles.preview} aria-hidden="true">
        <div className={styles.miniSide}>
          <span className={styles.miniBrand}>梦</span>
          <i className={styles.miniItem} />
          <i className={styles.miniItem} />
          <i className={styles.miniItem} />
        </div>
        <div className={styles.miniMain}>
          <div className={styles.miniMsg}>
            <span className={styles.miniAvatar}>梦</span>
            <span className={styles.miniBubble}>已经把文件整理进去了，一共 12 个。</span>
          </div>
          <div className={styles.miniMsg} data-user="">
            <span className={styles.miniBubble}>辛苦了，接下来跑一下测试。</span>
          </div>
          <div className={styles.miniTool}>
            <span className={styles.miniDot} />
            正在运行 · pnpm test
          </div>
          <div className={styles.miniComposer}>
            <span>说点什么…</span>
            <span className={styles.miniSend}>↑</span>
          </div>
        </div>
      </div>

      <div className={styles.grid}>
        {THEMES.map((t) => {
          const soon = t.id === 'soon'
          const on = !soon && t.id === prefs.theme
          return (
            <button
              key={t.id}
              className={styles.card}
              data-on={on ? '' : undefined}
              data-soon={soon ? '' : undefined}
              disabled={soon}
              onClick={() => {
                if (!soon) setPrefs({ theme: t.id as ThemeMode })
              }}
              aria-pressed={on}
            >
              <span className={styles.shot}>
                <Thumb kind={t.thumb} />
              </span>
              <span className={styles.cardLabel}>{t.label}</span>
            </button>
          )
        })}
      </div>

      <Group title="布局">
        <Row
          title="密度"
          desc="紧凑会收窄行高、控件高度和间距，字号不变 —— 一屏能多放几行，但没现在这么松。"
        >
          <Segmented
            value={prefs.density}
            options={DENSITY_OPTIONS}
            onChange={(density) => setPrefs({ density })}
            label="界面密度"
          />
        </Row>
      </Group>

      <Group title="动效">
        <Row
          title="动画"
          desc="「跟随系统」会跟着操作系统里的「减少动态效果」走；选「减少动效」则无条件关掉，包括气泡探出和卡片淡入。"
        >
          <Segmented
            value={prefs.motion}
            options={MOTION_OPTIONS}
            onChange={(motion) => setPrefs({ motion })}
            label="动效"
          />
        </Row>
      </Group>

      <Note>
        主题、密度、动效都存在这台机器上，改完立刻生效，不经过内核、也不需要重启。
      </Note>
    </div>
  )
}
