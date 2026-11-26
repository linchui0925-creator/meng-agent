/**
 * screen-ambient 的 bundle 入口 —— 执行后**只**注册 factory, 不跑任何副作用。
 *
 * 这是 docs/08 §1 那句「执行 ≠ 装载」的样板:
 *   执行这一行代码时, CSS 没注入、slot 没注册、屏幕没抓;
 *   全部锁在 factory 闭包里, 等 shell 调用 `apply` 时才发生。
 * 顺序因此自解: 谁先被下载、谁先被执行都无所谓。
 *
 * `__MENG_LOADER__` 由宿主注入 (modules/client 的 evaluate), 不是真全局。
 *
 * ── 这个插件做了什么 ──
 *
 * 抓屏幕 → 逐帧采样降采样后的画面 → 算主色调 → 写进宿主的环境光 token
 * (`--meng-alias-ambient-a/b/c`) → 宿主的 `.shell::before` 三块径向渐变
 * 就跟着屏幕主色变, 并由 CSS 动画做缓慢的明暗呼吸。
 *
 * **为什么不自己插一层背景**: 宿主已经有环境光层了, 而且它是**三块**渐变。
 * 自己再插一层就是两层光叠着, 反而脏。改 token 才是干净的做法 ——
 * 宿主为此专门留了这三个 token, 它们就是给人换的。
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'

import css from './panel.css?inline'
import { Panel, type PanelBridge } from './Panel.tsx'
import { AmbientDriver, type ThemeFace } from './ambient.ts'
import { BREATH_CSS, CAN_BREATHE } from './breath.ts'
import { ScreenCapture, type CaptureSnapshot, type CaptureState } from './capture.ts'
import { readSettings, writeSettings, type AmbientSettings } from './settings.ts'

declare const __MENG_LOADER__: {
  load(spec: { id: string; factory: () => unknown }): void
}

interface SlotRegistry {
  register(
    pluginId: string,
    reg: { name: string; component: unknown; order?: number; meta?: unknown },
  ): () => void
}

interface ClientContext {
  get(name: string): unknown
}

const ID = 'screen-ambient'
const LAYER_ID = 'screen-ambient'

__MENG_LOADER__.load({
  id: ID,
  factory: () => ({
    /**
     * 只声明 `slots`。
     *
     * **为什么不声明 `theme`**: shell 会校验 inject 里每个能力面是否真的存在,
     * 缺了就判 pending —— 插件永远挂着, 而不是失败, 报错信息还指向
     * 「等待能力面」这种看不懂的地方。
     *
     * `theme` 只有 web shell 提供 (桌面端主进程没有注册它), 而这个插件
     * 本来就只跑 web 端 (抓屏依赖 getDisplayMedia)。但**声明 inject 是给
     * shell 看的**: 少声明一个, 就多一份「运行时才发现缺」的余地。
     * 这里改成**运行时检查** —— 缺 theme 时给出明确的中文提示并停用功能,
     * 而不是让 shell 挂起。
     */
    inject: ['slots'],

    apply(ctx: ClientContext): () => void {
      const slots = ctx.get('slots') as SlotRegistry | undefined
      if (!slots) throw new Error(`${ID} 需要 slots 能力面`)

      const theme = ctx.get('theme') as ThemeFace | undefined

      /* ── 副作用 1 · 分区样式 ────────────────────────────────────── */
      // 打标是硬要求: invalidate 时宿主只回收带自己标记的 style (docs/08 §6)。
      // 不打标 = 卸载后样式永久残留, 而且宿主不敢替你回收 (怕抢了别人的)。
      const style = document.createElement('style')
      style.setAttribute('data-plugin', ID)
      style.textContent = css
      document.head.appendChild(style)

      /* ── 状态 ────────────────────────────────────────────────────── */
      let settings: AmbientSettings = readSettings()
      let snapshot: CaptureSnapshot = { state: 'idle', color: null, message: '' }
      let capture: ScreenCapture | null = null
      let driver: AmbientDriver | null = null

      /** 呼吸 CSS 单独一张表 —— 它有自己的 data-plugin 标记, 卸载时一并摘掉 */
      let breathStyle: HTMLStyleElement | null = null

      /** 当前是深色还是浅色。决定环境光该亮还是该暗 */
      function currentMode(): 'light' | 'dark' {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
      }

      function driverConfig() {
        return {
          strength: settings.strength,
          responsiveness: settings.responsiveness,
          mode: currentMode(),
          breathe: settings.breathe,
        }
      }

      /**
       * 呼吸动画的 style。
       *
       * 只有**真的支持 @property** 才注入 —— 不支持的话自定义属性不可插值,
       * 动画会在 50% 处生硬跳变, 那还不如不呼吸。
       */
      function ensureBreathStyle(): void {
        if (!CAN_BREATHE) return
        if (breathStyle?.isConnected) return
        breathStyle = document.createElement('style')
        breathStyle.setAttribute('data-plugin', `${ID}-breath`)
        breathStyle.textContent = BREATH_CSS
        document.head.appendChild(breathStyle)
      }

      /* ── 订阅: 让 React 那边知道状态变了 ────────────────────────── */

      /**
       * 一个极小的订阅机制 —— 插件不引状态库, 一个 Set 就够了。
       *
       * 这个插件的状态就三样: 设置、抓屏快照、驱动状态。
       */
      const listeners = new Set<() => void>()

      function notify(): void {
        for (const fn of listeners) fn()
      }

      function subscribe(fn: () => void): () => void {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      }

      /* ── 抓屏 ────────────────────────────────────────────────────── */

      /**
       * 开始抓屏。
       *
       * **必须在用户手势的调用栈里** —— 浏览器硬要求。所以它由设置页的
       * 「开始共享」按钮调用, 而不是 apply 里自动开始。
       */
      async function startCapture(): Promise<void> {
        if (capture?.active) return

        if (!theme) {
          snapshot = {
            state: 'unsupported',
            color: null,
            message: '这个宿主没有提供 theme 能力面, 无法驱动环境光',
          }
          notify()
          return
        }

        ensureBreathStyle()

        capture = new ScreenCapture({
          onSample: (color) => {
            snapshot = { ...snapshot, color }
            if (!driver) {
              driver = new AmbientDriver(LAYER_ID, theme, driverConfig())
            }
            driver.update(color)
          },
          onState: (state: CaptureState, message?: string) => {
            snapshot = { ...snapshot, state, message: message ?? '' }
            /**
             * 停了就撤掉环境光这一层, 让宿主配色重新露出来。
             *
             * **`no-permission` 不撤** —— 那只是「画面全黑」的提示, 捕获本身
             * 还在跑。用户去系统设置里给了权限、重启应用之后, 采样会自己恢复。
             * 把它当成「停了」反而会误导用户以为要重新点一次。
             */
            if (state === 'idle' || state === 'ended' || state === 'denied') {
              driver?.dispose()
              driver = null
              snapshot = { ...snapshot, color: null }
            }
            notify()
          },
          onSize: (size) => {
            snapshot = { ...snapshot, size }
            notify()
          },
        })

        await capture.start()
      }

      function stopCapture(): void {
        capture?.stop()
        capture = null
      }

      /* ── 设置分区 ────────────────────────────────────────────────── */

      function updateSettings(next: AmbientSettings): void {
        settings = next
        writeSettings(settings)
        driver?.reconfigure(driverConfig())
        notify()
      }

      const bridge: PanelBridge = {
        get settings() {
          return settings
        },
        get snapshot() {
          return snapshot
        },
        onSettings: updateSettings,
        onStart: () => {
          void startCapture()
        },
        onStop: stopCapture,
      }

      /**
       * 分区组件。
       *
       * 宿主每次渲染分区都新建这个函数 → React 会把它当成**新组件**,
       * 于是每次渲染都卸载重挂, 状态全丢。所以订阅必须建立在**组件内部**,
       * 不能靠父组件传 props。
       */
      function SettingsSection(): ReactElement {
        const [, setTick] = useState(0)

        useEffect(() => {
          return subscribe(() => setTick((n) => n + 1))
        }, [])

        return createElement(Panel, { bridge })
      }

      const off = slots.register(ID, {
        name: 'settings.section',
        component: SettingsSection,
        order: 900,
        meta: { label: '屏幕环境光', group: '插件', origin: 'external' },
      })

      /* ── 卸载 ────────────────────────────────────────────────────── */

      return () => {
        off()
        style.remove()
        breathStyle?.remove()
        /**
         * 停掉抓屏。**必须** —— 忘了停, 屏幕共享指示灯会一直亮着,
         * 用户会以为被监控了。
         */
        stopCapture()
        driver?.dispose()
        driver = null
        listeners.clear()
      }
    },
  }),
})
