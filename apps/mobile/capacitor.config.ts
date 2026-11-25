import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 移动端复用 apps/web 的构建产物。
 *
 * 开发时设置 MENG_MOBILE_DEV_URL 指向电脑上的 Vite；生产不写死地址，
 * 构建 web 时用 VITE_MENG_API_URL 指向远端内核。
 */
const devUrl = process.env.MENG_MOBILE_DEV_URL

const config: CapacitorConfig = {
  appId: 'ai.meng.app',
  appName: '梦',
  webDir: '../web/dist',
  ...(devUrl
    ? { server: { url: devUrl, cleartext: devUrl.startsWith('http://') } }
    : {}),
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_notify' },
  },
}

export default config
