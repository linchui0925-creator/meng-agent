/**
 * @meng/config —— 配置能力面 (seam)。**零实现**。
 *
 * ## 这一层为什么必须存在
 *
 * 之前每个插件都自己写一行:
 *     resolve(config.root ?? process.env.MENG_WORKSPACE ?? cwd)
 * 同一句话在仓库里出现了 **7 次** (net-local / tool-search / tool-bash /
 * bash-local / policy-fs / spill / fs), 而 `packages/fs` 那份连 config 兜底都没有。
 * 更糟的是空串行为不一: 一半用 `??` (空串算有效), 一半用 `||` (空串算没配)。
 *
 * 这就是"没有单一真相源"的确切形态: 同一个语义, 七处各自解析, 各自出偏差。
 * 等到设置页上线, 这七处要各改一遍 —— 那才是真正的"全部重新引用"。
 *
 * ## 这条缝唯一重要的决定: 声明与取值分开, 且**声明属于插件**
 *
 * 直觉做法是 `getConfig('sandbox.root')` —— 全局一个扁平的键值袋。
 * 那样做不出三件事:
 *   1. 设置页画不出表单。它得知道"有哪些键、什么类型、什么说明、缺省是啥",
 *      而这些信息只有插件自己知道
 *   2. 键名会冲突。两个插件都想用 `root`, 全局袋里只能叫 `a.root` / `b.root`
 *   3. 声明没有生命周期。插件被卸载了, 它的配置项还留在设置页上
 *
 * 所以走 scope: 每个插件在自己的 scope 里 declare, 声明随插件卸载一起回收。
 * **设置页不需要认识任何插件** —— 它遍历 `list()`, 就能画出全仓的配置表单。
 * 加一个配置项, 设置页一行都不用改。这是这一层最重要的性质。
 *
 * ## 取值顺序 (实现在 config-local, 这里只定契约)
 *
 *   settings (用户在界面上改的)  >  env (进程环境)  >  manifest (清单 config)  >  default (声明)
 *
 * **密钥是例外, 且是刻意的例外**: 密钥在 settings 层存的是**环境变量名**, 不是值。
 * 值永远只从 `process.env` 读, 永远不进 settings.json、不进清单、不进日志。
 * 这条来自 dsh 的原则: a literal key is not a configuration value ——
 * 密钥不是配置值, 它是配置指向的一个位置。
 *
 * 代价必须写在明处: **换密钥要重启进程**。env 是进程启动时读入的,
 * 运行中的进程看不到新的 env。这是安全换来的代价, 不是疏忽。
 *
 * ## 这条缝**不含**的判断 (留在上层)
 *   · 两套设置冲突时怎么提示用户 —— 那是设置页
 *   · 改完要不要立刻生效 —— 那是热更新, 现在没有"变的地方", 也就没有它
 *
 * ## 声明只有**一种写法**: zod schema
 *
 * 标量写 `z.number().default(4721)`, 组合写
 * `z.union([z.object({...}), z.object({...})])` —— 大配置小配置同一套语法。
 *
 * 曾经并存过两种写法: 扁平简写 (`{ type: 'number', default: 4721 }`) 加 zod,
 * 由实现层把前者归一成后者。**那条路已经删掉了。** 原因是"两种写法"必然
 * 长出第三件事: 一个新人要读两遍文档才能判断该用哪个, 而这个判断标准写不进
 * 类型系统 —— 于是写错不报错, 只是风格分裂。统一之后声明就是 schema,
 * 系统里没有"先转换再使用"这一步。
 *
 * **为什么是 zod 而不是 dsh 用的 schemastery**: 后者的 `toJSONSchema()` 等价物
 * 输出的是 `{ uid, refs }` 私有信封, 前端必须 `new Schema(...)` 才能还原 ——
 * 等于把设置页也焊死在一个 vendor 包里。zod 4 的 `z.toJSONSchema()` 输出
 * 标准 draft 2020-12, 前端连 zod 都不用装。
 *
 * **代价 (明知而为)**: 这条缝不再零运行时依赖 —— `KERNEL_CONFIG` 要真的构造
 * schema, 所以 zod 进了 dependencies。对外仍是类型 + 几个纯函数, 换库只改
 * 本文件和 config-local 两处。
 */

import { resolve } from 'node:path'
import * as z from 'zod'
import type { Ctx, Disposer } from '@meng/core'

/** 能力面名。故意和包名一致, 免得又多一个记不住的字符串 */
export const CONFIG_CAPABILITY = 'config'

/**
 * 设置页画控件用的粗分类。
 *
 * 前三个是标量 (输入框 / 数字框 / 开关), 后三个是组合:
 *   · `object` — 键值表或分组表单 (看 schema 里有没有 `additionalProperties`)
 *   · `array`  — 列表
 *   · `union`  — "选一种", 选中后再按选中项的 schema 展开
 *
 * 这只是**给前端省一次 switch 的提示**, 真值在 `ConfigEntry.schema` 里。
 * 认不出的类型降级成 `string` 也不会崩, 但那说明声明写得不该这么写。
 */
export type ConfigType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'union'

/**
 * 一个配置项的声明: **zod schema**。插件声明, 设置页消费 —— 两边互不认识。
 *
 * 只有一种写法。标量和组合用同一套语法:
 *
 *     root: z.string().default('.').meta({ env: 'MENG_WORKSPACE', description: '…' })
 *     port: z.number().int().min(1).max(65535).default(4721)
 *     mcp:  z.union([z.object({ transport: z.literal('stdio'), … }), …])
 *
 * ## 元信息挂在 `.meta()` 上, 不另建一套字段
 *
 * 认得的四个键, 其余原样进 JSON Schema:
 *
 *   · `secret: true`   —— 密钥。语义见下, 这是本层唯一的安全边界
 *   · `env: 'NAME'`    —— 绑定的环境变量名 (写它是为了兼容老名字)
 *   · `required: true` —— 给设置页显示的"必填"标记 (真正的必填由"没有 default"
 *                        决定: `parse(undefined)` 抛错, 天然就是缺了不行)
 *   · `description`    —— 界面说明。用**标准名**, 因为我们直接吃 JSON Schema
 *
 * 为什么用 meta 而不是自定义接口: `z.toJSONSchema()` 会把 meta 原样带进
 * JSON Schema, 于是**同一条通道同时喂界面和安全边界** —— 不会出现
 * "界面上说它是密钥、取值层却不知道"这种两处声明打架的情况。
 *
 * ## `secret: true` 的语义
 *
 *   · settings 层存的是**环境变量名**(如 DEEPSEEK_API_KEY), 不是密钥本身
 *   · 值只从 `process.env` 读
 *   · `get()` 拿不到它, 必须走 `secret()`
 *   · 不会出现在 sourceOf / 任何对外快照的值里
 */
export type ConfigItem = z.ZodType

export type ConfigDecl = Record<string, ConfigItem>

/**
 * 读一个 schema 上挂的元信息。
 *
 * 全仓只有这一处从 schema 里掏 meta —— 换成别的库只改这个函数。
 * 声明是 schema 而不是"schema + 一个并行字段表", 正是为了避免
 * "界面上标了密钥、取值层没标"这种两处声明不一致。
 */
function metaOf(schema: ConfigItem): Record<string, unknown> {
  const raw: unknown = schema.meta?.()
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/** 给设置页的一行。密钥行的 value 恒为 undefined —— 值不出这层 */
export interface ConfigEntry {
  /** 全名: `<scope>.<key>` */
  key: string
  scope: string
  /** scope 内的短名 */
  name: string
  type: ConfigType
  default?: string | number | boolean
  secret: boolean
  required: boolean
  desc?: string
  /** 当前生效的值。密钥行恒为 undefined */
  value?: string | number | boolean
  /** 这个值从哪一层来的: settings / env / manifest / default */
  source?: ConfigSource
  /** 密钥行: 当前绑定到哪个环境变量名。非密钥行恒为 undefined */
  secretRef?: string
  /**
   * 这一项的**标准 JSON Schema** (draft 2020-12)。
   *
   * 设置页画控件靠它: 标量画输入框, `object` + `additionalProperties` 画键值表,
   * `anyOf` 画"选一种"然后按选中项展开。**前端不需要装 zod** —— 它拿到的就是
   * 普通 JSON, 这是选 zod 而不是 schemastery 的唯一理由。
   *
   * 扁平声明也会有这个字段 (由实现层生成), 所以设置页只认它一种也行。
   */
  schema?: unknown
}

export type ConfigSource = 'settings' | 'env' | 'manifest' | 'default'

export const CONFIG_CODE = {
  /** 声明了但没配, 且没 default */
  MISSING: 'CONFIG_MISSING',
  /** 值类型不对 (比如端口配成 "abc") */
  TYPE: 'CONFIG_TYPE',
  /** 用了 get() 去取一个标了 secret 的键 */
  SECRET_AS_PLAIN: 'CONFIG_SECRET_AS_PLAIN',
} as const

export type ConfigCode = (typeof CONFIG_CODE)[keyof typeof CONFIG_CODE]

export class ConfigError extends Error {
  code: string
  key: string
  constructor(code: string, key: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.key = key
  }
}

/**
 * 一个插件的配置作用域。
 *
 * 生命周期跟随插件: 插件卸载 → declare 返回的 disposer 被调用 → 声明消失。
 * 这不是洁癖, 是为了"设置页上的项 = 当前装着的插件"这条等式永远成立。
 */
export interface ConfigScope {
  readonly name: string

  /** 声明本 scope 的配置项。重复声明同一个键会覆盖 (热重载要这个行为) */
  declare(decl: ConfigDecl): Disposer

  /** 取值。未声明的键返回 undefined —— 声明是取值的**前提**, 不是可选项 */
  get<T = string | number | boolean>(key: string): T | undefined

  /** 取值, 没有就抛。给"必须有"的场景用, 省掉每个调用点一行 if */
  require<T = string | number | boolean>(key: string): T

  /** 取密钥的**值**。只有标了 secret 的键能走这里 */
  secret(key: string): string | undefined

  /** 密钥当前绑定到哪个环境变量名。设置页显示"已绑定 X"用 */
  secretRef(key: string): string | undefined

  /** 这个键当前的值来自哪一层。排查"为什么我改了不生效"时唯一有用的信息 */
  sourceOf(key: string): ConfigSource | undefined
}

export interface ConfigService {
  scope(name: string): ConfigScope
  /** 全仓所有已声明的配置项。设置页的唯一入口 */
  list(): ConfigEntry[]
}

export function provideConfig(ctx: Ctx, impl: ConfigService): Disposer {
  return ctx.set<ConfigService>(CONFIG_CAPABILITY, impl)
}

/** 取能力面。插件侧统一走它, 免得每处都写字符串 */
export function getConfig(ctx: Ctx): ConfigService | undefined {
  return ctx.get<ConfigService>(CONFIG_CAPABILITY)
}

// ─────────────────────────────────────────────────────────────────────────────
// 下面是**内核级共享配置的唯一定义** + 同层纯函数。不是 seam 契约的一部分,
// 但属于契约的一部分: 所有实现方都必须认这些键名。
//
// 为什么放在这里而不是某个插件里: 这些值**不属于任何一个插件**。
// `sandbox.root` 被 7 个插件读 —— 它的定义如果住在其中一个插件里,
// 另外 6 个就对它产生了装载顺序上的依赖, 而那种依赖写不出来也测不出来。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内核级配置。**全仓唯一一份定义。**
 *
 * 按 scope 分组, 键写短名 —— 因为 `declare()` 只认 scope 内的短名。
 * 曾经这里写成扁平的 `'sandbox.root': {...}`, 在 `scope('sandbox')` 里
 * declare 一遍就成了 `sandbox.sandbox.root`, 于是 `get('root')` 恒为
 * undefined, 七个消费方全部退回 `?? cwd` 兜底 —— 而这一切没有任何报错,
 * 只有一条不变量检查能当场发现。分组是那次教训的直接结果。
 *
 * 加一个键之前先问: 这值是一个插件私有的, 还是多个插件共享的?
 * 私有 → 插件自己的 scope; 共享 → 这里。放错的后果是"同一个语义两处解析",
 * 也就是这一层要消灭的东西。
 */
export const KERNEL_CONFIG: Record<string, ConfigDecl> = {
  sandbox: {
    root: z.string().default('.').meta({
      // 老名字。已经写进部署脚本和文档里了, 改掉就是静默失效 —— 比报错难查得多
      env: 'MENG_WORKSPACE',
      description: '工作区根目录。文件读写、搜索、bash 的 cwd 都不能越过它',
    }),
  },
}

/**
 * 取工作区根目录的绝对路径。**只接受名称为 `sandbox` 的 scope**
 * (KERNEL_CONFIG 里的键都是 `sandbox.*`, 这个函数是它的专用便捷入口)。
 *
 * 所有消费方统一走它, 不各自写 `resolve(x ?? env ?? cwd)`:
 *   · `resolve('.')` 天然等于 cwd, 所以默认值写 '.' 就够, 不需要读进程状态
 *   · 七处各写一遍的后果已经发生过一次 —— 一半 `??` 一半 `||`,
 *     空串在一半地方算有效、另一半算没配
 */
export function resolveRoot(scope: ConfigScope): string {
  return resolve(String(scope.get('root') ?? '.'))
}

/**
 * 从 ctx 直接取工作区根目录。**七个消费方都该走这一个入口。**
 *
 * 为什么不是每处自己 `getConfig(ctx)?.scope('sandbox')` 再判空:
 * 那样每个调用点都会有 3 行样板, 而样板一多, 下一个人就会图省事写出
 * `?? process.cwd()` —— 于是又回到七处各解析各的。
 *
 * 没有配置能力面时(测试、单插件调试、demo)退回"只认 env + 默认"的路。
 * 这不是遗留分支: 配置层是**可选**的, 而"没装配置层时配置仍然可用"
 * 是这条设计成立的前提。代价是这条分支里的行为要和 config-local 对齐 ——
 * 所以 env 名从 KERNEL_CONFIG 里查, 不在这里写第二遍。
 */
export function sandboxRoot(ctx: Ctx): string {
  const svc = getConfig(ctx)
  if (svc) return resolveRoot(svc.scope('sandbox'))

  const item = KERNEL_CONFIG['sandbox']?.['root']
  const envName = item ? metaOf(item)['env'] : undefined
  const raw = typeof envName === 'string' ? process.env[envName] : undefined
  // 空串按"没配"处理 —— 和 config-local 同一条规则
  return resolve(raw === undefined || raw === '' ? '.' : raw)
}

/**
 * 没有 config 能力面时的兜底 scope。
 *
 * 为什么要有它: 配置能力面是**可选**的 —— 内核不装 config-local 也该能跑
 * (测试、demo、单插件调试都不需要设置页)。硬要求每个调用点判空,
 * 会让"加一个配置项"这件事变得很吵。
 *
 * 兜底行为: 只用声明里的 default。**不读 env** —— 读 env 会让"没装
 * config-local"和"装了但没配"两种状态变得不可区分, 排查时是灾难。
 */
export function fallbackScope(name: string): ConfigScope {
  const decls = new Map<string, ConfigItem>()

  const metaAt = (key: string): Record<string, unknown> => {
    const item = decls.get(key)
    return item ? metaOf(item) : {}
  }

  const read = (
    key: string,
  ): { value: string | number | boolean | undefined; source: ConfigSource | undefined } => {
    const item = decls.get(key)
    if (!item) return { value: undefined, source: undefined }
    // 密钥不出值 —— 和 config-local 同一条规则, 兜底层也不能破
    if (metaAt(key)['secret'] === true) return { value: undefined, source: undefined }
    // 默认值直接问 schema: parse(undefined) 有 default 就返回、没 default 就抛。
    // 不需要知道是哪个库 —— 换库时这个函数不用改
    try {
      const v: unknown = item.parse(undefined)
      // 组合配置 (object / array) 不是标量, 兜底 scope 不做值语义, 只报"有"
      if (v !== null && typeof v === 'object') return { value: undefined, source: undefined }
      return { value: v as string | number | boolean, source: 'default' }
    } catch {
      return { value: undefined, source: undefined }
    }
  }

  const refuseSecret = (key: string, via: string): never => {
    throw new ConfigError(
      CONFIG_CODE.SECRET_AS_PLAIN,
      `${name}.${key}`,
      `${name}.${key} 是密钥, 不能用 ${via}() 取 —— 用 secret()`,
    )
  }

  return {
    name,
    declare(decl) {
      const mine = Object.keys(decl)
      for (const key of mine) {
        const item = decl[key]
        if (item) decls.set(key, item)
      }
      return () => {
        for (const key of mine) {
          // 只删自己那份: 后来者覆盖过的声明不该被先来者的 disposer 干掉
          if (decls.get(key) === decl[key]) decls.delete(key)
        }
      }
    },
    get<T = string | number | boolean>(key: string): T | undefined {
      if (metaAt(key)['secret'] === true) refuseSecret(key, 'get')
      return read(key).value as T | undefined
    },
    require<T = string | number | boolean>(key: string): T {
      const v = this.get<T>(key)
      if (v === undefined) {
        throw new ConfigError(CONFIG_CODE.MISSING, `${name}.${key}`, `缺少配置 ${name}.${key}`)
      }
      return v
    },
    secret(key) {
      // 兜底 scope 不读 env: 见上面的注释。密钥声明在这里也只是"不报错",
      // 值恒空 —— 不会因为没装 config-local 就悄悄从 env 泄漏出来
      void key
      return undefined
    },
    secretRef(key) {
      const env = metaAt(key)['env']
      return metaAt(key)['secret'] === true && typeof env === 'string' ? env : undefined
    },
    sourceOf(key) {
      return read(key).source
    },
  }
}
