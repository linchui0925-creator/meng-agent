/**
 * @meng/bundle-base — 只有清单, 没有代码。
 *
 * 这是刻意的: base 如果能写代码, 它迟早会长成业务。dsh-base 的
 * `lib/index.js` 全文就是 `export {}` —— 我一开始以为是打包残留,
 * 后来明白这是纪律: bundle 的唯一产物是"哪些包、按什么配置、按什么顺序"。
 */

import { fileURLToPath } from 'node:url'

export const name = 'meng-base-bundle'

/** base 清单的绝对路径, 给 loader 用 */
export const patch = fileURLToPath(new URL('../meng.patch.yml', import.meta.url))

/** 行数上限: 超过就该拆 bundle (见 meng.patch.yml 规则 4) */
export const MAX_ROWS = 12
