/**
 * @meng/prompt — 系统提示的分区装配。
 *
 * Python 版是字符串拼接 + 硬编码 ContextSource 顺序, 插件想加一段话
 * 只能塞一个 SKILL.md 全量注入 —— 结果是提示词不可控、缓存命中率 33%。
 *
 * 这里每个 section 有稳定 id 和 order, 拼装结果按 order 排序后缓存:
 * 插件增减 section 只影响自己那一段, 前缀缓存不被整体打翻。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const name = 'meng-prompt'
export const inject: string[] = []

export interface Section {
  id: string
  /** 越小越靠前。0-99 保留给内核, 插件请用 100+ */
  order: number
  render(ctx: Ctx): string | Promise<string>
}

export interface PromptService {
  section(section: Section): Disposer
  render(): Promise<string>
}

export function apply(ctx: Ctx, config: { persona?: string }): Disposer {
  const sections = new Map<string, Section>()

  const service: PromptService = {
    section(section) {
      if (sections.has(section.id)) throw new Error(`section ${section.id} 重复注册`)
      if (section.order < 100) {
        console.warn(`[meng] section ${section.id} 使用了内核保留区间 order=${section.order}`)
      }
      sections.set(section.id, section)
      // 不直接返回 Set.delete: 它返回 boolean, 而 Disposer 是 void
      return () => {
        sections.delete(section.id)
      }
    },

    async render() {
      const ordered = [...sections.values()].sort((a, b) => a.order - b.order)
      const parts: string[] = []
      for (const section of ordered) parts.push((await section.render(ctx)).trim())
      return parts.filter(Boolean).join('\n\n')
    },
  }

  if (config.persona) {
    ctx.effect(() =>
      service.section({ id: 'core/persona', order: 10, render: () => config.persona ?? '' }),
    )
  }

  ctx.set('prompt', service)
  return () => sections.clear()
}

export const invariant = defineInvariant('@meng/prompt', [
  {
    id: 'renders',
    run: async (ctx) => {
      const prompt = ctx.get<PromptService>('prompt')
      if (!prompt) throw new Error('能力面 prompt 未注册')
      const text = await prompt.render()
      if (typeof text !== 'string') throw new Error('render() 必须返回字符串')
    },
  },
])
