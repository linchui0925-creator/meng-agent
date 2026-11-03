import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 移动端外壳。
 *
 * 为什么是 Capacitor 而不是 React Native (docs/05 §0 决策 6):
 *   插件化架构的全部价值是"写一个 UI 插件, 三端都能跑"。RN 不认 CSS、不认 DOM,
 *   等于插件生态按端裂成两半。Capacitor 直接跑 apps/web 的产物, web 代码 100% 复用,
 *   原生能力以插件形式补 (@capacitor/* → 包装成 platform/mobile 能力面)。
 *
 * 代价要说清: WebView 里跑 React, 长列表必须虚拟化, 复杂动画会掉帧。
 * M6 要设性能预算 (docs/05 §8)。
 */
const config: CapacitorConfig = {
  appId: 'ai.meng.app',
  appName: '梦',
  // 复用 apps/web 的构建产物, 不为移动端再建一份前端
  webDir: '../web/dist',
  server: {
    // 开发时连本机内核; 生产改为远端地址
    url: 'http://127.0.0.1:4722',
    cleartext: true,
  },
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_notify' },
  },
}

export default config
