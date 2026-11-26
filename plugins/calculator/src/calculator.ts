/**
 * 侧栏「计算器」的算术内核。
 *
 * 为什么单独一个文件: 项目里的规矩是「能测的部分别塞进组件」
 * (见 theme-nav.ts + theme-nav.test.ts)。组件只负责画, 算术规则在这里,
 * 于是「2+2*3 到底等于几」能被一条断言钉住, 不必开浏览器。
 *
 * ── 为什么不用 eval / new Function ──
 * 表达式求值最省事的写法是 `new Function('return ' + expr)()`, 但那等于把
 * 用户输入当代码执行 —— 侧栏常驻, 算出来的结果还会被贴回输入框, 一旦有人
 * 贴进 `fetch('http://evil/')` 之类的表达式, 就是在给自己开一个任意代码执行的口子。
 * 代价只是一台小状态机, 换来的是「这个输入只会被当成算式看」。
 *
 * ── 支持的语法 ──
 *   数字: 12 / 3.5 / .5
 *   运算符: + - * / %   (括号改变优先级)
 *   一元: -3 / +(3) / 负号连用
 *   隐式乘法: 2(3+4) / 3pi —— 不支持, 写了会报错而不是猜
 *   幂: ** —— 不支持, 避免和「乘两次」混淆, 也省掉大数暴算的坑
 *
 * 刻意**不支持**的: 变量、函数调用、科学计数法、百分号后缀、位运算。
 * 这是个计算器, 不是表达式引擎; 每加一个语法糖都得配一条测试。
 */

/**
 * 求值失败时抛这个。
 *
 * `kind` 是这里最要紧的一行: 界面要分清两种失败 ——
 *   - `incomplete` **还没写完**: 「12+」「(1」「2++」。这是输入的中途状态, 不该报警。
 *   - `invalid`   **真的写错了**: 「1/0」「1)」「abc」。这才该给红字。
 *
 * 判据交给解析器, 而不是拿字符串猜 —— 「2++」看起来像错的, 但它是合法算式
 * 「2++3」的前缀, 猜错了会让用户每写一个符号就闪一次红。
 */
export class CalcError extends Error {
  readonly kind: 'incomplete' | 'invalid'

  constructor(message: string, kind: 'incomplete' | 'invalid' = 'invalid') {
    super(message)
    this.name = 'CalcError'
    this.kind = kind
  }
}

type TokenType = 'num' | 'op' | 'lparen' | 'rparen' | 'end'

interface Token {
  type: TokenType
  value: string
}

/**
 * 词法: 字符串 → token 流。
 *
 * 遇到不认识的东西直接抛 —— 这里**不做**「忽略非法字符」, 因为
 * `1 2 + 3` 被忽略成 `12 + 3` 的话, 用户算出来的数是错的却看不出来。
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const ch = input[i] as string

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // 数字: 12 / 3.5 / .5 / 12.34
    if (isDigit(ch) || (ch === '.' && isDigit(input[i + 1] ?? ''))) {
      const start = i
      let seenDot = false
      while (i < input.length) {
        const c = input[i] as string
        if (isDigit(c)) {
          i++
        } else if (c === '.' && !seenDot) {
          seenDot = true
          i++
        } else {
          break
        }
      }
      tokens.push({ type: 'num', value: input.slice(start, i) })
      continue
    }

    // 运算符: 只认单字符
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch })
      i++
      continue
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch })
      i++
      continue
    }

    throw new CalcError(`不认识的符号「${ch}」`)
  }

  tokens.push({ type: 'end', value: '' })
  return tokens
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * 语法 + 求值一起做 —— 递归下降。
 *
 * 优先级 (从低到高): + -  →  * / %  →  一元负号  →  括号 / 数字
 *
 * 为什么用递归下降而不是「先转成后缀再求值」: 表达式只有一层优先级时,
 * 递归下降的代码量和栈深都可控, 而且报错位置能直接指向出错的 token。
 */
export function evaluate(input: string): number {
  const trimmed = input.trim()
  if (trimmed === '') throw new CalcError('算式是空的')

  const tokens = tokenize(trimmed)
  let pos = 0

  /**
   * token 流末尾永远补了一个 'end', 所以正常路径下不会越界。
   * 但解析器递归里 next() 可能被调过头 —— 这里兜一层, 越界就当 end 处理,
   * 免得整屏崩在 "Cannot read properties of undefined"。
   */
  const END_TOKEN: Token = { type: 'end', value: '' }

  const peek = (): Token => tokens[pos] ?? END_TOKEN

  const next = (): Token => tokens[pos++] ?? END_TOKEN

  /** 表达式 := 项 (('+' | '-') 项)* */
  function parseExpression(): number {
    let left = parseTerm()
    for (;;) {
      const t = peek()
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        next()
        const right = parseTerm()
        left = t.value === '+' ? left + right : left - right
      } else {
        return left
      }
    }
  }

  /** 项 := 因子 (('*' | '/' | '%') 因子)* */
  function parseTerm(): number {
    let left = parseFactor()
    for (;;) {
      const t = peek()
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        next()
        const right = parseFactor()
        if (t.value === '*') {
          left *= right
        } else if (t.value === '/') {
          // 除以 0 不给 Infinity: 那是个"看起来像个答案"的东西, 界面会照着显示
          if (right === 0) throw new CalcError('除数不能为 0')
          left /= right
        } else {
          if (right === 0) throw new CalcError('取模的除数不能为 0')
          left %= right
        }
      } else {
        return left
      }
    }
  }

  /** 因子 := ('+' | '-') 因子 | 括号 | 数字 */
  function parseFactor(): number {
    const t = peek()
    if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
      next()
      const v = parseFactor()
      return t.value === '-' ? -v : v
    }
    if (t.type === 'lparen') {
      next()
      const v = parseExpression()
      const close = next()
      if (close.type === 'end') throw new CalcError('括号没关上', 'incomplete')
      if (close.type !== 'rparen') throw new CalcError('括号没关上')
      return v
    }
    if (t.type === 'num') {
      next()
      const n = Number(t.value)
      if (!Number.isFinite(n)) throw new CalcError('数字太大了')
      return n
    }
    // 算到这儿没东西可拿了 —— 用户还在写
    if (t.type === 'end') throw new CalcError('算式还没写完', 'incomplete')
    // 该来操作数的地方来了个二元运算符 (比如 "2+*") —— 还在写, 不是写错
    if (t.type === 'op') throw new CalcError('算式还没写完', 'incomplete')
    throw new CalcError('算式里有不该出现的符号')
  }

  const result = parseExpression()
  const rest = peek()
  if (rest.type !== 'end') {
    if (rest.type === 'rparen') throw new CalcError('括号多了一个')
    if (rest.type === 'num') throw new CalcError('两个数字挨在一起了')
    throw new CalcError('算式还没写完', 'incomplete')
  }
  return result
}

/**
 * 结果怎么显示。
 *
 * 为什么把浮点尾巴剪掉: JS 的 0.1 + 0.2 = 0.30000000000000004,
 * 计算器显示这个用户会以为算错了。剪到 12 位小数, 再把整数值后面的
 * 「.0」去掉 —— 4 要写成 4, 不是 4.0。
 */
export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return '错误'
  if (value === 0) return '0' // -0 也归到 0
  const rounded = Number(value.toPrecision(12))
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1e21) return String(rounded)
  return expandExponential(String(rounded))
}

/**
 * 把 JS 的科学计数法展开成普通小数。
 *
 * 为什么: `String(2.5e-8)` 给的是 "2.5e-8"。计算器里出现这个形态,
 * 用户得自己换算才知道是多少 —— 展开成 "0.000000025" 才是给人看的答案。
 */
function expandExponential(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text)
  if (!match) return text
  const sign = match[1] ?? ''
  const intPart = match[2] ?? ''
  const fracPart = match[3] ?? ''
  const expText = match[4] ?? '0'
  const exponent = Number(expText)
  const digits = intPart + fracPart
  const pointIndex = intPart.length + exponent

  if (pointIndex <= 0) {
    return `${sign}0.${'0'.repeat(-pointIndex)}${digits}`
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointIndex - digits.length)}`
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`
}

/**
 * 输入框该显示什么 —— 每次按键后重算一次。
 *
 * 输入不完整时 (「12+」) 不报错, 只显示空串: 那不是错误, 是还没写完。
 * 只有**语法上真的错了** (比如「1/0」或者「1)」) 才提示。
 *
 * 判断「没写完」靠解析器给的 kind, 不靠字符串猜 —— 见 CalcError 的注释。
 */
export function previewResult(input: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: true, value: '' }
  try {
    return { ok: true, value: formatResult(evaluate(trimmed)) }
  } catch (err) {
    if (err instanceof CalcError && err.kind === 'incomplete') {
      return { ok: true, value: '' }
    }
    const message = err instanceof Error ? err.message : '算式有问题'
    return { ok: false, message }
  }
}
