/**
 * 平台能力面 · 移动端 (Capacitor)。
 *
 * 每个面包装一个 @capacitor/* 插件, 且**当运行在纯 web 容器里时自动降级** ——
 * Capacitor 在 web 下会回退到插件的 web 实现, 所以这份实现在浏览器里也能跑。
 */

import type { PlatformFaces } from './index.ts'

export function mobileFaces(): PlatformFaces {
  throw new Error('platform/mobile: 未实现 (M7)')
}
