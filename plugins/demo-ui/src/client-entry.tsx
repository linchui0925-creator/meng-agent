/**
 * demo-ui 的 bundle 入口 —— 执行后**只**注册 factory, 不跑任何副作用。
 *
 * 这是 docs/08 §1 那句 "执行 ≠ 装载" 的样板:
 *   执行这一行代码时, CSS 没注入、slot 没注册、React 没渲染;
 *   全部锁在 factory 闭包里, 等 shell 调用 `apply` 时才发生。
 * 顺序因此自解: 谁先被下载、谁先被执行都无所谓。
 *
 * `__MENG_LOADER__` / `__MENG_REQUIRE__` 由宿主注入 (modules/client 的 evaluate),
 * 不是真全局 —— 所以这段代码在 node 里也能被装载、被断言。
 */

import css from './panel.css?inline'
import { Panel } from './Panel.tsx'

declare const __MENG_LOADER__: {
  load(spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
}

const ID = 'demo-ui'

__MENG_LOADER__.load({
  id: ID,
  factory: () => {
    return {
      inject: ['slots'],

      apply(ctx: { get(name: string): unknown }): () => void {
        const slots = ctx.get('slots') as
          | {
              register(
                pluginId: string,
                reg: { name: string; component: unknown; order?: number },
              ): () => void
            }
          | undefined
        if (!slots) throw new Error(`${ID} 需要 slots 能力面`)

        // ── 副作用 1 · CSS ────────────────────────────────────────────
        // 打标是硬要求: invalidate 时宿主只回收带自己标记的 style (docs/08 §6)。
        // 不打标 = 卸载后样式永久残留, 而且宿主不敢替你回收(怕抢了别人的)。
        const style = document.createElement('style')
        style.setAttribute('data-plugin', ID)
        style.textContent = css
        document.head.appendChild(style)

        // ── 副作用 2 · 占位 ───────────────────────────────────────────
        const off = slots.register(ID, {
          name: 'sidebar.footer',
          component: Panel,
          order: -10, // 排在内置页脚之前
        })

        return () => {
          off()
          style.remove()
        }
      },
    }
  },
})
