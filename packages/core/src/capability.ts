/**
 * 能力面 (capability) 命名与版本。
 *
 * 为什么要有这一层: Python 版最大的返工来源是"插件以为自己在用的宿主 API 是这个样"
 * —— 90 个隐式约定散在 README 和代码里。这里把能力面做成**有限枚举 + 版本号**,
 * 插件声明依赖时可以带上版本, 装载时校验, 不匹配就 pending 而不是运行期崩。
 */

export const CAPABILITY_VERSION = 1

export const CAPABILITIES = [
  'llm', // 模型访问: 注册 provider / 流式请求
  'session', // 会话事件流 (真相源)
  'tools', // 工具注册 + 执行管线
  'prompt', // 系统提示分区
  'loop', // 对话循环 (策略层: 由 plugins/loop-* 填, 不在内核)
  'web', // HTTP / SSE 对外面
  'skill', // 技能发现与注入
  'sandbox', // 文件系统 / 子进程边界
  'approval', // 用户审批
] as const

export type Capability = (typeof CAPABILITIES)[number]

export interface CapabilityRef {
  name: Capability | (string & {})
  /** 不写就是 CAPABILITY_VERSION */
  version?: number
}

/** 声明式写依赖: inject: [capability('tools')] */
export function capability(name: Capability, version = CAPABILITY_VERSION): string {
  return version === CAPABILITY_VERSION ? name : `${name}@${version}`
}

/** 把 inject 里的字符串拆成 name / version */
export function parseRef(ref: string): { name: string; version: number } {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return { name: ref, version: CAPABILITY_VERSION }
  const version = Number(ref.slice(at + 1))
  return { name: ref.slice(0, at), version: Number.isFinite(version) ? version : CAPABILITY_VERSION }
}

/** 装载前校验: 返回缺失或不兼容的能力面 */
export function checkCapabilities(
  present: (name: string) => boolean,
  inject: string[],
): { missing: string[]; incompatible: string[] } {
  const missing: string[] = []
  const incompatible: string[] = []
  for (const ref of inject) {
    const { name, version } = parseRef(ref)
    if (!present(name)) missing.push(name)
    else if (version !== CAPABILITY_VERSION) incompatible.push(`${name}@${version} ≠ @${CAPABILITY_VERSION}`)
  }
  return { missing, incompatible }
}
