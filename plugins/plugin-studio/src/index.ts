import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineInvariant, type Ctx } from '@meng/core'
import { buildPlugin } from './build.ts'
import { packPlugin, verifyPlugin, verifyPluginPackage } from './package.ts'
import { installArchive, installPackage, rollbackLast, uninstallPlugin } from './install.ts'
import { ProfileStore } from '@meng/plugin-manifest'
import { loadCatalog, loadSignedCatalog, searchCatalog, findUpdates, installFromCatalog, type RevocationList } from './catalog.ts'
import { PublisherStore } from './publishers.ts'
import { LocalPluginTelemetry } from './telemetry.ts'
import { OfficialSourceStore } from './sources.ts'
import { MarketOperations } from './market.ts'
import { addTrustedKey, generateSigningKey, signArchive, writeSignature } from './signing.ts'
import { scaffoldPlugin } from './scaffold.ts'
import type { AdapterKind } from './manifest.ts'
import type { PluginKind } from './types.ts'
import { validatePlugin } from './validate.ts'

export { buildPlugin } from './build.ts'
export { packPlugin, verifyPlugin, verifyPluginPackage } from './package.ts'
export { installArchive, installPackage, rollbackLast, uninstallPlugin, type InstallOptions, type InstallResult, type PackageInstallOptions, type RollbackResult, type UninstallResult } from './install.ts'
export { addTrustedKey, generateSigningKey, readSignature, readTrustStore, signArchive, verifyArchiveSignature, writeSignature, type SignatureEnvelope, type SigningKey, type TrustStore } from './signing.ts'
export { compareVersions, findUpdates, installFromCatalog, latestVersion, loadCatalog, resolveVersion, rolloutBucket, searchCatalog, validateCatalog, type CatalogPlugin, type CatalogUpdate, type CatalogVersion, type PluginCatalog } from './catalog.ts'
export { PublisherStore, type PublisherRecord } from './publishers.ts'
export { LocalPluginTelemetry, type PluginEvent, type TelemetrySummary } from './telemetry.ts'
export { OfficialSourceStore, type OfficialSource } from './sources.ts'
export { MarketOperations, type MarketDashboard, type MarketPaths, type MarketSearchResult } from './market.ts'
export { scaffoldPlugin } from './scaffold.ts'
export type {
  BuildResult,
  PackResult,
  PluginKind,
  ScaffoldOptions,
  ScaffoldResult,
  ValidationResult,
  VerifyResult,
} from './types.ts'
export { validatePlugin } from './validate.ts'
export { validateProfileManifest, type ProfileValidation } from './profile.ts'
export {
  ADAPTER_KINDS,
  RUNTIME_MODES,
  validateMengExtensions,
  type AdapterKind,
  type AdapterRuntimeMode,
  type ManifestReport,
} from './manifest.ts'

export const name = 'meng-plugin-studio'
export const inject = ['tools', 'prompt', 'web']

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  mutates?: boolean
  group?: string
  timeoutMs?: number
  handler(args: Record<string, unknown>): Promise<unknown> | unknown
}

interface Tools {
  register(def: ToolDef): () => void
  list(): Array<{ name: string }>
}

interface Prompt {
  section(section: { id: string; order: number; render(): string }): () => void
}

interface Web {
  op(name: string, handler: (payload: Record<string, unknown>) => unknown): () => void
}

const writeSchema = {
  type: 'object',
  properties: {
    directory: { type: 'string', description: '插件目录' },
    confirm: { type: 'boolean', description: '用户已明确同意写入或执行生成代码' },
  },
  required: ['directory', 'confirm'],
  additionalProperties: false,
}

export function apply(ctx: Ctx): void {
  const tools = ctx.get<Tools>('tools')
  const prompt = ctx.get<Prompt>('prompt')
  const web = ctx.get<Web>('web')
  if (!tools || !prompt || !web) throw new Error('需要 tools、prompt 与 web 能力面')

  // 工具名用下划线, 不用点号: 厂商接口对 function.name 的规则是
  // `^[a-zA-Z0-9_-]+$` (OpenAI / DeepSeek / Gemini 一致), 点号会被整包拒掉 ——
  // 一次 400 就让这一轮所有工具都用不了, 不只是这一个名字
  const register = (def: ToolDef) => ctx.effect(() => tools.register({ group: 'plugin-studio', ...def }))
  register({
    name: 'studio_spec',
    description: '读取梦插件包规范',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => result(spec()),
  })
  register({
    name: 'studio_profile_list',
    description: '列出梦 profile 中已安装、启停状态和插件配置',
    parameters: {
      type: 'object',
      properties: { directory: { type: 'string' } },
      required: ['directory'],
      additionalProperties: false,
    },
    handler: (args) => {
      const plugins = new ProfileStore(text(args.directory)).init().pkg.meng?.profile?.bundles?.map((name) => {
        const state = new ProfileStore(text(args.directory)).list().find((item) => item.name === name)
        return state
      }) ?? []
      return result('profile 插件清单', { plugins })
    },
  })
  register({
    name: 'studio_profile_add',
    description: '把插件 bundle 登记到 profile；只改清单和依赖，不联网安装',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'string' },
        enabled: { type: 'boolean' },
        config: { type: 'object', additionalProperties: true },
        confirm: { type: 'boolean' },
      },
      required: ['directory', 'name', 'version', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const store = new ProfileStore(text(args.directory))
      store.init()
      const config = isRecord(args.config) ? { ...args.config } : {}
      if (typeof args.enabled === 'boolean') config.enabled = args.enabled
      const state = store.add(text(args.name), text(args.version), config)
      return result('插件已登记到 profile', state.pkg)
    }),
  })
  register({
    name: 'studio_profile_set',
    description: '修改 profile 中插件的启停状态和配置',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        config: { type: 'object', additionalProperties: true },
        confirm: { type: 'boolean' },
      },
      required: ['directory', 'name', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const store = new ProfileStore(text(args.directory))
      const name = text(args.name)
      if (typeof args.enabled === 'boolean') store.setEnabled(name, args.enabled)
      if (isRecord(args.config)) store.setConfig(name, { ...args.config })
      return result('profile 插件配置已更新', store.list().find((item) => item.name === name))
    }),
  })
  register({
    name: 'studio_profile_remove',
    description: '从 profile 清单中移除插件 bundle；默认不删除用户数据',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        name: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['directory', 'name', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const state = new ProfileStore(text(args.directory)).remove(text(args.name))
      return result('插件已从 profile 移除', state.pkg)
    }),
  })
  register({
    name: 'studio_keygen',
    description: '生成 Ed25519 插件签名密钥对；私钥以 0600 写入指定文件',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        privateKeyFile: { type: 'string' },
        publicKeyFile: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['privateKeyFile', 'publicKeyFile', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const keys = generateSigningKey()
      writeFileSync(text(args.privateKeyFile), keys.privateKey, { mode: 0o600 })
      writeFileSync(text(args.publicKeyFile), keys.publicKey)
      return result(`签名密钥已生成: ${keys.keyId}`, { keyId: keys.keyId })
    }),
  })
  register({
    name: 'studio_sign_archive',
    description: '为插件 tgz 生成 detached Ed25519 签名',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        archive: { type: 'string' },
        privateKeyFile: { type: 'string' },
        keyId: { type: 'string' },
        output: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['archive', 'privateKeyFile', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const envelope = signArchive(
        text(args.archive),
        readFileSync(text(args.privateKeyFile), 'utf8'),
        optional(args.keyId),
      )
      const file = writeSignature(text(args.archive), envelope, optional(args.output))
      return result('插件已签名', { file, envelope })
    }),
  })
  register({
    name: 'studio_trust_add',
    description: '把 Ed25519 公钥加入信任密钥库',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        trustStore: { type: 'string' },
        publicKeyFile: { type: 'string' },
        keyId: { type: 'string' },
        name: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['trustStore', 'publicKeyFile', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const keyId = addTrustedKey(text(args.trustStore), readFileSync(text(args.publicKeyFile), 'utf8'), {
        ...(optional(args.keyId) ? { keyId: optional(args.keyId) } : {}),
        ...(optional(args.name) ? { name: optional(args.name) } : {}),
      })
      return result(`公钥已信任: ${keyId}`, { keyId })
    }),
  })
  register({
    name: 'studio_catalog_search',
    description: '读取市场 catalog 并按关键词搜索',
    parameters: {
      type: 'object',
      properties: { source: { type: 'string' }, query: { type: 'string' } },
      required: ['source'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const catalog = await loadCatalog(text(args.source))
      return result('catalog 搜索结果', searchCatalog(catalog, optional(args.query) ?? ''))
    },
  })
  register({
    name: 'studio_catalog_updates',
    description: '比较 profile 已安装插件与市场 catalog',
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string' }, source: { type: 'string' }, channel: { type: 'string' },
        rolloutKey: { type: 'string' },
      },
      required: ['profile', 'source'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const catalog = await loadCatalog(text(args.source))
      return result('可用更新', findUpdates(
        text(args.profile),
        catalog,
        optional(args.channel) ?? 'stable',
        optional(args.rolloutKey) ?? text(args.profile),
      ))
    },
  })
  register({
    name: 'studio_catalog_install',
    description: '从市场 catalog 下载并安装插件',
    mutates: true,
    timeoutMs: 180_000,
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        source: { type: 'string' },
        pluginId: { type: 'string' },
        version: { type: 'string' },
        channel: { type: 'string' },
        rolloutKey: { type: 'string' },
        trustStore: { type: 'string' },
        requireSignature: { type: 'boolean' },
        publisherStore: { type: 'string' },
        telemetryDir: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['profile', 'source', 'pluginId', 'confirm'],
      additionalProperties: false,
    },
    handler: async (args) => guardAsync(args, async () =>
      result('市场插件已安装', await installFromCatalog(
        text(args.profile),
        text(args.source),
        text(args.pluginId),
        {
          ...(optional(args.version) ? { version: optional(args.version) } : {}),
          ...(optional(args.channel) ? { channel: optional(args.channel) } : {}),
          ...(optional(args.rolloutKey) ? { rolloutKey: optional(args.rolloutKey) } : {}),
          ...(optional(args.trustStore) ? { trustStore: optional(args.trustStore) } : {}),
          ...(args.requireSignature === true ? { requireSignature: true } : {}),
          ...(optional(args.publisherStore) ? { publisherStore: optional(args.publisherStore) } : {}),
          ...(optional(args.telemetryDir) ? { telemetryDir: optional(args.telemetryDir) } : {}),
        },
      )),
    ),
  })
  register({
    name: 'studio_publisher_add',
    description: '登记插件发布者公钥并绑定 keyId',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' },
        publicKeyFile: { type: 'string' }, keyId: { type: 'string' }, confirm: { type: 'boolean' },
      },
      required: ['file', 'id', 'name', 'publicKeyFile', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => result('发布者已登记', new PublisherStore(text(args.file)).add({
      id: text(args.id), name: text(args.name), publicKey: readFileSync(text(args.publicKeyFile), 'utf8'),
      ...(optional(args.keyId) ? { keyId: optional(args.keyId) } : {}),
    }))),
  })
  register({
    name: 'studio_publisher_set',
    description: '暂停或恢复发布者',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' }, id: { type: 'string' }, suspended: { type: 'boolean' }, confirm: { type: 'boolean' } },
      required: ['file', 'id', 'suspended', 'confirm'], additionalProperties: false,
    },
    handler: (args) => guard(args, () => result('发布者状态已更新', new PublisherStore(text(args.file)).suspend(text(args.id), args.suspended === true))),
  })
  register({
    name: 'studio_source_add',
    description: '登记官方插件市场源',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, catalog: { type: 'string' },
        signature: { type: 'string' }, trustStore: { type: 'string' }, priority: { type: 'number' },
        confirm: { type: 'boolean' },
      },
      required: ['file', 'id', 'name', 'catalog', 'confirm'], additionalProperties: false,
    },
    handler: (args) => guard(args, () => result('市场源已登记', new OfficialSourceStore(text(args.file)).add({
      id: text(args.id), name: text(args.name), catalog: text(args.catalog),
      ...(optional(args.signature) ? { signature: optional(args.signature) } : {}),
      ...(optional(args.trustStore) ? { trustStore: optional(args.trustStore) } : {}),
      ...(typeof args.priority === 'number' ? { priority: args.priority } : { priority: 100 }),
    }))),
  })
  register({
    name: 'studio_market_feedback',
    description: '记录本地插件兼容反馈和评分',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' }, pluginId: { type: 'string' }, version: { type: 'string' },
        compatible: { type: 'string', enum: ['ok', 'broken', 'unknown'] }, rating: { type: 'number' },
        note: { type: 'string' }, confirm: { type: 'boolean' },
      },
      required: ['directory', 'pluginId', 'confirm'], additionalProperties: false,
    },
    handler: (args) => guard(args, () => result('反馈已记录', new LocalPluginTelemetry(text(args.directory)).record({
      type: 'feedback', pluginId: text(args.pluginId),
      ...(optional(args.version) ? { version: optional(args.version) } : {}),
      compatible: (optional(args.compatible) ?? 'unknown') as 'ok' | 'broken' | 'unknown',
      ...(typeof args.rating === 'number' ? { rating: Math.max(1, Math.min(5, Math.round(args.rating))) } : {}),
      ...(optional(args.note) ? { note: optional(args.note) } : {}),
    }))),
  })
  register({
    name: 'studio_market_telemetry',
    description: '读取本地插件安装、崩溃和兼容反馈汇总',
    parameters: {
      type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'], additionalProperties: false,
    },
    handler: (args) => result('本地市场遥测', new LocalPluginTelemetry(text(args.directory)).summary()),
  })
  register({
    name: 'studio_install',
    description: '校验并安装自包含插件 tgz 到 profile；失败自动回滚，不联网',
    mutates: true,
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'profile 目录' },
        archive: { type: 'string', description: '插件 .tgz 路径' },
        expectedSha256: { type: 'string', description: '可选的 tgz SHA-256' },
        signature: { type: 'string', description: '可选 detached 签名文件' },
        trustStore: { type: 'string', description: '可选信任密钥库' },
        requireSignature: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
      required: ['profile', 'archive', 'confirm'],
      additionalProperties: false,
    },
    handler: async (args) => guardAsync(args, async () =>
      result('插件已安装', await installArchive(text(args.profile), text(args.archive), {
        ...(optional(args.expectedSha256) ? { expectedSha256: optional(args.expectedSha256) } : {}),
        ...(optional(args.signature) ? { signature: optional(args.signature) } : {}),
        ...(optional(args.trustStore) ? { trustStore: optional(args.trustStore) } : {}),
        ...(args.requireSignature === true ? { requireSignature: true } : {}),
      })),
    ),
  })
  register({
    name: 'studio_install_package',
    description: '用 npm 安装带运行依赖的插件 tgz；联网需显式 allowNetwork=true，失败自动回滚',
    mutates: true,
    timeoutMs: 180_000,
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        archive: { type: 'string' },
        allowNetwork: { type: 'boolean' },
        npmCache: { type: 'string' },
        packageManager: { type: 'string', enum: ['npm', 'pnpm'] },
        registry: { type: 'string' },
        expectedSha256: { type: 'string' },
        signature: { type: 'string' },
        trustStore: { type: 'string' },
        requireSignature: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
      required: ['profile', 'archive', 'confirm'],
      additionalProperties: false,
    },
    handler: async (args) => guardAsync(args, async () =>
      result('插件及依赖已安装', await installPackage(text(args.profile), text(args.archive), {
        ...(args.allowNetwork === true ? { allowNetwork: true } : {}),
        ...(optional(args.npmCache) ? { npmCache: optional(args.npmCache) } : {}),
        ...(optional(args.packageManager) ? { packageManager: optional(args.packageManager) as 'npm' | 'pnpm' } : {}),
        ...(optional(args.registry) ? { registry: optional(args.registry) } : {}),
        ...(optional(args.expectedSha256) ? { expectedSha256: optional(args.expectedSha256) } : {}),
        ...(optional(args.signature) ? { signature: optional(args.signature) } : {}),
        ...(optional(args.trustStore) ? { trustStore: optional(args.trustStore) } : {}),
        ...(args.requireSignature === true ? { requireSignature: true } : {}),
      })),
    ),
  })
  register({
    name: 'studio_uninstall',
    description: '从 profile 卸载插件程序；默认保留 .meng 数据目录',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        name: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['profile', 'name', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () =>
      result('插件已卸载，用户数据保留', uninstallPlugin(text(args.profile), text(args.name))),
    ),
  })
  register({
    name: 'studio_rollback',
    description: '回滚最近一次插件安装或卸载事务',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        transactionId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['profile', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () =>
      result('插件事务已回滚', rollbackLast(text(args.profile), optional(args.transactionId))),
    ),
  })
  register({
    name: 'studio_create',
    description: '创建后端、前端或全栈插件骨架；不会覆盖已有目录',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        packageName: { type: 'string' },
        kind: { type: 'string', enum: ['backend', 'frontend', 'fullstack'] },
        adapter: { type: 'string', enum: ['library', 'cli', 'http', 'sidecar', 'mcp', 'ui'] },
        sourcePackage: { type: 'string', description: '上游包名或项目标识' },
        description: { type: 'string' },
        output: { type: 'string' },
        source: { type: 'string', description: '可选外部源码路径，只读，不复制' },
        confirm: { type: 'boolean' },
      },
      required: ['id', 'output', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      const created = scaffoldPlugin({
        id: text(args.id),
        output: text(args.output),
        packageName: optional(args.packageName),
        kind: (optional(args.kind) ?? 'backend') as PluginKind,
        adapter: optional(args.adapter) as AdapterKind | undefined,
        sourcePackage: optional(args.sourcePackage),
        description: optional(args.description),
        source: optional(args.source),
      })
      return result('插件骨架已创建；继续实现业务代码后再构建', created)
    }),
  })
  register({
    name: 'studio_adapt',
    description: '以只读外部源码为起点创建适配插件；业务迁移由当前对话完成',
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        packageName: { type: 'string' },
        kind: { type: 'string', enum: ['backend', 'frontend', 'fullstack'] },
        adapter: { type: 'string', enum: ['library', 'cli', 'http', 'sidecar', 'mcp', 'ui'] },
        sourcePackage: { type: 'string' },
        description: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['id', 'source', 'output', 'confirm'],
      additionalProperties: false,
    },
    handler: (args) => guard(args, () => {
      if (!args.source) throw new Error('适配外部功能必须提供 source')
      const created = scaffoldPlugin({
        id: text(args.id),
        output: text(args.output),
        packageName: optional(args.packageName),
        kind: (optional(args.kind) ?? 'fullstack') as PluginKind,
        adapter: (optional(args.adapter) ?? 'library') as AdapterKind,
        sourcePackage: optional(args.sourcePackage),
        description: optional(args.description),
        source: text(args.source),
      })
      return result('适配骨架已创建；请只读分析原源码，在新目录实现插件入口', created)
    }),
  })
  register({
    name: 'studio_validate',
    description: '校验插件清单和分发产物',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        built: { type: 'boolean', description: 'false 时只校验源码包结构' },
      },
      required: ['directory'],
      additionalProperties: false,
    },
    handler: (args) => {
      const report = validatePlugin(text(args.directory), { built: args.built !== false })
      return { ok: report.ok, text: report.ok ? '插件规范校验通过' : report.errors.join('\n'), value: report }
    },
  })
  register({
    name: 'studio_build',
    description: '构建后端 JavaScript、类型声明和可选前端 bundle',
    mutates: true,
    timeoutMs: 120_000,
    parameters: writeSchema,
    handler: async (args) => guardAsync(args, async () => result('插件构建完成', await buildPlugin(text(args.directory)))),
  })
  register({
    name: 'studio_pack',
    description: '构建并生成真实 .tgz 分发包，不发布',
    mutates: true,
    timeoutMs: 120_000,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        destination: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['directory', 'destination', 'confirm'],
      additionalProperties: false,
    },
    handler: async (args) => guardAsync(args, async () =>
      result('分发包已生成', await packPlugin(text(args.directory), text(args.destination))),
    ),
  })
  register({
    name: 'studio_verify',
    description: '在临时上下文装载插件并检查不变量；压缩包会先隔离解包，不是安全沙箱',
    mutates: true,
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        archive: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    handler: async (args) => guardAsync(args, async () => {
      if (!args.directory && !args.archive) throw new Error('directory 与 archive 至少提供一个')
      const report = args.archive
        ? await verifyPluginPackage(text(args.archive))
        : await verifyPlugin(text(args.directory))
      return { ok: report.ok, text: report.details.join('\n'), value: report }
    }),
  })
  const profileDir = (payload: Record<string, unknown>): string => {
    const raw = typeof payload.profile === 'string' && payload.profile.trim()
      ? payload.profile.trim()
      : process.env['MENG_PROFILE_DIR']
    return resolve(raw || join(process.env['MENG_DATA_DIR'] || '.meng', 'profile'))
  }
  const registerWeb = (name: string, handler: (payload: Record<string, unknown>) => unknown): void => {
    ctx.effect(() => web.op(name, handler))
  }
  const market = (payload: Record<string, unknown>): MarketOperations =>
    new MarketOperations(profileDir(payload), optional(payload.dataDir))
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []

  registerWeb('pluginMarket.dashboard', (payload) => market(payload).dashboard())
  registerWeb('pluginMarket.search', async (payload) => market(payload).search({
    ...(optional(payload.source) ? { source: optional(payload.source) } : {}),
    ...(optional(payload.sourceId) ? { sourceId: optional(payload.sourceId) } : {}),
    ...(optional(payload.query) ? { query: optional(payload.query) } : {}),
  }))
  registerWeb('pluginMarket.updates', async (payload) => market(payload).updates({
    ...(optional(payload.source) ? { source: optional(payload.source) } : {}),
    ...(optional(payload.sourceId) ? { sourceId: optional(payload.sourceId) } : {}),
    ...(optional(payload.channel) ? { channel: optional(payload.channel) } : {}),
    ...(optional(payload.rolloutKey) ? { rolloutKey: optional(payload.rolloutKey) } : {}),
  }))
  registerWeb('pluginMarket.install', async (payload) => {
    confirm(payload)
    return await market(payload).install({
      ...(optional(payload.source) ? { source: optional(payload.source) } : {}),
      ...(optional(payload.sourceId) ? { sourceId: optional(payload.sourceId) } : {}),
      pluginId: text(payload.pluginId),
      ...(optional(payload.version) ? { version: optional(payload.version) } : {}),
      ...(optional(payload.channel) ? { channel: optional(payload.channel) } : {}),
      ...(optional(payload.rolloutKey) ? { rolloutKey: optional(payload.rolloutKey) } : {}),
      ...(optional(payload.trustStore) ? { trustStore: optional(payload.trustStore) } : {}),
      ...(payload.requireSignature === true ? { requireSignature: true as const } : {}),
      ...(isRecord(payload.revocations) ? { revocations: payload.revocations } : {}),
    })
  })
  registerWeb('pluginMarket.uninstall', (payload) => {
    confirm(payload)
    return market(payload).uninstall(text(payload.name))
  })
  registerWeb('pluginMarket.publisher.add', (payload) => {
    confirm(payload)
    return market(payload).addPublisher({
      id: text(payload.id),
      name: text(payload.name),
      publicKey: text(payload.publicKey),
      ...(optional(payload.keyId) ? { keyId: optional(payload.keyId) } : {}),
      ...(strings(payload.roles).length ? { roles: strings(payload.roles) } : {}),
    })
  })
  registerWeb('pluginMarket.publisher.set', (payload) => {
    confirm(payload)
    return market(payload).setPublisher(text(payload.id), payload.suspended === true)
  })
  registerWeb('pluginMarket.source.add', (payload) => {
    confirm(payload)
    return market(payload).addSource({
      id: text(payload.id),
      name: text(payload.name),
      catalog: text(payload.catalog),
      ...(optional(payload.signature) ? { signature: optional(payload.signature) } : {}),
      ...(optional(payload.trustStore) ? { trustStore: optional(payload.trustStore) } : {}),
      ...(typeof payload.priority === 'number' ? { priority: payload.priority } : {}),
      ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
      ...(strings(payload.mirrors).length ? { mirrors: strings(payload.mirrors) } : {}),
    })
  })
  registerWeb('pluginMarket.source.set', (payload) => {
    confirm(payload)
    return market(payload).setSource(text(payload.id), {
      ...(optional(payload.name) ? { name: optional(payload.name) } : {}),
      ...(optional(payload.catalog) ? { catalog: optional(payload.catalog) } : {}),
      ...(optional(payload.signature) ? { signature: optional(payload.signature) } : {}),
      ...(optional(payload.trustStore) ? { trustStore: optional(payload.trustStore) } : {}),
      ...(typeof payload.priority === 'number' ? { priority: payload.priority } : {}),
      ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
      ...(Array.isArray(payload.mirrors) ? { mirrors: strings(payload.mirrors) } : {}),
    })
  })
  registerWeb('pluginMarket.source.remove', (payload) => {
    confirm(payload)
    market(payload).removeSource(text(payload.id))
    return { ok: true }
  })
  registerWeb('pluginMarket.feedback', (payload) => market(payload).recordFeedback({
    pluginId: text(payload.pluginId),
    ...(optional(payload.version) ? { version: optional(payload.version) } : {}),
    ...(optional(payload.compatible) ? { compatible: optional(payload.compatible) as 'ok' | 'broken' | 'unknown' } : {}),
    ...(typeof payload.rating === 'number' ? { rating: payload.rating } : {}),
    ...(optional(payload.note) ? { note: optional(payload.note) } : {}),
  }))
  registerWeb('pluginMarket.telemetry', (payload) => market(payload).telemetry({
    ...(typeof payload.limit === 'number' ? { limit: payload.limit } : {}),
    ...(optional(payload.pluginId) ? { pluginId: optional(payload.pluginId) } : {}),
  }))
  ctx.effect(() => prompt.section({ id: 'plugin-studio', order: 160, render: studioPrompt }))
}

export const invariant = defineInvariant('@meng/plugin-studio', [{
  id: 'tools-ready',
  run(ctx) {
    const tools = ctx.get<Tools>('tools')
    const required = ['studio_create', 'studio_adapt', 'studio_validate', 'studio_build', 'studio_pack', 'studio_verify']
    if (!tools || required.some((id) => !tools.list().some((tool) => tool.name === id))) {
      throw new Error('插件工坊工具未完整注册')
    }
  },
}])

function studioPrompt(): string {
  return `你可以通过插件工坊把自然语言需求或本地外部功能做成梦插件。
流程：明确插件 id、类型和输出目录；写入或执行前取得用户确认；用 studio_create 创建新插件，或用 studio_adapt 适配本地源码。
外部源码只读，不覆盖原目录，不复制密钥。先判断项目形态：library / cli / http / sidecar / mcp / ui，再选择对应适配器。
必须在 package.json 的 meng.adapter 和 adapter.manifest.yml 中写清 source、runtime、capabilities、compatibility 与 unsupported，不得声称未适配功能可用。
后端能力通过 ctx.get(name) 注入，不直接 import 其他插件内部文件。前端共享 React 等宿主模块，样式标记 data-plugin，所有副作用可卸载。
完成后依次 studio_validate、studio_build、studio_pack、studio_verify。验证只用 Mock，不调用真实付费模型。具体字段以 studio_spec 为准。`
}

function spec(): string {
  return readFileSync(new URL('../PLUGIN_SPEC.md', import.meta.url), 'utf8')
}

function result(text: string, value?: unknown): { ok: boolean; text: string; value?: unknown } {
  return { ok: true, text, ...(value === undefined ? {} : { value }) }
}

function guard(args: Record<string, unknown>, run: () => unknown): unknown {
  try {
    confirm(args)
    return run()
  } catch (error) {
    return failure(error)
  }
}

async function guardAsync(args: Record<string, unknown>, run: () => Promise<unknown>): Promise<unknown> {
  try {
    confirm(args)
    return await run()
  } catch (error) {
    return failure(error)
  }
}

function confirm(args: Record<string, unknown>): void {
  if (args.confirm !== true) throw new Error('需要用户明确确认：confirm=true')
}

function failure(error: unknown): { ok: boolean; text: string; error: string } {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, text: message, error: message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('字符串参数不能为空')
  return value
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
