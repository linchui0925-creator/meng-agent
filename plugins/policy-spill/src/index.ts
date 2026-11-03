/**
 * @meng/plugin-policy-spill —— 对位 dsh-spill-policy。
 *
 * 零能力面: 只挂 tools/post-execute 一道钩子。做的事就一件 ——
 * **工具回显超过预算就落盘, 回给模型一个 locator, 而不是把尾部丢掉。**
 *
 * 为什么必须有这一层 (而不是让工具自己截断):
 *   read 截断不要紧 —— 文件本来就在磁盘上, 模型可以 offset 续读。
 *   要命的是**瞬时产物**: bash 的 stdout、grep 的命中列表。
 *   这些一丢就永远没了, 模型连"去哪找"都不知道, 只能重跑一遍命令。
 *
 * 为什么"多大算溢出"在这里而不在 spill 包里:
 *   那是**部署决策** (托管版想省上下文就调小, 本地想少落盘就调大),
 *   和 policy-fs 的"先读后写"是同一种东西 —— 不装本插件 = 不落盘 = 裸截断,
 *   这是特性不是漏洞。
 *
 * 为什么 read 默认排除:
 *   read 的结果本来就来自磁盘上的文件, 再落一份是纯粹的重复;
 *   而且 read 自带 offset/limit, 它自己截断时已经告诉模型怎么续读了。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { SpillService } from '@meng/spill'
import type { ToolCall, ToolResult } from '@meng/tools'

export const name = 'meng-plugin-policy-spill'
/** 刻意不写 inject: 钩子先挂上, seam 后装载也一样拦得住 */
export const inject: string[] = []

export interface Config {
  /** 超过这么多字节就落盘。默认 50000, 对齐 dsh 的 50KB 阈值 */
  maxInlineBytes?: number
  /** 落盘时内联保留的头部预览字节数 */
  headBytes?: number
  /** 这些工具永不落盘 */
  exclude?: string[]
  /** 落盘文件保留上限, 超出清最旧的 */
  maxFiles?: number
}

/** 按字节切, 但不切在代理对中间 —— 否则预览末尾会蹦出一个乱码字符 */
function safeHead(text: string, bytes: number): string {
  const head = text.slice(0, bytes)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) return head.slice(0, -1)
  return head
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const maxInlineBytes = config.maxInlineBytes ?? 50000
  const headBytes = config.headBytes ?? 2000
  const exclude = new Set(config.exclude ?? ['read'])
  const maxFiles = config.maxFiles ?? 200

  const off = ctx.on(
    'tools/post-execute',
    async (
      call: ToolCall,
      result: ToolResult,
      next: () => Promise<ToolResult>,
    ): Promise<ToolResult> => {
      // 没有 spill seam = 没有硬闸, 原样放行 (和"不装 policy-fs 就不设防"同理)
      const spill = ctx.get<SpillService>('spill')
      if (!spill) return next()
      if (exclude.has(call.name)) return next()

      // 闸的对象是**模型真正会读到的那段**: 成功看 text, 失败看 error。
      // 只盯 text 会漏掉最危险的场景 —— 编译失败时 200KB 的 stderr 正是走 error 的
      const field: 'text' | 'error' = result.ok ? 'text' : 'error'
      const payload = result[field] ?? ''
      const bytes = Buffer.byteLength(payload)
      if (bytes <= maxInlineBytes) return next()

      const ref = await spill.write({
        text: payload,
        tool: call.name,
        callId: call.id,
        keep: maxFiles,
      })
      const head = safeHead(payload, headBytes)
      return {
        ...result,
        [field]: `${head}\n\n… (后续 ${bytes - Buffer.byteLength(head)} 字节未内联)\n${spill.locator(ref)}`,
      } as ToolResult
    },
    // 后段钩子: 先让别的监听器改写完, 再由它做最后一道瘦身
    { priority: -100 },
  )

  return () => off()
}

export const invariant = defineInvariant('@meng/plugin-policy-spill', [
  {
    id: 'passes-through-when-small',
    async run(ctx) {
      // 只验"小结果原样放行 + 钩子真的挂上了"。
      // 大结果的落盘留给冒烟验 —— invariant 每次启动都跑, 不该往工作区里塞文件
      const probe: ToolCall = { id: 'invariant', name: 'bash', args: {} }
      const small: ToolResult = { ok: true, text: 'meng' }
      const out = await ctx.waterfall<ToolResult>('tools/post-execute', [probe, small], () => small)
      if (out.text !== small.text) throw new Error(`小结果被改写: ${out.text}`)

      // locator 是模型唯一能靠它找回内容的东西, 格式里必须带路径和取回方式
      const spill = ctx.get<SpillService>('spill')
      if (!spill) throw new Error('能力面 spill 未装载, 硬闸形同虚设')
      const line = spill.locator({
        id: 'x', rel: '.meng/spill/x.txt', path: '/x', bytes: 1, createdAt: 0,
      })
      if (!line.includes('.meng/spill/x.txt') || !line.includes('read')) {
        throw new Error(`locator 缺关键信息: ${line}`)
      }
    },
  },
])
