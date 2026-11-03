/**
 * @meng/bundle-kit —— 同样只有清单。
 *
 * 六行, 三层 (抄 dsh 的分层真相):
 *   seam (fs) → 薄壳 (tool-fs / tool-search / tool-bash) → 策略 (policy-fs / policy-bash)。
 * 顺序不写在文件里 —— 谁先谁后由 inject 和监听器 priority 决定。
 */

import { fileURLToPath } from 'node:url'

export const name = 'meng-kit-bundle'

export const patch = fileURLToPath(new URL('../meng.patch.yml', import.meta.url))
