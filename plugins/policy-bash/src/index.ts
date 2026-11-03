/**
 * @meng/plugin-policy-bash —— 对位 dsh-bash-sandbox (的临时形态)。
 *
 * 零能力面: 只挂 tools/pre-execute。两条规则:
 *
 * 1. **声明式升权** (dsh 的正路): 模型申报 sandbox_permissions: danger-full-access
 *    时, 除非部署方在清单里显式开了 allowDanger, 否则拒绝。
 *    模型写没写 justification 由 tool-bash 的 schema 校验管 (成对规则),
 *    这里只管"部署方授没授权"。
 *
 * 2. **止血带** (临时的, dsh 没有): 真沙箱 (OS 级 seatbelt/容器, 对位
 *    dsh-bash-sandbox) 落地前, 用一张极短的灾难命令表兜底 ——
 *    rm -rf 指向根/家目录、fork bomb、mkfs、dd 写设备、关机重启。
 *    这不是回到"猜哪些命令危险"的老路: 老路是拿正则当**权限系统**,
 *    这里只拦"一次执行就不可逆"的少数几条。沙箱包落地后删掉这段。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { PreDecision, ToolCall, ToolDef } from '@meng/tools'

export const name = 'meng-plugin-policy-bash'
export const inject: string[] = []

export interface Config {
  /** 允许 danger-full-access 申报通过。默认 false —— 没有真沙箱, 越权不开门 */
  allowDanger?: boolean
  /** 止血带命令表。置 [] 可关掉 (不推荐, 除非外面有真沙箱) */
  denyCommands?: string[]
}

const DEFAULT_DENY = [
  String.raw`\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(~|/|\*|\.\.?)?(\s|$)`,
  String.raw`\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(/|~)(/|\s|$)`,
  String.raw`:\(\)\s*\{\s*:\|:&\s*\}`,
  String.raw`\bmkfs(\.[a-z0-9]+)?\b`,
  String.raw`\bdd\b[^|;\n]*\bof=/dev/`,
  String.raw`\b(shutdown|reboot|halt|poweroff)\b`,
]

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const allowDanger = config.allowDanger === true
  const deny = (config.denyCommands ?? DEFAULT_DENY).map((p) => new RegExp(p, 'i'))

  const deny_ = (reason: string): PreDecision => ({ allow: false, reason })

  const off = ctx.on(
    'tools/pre-execute',
    (call: ToolCall, _def: ToolDef, next: () => Promise<PreDecision>): Promise<PreDecision> | PreDecision => {
      if (call.name !== 'bash') return next()

      // 1) 声明式升权: 部署方没开门, 申报越权就拒
      if (call.args.sandbox_permissions === 'danger-full-access' && !allowDanger) {
        return deny_('danger-full-access 未获本部署授权 (在清单里开 policy-bash.allowDanger 才能申报)')
      }

      // 2) 止血带: 一次执行就不可逆的命令, 不等沙箱落地了
      const command = String(call.args.command ?? '')
      for (const re of deny) {
        if (re.test(command)) return deny_(`命令被策略拒绝 (不可逆操作): ${command.slice(0, 80)}`)
      }

      return next()
    },
    // 数值越大越先执行: 策略必须比任何"我要记个日志"的监听器先看到
    { priority: 100 },
  )

  return () => off()
}

export const invariant = defineInvariant('@meng/plugin-policy-bash', [
  {
    id: 'catastrophe-blocked',
    async run(ctx) {
      // 直接走 waterfall 喂危险命令 —— 不经过真实执行, 所以不会有副作用
      const probe = (command: string, extra: Record<string, unknown> = {}): ToolCall => ({
        id: 'invariant',
        name: 'bash',
        args: { command, description: 'invariant 探针', ...extra },
      })
      const def: ToolDef = {
        name: 'bash',
        description: '',
        parameters: {},
        mutates: true,
        handler: () => ({ ok: true, text: '不该被执行' }),
      }

      for (const command of ['rm -rf /', 'rm -rf ~', 'mkfs.ext4 /dev/sda1', 'dd if=x of=/dev/sda']) {
        const decision = await ctx.waterfall<PreDecision>('tools/pre-execute', [probe(command), def], () => ({
          allow: true as const,
        }))
        if (decision.allow === true) throw new Error(`止血带没拦住: ${command}`)
      }

      // 申报越权也必须被拒 (allowDanger 默认关)
      const escalate = await ctx.waterfall<PreDecision>(
        'tools/pre-execute',
        [
          probe('cat ~/.ssh/id_rsa', { sandbox_permissions: 'danger-full-access', justification: 'invariant' }),
          def,
        ],
        () => ({ allow: true as const }),
      )
      if (escalate.allow === true) throw new Error('danger-full-access 未经授权竟被放行')

      // 正常命令不能被误伤
      const normal = await ctx.waterfall<PreDecision>('tools/pre-execute', [probe('echo ok'), def], () => ({
        allow: true as const,
      }))
      if (normal.allow !== true) throw new Error('正常命令被误拦')
    },
  },
])
