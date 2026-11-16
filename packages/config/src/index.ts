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
 * 认得的六个键, 其余原样进 JSON Schema:
 *
 *   · `secret: true`   —— 密钥。语义见下, 这是本层唯一的安全边界
 *   · `env: 'NAME'`    —— 绑定的环境变量名 (写它是为了兼容老名字)
 *   · `required: true` —— 给设置页显示的"必填"标记 (真正的必填由"没有 default"
 *                        决定: `parse(undefined)` 抛错, 天然就是缺了不行)
 *   · `description`    —— 界面说明。用**标准名**, 因为我们直接吃 JSON Schema
 *   · `path: true`     —— 值是路径。`list()` 会多给一个 `resolved` (resolve 后的绝对路径)
 *   · `restartRequired: true` —— 改了要重启才生效。界面据此显示提示, 而不是自己猜
 *
 * 前四个是"给界面看的", 后两个是"让界面不必猜的"。两类都挂在同一个地方,
 * 因为它们要解决的是同一个问题: 声明是唯一真相, 界面不许有第二份判断。
 *
 * 注意 `secret` / `env` / `required` / `path` / `restartRequired` 这几个**不进
 * 导出的 JSON Schema** —— 它们是本层的元信息, 不是 JSON Schema 的关键字。
 * 以前原样漏出去过, 于是 `required: true` (布尔) 混进了 schema, 而标准里
 * `required` 必须是字符串数组: 一个严格的校验器会当场判整份 schema 非法。
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
  /**
   * 当前生效的值。密钥行恒为 undefined。
   *
   * **类型是 `unknown` 而不是标量。** 声明层早就允许 `object` / `array`
   * (`ConfigType` 里就有这两项), 而 `provider-openai` 的 `routes` 是一张
   * 路由字典 —— 它的值是个对象。这里写窄了, 实现层只能靠一句
   * `as string | number | boolean` 把它塞进去: 类型说不会发生, 运行时天天发生,
   * 于是任何 `String(entry.value)` 都会静默得到 `[object Object]`。
   *
   * 真正的形状由 `schema` 描述, 消费方按 schema 收窄 —— 和写通道同一个立场
   * (那里早就是 `unknown` 了)。
   */
  value?: unknown
  /** 这个值从哪一层来的: settings / env / manifest / default */
  source?: ConfigSource
  /** 密钥行: 当前绑定到哪个环境变量名。非密钥行恒为 undefined */
  secretRef?: string
  /**
   * 密钥行: 那个环境变量里**有没有值**。
   *
   * 只回答"有/没有", 不带值 —— 设置页要显示"已绑定 DEEPSEEK_API_KEY(有值)"
   * 还是"已绑定但环境变量是空的", 这两种状态对用户的含义完全不同, 而
   * 界面上原本只能看到同一个 `secretRef`, 于是"我明明绑好了却没生效"。
   */
  present?: boolean
  /**
   * 解析失败的原因 (必填但没配 / 值类型不对)。
   *
   * 有它, 一行坏了只坏这一行; 没有它, `list()` 会整体抛异常 ——
   * 设置页于是白屏, 用户连"去配它"的输入框都看不到。
   */
  unresolved?: string
  /**
   * 非密钥行: 这一项会从**哪个环境变量**读 (`.meta({env})` 或按命名规则推出来的名字)。
   *
   * 为什么要有: 界面上那句"环境变量优先于这一页"是对的但不够用 —— 用户会去
   * 找那个变量。以前只有密钥行有 `secretRef`, 普通配置项前端只能把
   * `MENG_WORKSPACE` 这类名字硬编码在文案里, 后端一改名就静默过期。
   *
   * 密钥行**不给**: 那里 `secretRef` 才是真相 (它可能被绑到别的变量上),
   * 两个字段说同一件事迟早打架。
   */
  envName?: string
  /**
   * 值 **resolve 之后**的形态。目前只有标了 `.meta({ path: true })` 的路径类配置给。
   *
   * 为什么要有: `sandbox.root` 的默认值是 `.`, 界面照原样显示一个点, 而用户
   * 真正想知道的是"现在到底在哪个绝对路径"。前端不知道服务进程的 cwd,
   * 算不出来, 只能写一句人话("启动梦时所在的目录")绕着走。
   */
  resolved?: string
  /**
   * 改了**要重启**才生效。由声明自己说 (`.meta({ restartRequired: true })`),
   * 不让界面去猜。
   *
   * 为什么值得一个字段: "要重启"这件事现在是每个设置分区各写一句文案,
   * 将来端口、数据目录这些同类配置都得再写一遍 —— 而文案和实现对不上时,
   * 界面就会替后端撒谎 (写了"立刻生效", 实际要重启)。
   */
  restartRequired?: boolean
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
  /** 写一个从未声明过的键 */
  UNKNOWN: 'CONFIG_UNKNOWN',
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

  /**
   * 订阅本 scope 的配置变化。`set` / `unset` 落到本 scope 之后调用。
   *
   * ## 为什么"每次请求重读"不够
   *
   * 重读只能让**值**变了立刻生效 (`baseURL` 改了, 下一个请求就用新的)。
   * 但有些配置本身就是**结构**: `routes` 是一个字典, 加一个 key 就是多了
   * 一条路由 —— 而路由是在 `apply` 时注册进 llm 的, 不是每次请求现算的。
   * 没有这条通知, 用户加了一条供应商只能重启进程才看得见。
   *
   * 这条通道存在的**唯一理由**就是这个: 声明里含"会增删的键"的插件需要它。
   * 只有标量配置的插件不必订阅 —— 重读更简单, 也不会漏掉"谁先谁后"的问题。
   *
   * 不保证顺序, 不保证只在写成功后调用 (写入前的校验已经抛了, 到这里的
   * 都是已落盘的变化)。订阅者自己负责幂等: 回调可能连续来两次。
   */
  onChange(fn: () => void): Disposer
}

/**
 * 写一个配置值, 返回它重新解析后的样子 (一条 entry)。
 *
 * **密钥行写的是环境变量名, 不是密钥本身** —— 与 settings.json 里存的东西一致。
 * 这样设置页只有一条写路径: `set('llm.deepseek','apiKey','MY_DEEPSEEK_KEY')`
 * 的含义是"这个密钥去 MY_DEEPSEEK_KEY 里找", 而值永远不经过这条通道。
 *
 * 校验在写之前做 (`schema.parse`), 坏值不会落盘 —— 否则下次启动会读到一份
 * 自己写坏的 settings.json, 而报错会指向"配置读不出来", 指不回写它的那一刻。
 *
 * 值可以是数组/对象 (`models: string[]` 就是), 校验一律交给声明里的 schema:
 * 在这里再写一套"允许哪些形状"等于第二份规则, 而两份规则必然漂移。
 */
export interface ConfigWriteResult {
  /** 写完之后这一项的样子。设置页拿它直接替换那一行, 不需要再 list() 一次 */
  entry: ConfigEntry
  /** 同一个 scope 下的全部条目: 写一个键可能让同组的值跟着变 (组合配置) */
  scopeEntries: ConfigEntry[]
}

export interface ConfigService {
  scope(name: string): ConfigScope
  /** 全仓所有已声明的配置项。设置页的唯一入口 */
  list(): ConfigEntry[]

  /**
   * 写一层 settings。未声明的键直接拒绝: 设置页只画已声明的项,
   * 写未声明的键等于往黑箱里塞东西, 而用户永远看不到它、也删不掉它。
   *
   * ## `path`: 只改组合配置里的一个字段
   *
   * 组合配置 (`llm.openai.routes` 那种字典) 的值是整张表。不带 `path` 时写的是
   * **整张表**, 于是"改一条路由的一个字段"只能靠前端读-改-写:
   *
   *     list() → 改副本 → set(整张)
   *
   * 这条路上有两份状态, 任何一处先写都会把另一处覆盖掉 —— 而覆盖是**静默**的,
   * 用户看到的是"我刚改的那个字段又变回去了"。带上 `path` 之后, 后端从磁盘上
   * 的当前值出发改那一格, 只有一份状态, 覆盖窗口消失:
   *
   *     set('llm.openai', 'routes', 'https://x/v1', ['zai', 'baseURL'])
   *
   * 校验仍是**整份 schema**: 改一格之后整张表必须仍然合法, 否则拒绝落盘 ——
   * 只校验那一格的话, 会写出"字段对了但整条路由不成立"的半坏配置。
   */
  set(
    scope: string,
    key: string,
    value: unknown,
    path?: Array<string | number>,
  ): Promise<ConfigWriteResult>

  /** 清掉 settings 层 → 回落到 env / default。同样只接受已声明的键 */
  unset(scope: string, key: string): Promise<ConfigWriteResult>
}

export function provideConfig(ctx: Ctx, impl: ConfigService): Disposer {
  return ctx.set<ConfigService>(CONFIG_CAPABILITY, impl)
}

/** 取能力面。插件侧统一走它, 免得每处都写字符串 */
export function getConfig(ctx: Ctx): ConfigService | undefined {
  return ctx.get<ConfigService>(CONFIG_CAPABILITY)
}

/**
 * 环境变量名的推导规则: `sandbox.root` → `MENG_SANDBOX_ROOT`。
 *
 * 放在缝里而不是实现里, 因为**兜底 scope 也要用同一套**。两处各写一遍,
 * 就会在"没装 config-local 时读不到环境变量"这种事上分岔 —— 而那种分岔
 * 只在特定部署里出现, 本地永远复现不了。
 */
export function envNameOf(scope: string, key: string): string {
  const raw = `${scope}.${key}`
  return `MENG_${raw.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

/**
 * 声明一个插件自己的配置 scope。**插件装配置的唯一入口。**
 *
 * 它做的事很少, 但省掉的是每个插件都要写一遍的三行样板:
 *
 *     const svc = getConfig(ctx)
 *     const scope = svc ? svc.scope(NS) : fallbackScope(NS)
 *     ctx.effect(() => scope.declare(CONFIG))
 *
 * 样板一多, 下一个人就会图省事写成 `if (!svc) return` —— 于是那个插件在
 * 没有 config-local 的环境里**静默没有配置**, 表现为"默认值全对但 env 全不认"。
 *
 * 返回的 `dispose` 必须挂到插件的生命周期上 (通常 `ctx.effect(() => dispose)`),
 * 否则插件卸载后它的配置项会留在设置页上, 点一下就没反应。
 */
export function openScope(
  ctx: Ctx,
  name: string,
  decl: ConfigDecl,
): { scope: ConfigScope; dispose: Disposer } {
  const svc = getConfig(ctx)
  const scope = svc ? svc.scope(name) : fallbackScope(name)
  const dispose = scope.declare(decl)
  return { scope, dispose }
}

/**
 * 探一次密钥: 拿到它的值与它绑定的环境变量名。**不改变任何声明。**
 *
 * 给"启动自检"用 —— 那类代码拿到的 ctx 不一定是插件自己的 scope,
 * 也不该为了读一个值去 declare (同一份声明被 declare 两次, 先退出的那个
 * disposer 会把后一份一起删掉, 这个坑已经在 config-local 里写过注释了)。
 */
export function probeSecret(
  ctx: Ctx,
  scopeName: string,
  key: string,
  decl: ConfigDecl,
): { value?: string; ref?: string } {
  const svc = getConfig(ctx)
  if (svc) {
    const scope = svc.scope(scopeName)
    const value = scope.secret(key)
    const ref = scope.secretRef(key)
    return { ...(value === undefined ? {} : { value }), ...(ref === undefined ? {} : { ref }) }
  }
  // 没有配置层: 兜底 scope 是**每次新建**的, 不认识别处声明过的键 ——
  // 所以这里补一份临时声明, 读完就撤
  const scope = fallbackScope(scopeName)
  const undo = scope.declare(decl)
  try {
    const value = scope.secret(key)
    const ref = scope.secretRef(key)
    return { ...(value === undefined ? {} : { value }), ...(ref === undefined ? {} : { ref }) }
  } finally {
    undo()
  }
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
      // 值是个路径, 界面要显示"现在到底在哪个绝对路径"而不是一个点
      path: true,
      /**
       * **改了立刻生效, 不用重启。** 曾经标过 `restartRequired: true`, 理由是
       * "七个消费方都在 apply() 里把根抓成了常量" —— 那是**实现顺手**, 不是
       * 结构必然: 根只是一条路径, 围栏比较 / relative 换算 / mkdir 全是每次
       * 现算的。七处改成现读之后, 这条声明就撤了。
       *
       * `restartRequired` 这个字段留着: 真只能在启动时读的配置 (端口、
       * 数据目录) 以后要靠它。现在没有一项标它 —— 界面上那句"重启后生效"
       * 应该消失。
       */
    }),
    /**
     * 权限模式。**和 root 放在同一个 scope**, 因为"这一片目录允许什么"
     * 是一个整体: 目录是范围, 模式是这个范围内外的宽严。
     *
     * 三档的差别只在两个闸门上 (写文件前 / 跑命令前), 见 `policy-approval`:
     *
     *   · `ask`  请求批准 —— 工作区内写和跑命令**每次都问**; 读工作区外也问
     *   · `auto` 帮我批准 —— 只问高风险 (越界 / 敏感路径), 其余自主
     *   · `full` 绝对权限 —— 不问, 也不设围栏
     *
     * 三档**都拦**"一次执行就不可逆"的灾难命令 (rm -rf / 之类)。那不是权限,
     * 是止损 —— 见 policy-bash。
     */
    mode: z.enum(['ask', 'auto', 'full']).default('auto').meta({
      description:
        '权限模式: ask=每次都问 / auto=只问高风险(越界、敏感路径) / full=不问也不围栏',
    }),
  },
}

/**
 * 权限模式。三档语义写在 `KERNEL_CONFIG.sandbox.mode` 的注释里。
 *
 * 为什么这个取值函数要放在缝里而不是 `policy-approval` 插件里:
 * **围栏也要读它** —— `@meng/fs` 在 `full` 模式下不再拒越界路径。
 * 两处各写一份 `get('mode') ?? 'auto'`, 迟早一处改了另一处没改,
 * 表现是"界面显示绝对权限, 但读工作区外还是被拒"。
 */
export type SandboxMode = 'ask' | 'auto' | 'full'

export function sandboxMode(ctx: Ctx): SandboxMode {
  const svc = getConfig(ctx)
  const raw = svc ? svc.scope('sandbox').get('mode') : undefined
  // 脏值一律当默认档: 猜错方向的后果是"以为放开了其实没放开"(或反过来),
  // 两种都比"用默认值"坏
  return raw === 'ask' || raw === 'full' ? raw : 'auto'
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
 * 兜底行为: 普通值只用声明里的 default, **不读 env** —— 读 env 会让"没装
 * config-local"和"装了但没配"两种状态变得不可区分, 排查时是灾难。
 *
 * 唯一例外是**密钥**: 它的值只能来自 env (settings 存的是变量名), 不存在
 * 上面那种歧义, 所以兜底也读。否则"没装 config-local"就等于"永远没有凭据",
 * 而界面上看不出是配置层缺了还是 key 没设。
 */
export function fallbackScope(name: string): ConfigScope {
  const decls = new Map<string, ConfigItem>()

  const metaAt = (key: string): Record<string, unknown> => {
    const item = decls.get(key)
    return item ? metaOf(item) : {}
  }

  const read = (
    key: string,
  ): { value: unknown; source: ConfigSource | undefined } => {
    const item = decls.get(key)
    if (!item) return { value: undefined, source: undefined }
    // 密钥不出值 —— 和 config-local 同一条规则, 兜底层也不能破
    if (metaAt(key)['secret'] === true) return { value: undefined, source: undefined }
    // 默认值直接问 schema: parse(undefined) 有 default 就返回、没 default 就抛。
    // 不需要知道是哪个库 —— 换库时这个函数不用改
    try {
      const v: unknown = item.parse(undefined)
      /**
       * **组合配置也返回值。**
       *
       * 这里曾经对 object/array 一律返回 undefined, 理由是"兜底 scope 不做
       * 值语义"。那条规则在多路由之前没害处, 因为没有任何插件用对象/数组
       * 声明默认值。`provider-openai` 的 `routes` 字典一来, 它变成了:
       * 没装 config-local 时 `routes()` 恒为空 → 一条路由都不注册 →
       * provider 静默消失。不是"功能少一点", 是根本跑不起来。
       *
       * 默认值本来就是 schema 自己 parse 出来的完整值, 没有"不敢给"的理由。
       */
      return { value: v, source: 'default' }
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
      // **密钥是唯一读 env 的一类, 即使没有 config-local。**
      //
      // 上面那条"兜底不读 env"的理由是: 读了 env, "没装 config-local"和
      // "装了但没配"就分不清了 —— 那是对**普通值**说的 (普通值三层来源,
      // 分不清就查不出来源)。
      // 密钥没有这个歧义: 它的值**只能**来自 env, settings 层存的是变量名。
      // 兜底不读 = 没装 config-local 时所有 provider 都永远"没有凭据",
      // 而这件事在界面上看起来像"我的 key 明明在环境里"。
      const meta = metaAt(key)
      if (meta['secret'] !== true) return undefined
      const envName = typeof meta['env'] === 'string' ? meta['env'] : envNameOf(name, key)
      const raw = process.env[envName]
      // 空串等于没配 —— 与 config-local 同一条规则
      return raw === undefined || raw === '' ? undefined : raw
    },
    secretRef(key) {
      const env = metaAt(key)['env']
      return metaAt(key)['secret'] === true && typeof env === 'string' ? env : undefined
    },
    sourceOf(key) {
      return read(key).source
    },
    onChange() {
      // 兜底 scope 没有可写的地方, 所以永远不会有变化可通知。
      // 返回一个真 disposer 而不是空函数: 订阅方的 `ctx.effect` 需要一个能调的回收口,
      // 给 undefined 会让所有调用点多一行判空 —— 而那一行在装了 config-local 的
      // 生产路径上永远走不到。
      return () => {}
    },
  }
}
