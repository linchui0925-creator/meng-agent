/**
 * 一个**够用就停**的 Markdown 解析器。只做块级 + 行内的那一小撮, 不做完整实现。
 *
 * 为什么自己写而不是装 `marked` / `remark`:
 *   · 这个仓库除了 React 零第三方依赖, 装一个 parser 就带进来一棵 AST 生态;
 *   · 更重要的是**安全**: 现成的库多数给 HTML 字符串, 得再配一个 sanitizer 才敢用。
 *     这里产出的是**数据**（`Block[]` / `Inline[]`）, 由 React 渲染成元素 ——
 *     结构上就没有 `dangerouslySetInnerHTML`, 也就不存在"漏了一个转义"这回事。
 *
 * 覆盖: 围栏代码块 / 行内代码 / 粗体 / 斜体 / 标题 / 无序列表 / 有序列表 / 引用 /
 * 分隔线 / 链接 / 硬换行。**不做**: 表格、嵌套列表、图片、脚注、HTML 内联。
 * 不做不是偷懒 —— 模型输出里出现表格的概率远低于"列表和代码块", 而每多支持一种
 * 语法, 就多一处"流式输出到一半时闪一下"的机会。
 *
 * ── 流式输出是这里的头号约束 ──
 * 消息是一块一块来的, 所以:
 *   · **没闭合的 ``` 也要当成代码块**（否则用户会先看到一屏裸反引号, 再突然变整齐）;
 *   · 没闭合的 `**` 就按字面显示（等到闭合那一刻再变粗体, 而不是先吞掉字符）。
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'br' }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; inline: Inline[] }
  | { kind: 'em'; inline: Inline[] }
  | { kind: 'link'; href: string; inline: Inline[] }

export type TableAlign = 'left' | 'right' | 'center'

export type Block =
  | { kind: 'code'; lang?: string; text: string }
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: Array<TableAlign | undefined> }
  | { kind: 'quote'; inline: Inline[] }
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'hr' }

/**
 * 链接只放三种协议。
 *
 * `javascript:` / `data:` 一律当成普通文字 —— 这条不是洁癖: 模型是被内容影响的,
 * 而一条 `[点我](javascript:…)` 在聊天里点下去就是一次任意脚本执行。
 * 宁可显示成一串看不懂的原文, 也不要一个能点的陷阱。
 */
function safeHref(raw: string): string | undefined {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url
  return undefined
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?/
const UL = /^(\s*)[-*+]\s+(.*)$/
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/

/** 拆表格行：外框竖线不产生空单元格，代码与反斜杠里的竖线不拆列。 */
function splitTableRow(line: string): string[] {
  const text = line.trim()
  if (!text.includes('|')) return []
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      cell += ch + text[i + 1]!
      i++
      continue
    }
    if (ch === '`') {
      inCode = !inCode
      cell += ch
      continue
    }
    if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  if (text.startsWith('|')) cells.shift()
  if (text.endsWith('|') && cells.at(-1) === '') cells.pop()
  return cells
}

function tableAlignments(line: string | undefined): Array<TableAlign | undefined> | undefined {
  if (line === undefined) return
  const cells = splitTableRow(line)
  if (cells.length === 0) return
  const align: Array<TableAlign | undefined> = []
  for (const cell of cells) {
    const m = /^(:?)-{3,}(:?)$/.exec(cell)
    if (m === null) return
    align.push(m[1] !== '' && m[2] !== '' ? 'center' : m[2] !== '' ? 'right' : m[1] !== '' ? 'left' : undefined)
  }
  return align
}

/**
 * 表格只在“表头下一行就是合法分隔行”时成立。
 * 流式输出还没写到分隔行时先按普通段落显示，避免半张表先闪一下。
 */
function tableAt(lines: readonly string[], index: number): { block: Block; next: number } | undefined {
  const headerLine = lines[index]
  if (headerLine === undefined || !headerLine.includes('|')) return
  const align = tableAlignments(lines[index + 1])
  if (align === undefined) return
  const header = splitTableRow(headerLine)
  if (header.length === 0 || header.length !== align.length) return

  const rows: Inline[][][] = []
  let next = index + 2
  while (next < lines.length) {
    const line = lines[next]!
    if (line.trim() === '' || !line.includes('|')) break
    const cells = splitTableRow(line)
    if (cells.length === 0) break
    rows.push(header.map((_, i) => parseInline((cells[i] ?? '').trim())))
    next++
  }
  return {
    block: { kind: 'table', header: header.map((cell) => parseInline(cell)), rows, align },
    next,
  }
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const line = lines[index]!
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line)
    || tableAt(lines, index) !== undefined
  )
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // ── 围栏代码块 ──
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[2]!
      const lang = fence[3]!.trim()
      i++
      const body: string[] = []
      while (i < lines.length) {
        const cur = lines[i]!
        // 闭合行: 同一种符号、长度不短于开头（``` 能闭合 ```` 不行）
        if (cur.trim().startsWith(mark)) {
          i++
          break
        }
        body.push(cur)
        i++
      }
      // 没闭合 = 还在流式输出。**照样画成代码块**（见文件头）
      out.push({ kind: 'code', ...(lang === '' ? {} : { lang }), text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    if (HR.test(line)) {
      out.push({ kind: 'hr' })
      i++
      continue
    }

    const table = tableAt(lines, i)
    if (table !== undefined) {
      out.push(table.block)
      i = table.next
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, inline: parseInline(heading[2]!.trim()) })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(QUOTE, ''))
        i++
      }
      out.push({ kind: 'quote', inline: parseInline(body.join('\n')) })
      continue
    }

    const ol = OL.exec(line)
    if (ol) {
      const items: Inline[][] = []
      while (i < lines.length) {
        const cur = lines[i]!
        const m = OL.exec(cur)
        if (m) {
          items.push(parseInline(m[3]!.trim()))
          i++
          continue
        }
        // 续行（缩进 ≥2 空格）并进上一条 —— 模型写的长条目经常折行
        if (cur.trim() !== '' && /^\s{2,}/.test(cur) && items.length > 0) {
          items[items.length - 1] = [...items[items.length - 1]!, { kind: 'br' }, ...parseInline(cur.trim())]
          i++
          continue
        }
        break
      }
      out.push({ kind: 'list', ordered: true, start: Number(ol[2]), items })
      continue
    }

    const ul = UL.exec(line)
    if (ul) {
      const items: Inline[][] = []
      while (i < lines.length) {
        const cur = lines[i]!
        const m = UL.exec(cur)
        if (m) {
          items.push(parseInline(m[2]!.trim()))
          i++
          continue
        }
        if (cur.trim() !== '' && /^\s{2,}/.test(cur) && items.length > 0) {
          items[items.length - 1] = [...items[items.length - 1]!, { kind: 'br' }, ...parseInline(cur.trim())]
          i++
          continue
        }
        break
      }
      out.push({ kind: 'list', ordered: false, start: 1, items })
      continue
    }

    // ── 段落: 一直吃到空行或下一个块的开头 ──
    const body: string[] = []
    while (i < lines.length) {
      const cur = lines[i]!
      if (cur.trim() === '' || isBlockStart(lines, i)) break
      body.push(cur)
      i++
    }
    if (body.length === 0) {
      // 理论上到不了这里（上面每种块开头都 continue 了）。真到了就吞掉这一行,
      // 绝不能让 i 原地不动 —— 那会死循环, 表现是整页卡死
      i++
      continue
    }
    out.push({ kind: 'para', inline: parseInline(body.join('\n')) })
  }

  return out
}


 /** 裸链接：只认 http(s) / mailto，并剥掉句中不属于 URL 的尾标点。 */
function autolinkAt(text: string, start: number): { href: string; label: string; length: number } | undefined {
  const match = /^(?:https?:\/\/|mailto:)[^\s<>"'\u3000]+/i.exec(text.slice(start))
  if (match === null) return
  let raw = match[0]
  // 句末标点不属于链接
  while (/[.,!?;:，。！？；：、]$/.test(raw)) raw = raw.slice(0, -1)
  // URL 里配对成功的右括号保留；不配对的右括号剥掉
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -1)
  }
  // 中文/英文的成对收尾标点，出现在链接末尾时一律不吞
  raw = raw.replace(/[）】》」』]+$/u, '')
  const href = safeHref(raw)
  return href === undefined ? undefined : { href, label: raw, length: raw.length }
}

/** 用户纯文本只用 autolink，不解释 Markdown；助手侧 parseInline 复用同一识别器。 */
export function linkifyText(text: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      out.push({ kind: 'text', text: buf })
      buf = ''
    }
  }
  let i = 0
  while (i < text.length) {
    if (text[i] === '\n') {
      flush()
      out.push({ kind: 'br' })
      i++
      continue
    }
    const link = autolinkAt(text, i)
    if (link !== undefined) {
      flush()
      out.push({ kind: 'link', href: link.href, inline: [{ kind: 'text', text: link.label }] })
      i += link.length
      continue
    }
    buf += text[i]
    i++
  }
  flush()
  return out
}

/**
 * 行内解析。一个字符一个字符往前走 —— 因为要处理"没闭合就不当标记"这种情况,
 * 用正则一次性替换是做不到的（它不知道后面还有没有闭合）。
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      out.push({ kind: 'text', text: buf })
      buf = ''
    }
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    // 反斜杠转义: `\*` 就是星号本身
    if (ch === '\\' && i + 1 < text.length) {
      buf += text[i + 1]!
      i += 2
      continue
    }

    if (ch === '\n') {
      flush()
      out.push({ kind: 'br' })
      i++
      continue
    }

    if (ch === '`') {
      const ticks = /^`+/.exec(text.slice(i))![0]
      const close = text.indexOf(ticks, i + ticks.length)
      if (close !== -1) {
        flush()
        out.push({ kind: 'code', text: text.slice(i + ticks.length, close) })
        i = close + ticks.length
        continue
      }
      // 没闭合（流式中途）→ 按字面
      buf += ticks
      i += ticks.length
      continue
    }

    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const mark = text.slice(i, i + 2)
      const close = text.indexOf(mark, i + 2)
      // 两侧都不许紧贴空白: 否则 `2 * 3 * 4` 里的星号会被当成强调
      if (close !== -1 && close > i + 2 && !/\s/.test(text[i + 2]!) && !/\s/.test(text[close - 1]!)) {
        flush()
        out.push({ kind: 'strong', inline: parseInline(text.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      const close = text.indexOf(ch, i + 1)
      if (close !== -1 && close > i + 1 && !/\s/.test(text[i + 1]!) && !/\s/.test(text[close - 1]!)) {
        flush()
        out.push({ kind: 'em', inline: parseInline(text.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }

    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i))
      const href = m === null ? undefined : safeHref(m[2]!)
      if (m !== null && href !== undefined) {
        flush()
        out.push({ kind: 'link', href, inline: parseInline(m[1]!) })
        i += m[0].length
        continue
      }
    }

    const link = autolinkAt(text, i)
    if (link !== undefined) {
      flush()
      out.push({ kind: 'link', href: link.href, inline: [{ kind: 'text', text: link.label }] })
      i += link.length
      continue
    }

    buf += ch
    i++
  }

  flush()
  return out
}

/** 行内元素拼回纯文本。导出、复制、`title` 属性都要用它 */
export function plainTextOf(inline: Inline[]): string {
  let s = ''
  for (const n of inline) {
    if (n.kind === 'text' || n.kind === 'code') s += n.text
    else if (n.kind === 'br') s += '\n'
    else if (n.kind === 'link') s += plainTextOf(n.inline)
    else s += plainTextOf(n.inline)
  }
  return s
}
