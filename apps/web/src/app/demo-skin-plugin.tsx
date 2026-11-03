/**
 * 示例: 一个**会改界面本身**的插件。
 *
 * 它演示三条路, 只有前两条是通的 —— 第三条是我们刻意堵死的:
 *
 *   ① 换组件 (`?skin=composer`)
 *      往 `composer` 这个 single slot 里注册, priority 高于内置实现。
 *      内置输入框整块被替换, 宿主代码一行不改。
 *
 *   ② 改配色 (`?skin=accent`)
 *      只覆盖 `--meng-alias-*` 这一层赋值。整站换色, 组件一行不改。
 *      这是**唯一**被鼓励的"改原有样式"方式 —— 因为组件只引用 alias,
 *      所以换肤就真的只是一组赋值。
 *
 *   ③ 直接覆盖别人的 class (不给)
 *      CSS Modules 的类名是哈希过的, 本来也摸不到; 就算摸到, 这类覆盖会随
 *      组件内部结构变化而静默失效 —— 那不是"改样式", 是"埋定时炸弹"。
 *
 * 注意: 现在还是静态 import (F5 之前 loadModule 是写死的表)。
 * 插件代码本身没有任何变化 —— 换成 import() 时这个文件不用动。
 */

import type { Disposer } from '@meng/core'
import type { SlotRegistry } from '@meng/slots'
import type { ThemeController } from '@meng/ui'

import type { ComposerApi } from './layout.ts'

export const DEMO_SKIN_ID = 'demo.skin'

/**
 * 替换版输入框: 圆角胶囊 + 斜杠命令提示。
 * 样式**只用 alias token**, 所以它跟着主题一起变, 不需要自己写深色分支。
 */
function CompactComposer({ value, setValue, send, busy, error }: ComposerApi) {
  const canSend = value.trim().length > 0 && !busy
  return (
    <div style={{ padding: '12px 24px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'var(--meng-alias-bg-surface)',
          border: '1px solid var(--meng-alias-border-l2)',
          borderRadius: 999,
          padding: '6px 6px 6px 16px',
          boxShadow: 'var(--meng-alias-shadow-sm)',
        }}
      >
        <span
          style={{
            color: 'var(--meng-alias-accent)',
            fontFamily: 'var(--meng-specific-font-mono)',
            fontSize: 'var(--meng-specific-text-base)',
            lineHeight: 1,
          }}
        >
          ›
        </span>
        <input
          value={value}
          aria-label="输入消息 (插件实现)"
          placeholder="输入消息，/ 唤起命令…"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--meng-alias-fg-primary)',
            fontFamily: 'var(--meng-specific-font-sans)',
            fontSize: 'var(--meng-specific-text-base)',
            lineHeight: 'var(--meng-specific-leading-normal)',
          }}
        />
        <button
          type="button"
          aria-label="发送"
          disabled={!canSend}
          onClick={send}
          style={{
            border: 0,
            borderRadius: 999,
            padding: '8px 18px',
            cursor: canSend ? 'pointer' : 'not-allowed',
            background: canSend ? 'var(--meng-alias-accent)' : 'var(--meng-alias-bg-active)',
            color: canSend ? 'var(--meng-alias-fg-on-accent)' : 'var(--meng-alias-fg-disabled)',
            fontFamily: 'var(--meng-specific-font-sans)',
            fontSize: 'var(--meng-specific-text-md)',
            transition: 'background 120ms ease',
          }}
        >
          {busy ? '发送中' : '发送'}
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 'var(--meng-specific-text-sm)', color: 'var(--meng-alias-danger)' }}>
          发送失败: {error}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--meng-specific-text-sm)',
          color: 'var(--meng-alias-fg-muted)',
        }}
      >
        <span>由插件 demo.skin 替换 · 不是内置输入框</span>
        <span>Enter 发送</span>
      </div>
    </div>
  )
}

/** 换肤: 只动 alias 这一层。值取 #b4471f 是因为它在 canvas 上过 WCAG AA (脚本验过) */
const SKIN_ACCENT = {
  '--meng-alias-accent': '#b4471f',
  '--meng-alias-accent-hover': '#983a19',
  '--meng-alias-accent-active': '#7d2f14',
  '--meng-alias-accent-subtle': '#fbeee8',
}

/**
 * 故意写坏的颜色 (?skin=badaccent) —— 验证运行时对比度审计。
 * #9db9f2 是淡蓝, 在白底上只有约 2:1, 链接文字根本读不清。
 * 期望: 控制器只拒这四个里过不了审的那部分 (fg 侧的 accent 全家),
 * 其余 token 和界面一切照旧 —— 插件不会崩, 只是「坏颜色没生效」。
 */
const SKIN_BAD_ACCENT = {
  '--meng-alias-accent': '#9db9f2',
  '--meng-alias-accent-hover': '#b3ccf7',
  '--meng-alias-accent-active': '#c9defa',
}

/** 故意崩的输入框 (?skin=boom) —— 验证「一个插件崩了不炸整棵树」 */
function BrokenComposer(): null {
  throw new Error('demo.boom 故意在渲染期崩溃')
}

export const demoSkinRuntime = {
  inject: ['slots', 'theme'],
  apply(ctx: { get(name: string): unknown }): Disposer {
    const slots = ctx.get('slots') as SlotRegistry | undefined
    if (!slots) throw new Error('demo.skin 需要 slots 能力面')

    const skin = new URLSearchParams(location.search).get('skin')
    const offs: Disposer[] = []

    if (skin === 'composer' || skin === 'both') {
      /**
       * 「永久替换」在 chain 里就是: select 恒不弃权。
       * 它和审批条共存 —— 有待审批时审批条 priority 更高先被问, 没有时才轮到它。
       */
      offs.push(
        slots.register(DEMO_SKIN_ID, {
          name: 'composer',
          component: CompactComposer,
          priority: 1,
          select: () => ({}),
        }),
      )
    }

    if (skin === 'boom') {
      /**
       * 它 select 恒真 + priority 最高 → 一定被选上, 然后一定崩。
       * 期望: 错误边界把它单独摘掉, 座位重新选举落到 fallback,
       * 输入框照常出现, 界面其他部分一行都没受影响。
       */
      offs.push(
        slots.register('demo.boom', {
          name: 'composer',
          component: BrokenComposer,
          priority: 99,
          select: () => ({}),
        }),
      )
    }

    if (skin === 'accent' || skin === 'both') {
      const theme = ctx.get('theme') as ThemeController | undefined
      if (!theme) throw new Error('demo.skin 要换色, 但宿主没有提供 theme 能力面')

      /**
       * 只提交自己这一层。**不存旧值、不碰别人的属性** ——
       * 覆盖顺序和撤销都由控制器按层栈重算。旧版这里每个插件各存一份旧值,
       * 两个皮肤同时开着时卸载谁都可能把另一个的值抹掉。
       */
      theme.apply(DEMO_SKIN_ID, SKIN_ACCENT)
      offs.push(() => theme.remove(DEMO_SKIN_ID))
    }

    if (skin === 'badaccent') {
      const theme = ctx.get('theme') as ThemeController | undefined
      if (!theme) throw new Error('demo.skin 要换色, 但宿主没有提供 theme 能力面')
      // 提交坏颜色: 期望控制器拒绝 (console.error 点名), 界面保持内置 accent
      theme.apply(DEMO_SKIN_ID, SKIN_BAD_ACCENT)
      offs.push(() => theme.remove(DEMO_SKIN_ID))
    }

    return () => {
      for (const off of offs) off()
    }
  },
}
