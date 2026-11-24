import { defineInvariant, type Ctx } from '@meng/core'

export const name = '{{id}}'
export const inject = ['tools']

interface Tools {
  register(def: {
    name: string
    description: string
    parameters: Record<string, unknown>
    handler(args: Record<string, unknown>): { ok: boolean; text: string }
  }): () => void
  list(): Array<{ name: string }>
}

export function apply(ctx: Ctx): void {
  const tools = ctx.get<Tools>('tools')
  if (!tools) throw new Error('需要 tools 能力面')
  ctx.effect(() => tools.register({
    name: '{{toolName}}',
    description: {{descriptionJson}},
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args) => ({ ok: true, text: String(args.text) }),
  }))
}

export const invariant = defineInvariant('{{packageName}}', [{
  id: 'tool-ready',
  run(ctx) {
    const tools = ctx.get<Tools>('tools')
    if (!tools?.list().some((tool) => tool.name === '{{toolName}}')) throw new Error('示例工具未注册')
  },
}])
