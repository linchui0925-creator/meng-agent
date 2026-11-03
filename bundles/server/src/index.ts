/**
 * @meng/bundle-server — 只有清单, 没有代码。
 *
 * 与 base 分开的理由: 桌面端要的是"内核跑在主进程里", 不是"内核开个 HTTP 端口"。
 * 如果把 web 塞进 base, 桌面端就得先禁掉一个它不需要的行 —— 而"装了再禁"
 * 是插件系统里最脆的一种状态 (Python 版 disabled 插件照样加载的 bug 就出在这)。
 */

import { fileURLToPath } from 'node:url'

export const name = 'meng-server-bundle'

export const patch = fileURLToPath(new URL('../meng.patch.yml', import.meta.url))

export const MAX_ROWS = 8
