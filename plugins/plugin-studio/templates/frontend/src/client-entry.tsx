import css from './panel.css?inline'
import { Panel } from './Panel.tsx'

declare const __MENG_LOADER__: {
  load(spec: { id: string; factory: () => unknown }): void
}

__MENG_LOADER__.load({
  id: '{{id}}',
  factory: () => ({
    inject: ['slots'],
    apply(ctx: { get(name: string): unknown }) {
      const slots = ctx.get('slots') as {
        register(id: string, value: Record<string, unknown>): () => void
      } | undefined
      if (!slots) throw new Error('需要 slots 能力面')
      const style = document.createElement('style')
      style.dataset.plugin = '{{id}}'
      style.textContent = css
      document.head.appendChild(style)
      const off = slots.register('{{id}}', {
        name: 'settings.section',
        component: Panel,
        order: 900,
        meta: { label: '{{id}}', group: '插件', origin: 'external' },
      })
      return () => {
        off()
        style.remove()
      }
    },
  }),
})
