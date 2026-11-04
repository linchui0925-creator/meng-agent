/**
 * JSON Schema → 控件描述。设置页「内核」分区的第一刀。
 *
 * 吃的是后端 `z.toJSONSchema()` 的产物（draft 2020-12 的子集）—— 纯数据、
 * 可过 WS。前端**不装 zod**: zod 的力气在声明端（写声明 + parse 校验 +
 * 导出），前端只消费导出的结果，前两步都用不上。后端选 zod 而不是
 * schemastery 的理由（后者输出私有信封、会把前端焊死在 vendor 包上）
 * 在这一侧兑现。
 *
 * 这一刀只认四个关键字: string / number(含 integer) / boolean / enum。
 * 认不出的（anyOf / object / 脏输入）**不降级成文本框** —— 把一个
 * 联合类型装成字符串框, 用户会往里粘贴一段 JSON, 那是静默的坑。
 * 返回 'unsupported', 界面画只读行。这与后端「parse 不是函数就当场
 * 报错」是同一条哲学: 认不出就明说, 不蒙混过关。
 *
 * zod 的 `.meta()`（env / description / secret…）会原样混进 schema
 * 顶层, 所以所有字段读取都走白名单, 杂字段自然忽略 —— 不做「有奇怪
 * 字段就报错」的反向防御, 那会让后端加一个 meta 前端就炸一次。
 */

/** 一行配置该画成什么控件。纯数据, 不含渲染 */
export type FieldDesc =
  | { kind: 'text' }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'switch' }
  | { kind: 'select'; options: Array<string | number> }
  | { kind: 'fixed'; value: string | number | boolean }
  | { kind: 'unsupported'; reason: string }

/**
 * schema (unknown, 后端来的) → 控件描述。
 *
 * 判定优先级刻意是: enum > const > type。
 *   · enum 永远优先 —— 带 enum 的 string 是选择题, 不是填空题
 *   · const 是「只有一个选项的选择题」—— z.literal 的输出, 只读展示
 *   · 剩下的才看 type
 */
export function schemaToField(schema: unknown): FieldDesc {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { kind: 'unsupported', reason: 'schema 不是对象' }
  }
  const s = schema as Record<string, unknown>

  if (Array.isArray(s.enum)) {
    const options = s.enum.filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    )
    // enum 里混进对象/null: 选项列表画不出来, 不猜
    return options.length === s.enum.length
      ? { kind: 'select', options }
      : { kind: 'unsupported', reason: 'enum 里有非标量值' }
  }

  if (typeof s.const === 'string' || typeof s.const === 'number' || typeof s.const === 'boolean') {
    return { kind: 'fixed', value: s.const }
  }

  switch (s.type) {
    case 'string':
      return { kind: 'text' }
    case 'boolean':
      return { kind: 'switch' }
    case 'number':
      return { kind: 'number', min: finite(s.minimum), max: finite(s.maximum) }
    case 'integer':
      // zod 的 .int() 出来是 type: "integer"; 数字框给 step:1,
      // 上下键就不会停在 0.5 上
      return { kind: 'number', min: finite(s.minimum), max: finite(s.maximum), step: 1 }
    default:
      return { kind: 'unsupported', reason: `type "${String(s.type)}" 这刀还没接` }
  }
}

/** minimum/maximum 只认有限数字 —— Infinity 进 DOM 属性是另一种静默坑 */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
