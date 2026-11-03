/**
 * 错误基类: 带一个稳定的机器码。
 *
 * 存在理由 (对位 dsh 的 HarnessError, 也修我们自己的坑):
 * provider-openai 以前是 `throw new Error(\`provider 返回 ${status}: ...\`)` ——
 * HTTP 状态被拼进人类可读的字符串里。结果是重试策略没法路由、UI 没法分类、
 * 日志只能靠正则去猜。状态码是**事实**, 不是文案。
 *
 * 规矩: 路由**永远**看 `code`, 不许解析 `message`。
 * 文案随便改, code 一旦发布就不动。
 */

export class MengError extends Error {
  /** 稳定机器码。跨包共享一套词表, 各包自己加前缀避免撞车 */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** 把任意 throw 出来的东西规整成 { message, code }, 落事件流/回显时用 */
export function errorFacts(err: unknown): { message: string; code: string } {
  if (err instanceof MengError) return { message: err.message, code: err.code }
  const message = err instanceof Error ? err.message : String(err)
  return { message, code: 'UNKNOWN' }
}
