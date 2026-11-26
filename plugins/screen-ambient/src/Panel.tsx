/**
 * 设置分区 —— 插件的控制面板。
 *
 * **为什么自己写控件而不复用宿主的 `apps/web/src/app/settings/controls.tsx`**:
 * 那个模块在宿主应用内部, 插件拿不到 (也不该去 import 宿主应用源码)。
 * `packages/ui` 里的组件是**聊天界面**的控件, 尺寸和语义都偏"操作",
 * 而设置页要的是「一行一个设置项, 控件永远靠右对齐」这种表单节奏。
 * 所以这里写一份**精简的**分区控件 —— 只写这个分区真的用到的那几个。
 *
 * 可访问性照抄宿主的做法: 开关用 `role="switch"`, 滑杆用原生 `<input type=range>`。
 * 自己写 div 装样子的话读屏和键盘 Tab 得重新补一遍, 还容易补错。
 */

import { useCallback } from 'react'

import { CAN_BREATHE } from './breath.ts'
import type { CaptureSnapshot, CaptureState } from './capture.ts'
import type { AmbientSettings } from './settings.ts'
// CSS 以 ?inline 导入成字符串, 由 factory 注入; 类名是普通字符串, 不是 CSS Modules 对象

/** 宿主传进来的、以及插件要用的外部接口 */
export interface PanelBridge {
  /** 当前设置 */
  settings: AmbientSettings
  /** 改设置 */
  onSettings: (next: AmbientSettings) => void
  /** 抓屏状态 */
  snapshot: CaptureSnapshot
  /** 开始抓屏（必须在用户手势里） */
  onStart: () => void
  /** 停掉抓屏 */
  onStop: () => void
}

export function Panel(props: { bridge: PanelBridge }) {
  const { bridge } = props
  const { settings, snapshot } = bridge

  const set = useCallback(
    (patch: Partial<AmbientSettings>) => {
      bridge.onSettings({ ...settings, ...patch })
    },
    [bridge, settings],
  )

  return (
    <div className="sa-root">
      <p className="sa-lead">
        抓取屏幕画面，算出此刻的主色调，驱动界面的环境光随之呼吸。
        抓屏需要你手动授权一次；授权后画面只在本机内存里逐帧采样，不会离开这台电脑。
      </p>

      {/* ── 授权与状态 ── */}
      <section className="sa-group">
        <h3 className="sa-group-title">屏幕捕获</h3>
        <div className="sa-group-body">
          <div className="sa-row">
            <div className="sa-row-text">
              <span className="sa-row-title">共享屏幕</span>
              <p className="sa-row-desc">{describeState(snapshot.state, snapshot.message)}</p>
            </div>
            <div className="sa-row-control">
              {snapshot.state === 'running' ? (
                <button
                  type="button"
                  className="sa-button"
                  onClick={bridge.onStop}
                  data-testid="sa-stop"
                >
                  停止共享
                </button>
              ) : (
                <button
                  type="button"
                  className="sa-button-primary"
                  onClick={bridge.onStart}
                  disabled={snapshot.state === 'requesting'}
                  data-testid="sa-start"
                >
                  {snapshot.state === 'requesting' ? '等待授权…' : '开始共享'}
                </button>
              )}
            </div>
          </div>

          <div className="sa-row">
            <div className="sa-row-text">
              <span className="sa-row-title">状态</span>
              <p className="sa-row-desc">{stateDetail(snapshot)}</p>
            </div>
            <div className="sa-row-control">
              <span className="sa-badge" data-state={snapshot.state}>
                {stateLabel(snapshot.state)}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── 效果调节 ── */}
      <section className="sa-group">
        <h3 className="sa-group-title">效果</h3>
        <div className="sa-group-body">
          <div className="sa-row">
            <div className="sa-row-text">
              <span className="sa-row-title">启用</span>
              <p className="sa-row-desc">关掉后环境光恢复宿主的默认冷暖配色</p>
            </div>
            <div className="sa-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                className="sa-switch"
                data-on={settings.enabled ? '' : undefined}
                onClick={() => set({ enabled: !settings.enabled })}
                data-testid="sa-enabled"
              >
                <span className="sa-switch-knob" />
              </button>
            </div>
          </div>

          <Slider
            title="强度"
            desc="环境光的浓度。太高会盖过正文。"
            value={settings.strength}
            disabled={!settings.enabled}
            onChange={(v) => set({ strength: v })}
            testId="sa-strength"
          />

          <Slider
            title="跟随速度"
            desc="屏幕变色后背景追上去的速度。慢一点更柔和, 快一点更跟手。"
            value={settings.responsiveness}
            disabled={!settings.enabled}
            onChange={(v) => set({ responsiveness: v })}
            testId="sa-responsiveness"
          />

          <Slider
            title="呼吸幅度"
            desc="环境光缓慢明暗起伏的幅度。"
            value={settings.breathe}
            disabled={!settings.enabled}
            onChange={(v) => set({ breathe: v })}
            testId="sa-breathe"
          />
        </div>
      </section>

      <p className="sa-note">
        {CAN_BREATHE
          ? '呼吸由浏览器合成器上的 CSS 动画驱动，采样停止时界面也不会卡顿。'
          : '这个浏览器不支持 CSS @property，呼吸动画已降级为静态光效。'}
      </p>
    </div>
  )
}

/* ────────────────────────── 局部控件 ────────────────────────── */

function Slider(props: {
  title: string
  desc: string
  value: number
  disabled?: boolean
  onChange: (value: number) => void
  testId: string
}) {
  return (
    <div className="sa-row">
      <div className="sa-row-text">
        <span className="sa-row-title">{props.title}</span>
        <p className="sa-row-desc">{props.desc}</p>
      </div>
      <div className="sa-row-control">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={props.value}
          disabled={props.disabled}
          className="sa-slider"
          onChange={(e) => props.onChange(Number(e.target.value))}
          data-testid={props.testId}
        />
      </div>
    </div>
  )
}

/* ────────────────────────── 状态文案 ────────────────────────── */

function stateLabel(state: CaptureState): string {
  switch (state) {
    case 'running':
      return '运行中'
    case 'requesting':
      return '等待授权'
    case 'denied':
      return '被拒绝'
    case 'no-permission':
      return '缺权限'
    case 'ended':
      return '已停止'
    case 'unsupported':
      return '不支持'
    default:
      return '未启动'
  }
}

function describeState(state: CaptureState, message: string): string {
  if (state === 'running') return '正在逐帧采样屏幕画面。停止共享后环境光会恢复默认。'
  if (message) return message
  if (state === 'unsupported') return '当前环境没有屏幕捕获能力。'
  return '点击「开始共享」，在弹窗里选择要共享的屏幕。'
}

function stateDetail(snapshot: CaptureSnapshot): string {
  if (snapshot.state === 'no-permission') {
    return '画面是全黑的 —— 系统没放行屏幕录制。给权限后重启应用即可。'
  }
  if (snapshot.state !== 'running') return '没有采样时环境光保持宿主的默认配色。'
  const size = snapshot.size
  if (!size) return '正在采样…'
  return `采样来源 ${size.width}×${size.height}，降采样到 32×32 统计主色。`
}
