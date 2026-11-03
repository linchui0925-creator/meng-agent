/**
 * @meng/core — 内核契约。
 *
 * 只导出契约与机制, 不导出任何业务能力。
 * 任何想在这里加"顺手实现一下"的冲动, 都应该变成一个新的 packages/*。
 */

export {
  createContext,
  disposeFrom,
  type Ctx,
  type Disposer,
  type Handler,
  type OnOptions,
} from './context.ts'

export { StatusGraph, type ClientFace, type NodeRecord, type PluginStatus } from './status.ts'

/**
 * loader **不从这里导出**: 它 import node:fs / node:path, 一旦被 barrel 带出去,
 * 浏览器包会尝试解析 node 内置模块 (Vite 会 externalize 成运行时炸弹)。
 * 需要它的地方 (目前只有 apps/server) 走 '@meng/core/loader'。
 *
 * 但**类型**可以留: `export type` 在编译期被完全擦除, 不会产生运行时 import。
 * 少了这行, server 侧 `MountedRow` 就没地方取了。
 */
export type { MountedRow, PatchRow } from './loader.ts'

export {
  CAPABILITIES,
  CAPABILITY_VERSION,
  capability,
  checkCapabilities,
  parseRef,
  type Capability,
  type CapabilityRef,
} from './capability.ts'

export {
  defineInvariant,
  runInvariants,
  type Check,
  type CheckResult,
  type Invariant,
} from './invariant.ts'

export { MengError, errorFacts } from './error.ts'
