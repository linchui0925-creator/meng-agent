/**
 * @meng/plugin-policy-approval —— 权限模式 (三档) 的执行者。
 *
 * 零能力面: 只挂 `tools/pre-execute`。三档语义写在 `sandbox.mode` 的声明里,
 * 这里只负责"按模式把决定翻译成 放行 / 问 / 拒"。
 *
 * ## 为什么审批挂在这一层, 不挂在 fs 的 intent 槽
 *
 * 因为**只有这里拿得到完整上下文**。`tools/pre-execute` 的入参是 ToolCall,
 * 带 sessionId / runId / signal —— 审批卡片要路由回某个会话的某一轮, 少了这些
 * 就弹不出来。fs 的 intent 槽只有一个路径和几个标记, 它连"这次是谁在问"都不知道。
 *
 * ## 批准之后怎么越过围栏
 *
 * 批准发生在工具执行**之前**, 而围栏在**更下面** (fs seam)。如果什么都不做,
 * 用户点了"允许", 底下那道围栏仍然会拒 —— 界面上就是"我明明批准了它还说越界"。
 *
 * 所以批准时把凭据写进 `call.grants`, 一路传到 seam: 一次调用一份, 用完即弃。
 * **不用"临时改全局模式"**: 那会让一次批准顺带放开同时跑着的别的调用。
 *
 * ## 三档
 *
 * | | 请求批准 `ask` | 帮我批准 `auto` | 绝对权限 `full` |
 * |---|---|---|---|
 * | 工作区内读 | 放行 | 放行 | 放行 |
 * | 工作区内写/改 | **问** | 放行 | 放行 |
 * | 工作区内跑命令 | **问** | 放行 | 放行 |
 * | 读工作区外 | **问** | **问** | 放行 |
 * | 写工作区外 | **问** | **问** | 放行 |
 * | 写敏感路径 | **问** | **问** | 放行 |
 * | 灾难命令 (rm -rf / 等) | **拒** | **拒** | **拒** |
 *
 * 最后一行三档一致, 而且不在这里: 它是 `policy-bash` 的止血带, 而且优先级更高
 * (100 > 90) 所以先跑。它拦的不是权限而是"一次执行就不可逆" —— 绝对权限是
 * "不用问我", 不是"替我删库"。
 *
 * ## 什么是"高风险"
 *
 * 只有两类, 都是**结构上可判定的**, 不是猜命令:
 *   1. 目标在工作区之外 (读/写/执行的工作目录)
 *   2. 目标是敏感路径 (.git / .env / .ssh / id_rsa / .npmrc)
 *
 * 刻意**不**做"这条命令看起来危险"的猜测 —— 那正是 policy-bash 头部吐槽的老路
 * (拿正则当权限系统)。命令的风险由模型自己申报 (`sandbox_permissions`) 和
 * 灾难命令表兜底。
 */

import { relative, resolve, sep } from 'node:path'
import { sandboxMode, sandboxRoot } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import { isWithin } from '@meng/fs'
import type { PreDecision, ToolCall, ToolDef } from '@meng/tools'

export const name = 'meng-plugin-policy-approval'
/** 刻意不写 inject: 钩子先挂上, 工具后注册也一样拦得住 */
export const inject: string[] = []

export interface Config {
  /** 敏感路径: 写这些要问。默认与 policy-fs 的 noWrite 同一组 */
  sensitive?: string[]
}

const DEFAULT_SENSITIVE = ['.git/', '.env', '.ssh/', 'id_rsa', '.npmrc']

/** 参数里可能带路径的键。取到几个判几个, 取不到就是"没有目标" */
const PATH_KEYS = ['file_path', 'path', 'workdir'] as const

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const sensitive = config.sensitive ?? DEFAULT_SENSITIVE

  const off = ctx.on(
    'tools/pre-execute',
    (call: ToolCall, def: ToolDef, next: () => Promise<PreDecision>): Promise<PreDecision> | PreDecision => {
      // **每次现读**: 模式可以在设置页里改, 改完下一次工具调用就按新的判
      const mode = sandboxMode(ctx)
      if (mode === 'full') return next()

      const root = sandboxRoot(ctx)
      const targets = targetsOf(call)
      const outside = targets.filter((t) => !isWithin(root, t))
      const hitSensitive = targets.filter((t) => isSensitive(root, t, sensitive))

      if (mode === 'auto') {
        // 只有高风险才问。工作区内的常规读写、普通命令一律自主
        if (outside.length === 0 && hitSensitive.length === 0) return next()
      } else {
        // 请求批准: 会改东西的一律问; 只读工具工作区内不问 (读不破坏任何东西,
        // 每次都问会把"看一眼代码"变成一连串弹窗, 用户会直接切到绝对权限)
        if (def.mutates !== true && outside.length === 0) return next()
      }

      // 批准后要让底下的围栏放行 —— 凭据先写上。被拒绝时工具不会执行,
      // 这份凭据也就没人读, 不存在"拒了却放开"的窗口
      call.grants = {
        ...(outside.length > 0 ? { outside: true } : {}),
        ...(hitSensitive.length > 0 ? { sensitive: true } : {}),
      }
      return { allow: 'ask', reason: reasonOf(call, def, outside, hitSensitive) }
    },
    // 数值越大越先执行。policy-bash 是 100 —— 灾难命令必须在"问用户"之前
    // 就被拒掉: 让用户去批一条 rm -rf / 是把风险转嫁给一个正在赶时间的人
    { priority: 90 },
  )

  return () => off()
}

function targetsOf(call: ToolCall): string[] {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const raw = call.args[key]
    if (typeof raw === 'string' && raw.trim() !== '') out.push(raw.trim())
  }
  return out
}

function isSensitive(root: string, target: string, patterns: readonly string[]): boolean {
  const rel = relative(root, resolve(root, target)).split(sep).join('/')
  return patterns.some((p) => {
    const pat = p.split('\\').join('/')
    return rel === pat || rel.startsWith(pat.endsWith('/') ? pat : pat + '/')
  })
}

/** 给审批卡片的一句话。说清楚"要动哪里、为什么被拦", 不重复"允许执行 X?" */
function reasonOf(call: ToolCall, def: ToolDef, outside: string[], hitSensitive: string[]): string {
  const parts: string[] = []
  if (outside.length > 0) parts.push(`目标在工作区外: ${outside.join(', ')}`)
  if (hitSensitive.length > 0) parts.push(`目标是敏感路径: ${hitSensitive.join(', ')}`)
  if (parts.length === 0) {
    // 请求批准模式下, 工作区内的写/执行也走这里 —— 没有"越界"可讲, 就说它在干什么
    const verb = call.name === 'bash' ? '要执行一条命令' : `会改动文件 (${call.name})`
    parts.push(def.mutates === true ? verb : `${call.name} 会改动东西`)
  }
  return parts.join(' · ')
}

export const invariant = defineInvariant('@meng/plugin-policy-approval', [
  {
    /**
     * 三档 × 三类目标的决定表。**测"决定"而不真的执行** —— 真跑一次会弹一张
     * 没人回答的审批卡, 自检会挂住 (这条是踩过的: 上一版 tool-bash 的围栏断言
     * 就是这么把 `meng graph` 拖到 10 秒超时的)。
     *
     * 断言按**当前模式**对表, 所以三种配置下这条都成立 —— 不是只测默认档。
     */
    id: 'mode-decides',
    async run(ctx) {
      const mode = sandboxMode(ctx)

      const decide = async (
        name: string,
        args: Record<string, unknown>,
        mutates: boolean,
      ): Promise<PreDecision> => {
        const def: ToolDef = {
          name,
          description: '',
          parameters: {},
          ...(mutates ? { mutates: true } : {}),
          handler: () => ({ ok: true, text: '' }),
        }
        return ctx.waterfall<PreDecision>(
          'tools/pre-execute',
          [{ id: 'invariant', name, args }, def],
          () => ({ allow: true as const }),
        )
      }

      // 期望值直接照抄模块头那张表
      const wantOutside = mode === 'full' ? true : 'ask'
      const wantInsideWrite = mode === 'ask' ? 'ask' : true

      const outsideRead = await decide('read', { file_path: '/etc/hosts' }, false)
      if (outsideRead.allow !== wantOutside) {
        throw new Error(`模式 ${mode}: 读工作区外应得 ${String(wantOutside)}, 实际 ${String(outsideRead.allow)}`)
      }

      const insideWrite = await decide('write', { file_path: 'README.md' }, true)
      if (insideWrite.allow !== wantInsideWrite) {
        throw new Error(`模式 ${mode}: 工作区内写应得 ${String(wantInsideWrite)}, 实际 ${String(insideWrite.allow)}`)
      }

      // 敏感路径在非 full 档一律要问 (full 档不设围栏, 所以直接放行)
      const sensitive = await decide('write', { file_path: '.env' }, true)
      if (sensitive.allow !== wantOutside) {
        throw new Error(`模式 ${mode}: 写敏感路径应得 ${String(wantOutside)}, 实际 ${String(sensitive.allow)}`)
      }

      // 工作区内的只读不该被打扰 (请求批准档也不该把"看一眼代码"变成弹窗)
      const insideRead = await decide('read', { file_path: 'README.md' }, false)
      if (insideRead.allow !== true) {
        throw new Error(`模式 ${mode}: 工作区内读被拦了 (${String(insideRead.allow)}) —— 读不破坏任何东西`)
      }
    },
  },
])
