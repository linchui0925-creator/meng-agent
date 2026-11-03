/**
 * A/B 验证：小模型索引到底值不值。
 *
 * 目的不是实现功能，是**证伪**。做法是把"模型怎么读大材料"抽象成可复现的策略，
 * 用代码量代价：
 *
 *   B 组（现状）  模型自己猜关键词 grep，命中后读第一个命中附近的窗口
 *   C 组（设想）  模型按索引描述选块，读那一块
 *   C' 对照      索引只有标题（描述写得糙），看看质量差多少
 *
 * 量的三件事：读进上下文的字节数 / 步数 / 是否命中答案所在块。
 *
 * 用法:
 *   ... ab-index.ts chunks <file>                    看分块
 *   ... ab-index.ts locate <file> <case.json>        打印每个问题关键词的命中行，用来定答案位置
 *   ... ab-index.ts run <file> <case.json>           跑三组对照
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readable } from '@meng/net'

/** 单块上限: 超过就按行硬切。按结构切之后仍可能有超长章节 */
const MAX_LINES = 240

interface Chunk {
  no: number
  from: number
  to: number
  /** 文档自己的标题（有就用，没有就用指纹） */
  title: string
  text: string
}

function toText(file: string): string {
  const raw = readFileSync(file, 'utf8')
  return file.endsWith('.html') ? readable(raw) : raw
}

/**
 * 分块按**文档自己的结构**：遇到 markdown 标题就开新块。
 * 比固定行数聪明的地方 —— 块边界和作者的意思一致，模型看标题就知道这块讲什么，
 * 而且标题是代码从原文读的，不是模型编的（位置和标题都不用模型负责）。
 */
function chunk(lines: string[]): Chunk[] {
  const out: Chunk[] = []
  let start = 0
  const push = (from: number, to: number): void => {
    if (to <= from) return
    const text = lines.slice(from, to).join('\n')
    if (!text.trim()) return
    const head = lines
      .slice(from, Math.min(from + 6, to))
      .map((l) => l.trim())
      .find((l) => l.startsWith('#'))
    out.push({
      no: out.length + 1,
      from: from + 1,
      to,
      title: head ? head.replace(/^#+\s*/, '') : fingerprint(text),
      text,
    })
  }

  for (let i = 1; i < lines.length; i++) {
    // Node 文档的 API 条目住在 h5 上（##### filehandle.read(...)），不是 h3。
    // 任意级别标题都当块边界, 再用"至少 12 行"挡住过碎的分割。
    const isHeading = /^#{1,6}\s/.test(lines[i] ?? '')
    const tooLong = i - start >= MAX_LINES
    if ((isHeading && i - start >= 12) || tooLong) {
      push(start, i)
      start = i
    }
  }
  push(start, lines.length)
  return out
}

function fingerprint(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 4)
  return (line ?? '').slice(0, 48)
}

function utf8(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

let cached: { file: string; lines: string[] } | null = null
function linesOf(file: string): string[] {
  if (cached?.file === file) return cached.lines
  cached = { file, lines: toText(file).split('\n') }
  return cached.lines
}

function printChunks(file: string): void {
  const lines = linesOf(file)
  writeFileSync(`${file}.txt`, lines.join('\n'))
  const chunks = chunk(lines)
  console.log(`纯文本 ${utf8(lines.join('\n'))} 字节 / ${lines.length} 行 → ${chunks.length} 块`)
  console.log('')
  for (const c of chunks) {
    console.log(`[${String(c.no).padStart(2)}] ${String(c.from).padStart(5)}-${String(c.to).padStart(5)} · ${String(utf8(c.text)).padStart(6)}B · ${c.title.slice(0, 60)}`)
  }
}

interface Question {
  id: string
  ask: string
  /** 模型会先试的关键词（按顺序，模拟"猜"） */
  keywords: string[]
  /** 脚本用来定位答案行: 第 practice 次出现处（1-based），避开前面的目录 */
  answerProbe: string
  practice?: number
  /** 定好之后填: 答案行区间 */
  answerFrom?: number
  answerTo?: number
}

interface IndexEntry {
  no: number
  /** 小模型写的一句话: 这块"含什么可以问" */
  desc: string
}

interface Case {
  note?: string
  /** 命中后往回/往前各读多少行 */
  window?: number
  questions: Question[]
  /** C 组: 带描述的索引 */
  index: IndexEntry[]
}

function locate(file: string, caseFile: string): void {
  const lines = linesOf(file)
  const c: Case = JSON.parse(readFileSync(caseFile, 'utf8'))
  for (const q of c.questions) {
    const hits: number[] = []
    lines.forEach((l, i) => {
      if (l.includes(q.answerProbe)) hits.push(i + 1)
    })
    const n = q.practice ?? 1
    const pick = hits[n - 1]
    console.log(
      `${q.id}: "${q.answerProbe}" 命中 ${hits.length} 处 · 第 ${n} 处 = 行 ${pick ?? '无'} · 前 5 处: ${hits.slice(0, 5).join(', ')}`,
    )
  }
}

function run(file: string, caseFile: string): void {
  const lines = linesOf(file)
  const total = utf8(lines.join('\n'))
  const c: Case = JSON.parse(readFileSync(caseFile, 'utf8'))
  const chunks = chunk(lines)
  const win = c.window ?? 15

  // 索引本身的成本: 模型必须先读它
  const descOf = (no: number): string => c.index.find((e) => e.no === no)?.desc ?? ''
  const goodIndex = chunks
    .map((ch) => `[${ch.no}] ${ch.from}-${ch.to} ${ch.title} — ${descOf(ch.no)}`)
    .join('\n')
  const bareIndex = chunks.map((ch) => `[${ch.no}] ${ch.from}-${ch.to}`).join('\n')

  const rows: string[] = []
  const sum = { b: 0, c: 0, c2: 0, bSteps: 0, cSteps: 0, c2Steps: 0, bHit: 0, cHit: 0, c2Hit: 0, cTop3: 0 }
  // 索引只在第一次读这份材料时付一次钱, 之后同一份材料再用到就是白赚
  let indexCharged = false

  for (const q of c.questions) {
    const from = q.answerFrom ?? 0
    const to = q.answerTo ?? 0

    // ── B: 猜关键词 → grep → 读命中附近的窗口 ──
    // 公平起见给 B 组"会跳"的能力: 模型读到导航列表会发现不对, 继续往下找。
    // 最多试 3 个命中位置 —— 这是真实模型会做的事, 不是故意让它瞎。
    let bNote = '未命中→读全文'
    let bUsed = 0
    let bHit = false
    for (const kw of q.keywords) {
      sum.bSteps++
      const hits: number[] = []
      lines.forEach((l, i) => {
        if (l.toLowerCase().includes(kw.toLowerCase())) hits.push(i + 1)
      })
      if (!hits.length) {
        bUsed += utf8(kw) + 120
        continue
      }
      const shown = hits.slice(0, 20)
      bUsed += utf8(shown.join('\n')) + utf8(kw)
      for (const h of shown.slice(0, 10)) {
        const wf = Math.max(1, h - win)
        const wt = Math.min(lines.length, h + win)
        sum.bSteps++
        bUsed += utf8(lines.slice(wf - 1, wt).join('\n'))
        bNote = `${kw}→跳到行${h}`
        if (h >= from && h <= to) {
          bHit = true
          break
        }
      }
      if (bHit) break
    }
    if (!bHit) bUsed += total // 没命中 → 退化成整篇读
    sum.b += bUsed
    if (bHit) sum.bHit++

    // ── C / C': 按索引选块 ──
    const ranked = rank(chunks, c, q, 1)
    const pickGood = ranked[0]
    const pickBare = rank(chunks, c, q, 0)[0]
    const cUsed = (indexCharged ? 0 : utf8(goodIndex)) + (pickGood ? utf8(pickGood.text) : 0)
    const c2Used = (indexCharged ? 0 : utf8(bareIndex)) + (pickBare ? utf8(pickBare.text) : 0)
    indexCharged = true
    sum.cSteps += pickGood ? 1 : 0
    sum.c2Steps += pickBare ? 1 : 0
    const cHit = covers(pickGood, q)
    const c2Hit = covers(pickBare, q)
    if (ranked.slice(0, 3).some((ch) => covers(ch, q))) sum.cTop3++
    sum.c += cUsed
    sum.c2 += c2Used
    if (cHit) sum.cHit++
    if (c2Hit) sum.c2Hit++

    rows.push(
      `${q.id.padEnd(4)} | B ${bHit ? '命中' : '错过'} ${String(bUsed).padStart(7)}B ${bNote.slice(0, 26).padEnd(28)} | C ${cHit ? '命中' : '错过'} #${pickGood?.no ?? '-'} ${String(cUsed).padStart(7)}B | C' ${c2Hit ? '命中' : '错过'} #${pickBare?.no ?? '-'}`,
    )
  }

  console.log(`材料 ${total} 字节 / ${lines.length} 行 / ${chunks.length} 块`)
  console.log(`好索引 ${utf8(goodIndex)} 字节 · 裸索引(只有标题) ${utf8(bareIndex)} 字节`)
  console.log('')
  for (const r of rows) console.log(r)
  console.log('')
  const n = c.questions.length
  console.log('        总上下文      步数   命中')
  console.log(`B  现状 ${String(sum.b).padStart(10)}B ${String(sum.bSteps).padStart(5)}   ${sum.bHit}/${n}`)
  console.log(`C  索引 ${String(sum.c).padStart(10)}B ${String(sum.cSteps).padStart(5)}   ${sum.cHit}/${n}   （前 3 候选里有 ${sum.cTop3}/${n}）`)
  console.log(`C' 裸标 ${String(sum.c2).padStart(10)}B ${String(sum.c2Steps).padStart(5)}   ${sum.c2Hit}/${n}`)
  console.log('')
  console.log(`C  / B = ${(sum.c / sum.b).toFixed(2)}×   C' / B = ${(sum.c2 / sum.b).toFixed(2)}×   （<1 才是省）`)

  // 索引成本只在第一次读这份材料时付, 之后摊销。盈亏平衡点在这里。
  const bAvg = sum.b / n
  const cAvg = (sum.c - utf8(goodIndex)) / n
  const indexCost = utf8(goodIndex)
  const gap = bAvg - cAvg
  console.log('')
  console.log(`B 每问 ${Math.round(bAvg)}B · C 每问读块 ${Math.round(cAvg)}B · 索引一次性 ${indexCost}B`)
  if (gap <= 0) {
    console.log('→ 索引不可能省: 每问省下的还不够付索引本身')
  } else {
    console.log(
      `→ 同一份材料问 ${(indexCost / gap).toFixed(1)} 次以上, 索引才开始划算（本组问了 ${n} 次）`,
    )
  }
}

/**
 * 模拟"模型按索引选块"：给所有块打分排序。
 *
 * level 0 = 索引里没有语义信息（只有行号）, 模型无从选起
 * level 1 = 索引里有文档自己的标题（代码从原文读的, 不花模型一分钱）
 * level 2 = 标题 + 小模型写的一句话
 *
 * 打分规则贴近"中规中矩的模型": 关键词出现在标题开头（= 就是这个名字）权重最高,
 * 出现在后段（= 只是顺带提到）权重低。并列时块更小的优先 —— 更精确。
 */
function rank(chunks: Chunk[], c: Case, q: Question, level: 0 | 1 | 2): Chunk[] {
  if (level === 0) return []
  const scored: Array<{ ch: Chunk; score: number }> = []
  for (const ch of chunks) {
    const desc = level === 2 ? (c.index.find((e) => e.no === ch.no)?.desc ?? '') : ''
    const head = ch.title.toLowerCase()
    const tail = desc.toLowerCase()
    let score = 0
    for (const kw of q.keywords) {
      const k = kw.toLowerCase()
      const at = head.indexOf(k)
      // 只在标题开头出现才算"就是这个名字"。`fs.readFile(` 也会命中
      // `fsPromises.readFile(`（位置 11），那只是长得像, 不是同一个 API
      if (at >= 0) score += at <= 5 ? 10 : 2
      if (tail.includes(k)) score += 4
    }
    if (score > 0) scored.push({ ch, score })
  }
  scored.sort((a, b) => b.score - a.score || a.ch.from - b.ch.from)
  return scored.map((s) => s.ch)
}

function covers(ch: Chunk | undefined, q: Question): boolean {
  if (!ch) return false
  const from = q.answerFrom ?? 0
  const to = q.answerTo ?? 0
  return ch.from <= to && ch.to >= from
}

const [mode, file, caseFile] = process.argv.slice(2)
if (!mode || !file) {
  console.error('用法: ab-index.ts chunks <file> | locate <file> <case.json> | run <file> <case.json>')
  process.exit(1)
}
if (mode === 'chunks') printChunks(file)
else if (mode === 'locate') locate(file, caseFile ?? '')
else if (mode === 'run') run(file, caseFile ?? '')
else {
  console.error(`未知模式: ${mode}`)
  process.exit(1)
}
