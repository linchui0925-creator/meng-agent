import css from './market.css?inline'
import { MarketPanel } from './MarketPanel.tsx'

declare const __MENG_LOADER__: {
  load(spec: { id: string; factory: () => unknown }): void
}

const ID = 'plugin-studio'

__MENG_LOADER__.load({
  id: ID,
  factory: () => ({
    inject: ['slots', 'transport'],
    apply(ctx: { get(name: string): unknown }): () => void {
      const slots = ctx.get('slots') as {
        register(pluginId: string, reg: { name: string; component: unknown; order?: number; meta?: unknown }): () => void
      } | undefined
      if (!slots) throw new Error('plugin-studio 需要 slots 能力面')
      const transport = ctx.get('transport') as { invoke<T>(op: string, payload?: unknown): Promise<T> } | undefined
      const BoundPanel = () => <MarketPanel transport={transport} />
      const style = document.createElement('style')
      style.setAttribute('data-plugin', ID)
      style.textContent = css
      document.head.appendChild(style)
      const off = slots.register(ID, {
        name: 'settings.section',
        component: BoundPanel,
        order: 920,
        meta: { label: '插件市场', group: '插件', origin: 'external' },
      })
      return () => {
        off()
        style.remove()
      }
    },
  }),
})
