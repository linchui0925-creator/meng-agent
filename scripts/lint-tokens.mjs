/**
 * token 硬规矩 —— docs/07 §F3: 「`*.module.css` 里除 tokens.css 外出色值直接报错」。
 *
 * 为什么必须现在就有: 组件的样式一旦写了几十处 hex, 后来补这条规则就等于要求
 * 把所有组件重写一遍; 而先有规则, 新写的天然合规。**迟了就没用了。**
 *
 * 允许的例外只有两个: 透明色与继承色 (它们不携带主题信息)。
 * 用法: node scripts/lint-tokens.mjs  (exit 1 = 有违规)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

/** 这些文件本身就是在定义颜色, 不参与检查 */
const ALLOW = new Set(['packages/ui/src/tokens.css'])

const COLOR_PATTERNS = [
  { re: /#[0-9a-fA-F]{3,8}\b/g, what: 'hex 色值' },
  { re: /\brgba?\s*\(/g, what: 'rgb()/rgba()' },
  { re: /\bhsla?\s*\(/g, what: 'hsl()/hsla()' },
  { re: /\b(?:white|black)\b(?=\s*[;,)}])/g, what: '颜色关键字' },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (name.endsWith('.css')) out.push(full)
  }
  return out
}

const files = walk(join(ROOT, 'packages')).concat(walk(join(ROOT, 'apps')))
const violations = []

for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/')
  if (ALLOW.has(rel)) continue

  const text = readFileSync(file, 'utf8')
  // 去掉注释再查: 注释里写 "#fff 之类的旧值" 不该报错
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

  for (const { re, what } of COLOR_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length
      const snippet = code.split('\n')[line - 1]?.trim() ?? ''
      violations.push({ rel, line, what, snippet })
    }
  }
}

if (violations.length === 0) {
  console.log(`✓ ${files.length} 个 CSS 文件, 无硬编码颜色`)
  process.exit(0)
}

console.error(`✗ ${violations.length} 处硬编码颜色 (必须走 var(--meng-alias-*)):`)
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}  ${v.what}  | ${v.snippet.slice(0, 80)}`)
}
console.error('\n唯一允许定义色值的地方: packages/ui/src/tokens.css')
process.exit(1)
