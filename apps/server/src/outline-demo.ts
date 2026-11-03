/**
 * 手动验证 outline: 给一份长材料建地图, 看模型实际会拿到什么。
 *
 *   node --use-env-proxy --experimental-strip-types apps/server/src/outline-demo.ts https://nodejs.org/api/fs.html
 *   node --experimental-strip-types apps/server/src/outline-demo.ts .meng/web/某个文件.html
 *
 * 参数是网址就先抓下来再建图, 是路径就直接建图。
 * 为什么要有它: outline 的输出是给模型看的, 不在任何界面上显示 ——
 * 想确认"这份材料模型到底能不能找到东西", 只有这里能看。
 */

import { createContext } from '@meng/core'
import { apply as fsApply } from '@meng/fs'
import { apply as toolsApply } from '@meng/tools'
import type { ToolService } from '@meng/tools'
import { apply as netApply } from '../../../plugins/net-local/src/index.ts'
import { apply as fetchApply } from '../../../plugins/tool-fetch/src/index.ts'
import { apply as outlineApply } from '../../../plugins/tool-outline/src/index.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('用法: node ... outline-demo.ts <url 或 文件路径>')
  process.exit(2)
}

const ctx = createContext('outline-demo')
toolsApply(ctx)
fsApply(ctx, { root: process.cwd() })
netApply(ctx, { root: process.cwd(), timeoutMs: 30000 })
fetchApply(ctx, { displayChars: 200 })
outlineApply(ctx)

const tools = ctx.get<ToolService>('tools')
if (!tools) throw new Error('tools 未装载')

let path = arg
if (/^https?:\/\//i.test(arg)) {
  const fetched = await tools.call({ id: 'f', name: 'web_fetch', args: { url: arg } })
  if (!fetched.ok) {
    console.error(`抓取失败: ${fetched.error}`)
    process.exit(1)
  }
  const rel = /\.meng\/\S+/.exec(fetched.text)?.[0]
  if (!rel) {
    console.error('抓到了但没找到落盘路径')
    process.exit(1)
  }
  path = rel
  console.log(`（已抓取 → ${rel}）\n`)
}

const started = Date.now()
const r = await tools.call({ id: 'o', name: 'outline', args: { path } })
console.log(r.ok ? r.text : `失败: ${r.error}`)
console.log(`\n（耗时 ${Date.now() - started}ms · 这是模型会看到的那份地图, 不是内容本身）`)
process.exit(r.ok ? 0 : 1)
