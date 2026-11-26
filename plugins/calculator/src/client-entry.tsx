/**
 * calculator 客户端插件入口。
 *
 * 执行这里只注册 factory；CSS、slot 注册和 React 组件都锁在 apply 里。
 * 卸载时 disposer 会移除 slot 占位和本插件注入的 style。
 */

import css from './calculator.css?inline'
import { Calculator } from './Calculator.tsx'

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

const ID = 'calculator'

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

      const off = slots.register(ID, {
        name: 'sidebar.utility',
        component: Calculator,
        order: 50,
        meta: { label: '计算器', origin: 'builtin' },
      })

      return () => {
        off()
        style.remove()
      }
    },
  }),
})
