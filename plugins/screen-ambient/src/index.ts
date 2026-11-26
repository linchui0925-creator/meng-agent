/**
 * screen-ambient 的后端面。
 *
 * **这个插件的后端是空的, 而且是故意的。**
 *
 * 抓屏、采样、算色 —— 全在前端做完了:
 *   · 画面从来没离开过这台机器 (不进后端, 不上网络)
 *   · 采样在渲染进程的 canvas 里, 后端碰不到也用不上
 *   · 环境光 token 由宿主前端的主题能力面直接写
 *
 * 后端如果再实现一遍采样, 就等于把画面搬出浏览器 —— 那正是我们要避免的。
 * 所以这里只有一个**清单自检**: 确认包里的 plugin id 和清单对得上。
 *
 * 为什么还要留这个文件: 包规范要求 `main` / `types` 指向真实产物,
 * 且后端面必须在 patch 里占一行 (否则宿主装载时找不到这个插件)。
 */

import { readFileSync } from 'node:fs'
import { defineInvariant } from '@meng/core'

export const name = 'screen-ambient'
export const inject: string[] = []

export function apply(): void {}

export const invariant = defineInvariant('@meng/plugin-screen-ambient', [
  {
    id: 'manifest-ready',
    run() {
      const pkg = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { meng?: { plugin?: { id?: string } } }
      if (pkg.meng?.plugin?.id !== 'screen-ambient') {
        throw new Error('插件清单不匹配')
      }
    },
  },
])
