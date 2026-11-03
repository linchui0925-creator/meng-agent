/**
 * 示例插件: 一个工具 + 一段提示 + 一条拦截规则。
 *
 * 这三件事覆盖了 90% 插件的真实诉求, 也是判断 base 设计够不够用的试金石:
 *   1. 加能力 (工具) —— 需要 ctx.tools
 *   2. 改行为 (提示分区) —— 需要 ctx.prompt
 *   3. 加约束 (拦截) —— 需要 ctx.waterfall 拿到控制权
 *
 * 如果哪天这三件事里有任何一件需要改内核, 说明抽象漏了。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const name = 'meng-plugin-hello'
export const inject = ['tools', 'prompt']

export interface Config {
  greeting: string
  loud: boolean
}

export function apply(ctx: Ctx, config: Config): Disposer {
  const disposers: Disposer[] = []

  // 1. 加一个工具
  disposers.push(
    ctx.effect(() =>
      ctx.get<{ register: (def: unknown) => Disposer }>('tools')!.register({
        name: 'hello',
        description: '向用户问好。参数 name 是要问候的人; panic=true 时会被拦截 (演示用)',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要问候的人' },
            panic: { type: 'boolean', description: '触发拦截演示' },
          },
          required: ['name'],
        },
        handler: (args: Record<string, unknown>) => {
          const who = String(args.name ?? '世界')
          const text = `${config.greeting}, ${who}!`
          return { ok: true, text: config.loud ? text.toUpperCase() : text }
        },
      }),
    ),
  )

  // 2. 贡献一段系统提示 (order ≥ 100, 不占内核区间)
  disposers.push(
    ctx.effect(() =>
      ctx.get<{ section: (s: unknown) => Disposer }>('prompt')!.section({
        id: 'plugin-hello',
        order: 100,
        render: () => '可以用 hello 工具向用户问好。',
      }),
    ),
  )

  // 3. 加一条约束: panic=true 的 hello 调用直接拒绝
  //    注意这里 return 的是"决定", 而 tools.call 会真的短路 —— 不是记账
  disposers.push(
    ctx.on(
      'tools/pre-execute',
      (call: { name: string; args: Record<string, unknown> }, _def: unknown, next: () => unknown) => {
        if (call.name === 'hello' && call.args.panic === true) {
          return { allow: false, reason: 'hello.panic 被示例插件拦截' }
        }
        return next()
      },
      { priority: 50 },
    ),
  )

  return () => {
    for (const off of disposers.reverse()) void off()
  }
}

export const invariant = defineInvariant('@meng/plugin-hello', [
  {
    id: 'tool-visible',
    run(ctx) {
      const tools = ctx.get<{ list: () => Array<{ name: string }> }>('tools')
      if (!tools) throw new Error('tools 能力面缺失')
      if (!tools.list().some((t) => t.name === 'hello')) throw new Error('hello 工具未注册成功')
    },
  },
])
