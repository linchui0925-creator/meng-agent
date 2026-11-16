/**
 * 密钥分区的纯逻辑：**从 `llm.catalog` 里把"哪家有钥匙"合成出来**。
 *
 * ── 为什么这一页读 catalog 而不是 config.list ──
 * 两家供应商的密钥**形状不一样**, 而只有 adapter 自己知道区别:
 *
 *   · `deepseek`  扁平 —— `llm.deepseek.apiKey` 是一条 secret 项, 变量名在 `secretRef`,
 *                 有没有值在 `present`。`config.list` 里能直接捞到。
 *   · `openai` 那族 路由字典 —— 整个 scope 只有 `llm.openai.routes` 一条 (object),
 *                 密钥**不是一项配置**, 而是字典里每条 profile 的 `apiKeyEnv` 字段。
 *                 `config.list` 里根本没有"zai 的密钥"这一行, 更没有 present。
 *
 * 所以"每家一行"这个界面上的事实, 在后端是两种存法。硬从 `config.list` 拼,
 * 路由型的家会整段消失。`llm.catalog` 恰好是唯一一份**按 provider 归好组**的数据:
 * 每家的 `config` + `missing` 都在里面。
 *
 * ── `present` 为什么对路由型是"读后端说的话" ──
 * 后端没有给路由型下发 present。它给的是 `missing`, 而 `provider-openai` 的
 * `missingOf()` 里那条文案是写死的:
 *
 *     `环境变量 ${profile.apiKeyEnv} 里没有值`
 *
 * 于是判据是「后端有没有点名这个变量」—— 读的是**它已经说了什么**, 不是猜格式。
 * 一旦后端按 HANDOFF §1.8 补上 `present` / `envName`, 这个函数换成直读就行,
 * 界面一行都不用改。**这是全文件唯一一处"绕"**, 所以单独写在 `presentOf()` 里。
 */

/** 这一页真正读的配置项形状。不从别的分区借类型 —— 各自声明自己用到的字段 */
export interface KeyEntry {
  key: string
  type: string
  secret: boolean
  secretRef?: string
  present?: boolean
  /** 组合值（路由字典）。类型是 unknown, 用之前必须收窄 */
  value?: unknown
}

/** 一家供应商在这一页需要的最小信息 */
export interface KeyProvider {
  id: string
  name: string
  available: boolean
  dormant?: boolean
  declared?: boolean
  configScope?: string
  config: KeyEntry[]
  missing: string[]
}

/**
 * 变量里到底有没有值。
 *   yes     —— 有（这家能发请求）
 *   no      —— 没有（后端点名了这个变量）
 *   unknown —— 后端没提密钥的事, 但提了别的问题（缺模型 / 缺地址）。
 *              画成"没有值"会冤枉用户, 画成"有值"会让他以为能用了
 */
export type KeyPresence = 'yes' | 'no' | 'unknown'

/** 往哪儿写。两种形状各一条路, 前端必须知道自己是哪条 */
export type KeyTarget =
  /** 扁平: 一个字段就是变量名 */
  | { kind: 'single'; key: string }
  /** 路由字典: 读整张 -> 改这一条 -> 整张写回 */
  | { kind: 'dict'; key: string; id: string; dict: Record<string, unknown> }

export interface KeyRow {
  id: string
  name: string
  /** 绑定的环境变量名。空串 = 这家声明里没有密钥字段 */
  envName: string
  present: KeyPresence
  /** 用户自己加的（不在内置目录里） */
  declared: boolean
  /** 后端原话里**跟密钥无关**的那些（"这条路由没有任何模型"之类） */
  notes: string[]
  target: KeyTarget
}

/**
 * 模型分区里被藏掉的那些, 这一页也不出现。
 *
 * `openai` 是**默认路由**, 不是可选品牌: 它在设置页里露出来, 用户会以为
 * "这是我要配的一家", 而实际上是内核的兜底。两边必须用同一份判据,
 * 否则会出现"模型页里没有、密钥页里冒出来"的鬼。
 */
export const HIDDEN_IDS: readonly string[] = ['openai']

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 路由型那一条的 present。见文件头对"绕"的说明。
 *
 * `missing` 里只要有一条点了这个变量名, 就说明它没值 —— 这是**后端已经
 * 说过的话**, 不是前端在解析格式。反过来: 一条都没点, 且没有别的抱怨,
 * 那它就有值。
 */
function presentOf(missing: readonly string[], envName: string): KeyPresence {
  if (envName !== '' && missing.some((m) => m.includes(envName))) return 'no'
  return missing.length === 0 ? 'yes' : 'unknown'
}

/** 把一条 `missing` 从 notes 里剔掉: 它已经被画成状态点了, 再显示一遍就是复读 */
function notesOf(missing: readonly string[], envName: string): string[] {
  return missing.filter((m) => !(envName !== '' && m.includes(envName)))
}

/**
 * 一家供应商 → 一行。返回 `undefined` 表示这一页不该画它。
 *
 * 三种不画的情况各有理由:
 *   · `dormant`  —— 还没添加进配置。密钥页不是引导页, 去模型分区加
 *   · 没有 configScope —— 没有可配的东西（mock 这类）
 *   · 拿不到变量名 —— 声明里就没有密钥字段（不该发生, 但静默画一个空输入框更糟）
 */
export function keyRowOf(p: KeyProvider, hidden: readonly string[] = HIDDEN_IDS): KeyRow | undefined {
  if (hidden.includes(p.id)) return undefined
  if (p.dormant) return undefined
  if (!p.configScope) return undefined

  // ① 扁平型: 配置里有一条 secret 项
  const secret = p.config.find((e) => e.secret)
  if (secret) {
    const envName = secret.secretRef ?? ''
    return {
      id: p.id,
      name: p.name,
      envName,
      // present 缺失时按"没报告"处理, **不猜 true** —— 猜 true 会让用户
      // 以为配好了, 然后第一句话就失败
      present: secret.present === true ? 'yes' : secret.present === false ? 'no' : 'unknown',
      declared: p.declared === true,
      notes: notesOf(p.missing, envName),
      target: { kind: 'single', key: secret.key },
    }
  }

  // ② 路由字典型: 密钥在这一条 profile 里
  const holder = p.config.find((e) => isDict(e.value))
  if (!holder || !isDict(holder.value)) return undefined
  const profile = holder.value[p.id]
  if (!isDict(profile)) return undefined
  const envName = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : ''
  if (envName === '') return undefined

  return {
    id: p.id,
    name: p.name,
    envName,
    present: presentOf(p.missing, envName),
    declared: p.declared === true,
    notes: notesOf(p.missing, envName),
    target: { kind: 'dict', key: holder.key, id: p.id, dict: holder.value },
  }
}

/** 全部行, 保持后端给的顺序（活着的在前） —— 排序会让供应商每次启动换位置 */
export function keyRowsOf(providers: readonly KeyProvider[], hidden: readonly string[] = HIDDEN_IDS): KeyRow[] {
  const out: KeyRow[] = []
  for (const p of providers) {
    const row = keyRowOf(p, hidden)
    if (row) out.push(row)
  }
  return out
}

/**
 * 分段：内置供应商 / 自定义 API。和模型分区一条判据（`declared`）。
 *
 * **不按"有没有 key"分段** —— 那是同一家的两种处境, 升级成一级结构会让
 * "这家到底是哪来的"看不出来, 而用户来这一页第一眼要判断的就是这个。
 */
export function splitRows(rows: readonly KeyRow[]): { vendors: KeyRow[]; customs: KeyRow[] } {
  return {
    vendors: rows.filter((r) => !r.declared),
    customs: rows.filter((r) => r.declared),
  }
}

/**
 * 写入用的一步。`config.set` 只接受**整张字典**, 所以路由型要先摊开再合回去。
 *
 * 为什么在这里算而不是在组件里: 「改一条 = 写整张」这个事实很容易写错一次
 * （漏掉其它路由 = 一次保存删掉别的供应商）, 写错了界面还会报"保存成功"。
 * 放在纯函数里, 单测能钉住"其它路由一条都没丢"。
 */
export function writeOf(row: KeyRow, envName: string): { key: string; value: unknown } {
  if (row.target.kind === 'single') return { key: row.target.key, value: envName }

  const { key, id, dict } = row.target
  const current = dict[id]
  // profile 不是对象（被手工改坏 / 后端换了形状）时**不覆盖**, 直接抛：
  // 覆盖成 `{ apiKeyEnv }` 会把地址和模型一起抹掉
  if (!isDict(current)) throw new Error(`${id} 的配置不是一个对象，不能只改变量名`)
  return { key, value: { ...dict, [id]: { ...current, apiKeyEnv: envName } } }
}

/**
 * 变量名不能是空串, 也不能带空格/等号 —— 它会被当成 `process.env` 的键。
 * 只做"明显不对"的即时提示, 真正的校验仍以后端 `parse()` 抛的错为准。
 */
export function envNameError(envName: string): string | undefined {
  const v = envName.trim()
  if (v === '') return '变量名不能是空的'
  if (/\s/.test(v)) return '变量名里不能有空格'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return '只能用字母、数字和下划线，且不能以数字开头'
  return undefined
}

/** 行首那个字母章。中文名取首字 —— 和模型分区同一套视觉语言 */
export function stampOf(name: string): string {
  return ([...name.trim()][0] ?? '?').toUpperCase()
}

export const PRESENCE_TEXT: Record<KeyPresence, string> = {
  yes: '已绑定',
  no: '变量是空的',
  unknown: '状态未知',
}
