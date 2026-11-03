/**
 * 手动验证抓取, 不启动内核、不读清单 —— 只装三个包。
 *
 *   node --use-env-proxy --experimental-strip-types apps/server/src/fetch-demo.ts https://example.com
 *
 * 为什么要有它: 平时想确认"某个网页抓下来到底长什么样", 要么起整个服务, 要么
 * 直接看 .meng/web 里的原始 HTML —— 后者是压缩成一行的 300KB, 根本读不了。
 * 这个入口跑的就是模型会看到的那段文字。
 */

import { createContext } from '@meng/core'
import { apply as toolsApply } from '@meng/tools'
import type { ToolService } from '@meng/tools'
import { apply as netApply } from '../../../plugins/net-local/src/index.ts'
import { apply as fetchApply } from '../../../plugins/tool-fetch/src/index.ts'

const url = process.argv[2]
if (!url) {
  console.error('用法: node ... fetch-demo.ts <url>')
  process.exit(2)
}

const ctx = createContext('fetch-demo')
toolsApply(ctx)
netApply(ctx, { timeoutMs: 30000 })
fetchApply(ctx, { displayChars: Number(process.env.DISPLAY_CHARS ?? 1200) })

const tools = ctx.get<ToolService>('tools')
if (!tools) throw new Error('tools 未装载')

const started = Date.now()
const r = await tools.call({ id: 'demo', name: 'web_fetch', args: { url } })
console.log(r.ok ? r.text : `失败: ${r.error}`)
console.log(`\n（耗时 ${Date.now() - started}ms · 想改显示长度: DISPLAY_CHARS=4000 ...）`)
process.exit(r.ok ? 0 : 1)
