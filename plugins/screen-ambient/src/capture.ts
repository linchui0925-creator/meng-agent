/**
 * 屏幕捕获与像素采样。
 *
 * 三件事, 每件都有个坑:
 *
 * 1. **授权是一次性的, 流是活的**。
 *    `getDisplayMedia` 必须由**用户手势**触发 (浏览器硬要求)。所以本模块
 *    不在 apply 里就抓 —— apply 时没有手势, 必然被拒。抓屏动作放在
 *    设置分区里那个按钮上, 由用户点。
 *
 * 2. **视频帧不是画布**。
 *    `<video>` 的 `drawImage` 出来的是画面, 但每帧都按视频原始分辨率
 *    画再读像素, 一个 4K 屏每帧就是 800 万次读 —— 页面直接卡死。
 *    所以先缩到 32×32 再采样: 主色是个统计量, 不需要分辨率。
 *
 * 3. **`requestVideoFrameCallback` 比 `setInterval` 对**。
 *    屏幕没变化时视频不产生新帧, 按固定间隔轮询会白烧 CPU;
 *    按帧回调则是**有画面才干活**。
 */

import { dominantColor, type DominantColor } from './color.ts'

/** 采样边长。32 = 1024 个像素, 统计主色绰绰有余 */
const SAMPLE_SIZE = 32

/**
 * 连续多少帧全黑才提示「可能没权限」。
 *
 * 取 8 帧: 一帧全黑可能是刚好切到黑屏的瞬间, 8 帧连续全黑基本可以确定
 * 是系统没放行。采样帧率是 4~8fps, 所以 8 帧约 1~2 秒 —— 够短, 不至于
 * 让用户等太久才发现问题。
 */
const BLACK_FRAME_THRESHOLD = 8

/**
 * 判断一帧是不是全黑。
 *
 * 判据是「所有像素都低于某个亮度」, 而不是「严格等于 0」——
 * macOS 给的「黑屏」其实是很暗的深灰 (压缩 + 色彩空间转换的结果),
 * 严格判 0 永远不成立。
 */
function isFullyBlack(data: Uint8ClampedArray): boolean {
  if (data.length === 0) return false
  for (let i = 0; i < data.length; i += 4) {
    // 亮度用最简单的加权近似就够 —— 这里只要区分「黑」和「不是黑」
    const lum =
      0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)
    if (lum > 6) return false
  }
  return true
}

export type CaptureState =
  | 'idle'
  | 'requesting'
  | 'running'
  | 'denied'
  | 'ended'
  | 'unsupported'
  | 'no-permission'

export interface CaptureSnapshot {
  state: CaptureState
  /** 当前主色。没采到时为 null */
  color: DominantColor | null
  /** 错误说明。state 不是 'running' 时可能有 */
  message: string
  /** 采样分辨率。给设置页显示「已接上」用 */
  size?: { width: number; height: number }
}

export interface CaptureOptions {
  /** 每采到一帧调一次 */
  onSample: (color: DominantColor) => void
  /** 状态变化时调一次 */
  onState: (state: CaptureState, message?: string) => void
  /** 视频尺寸变化时调一次 */
  onSize?: (size: { width: number; height: number }) => void
}

/**
 * 一路屏幕捕获。
 *
 * 用法: `await capture.start()` (必须在用户手势里), 然后它自己跑,
 * `capture.stop()` 收摊。卸载时**必须** stop —— 忘了停, 屏幕共享指示灯
 * 会一直亮着, 用户会以为被监控了。
 */
export class ScreenCapture {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private frameCallback: number | null = null
  private stopped = false
  private readonly options: CaptureOptions

  /**
   * 不用参数属性（`constructor(private readonly options: ...)`）——
   * Node 的 strip-only 模式不支持那套语法, 写了这个文件就没法在 node 下
   * 直接跑测试。多写两行, 换测试能跑。
   */
  constructor(options: CaptureOptions) {
    this.options = options
  }

  /** 当前是否在跑 */
  get active(): boolean {
    return this.stream !== null
  }

  /**
   * 开始捕获。**必须在用户手势的调用栈里**。
   *
   * 失败不抛 —— 失败原因（没授权 / 不支持 / 被拒）走 onState,
   * 因为这些都是用户能理解并处理的情况, 不该炸调用方。
   */
  async start(): Promise<boolean> {
    if (this.stream) return true

    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.options.onState('unsupported', '这个浏览器不支持屏幕捕获 (getDisplayMedia)')
      return false
    }

    this.options.onState('requesting')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // 抓到的画面会降采样到 32×32, 没必要要原始分辨率
          width: { ideal: 320 },
          height: { ideal: 180 },
          frameRate: { ideal: 4, max: 8 },
        },
        audio: false,
      })
    } catch (err) {
      const message = describeCaptureError(err)
      this.options.onState(message.includes('取消') ? 'ended' : 'denied', message)
      return false
    }

    // 用户从浏览器自带的浮层里点了「停止共享」—— 这条路不走 start 的 try/catch
    const track = stream.getVideoTracks()[0]
    track?.addEventListener('ended', () => {
      this.options.onState('ended', '屏幕共享已停止')
      this.dispose()
    })

    this.stream = stream
    this.stopped = false

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    this.video = video

    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })

    try {
      await video.play()
    } catch (err) {
      this.options.onState('denied', describeCaptureError(err))
      this.dispose()
      return false
    }

    this.options.onState('running')
    this.scheduleFrame()
    return true
  }

  /**
   * 挂下一帧回调。
   *
   * `requestVideoFrameCallback` 只在**真有新帧**时触发 —— 屏幕静止时
   * 一次回调都不来, CPU 占用是 0。用 `setInterval` 的话每秒空转 4 次。
   */
  private scheduleFrame(): void {
    if (this.stopped || !this.video) return

    const video = this.video
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.frameCallback = video.requestVideoFrameCallback(() => {
        if (this.stopped) return
        this.sample()
        this.scheduleFrame()
      })
      return
    }

    // 老浏览器没有 rVFC, 退化成定时器（此时就没有「静止即空闲」这个好处了）
    this.frameCallback = window.setTimeout(() => {
      if (this.stopped) return
      this.sample()
      this.scheduleFrame()
    }, 250) as unknown as number
  }

  /** 采一帧, 算主色 */
  private sample(): void {
    const video = this.video
    const ctx = this.ctx
    if (!video || !ctx || this.stopped) return

    const width = video.videoWidth
    const height = video.videoHeight
    if (width === 0 || height === 0) return

    if (this.lastSize?.width !== width || this.lastSize?.height !== height) {
      this.lastSize = { width, height }
      this.options.onSize?.({ width, height })
    }

    try {
      ctx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data

      /**
       * 黑帧检测 —— macOS 特有。
       *
       * 用户没给「屏幕录制」权限时, Electron **不会报错**, 而是给你一块
       * 全黑的画面。没有这段检测的话, 插件会安静地显示「运行中」, 而背景
       * 永远不动 —— 用户完全不知道发生了什么, 只觉得插件坏了。
       *
       * 判据: 连续 N 帧全黑, 且**画面尺寸正常** (尺寸为 0 那是还没准备好,
       * 不是权限问题)。全黑且没有主色, 就是权限没给。
       *
       * 注意: 用户真在放一段全黑视频时也会命中。所以只**提示**, 不自动停 ——
       * 误停比误报更烦人。
       */
      const black = isFullyBlack(data)
      if (black) {
        this.blackFrames++
        if (this.blackFrames >= BLACK_FRAME_THRESHOLD && !this.warnedBlack) {
          this.warnedBlack = true
          this.options.onState(
            'no-permission',
            '抓到的是全黑画面 —— 系统可能还没给「屏幕录制」权限（macOS: 系统设置 › 隐私与安全性 › 屏幕录制）',
          )
        }
      } else {
        this.blackFrames = 0
        this.warnedBlack = false
      }

      const color = dominantColor(data)
      if (color) this.options.onSample(color)
    } catch {
      /**
       * `getImageData` 在某些环境下会抛（tainted canvas / 上下文丢失）。
       * 这不该让插件炸掉 —— 停掉这一帧的采样, 等下一帧再试。
       */
    }
  }

  /** 连续全黑的帧数 */
  private blackFrames = 0
  /** 是否已经就「全黑」提示过一次 */
  private warnedBlack = false

  private lastSize: { width: number; height: number } | null = null

  /** 停止捕获并彻底释放。**卸载时必须调** */
  stop(): void {
    this.stopped = true

    if (this.frameCallback !== null) {
      const video = this.video
      if (video && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(this.frameCallback)
      }
      window.clearTimeout(this.frameCallback)
      this.frameCallback = null
    }

    this.dispose()
    this.options.onState('idle')
  }

  /** 释放媒体资源（不通知状态） */
  private dispose(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null

    if (this.video) {
      this.video.srcObject = null
      this.video = null
    }
    this.ctx = null
    this.canvas = null
  }
}

/**
 * 把 `getDisplayMedia` 的异常翻译成人话。
 *
 * `DOMException` 的 name 是稳定的, message 各家浏览器不同 —— 所以按 name 判,
 * 不按 message 判。
 */
export function describeCaptureError(err: unknown): string {
  if (!(err instanceof Error)) return '屏幕捕获失败'
  const name = err.name
  switch (name) {
    case 'NotAllowedError':
      return '屏幕捕获被拒绝（需要在浏览器弹窗里允许共享）'
    case 'NotFoundError':
      return '没有找到可捕获的屏幕'
    case 'NotSupportedError':
      return '这个环境不支持屏幕捕获'
    case 'SecurityError':
      return '屏幕捕获被安全策略拦下'
    case 'AbortError':
      return '屏幕捕获已取消'
    default:
      return err.message || `屏幕捕获失败 (${name})`
  }
}
