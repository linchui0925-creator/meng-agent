/**
 * transport · Electron IPC (桌面端连本地内核)。
 *
 * 与 ws 实现**同一套 Transport 接口**, 所以业务插件不知道内核在本地主进程还是云端。
 * 想要"桌面端连云端内核", 换一个 transport 插件即可, 不动任何业务代码。
 */

import type { Transport } from './index.ts'

export function createIpcTransport(): Transport {
  throw new Error('transport/ipc: 未实现 (M6)')
}
