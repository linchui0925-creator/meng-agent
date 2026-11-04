/**
 * 供应商目录 —— 把「装了什么」「配了什么」「能不能用」合成一份给设置页看的表。
 *
 * ## 为什么这层不是 `@meng/llm` 的
 *
 * `@meng/llm` 的立场是 **provider-neutral**: 它认识路由、认识流, 不认识
 * "用户在设置页里填了什么"。把配置拼进来, llm 就得依赖 config, 而那两条缝
 * 是并列的、谁也不该认识谁。
 *
 * 所以合并在**出口这一层** (`llm.catalog` op 旁边), 且做成**纯函数**:
 * 输入是两个包各自吐出来的数据, 输出是普通 JSON。这样它可以被单测直接打,
 * 不用起内核、不用假装一个是配置层。
 *
 * ## 与 dsh 的关系
 *
 * dsh 有一张 `configurable-provider` 目录, 记着"这个 adapter 现在有哪些路由"
 * 以及"每条路由的配置在设置页的哪段路径上"。它是**设置页的路由索引** ——
 * 因为 dsh 的一个 adapter 能挂多条路由, 而 `listProviders()` 只给活着的那些,
 * 光靠它推不出"哪些配置还能被激活"。
 *
 * 我们没抄那张表: 路由要么注册着、要么不在 (见 `provider-openai` 的
 * `sync()` —— 配置即真相, 增删立刻落到注册表), 所以注册表本身就是索引。
 * **但多路由这件事本身抄了**: `provider-openai` 的 `routes` 字典一个 key
 * 一条路由, 用户自己加网关不需要我们写插件。
 *
 * 代价: 没有"路由存在但未激活"这个中间态。dsh 用它做"装好但没开"的开关,
 * 我们这边"没 key"就是没激活, 界面上表现为 `available: false` + `missing`。
 */

import type { ConfigEntry } from '@meng/config'
import type { ProviderInfo } from '@meng/llm'

export interface CatalogProvider {
  /** 路由 id, 也是 `GenerateOptions.model` 之外唯一能点名它的东西 */
  id: string
  /** 给人看的名字 */
  name: string
  models: string[]
  /** 现在能不能真的发请求 */
  available: boolean
  /**
   * 它的配置在哪个 scope。设置页拿它去 `config.list()` 里捞同一 scope 的行。
   * 没有就是 `undefined` 且 `config` 为空数组 —— 比如 mock, 它没有可配的东西。
   */
  configScope?: string
  /** 这个 provider 的配置项 (含 schema / 当前值 / 密钥绑定名) */
  config: ConfigEntry[]
  /**
   * **还差什么才能用**。人话, 直接显示。
   * 只在 `available === false` 时非空 —— 可用的时候不该有噪音。
   */
  missing: string[]
}

/**
 * 合并。
 *
 * 顺序 = 注册顺序 (= 插件的装载顺序)。**不排序**: 界面上供应商的次序
 * 应该和"谁先装的"一致, 排序会让它每次启动都可能换位置。
 */
export function catalogOf(providers: readonly ProviderInfo[], entries: readonly ConfigEntry[]): CatalogProvider[] {
  return providers.map((p) => {
    const config = p.configScope ? entries.filter((e) => e.scope === p.configScope) : []
    return {
      id: p.id,
      name: p.name,
      models: [...p.models],
      available: p.available,
      ...(p.configScope ? { configScope: p.configScope } : {}),
      config,
      // **provider 自己说的优先。** 它知道每条路由绑的是哪个变量名;
      // 这层按配置项推只能推"哪一项缺了", 而多路由下缺的是**字典里某一条的某个字段**,
      // 从扁平 entries 里看不出来。config 兜底那条路留给"没实现 missing() 的老 provider"
      missing: p.available ? [] : p.missing && p.missing.length > 0 ? p.missing : missingOf(config),
    }
  })
}

/**
 * 缺什么。两条判据都来自声明本身, 不是猜的:
 *   · 密钥行: 绑定的那个环境变量里没有值 (`present === false`)
 *   · 必填行: resolve 不出来 (`unresolved` 有值, 说明缺必填或类型不对)
 *
 * 一个 provider 完全没声明配置却 still available=false —— 那是它自己的事
 * (比如等着别的东西), 这里给一条兜底文案, 不硬编一个不存在的字段名。
 */
function missingOf(config: readonly ConfigEntry[]): string[] {
  const out: string[] = []
  for (const e of config) {
    if (e.secret && e.present === false) {
      out.push(`${e.secretRef ?? e.key} 里没有值`)
      continue
    }
    if (e.unresolved) out.push(`${e.key} 还没配好: ${e.unresolved}`)
  }
  return out
}
