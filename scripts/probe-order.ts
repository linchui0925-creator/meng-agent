/**
 * 复现探针: 同一个清单, 行序正/倒各跑一次, 比较激活集合。
 *
 * 只读 —— 除了往系统临时目录写一份倒序后的清单, 不碰仓库里任何文件。
 * 给后端 HANDOFF B-06 回"最小复现"用:
 *
 *   node --experimental-strip-types scripts/probe-order.ts
 *
 * 2026-11-03 实测 (仍然复现):
 *   正序 active: agent,llm,persistence,prompt,session,tools     非 active: 无
 *   倒序 active: llm,prompt,session                              非 active: agent/persistence/tools 全 pending
 * 也就是说清单**内部**行序也是敏感的, 与 docs/02「行序不携带加载语义」的宣言不符。
 * 根因大概率是 loadPatch 单次遍历、pending 行不回头重试 (docs/07 §1.2 里的同一个判断)。
 */
import { createContext, StatusGraph } from '@meng/core'
import { loadPatch } from '@meng/core/loader'
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'bundles/base/meng.patch.yml'
const raw = readFileSync(SRC, 'utf8')
const lines = raw.split('\n')
// 把 insert 下的 "- id: xxx" 行序倒过来, 其余一字不动
const idx: number[] = []
lines.forEach((l, i) => { if (/^\s*- id: /.test(l)) idx.push(i) })
const groups: string[][] = []
for (let i = 0; i < idx.length; i++) {
  const start = idx[i]!
  const end = i + 1 < idx.length ? idx[i + 1]! : lines.length
  groups.push(lines.slice(start, end))
}
const head = lines.slice(0, idx[0]!)
writeFileSync('/tmp/reversed.yml', [...head, ...groups.slice().reverse().flat()].join('\n'))

async function run(file: string) {
  const ctx = createContext('probe')
  const graph = new StatusGraph()
  await loadPatch(ctx, graph, file)
  const nodes = graph.snapshot()
  return {
    active: nodes.filter((n) => n.status === 'active').map((n) => n.id).sort(),
    other: nodes.filter((n) => n.status !== 'active').map((n) => `${n.id}:${n.status}`).sort(),
  }
}

const a = await run(SRC)
const b = await run('/tmp/reversed.yml')
console.log('正序 active:', a.active.join(','))
console.log('正序 非active:', a.other.join(',') || '(无)')
console.log('倒序 active:', b.active.join(','))
console.log('倒序 非active:', b.other.join(',') || '(无)')
console.log(a.active.join(',') === b.active.join(',') ? '一致 ✅ 行序无关' : '不一致 ❌ 行序敏感')
