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
 *   · 配置值的合法性校验 (端口范围、路径存在) —— 那要等真有设置页再谈,
 *     现在手写 30 行够了, 不值得为 3 个 provider 引入一个 schema 库
 */

import { resolve } from 'node:path'
import type { Ctx, Disposer } from '@meng/core'

/** 能力面名。故意和包名一致, 免得又多一个记不住的字符串 */
export const CONFIG_CAPABILITY = 'config'

export type ConfigType = 'string' | 'number' | 'boolean'

/**
 * 一个配置项的声明。**插件声明, 设置页消费** —— 两边互不认识。
 */
export interface ConfigField {
  type: ConfigType
  /** 没配时用它。required 为真时不该同时写 default */
  default?: string | number | boolean
  /**
   * 密钥。为真时:
   *   · settings 层存的是**环境变量名**(如 DEEPSEEK_API_KEY), 不是密钥本身
   *   · 值只从 process.env 读
   *   · `get()` 拿不到它, 必须走 `secret()`
   *   · 不会出现在 sourceOf / 任何对外快照的值里
   */
  secret?: boolean
  /**
   * 这个配置项对应的**环境变量名**。
   *
   * 普通键: 缺省按 `MENG_<SCOPE>_<KEY>` 推导, 写它就是为了**兼容老名字**
   * (比如 `sandbox.root` 的老名字是 `MENG_WORKSPACE`, 已经散在部署脚本里了)。
   *
   * 密钥: 这是**缺省**绑定的环境变量名 —— 配了它, 用户什么都不设也能从
   * 环境变量工作; 用户在界面上改了, 就是换绑到另一个环境变量名。
   */
  env?: string
  /** 缺了就报错, 而不是静默给默认值。启动期失败比第一句话才失败好查 */
  required?: boolean
  /** 给设置页显示的说明 */
  desc?: string
}

export type ConfigDecl = Record<string, ConfigField>

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
    root: {
      type: 'string',
      default: '.',
      // 老名字。已经写进部署脚本和文档里了, 改掉就是静默失效 —— 比报错难查得多
      env: 'MENG_WORKSPACE',
      desc: '工作区根目录。文件读写、搜索、bash 的 cwd 都不能越过它',
    },
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

  const envName = KERNEL_CONFIG['sandbox']?.['root']?.env
  const raw = envName ? process.env[envName] : undefined
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
  const decls = new Map<string, { field: ConfigField; scope: string }>()
  const fieldOf = (key: string): ConfigField | undefined => decls.get(key)?.field

  const read = (key: string): { value: string | number | boolean | undefined; source: ConfigSource | undefined } => {
    const field = fieldOf(key)
    if (!field) return { value: undefined, source: undefined }
    if (field.secret) return { value: undefined, source: undefined }
    if (field.default !== undefined) return { value: field.default, source: 'default' }
    return { value: undefined, source: undefined }
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
        const field = decl[key]
        if (field) decls.set(key, { field, scope: name })
      }
      return () => {
        for (const key of mine) {
          // 只删自己那份: 后来者覆盖过的声明不该被先来者的 disposer 干掉
          const cur = decls.get(key)
          if (cur && cur.field === decl[key]) decls.delete(key)
        }
      }
    },
    get<T = string | number | boolean>(key: string): T | undefined {
      const field = fieldOf(key)
      if (field?.secret) refuseSecret(key, 'get')
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
      const field = fieldOf(key)
      if (!field?.secret) return undefined
      // 兜底 scope 不读 env: 见上面的注释
      return undefined
    },
    secretRef(key) {
      const field = fieldOf(key)
      return field?.secret ? field.env : undefined
    },
    sourceOf(key) {
      return read(key).source
    },
  }
}
