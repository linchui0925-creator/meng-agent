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
 * ## manifest 层
 *
 * 清单里的 `config:` 值走的是插件 `apply(ctx, config)` 参数, 不走这一层。
 * 原因: 那份配置是**单个插件私有**的, 它不需要跨插件共享, 也就没有
 * "被谁盖过"的问题。这一层留空, 等真有插件需要"清单值可被界面覆盖"再接 ——
 * 现在接就是死代码。
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CONFIG_CODE,
  ConfigError,
  KERNEL_CONFIG,
  provideConfig,
  type ConfigDecl,
  type ConfigEntry,
  type ConfigField,
  type ConfigScope,
  type ConfigService,
  type ConfigSource,
} from '@meng/config'
import type { Ctx, Disposer } from '@meng/core'
import { defineInvariant } from '@meng/core'

/** 环境变量名推导: `sandbox.root` → `MENG_SANDBOX_ROOT` */
function envNameOf(scope: string, key: string): string {
  const raw = `${scope}.${key}`
  return `MENG_${raw.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

/** 把字符串按声明类型转过去。转不过去就抛 —— 静默给默认值会让错配置永远查不出来 */
function coerce(field: ConfigField, raw: unknown, full: string): string | number | boolean {
  if (field.type === 'string') {
    if (typeof raw === 'string') return raw
    // 数字/布尔也该能当字符串用: 用户把端口写成 4721, YAML 会解析成 number
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    throw new ConfigError(CONFIG_CODE.TYPE, full, `${full} 应该是字符串, 拿到 ${typeof raw}`)
  }
  if (field.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw)
      if (Number.isFinite(n)) return n
    }
    throw new ConfigError(CONFIG_CODE.TYPE, full, `${full} 应该是数字, 拿到 ${JSON.stringify(raw)}`)
  }
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ConfigError(CONFIG_CODE.TYPE, full, `${full} 应该是布尔值, 拿到 ${JSON.stringify(raw)}`)
}

interface Slot {
  field: ConfigField
  scope: string
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
    const envName = slot.field.env ?? envNameOf(slot.scope, name)
    const raw = process.env[envName]
    // 空串按"没配"处理。这一条是**统一**的: 老代码一半 `??` 一半 `||`,
    // 空串在一半地方算有效值, 于是 `MENG_WORKSPACE=` 这种写法行为随机
    return raw === undefined || raw === '' ? undefined : raw
  }

  const resolveOne = (
    scope: string,
    key: string,
  ): { value: string | number | boolean | undefined; source?: ConfigSource; secretRef?: string } => {
    const slot = slotOf(scope, key)
    if (!slot) return { value: undefined }
    const full = `${scope}.${key}`
    const field = slot.field

    if (field.secret) {
      // 密钥: settings 里存的是**名字**, 值只从环境读
      const bound = settings[full]
      const envName =
        typeof bound === 'string' && bound.trim() !== ''
          ? bound.trim()
          : (field.env ?? envNameOf(scope, key))
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
      return { value: coerce(field, fromSettings, full), source: 'settings' }
    }

    const raw = fromEnv(slot, key)
    if (raw !== undefined) return { value: coerce(field, raw, full), source: 'env' }

    if (field.default !== undefined) return { value: field.default, source: 'default' }

    if (field.required) {
      throw new ConfigError(CONFIG_CODE.MISSING, full, `缺少必填配置 ${full} (环境变量 ${field.env ?? envNameOf(scope, key)})`)
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
        const mine: Array<[string, ConfigField]> = []
        for (const key of Object.keys(decl)) {
          const field = decl[key]
          if (!field) continue
          const full = `${scope}.${key}`
          slots.set(full, { field, scope })
          mine.push([full, field])
        }
        return () => {
          for (const [full, field] of mine) {
            // 只回收自己那一版: 后来者覆盖过的声明不该被先来者的 disposer 干掉,
            // 否则热重载时会出现"新的声明被旧的卸载顺手删了"
            const cur = slots.get(full)
            if (cur && cur.field === field) slots.delete(full)
          }
          if (mine.length > 0 && ![...slots.values()].some((s) => s.scope === scope)) {
            scopes.delete(scope)
          }
        }
      },
      get<T = string | number | boolean>(key: string): T | undefined {
        if (slotOf(scope, key)?.field.secret) refuseSecret(key, 'get')
        return resolveOne(scope, key).value as T | undefined
      },
      require<T = string | number | boolean>(key: string): T {
        const v = self.get<T>(key)
        if (v === undefined) {
          throw new ConfigError(CONFIG_CODE.MISSING, `${scope}.${key}`, `缺少配置 ${scope}.${key}`)
        }
        return v
      },
      secret(key: string) {
        const slot = slotOf(scope, key)
        if (!slot?.field.secret) return undefined
        return resolveOne(scope, key).value as string | undefined
      },
      secretRef(key: string) {
        const slot = slotOf(scope, key)
        if (!slot?.field.secret) return undefined
        return resolveOne(scope, key).secretRef
      },
      sourceOf(key: string) {
        if (slotOf(scope, key)?.field.secret) {
          // 密钥的来源恒为 env —— 说"settings"会让人以为值存在文件里
          return resolveOne(scope, key).value === undefined ? undefined : 'env'
        }
        return resolveOne(scope, key).source
      },
    }

    scopes.set(scope, self)
    return self
  }

  const service: ConfigService = {
    scope: makeScope,
    list(): ConfigEntry[] {
      const out: ConfigEntry[] = []
      for (const [full, slot] of slots) {
        const at = full.indexOf('.')
        const scope = full.slice(0, at)
        const name = full.slice(at + 1)
        const r = resolveOne(scope, name)
        const entry: ConfigEntry = {
          key: full,
          scope,
          name,
          type: slot.field.type,
          secret: slot.field.secret === true,
          required: slot.field.required === true,
        }
        if (slot.field.default !== undefined) entry.default = slot.field.default
        if (slot.field.desc !== undefined) entry.desc = slot.field.desc
        // 密钥行的 value **恒不给**: 这条 if 是这一层唯一的安全边界
        if (slot.field.secret !== true) {
          if (r.value !== undefined) entry.value = r.value
          if (r.source !== undefined) entry.source = r.source
        } else if (r.secretRef !== undefined) {
          entry.secretRef = r.secretRef
        }
        out.push(entry)
      }
      // 稳定顺序: 设置页靠它, 顺序乱跳会让人以为配置变了
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
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
])
