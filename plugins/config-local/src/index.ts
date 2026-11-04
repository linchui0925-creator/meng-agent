/**
 * @meng/plugin-config-local —— 配置能力面的本地实现。
 *
 * ## 取值顺序
 *
 *   settings (界面上改的)  >  env (进程环境)  >  default (声明里)
 *
 * 选"界面优先"是刻意的: 用户在界面上动手了, 却因为环境变量里有个更早的残留
 * 而不生效 —— 这类投诉最难查, 也最伤信任。代价是 CI/Docker 里设的 env 会被
 * 已存的界面值盖住; 所以 `sourceOf()` 必须能回答"这值从哪来的", 那是排查
 * 这类问题的唯一入口。
 *
 * ## 密钥: settings 里存的是**环境变量名**, 不是值
 *
 * settings.json 里写的是:
 *     "llm.deepseek.key": "DEEPSEEK_API_KEY"
 * 值是运行时从 `process.env[DEEPSEEK_API_KEY]` 读的, 从不落盘。
 *
 * 好处: settings.json 可以进备份、进 git、进截图都不出事 ——
 * 而"用户能在界面上管密钥"这件事又真的做到了。
 * 代价: **换密钥要重启进程**。env 是进程启动时读入的, 运行中的进程看不到
 * 新的 env。这是安全换来的代价, 写在文档里, 不藏着。
 *
 * ## 两种声明写法, 一条处理路径
 *
 * 扁平声明 (`{ type: 'number' }`) 在这里被 `plainToZod()` 转成 zod schema,
 * 之后取值 / 校验 / 序列化只看 schema。所以两种写法不会有两套行为 ——
 * 这是"能给老的四十五个键一行不改地接上 zod"的前提。
 *
 * ## manifest 层
 *
 * 清单里的 `config:` 值走的是插件 `apply(ctx, config)` 参数, 不走这一层。
 * 原因: 那份配置是**单个插件私有**的, 它不需要跨插件共享, 也就没有
 * "被谁盖过"的问题。这一层留空, 等真有插件需要"清单值可被界面覆盖"再接 ——
 * 现在接就是死代码。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as z from 'zod'
import {
  CONFIG_CODE,
  ConfigError,
  KERNEL_CONFIG,
  envNameOf,
  provideConfig,
  type ConfigDecl,
  type ConfigEntry,
  type ConfigScope,
  type ConfigService,
  type ConfigSource,
  type ConfigType,
  type ConfigWriteResult,
} from '@meng/config'
import type { Ctx, Disposer } from '@meng/core'
import { defineInvariant } from '@meng/core'

/**
 * 把线上来的原始值转成 schema 期望的形状。
 *
 * 为什么必须做这一步: **env 里一切都是字符串**。不做转换, `MENG_PORT=4721`
 * 会被 `z.number()` 直接拒掉 —— 那不是配置错了, 是运输层只有字符串。
 * 同理 YAML 会把 `4721` 解析成 number, 而配置项是 string。
 *
 * 只按 schema 的顶层类型转, 不做递归: 组合配置 (object/array) 在 env 里
 * 应该是 JSON 字符串, 那不是"类型转换"而是"反序列化", 属于另一件事。
 * 现在没有这种配置项, 有的话在声明里用 `z.string().transform(JSON.parse)` 表达,
 * 语义更清楚。
 */
function shapeForWire(json: Record<string, unknown>, raw: unknown): unknown {
  const t = json['type']

  if (t === 'string') {
    // 数字/布尔也该能当字符串用: 用户把端口写成 4721, YAML 会解析成 number
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    return raw
  }
  if (t === 'number' || t === 'integer') {
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw)
      if (Number.isFinite(n)) return n
    }
    return raw
  }
  if (t === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    return raw
  }
  return raw
}

/** 从 JSON Schema 的顶层类型推 `ConfigEntry.type`。推不出就当联合 */
function typeOf(json: Record<string, unknown>): ConfigType {
  const t = json['type']
  if (t === 'string' || t === 'boolean' || t === 'object' || t === 'array') return t
  if (t === 'number' || t === 'integer') return 'number'
  if (Array.isArray(json['anyOf']) || Array.isArray(json['oneOf'])) return 'union'
  return 'string'
}

interface SlotMeta {
  secret: boolean
  env?: string
  required: boolean
  desc?: string
}

interface Slot {
  schema: z.ZodType
  meta: SlotMeta
  /** 标准 JSON Schema。算一次, 取值和 list() 共用 */
  json: Record<string, unknown>
  /** 声明的默认值。`parse(undefined)` 的结果, 算一次 */
  defaultValue: unknown
  scope: string
}

/**
 * 一个声明 → slot (不含 scope)。
 *
 * 声明本身就是 schema, 所以这里没有"先转换成 schema"的步骤 —— 只做
 * "把后面要反复用的三样东西算一次缓存起来": JSON Schema、元信息、默认值。
 */
function normalize(schema: z.ZodType, full: string): Omit<Slot, 'scope'> {
  // 运行时再挡一次: 类型系统只覆盖编译期, 而插件是动态加载的。
  // 万一有人从旧文档抄了 `{ type: 'string' }` 那种已经删掉的写法, 要在这里
  // 说清楚, 否则接下去会是 "schema.meta is not a function" —— 一条完全
  // 指不出问题所在的报错
  if (typeof (schema as { parse?: unknown }).parse !== 'function') {
    throw new Error(
      `${full}: 配置声明必须是 zod schema (如 z.string().default('.')), ` +
        `不再是 { type: 'string' } 那种写法 —— 后者已从接口删除`,
    )
  }

  let json: Record<string, unknown> = {}
  try {
    json = z.toJSONSchema(schema) as Record<string, unknown>
  } catch {
    // 有些 zod 类型本来就无法表示成 JSON Schema (bigint / date / transform)。
    // **不阻断启动**: 取值照样能走, 只是设置页画不出控件 —— 那比整个内核起不来好
    json = {}
  }

  // 元信息只从 `.meta()` 一处来。声明是 schema 而不是"schema + 一张平行字段表",
  // 所以不会出现"界面上说它是密钥、取值层却不知道"这种两处声明打架
  const rawMeta = (schema.meta?.() ?? {}) as Record<string, unknown>

  const meta: SlotMeta = {
    secret: rawMeta['secret'] === true,
    required: rawMeta['required'] === true,
  }
  if (typeof rawMeta['env'] === 'string') meta.env = rawMeta['env']
  if (typeof rawMeta['description'] === 'string') meta.desc = rawMeta['description']

  let defaultValue: unknown
  try {
    defaultValue = schema.parse(undefined)
  } catch {
    defaultValue = undefined
  }

  return { schema, meta, json, defaultValue }
}

export async function apply(
  ctx: Ctx,
  config: { dir?: string; file?: string } = {},
): Promise<Disposer> {
  // 引导值: settings 文件自己的位置**不能**从 settings 读, 只能从 env 或默认来。
  // 这是整个配置系统里唯一的鸡生蛋, 所以要写在这里, 让它是明面上的例外
  const dir = resolve(config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng')
  const file = config.file ?? join(dir, 'settings.json')

  /** 界面上改过的值。键是 `<scope>.<key>`, 密钥存的是 env 名 */
  let settings: Record<string, unknown> = {}
  let broken: string | undefined

  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // 文件坏了不阻断启动 —— 但要留话。悄悄当空配置启动, 等于把所有
      // 用户设置一次性丢掉, 而用户在界面上只会看到"我改的都没了"
      broken = `${file}: ${(err as Error).message}`
      console.warn(`[meng] 配置读不出来, 按空配置启动 → ${broken}`)
    }
  }

  const slots = new Map<string, Slot>()
  const scopes = new Map<string, ConfigScope>()

  const slotOf = (scope: string, key: string): Slot | undefined => slots.get(`${scope}.${key}`)

  /** 解析一层来源。返回 undefined 表示这层没给值 */
  const fromEnv = (slot: Slot, name: string): string | undefined => {
    const envName = slot.meta.env ?? envNameOf(slot.scope, name)
    const raw = process.env[envName]
    // 空串按"没配"处理。这一条是**统一**的: 老代码一半 `??` 一半 `||`,
    // 空串在一半地方算有效值, 于是 `MENG_WORKSPACE=` 这种写法行为随机
    return raw === undefined || raw === '' ? undefined : raw
  }

  /** 交给 schema 做最终校验。失败转成 ConfigError, 不把 zod 的类泄漏给调用方 */
  const parseVia = (slot: Slot, raw: unknown, full: string): unknown => {
    const shaped = shapeForWire(slot.json, raw)
    const result = slot.schema.safeParse(shaped)
    if (result.success) return result.data
    // zod 的错误消息带路径, 对"哪个键写错了"这个问题来说是最有用的信息
    const first = result.error.issues[0]
    const where = first && first.path.length > 0 ? `.${first.path.join('.')}` : ''
    const why = first ? first.message : '不符合声明'
    throw new ConfigError(CONFIG_CODE.TYPE, full, `${full}${where} ${why} (拿到 ${JSON.stringify(raw)})`)
  }

  const resolveOne = (
    scope: string,
    key: string,
  ): { value: unknown; source?: ConfigSource; secretRef?: string } => {
    const slot = slotOf(scope, key)
    if (!slot) return { value: undefined }
    const full = `${scope}.${key}`

    if (slot.meta.secret) {
      // 密钥: settings 里存的是**名字**, 值只从环境读
      const bound = settings[full]
      const envName =
        typeof bound === 'string' && bound.trim() !== ''
          ? bound.trim()
          : (slot.meta.env ?? envNameOf(scope, key))
      const value = process.env[envName]
      return {
        // 空串也是空 —— 密钥是空串等于没配
        value: value === undefined || value === '' ? undefined : value,
        source: value === undefined || value === '' ? undefined : 'env',
        secretRef: envName,
      }
    }

    const fromSettings = settings[full]
    // 空串和 env 层一样按"没配"处理。两层规则不一致的话, 用户在界面上
    // 清空一个输入框就会得到一个空字符串, 而不是"回到默认值" ——
    // 那是设置页上最容易被当成 bug 的行为
    if (fromSettings !== undefined && fromSettings !== null && fromSettings !== '') {
      return { value: parseVia(slot, fromSettings, full), source: 'settings' }
    }

    const raw = fromEnv(slot, key)
    if (raw !== undefined) return { value: parseVia(slot, raw, full), source: 'env' }

    if (slot.defaultValue !== undefined) return { value: slot.defaultValue, source: 'default' }

    if (slot.meta.required) {
      throw new ConfigError(
        CONFIG_CODE.MISSING,
        full,
        `缺少必填配置 ${full} (环境变量 ${slot.meta.env ?? envNameOf(scope, key)})`,
      )
    }
    return { value: undefined }
  }

  const makeScope = (scope: string): ConfigScope => {
    const existing = scopes.get(scope)
    if (existing) return existing

    const refuseSecret = (key: string, via: string): never => {
      throw new ConfigError(
        CONFIG_CODE.SECRET_AS_PLAIN,
        `${scope}.${key}`,
        `${scope}.${key} 是密钥, 不能用 ${via}() 取 —— 用 secret()。它的值不该流进任何"普通配置"的路径`,
      )
    }

    const self: ConfigScope = {
      name: scope,
      declare(decl: ConfigDecl) {
        const mine: Array<[string, Slot]> = []
        for (const key of Object.keys(decl)) {
          const item = decl[key]
          if (!item) continue
          const full = `${scope}.${key}`
          const slot: Slot = { ...normalize(item, full), scope }
          slots.set(full, slot)
          mine.push([full, slot])
        }
        return () => {
          for (const [full, slot] of mine) {
            // 只回收自己那一版: 后来者覆盖过的声明不该被先来者的 disposer 干掉,
            // 否则热重载时会出现"新的声明被旧的卸载顺手删了"
            const cur = slots.get(full)
            if (cur && cur.schema === slot.schema) slots.delete(full)
          }
          if (mine.length > 0 && ![...slots.values()].some((s) => s.scope === scope)) {
            scopes.delete(scope)
          }
        }
      },
      get<T = string | number | boolean>(key: string): T | undefined {
        if (slotOf(scope, key)?.meta.secret) refuseSecret(key, 'get')
        return resolveOne(scope, key).value as T | undefined
      },
      require<T = string | number | boolean>(key: string): T {
        const v = self.get<T>(key)
        if (v === undefined) {
          throw new ConfigError(CONFIG_CODE.MISSING, `${scope}.${key}`, `缺少配置 ${scope}.${key}`)
        }
        return v
      },
      secret(key) {
        const slot = slotOf(scope, key)
        if (!slot?.meta.secret) return undefined
        return resolveOne(scope, key).value as string | undefined
      },
      secretRef(key: string) {
        const slot = slotOf(scope, key)
        if (!slot?.meta.secret) return undefined
        return resolveOne(scope, key).secretRef
      },
      sourceOf(key: string) {
        if (slotOf(scope, key)?.meta.secret) {
          // 密钥的来源恒为 env —— 说"settings"会让人以为值存在文件里
          return resolveOne(scope, key).value === undefined ? undefined : 'env'
        }
        return resolveOne(scope, key).source
      },
    }

    scopes.set(scope, self)
    return self
  }

  /**
   * 落盘。**先写临时文件再 rename** —— 直接 writeFile 时进程被杀会留下半个
   * JSON, 下次启动读不出来, 而那时的报错只会说"配置读不出来", 指不回写它
   * 的那一刻。rename 在同一文件系统上是原子的。
   */
  const persist = async (): Promise<void> => {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    // 写成功了, 那份"读不出来"的旧账就该清了 —— 否则日志会一直报案
    broken = undefined
  }

  /** 一个槽 → 设置页的一行。list() 与写通道共用, 免得两处各拼一遍字段 */
  const entryOf = (full: string): ConfigEntry => {
    const slot = slots.get(full)
    if (!slot) throw new ConfigError(CONFIG_CODE.UNKNOWN, full, `${full} 没有被任何插件声明`)
    // **scope 从槽里取, 不按第一个点切全名。** scope 名自己可以带点
    // (`llm.deepseek`), 切出来就成了 `llm` + `deepseek.apiKey`,
    // 于是设置页按 scope 分组的那些行全部落到错误的组里 —— 而且不报错
    const scope = slot.scope
    const name = full.slice(scope.length + 1)

    // 必填项还没配时 resolveOne 会抛 —— 但 **list() 不能因此整页失败**。
    // 一个字段没配就让设置页白屏, 用户连"去配它"的输入框都看不到
    let r: { value: unknown; source?: ConfigSource; secretRef?: string } = { value: undefined }
    let unresolved: string | undefined
    try {
      r = resolveOne(scope, name)
    } catch (err) {
      unresolved = err instanceof Error ? err.message : String(err)
    }
    const entry: ConfigEntry = {
      key: full,
      scope,
      name,
      type: typeOf(slot.json),
      secret: slot.meta.secret,
      required: slot.meta.required,
      // 标准 JSON Schema, 设置页画控件靠它。前端不用装 zod
      schema: slot.json,
    }
    if (unresolved !== undefined) entry.unresolved = unresolved
    // 组合配置的默认值是对象/数组, 类型对不上 `default?: 标量` —— 不给,
    // 前端从 schema.default 拿得到同样的东西
    if (typeof slot.defaultValue === 'string' || typeof slot.defaultValue === 'number' || typeof slot.defaultValue === 'boolean') {
      entry.default = slot.defaultValue
    }
    if (slot.meta.desc !== undefined) entry.desc = slot.meta.desc
    // 密钥行的 value **恒不给**: 这条 if 是这一层唯一的安全边界
    if (!slot.meta.secret) {
      if (r.value !== undefined) entry.value = r.value as string | number | boolean
      if (r.source !== undefined) entry.source = r.source
    } else {
      if (r.secretRef !== undefined) entry.secretRef = r.secretRef
      // 只报"有没有", 不带值 —— 见 ConfigEntry.present 的注释
      entry.present = r.value !== undefined
    }
    return entry
  }

  const entriesIn = (scope: string): ConfigEntry[] =>
    [...slots.keys()]
      .filter((full) => full.startsWith(`${scope}.`))
      // 稳定顺序: 设置页靠它, 顺序乱跳会让人以为配置变了
      .sort()
      .map(entryOf)

  const write = async (scope: string, key: string, apply: (full: string) => void): Promise<ConfigWriteResult> => {
    const full = `${scope}.${key}`
    // 未声明的键直接拒绝: 设置页只画已声明的项, 写未声明的键等于往黑箱里塞
    // 东西 —— 用户看不到它, 也删不掉它
    if (!slotOf(scope, key)) {
      throw new ConfigError(
        CONFIG_CODE.UNKNOWN,
        full,
        `${full} 没有被任何插件声明 —— 只有已声明的键才能写`,
      )
    }
    apply(full)
    await persist()
    return { entry: entryOf(full), scopeEntries: entriesIn(scope) }
  }

  const service: ConfigService = {
    scope: makeScope,

    list(): ConfigEntry[] {
      // 稳定顺序: 设置页靠它, 顺序乱跳会让人以为配置变了
      return [...slots.keys()].sort().map(entryOf)
    },

    async set(scope: string, key: string, value: unknown): Promise<ConfigWriteResult> {
      const slot = slotOf(scope, key)
      return write(scope, key, (full) => {
        if (!slot) return
        if (slot.meta.secret) {
          // **密钥写的是变量名, 不是值。** 值永远不经过这条通道 ——
          // 这样 settings.json 进备份/进截图/进 git 都不出事
          const name = String(value).trim()
          if (name === '') delete settings[full]
          else settings[full] = name
          return
        }
        // 先按声明校验, 坏值不落盘。否则下次启动读到一份自己写坏的 settings,
        // 而报错会指向"读不出来", 指不回写它的那一刻
        const parsed = parseVia(slot, value, full)
        if (parsed === undefined || parsed === null) delete settings[full]
        else settings[full] = parsed
      })
    },

    async unset(scope: string, key: string): Promise<ConfigWriteResult> {
      return write(scope, key, (full) => {
        // 清掉 settings 层 → 自动回落到 env / default
        delete settings[full]
      })
    },
  }

  // 内核级共享配置在这里声明**一次**。7 个消费方只 get, 不 declare ——
  // 否则同一份声明被声明 7 次, 谁先卸载谁就把别人的删了
  for (const [scopeName, decl] of Object.entries(KERNEL_CONFIG)) {
    makeScope(scopeName).declare(decl)
  }

  if (!process.env['MENG_QUIET']) {
    const at = slots.get('sandbox.root')
    const who = at ? (resolveOne('sandbox', 'root').source ?? '无') : '未声明'
    console.log(`[meng] config · 设置文件 ${file}${broken ? ' (读取失败)' : ''} · sandbox.root 来自 ${who}`)
  }

  const disposer = provideConfig(ctx, service)
  return () => {
    disposer()
    scopes.clear()
    slots.clear()
  }
}

export const invariant = defineInvariant('@meng/plugin-config-local', [
  {
    id: 'root-resolvable',
    run(ctx) {
      const svc = ctx.get<ConfigService>('config')
      if (!svc) throw new Error('能力面 config 未注册')
      const sandbox = svc.scope('sandbox')
      const root = sandbox.get('root')
      // 这一条是"地基真的立住了"的检查: 内核级共享配置里最关键的一项
      // 必须能解析出值。它要是 undefined, 七个消费方会各自 `?? cwd` 兜底,
      // 于是又回到"各解析各的" —— 那这一层就白做了
      if (typeof root !== 'string' || root === '') {
        throw new Error(`sandbox.root 解析不出值 (拿到 ${JSON.stringify(root)})`)
      }
      const entries = svc.list()
      if (entries.length === 0) throw new Error('list() 是空的, 设置页将没有任何可编辑项')
    },
  },
  {
    id: 'secrets-never-listed',
    run(ctx) {
      const svc = ctx.get<ConfigService>('config')
      if (!svc) throw new Error('能力面 config 未注册')
      // 安全边界要能自证: 任何标了 secret 的项, list() 里都不许带出 value。
      // 现在还没有密钥项, 所以这条检查是"将来加了密钥也不会漏"的保险丝 ——
      // 它跑在每次启动, 漏了当场红, 而不是等某次截图进了群
      for (const entry of svc.list()) {
        if (entry.secret && entry.value !== undefined) {
          throw new Error(`${entry.key} 是密钥, 但 list() 把值带出来了`)
        }
      }
    },
  },
  {
    id: 'every-entry-has-schema',
    run(ctx) {
      const svc = ctx.get<ConfigService>('config')
      if (!svc) throw new Error('能力面 config 未注册')
      // 设置页只认 schema 一种输入也能画。任何一项没有 schema, 就意味着
      // 那一项在界面上会变成一个没有控件可用的死格子 —— 而且不会有报错
      for (const entry of svc.list()) {
        const schema = entry.schema as Record<string, unknown> | undefined
        if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
          throw new Error(
            `${entry.key} 没有 JSON Schema —— 设置页画不出控件。` +
              `如果是无法表示的类型 (date/transform), 在声明里换成可表示的写法`,
          )
        }
      }
    },
  },
])
