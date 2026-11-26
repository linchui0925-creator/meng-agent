/**
 * theme-ui 客户端插件入口：主题切换入口全部在这里，宿主只提供主题状态和能力。
 */
import css from './theme.css?inline'
import { ThemeNav } from './ThemeNav.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

declare const __MENG_LOADER__: {
  load(spec: { id: string; factory: () => unknown }): void
}

interface SlotRegistry {
  register(
    pluginId: string,
    reg: { name: string; component: unknown; order?: number; meta?: unknown },
  ): () => void
}

interface ClientContext {
  get(name: string): unknown
}

const ID = 'theme-ui'

__MENG_LOADER__.load({
  id: ID,
  factory: () => ({
    inject: ['slots'],
    apply(ctx: ClientContext): () => void {
      const slots = ctx.get('slots') as SlotRegistry | undefined
      if (!slots) throw new Error(`${ID} 需要 slots 能力面`)

      const style = document.createElement('style')
      style.setAttribute('data-plugin', ID)
      style.textContent = css
      document.head.appendChild(style)

      const offNav = slots.register(ID, {
        name: 'sidebar.utility',
        component: ThemeNav,
        order: 40,
        meta: { label: '主题', origin: 'builtin' },
      })
      const offToggle = slots.register(ID, {
        name: 'topbar.actions',
        component: ThemeToggle,
        order: 20,
        meta: { label: '主题切换', origin: 'builtin' },
      })

      return () => {
        offNav()
        offToggle()
        style.remove()
      }
    },
  }),
})
