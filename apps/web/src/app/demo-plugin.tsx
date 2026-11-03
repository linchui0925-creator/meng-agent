/**
 * 示例 UI 插件 —— 它的存在不是为了好看, 是为了**让 slot 机制真跑一遍**。
 *
 * 走的是插件真正的路径: shell 装载 → apply(ctx) → 从 ctx 取 'slots' 能力面 → 注册 →
 * 返回 disposer。所以它同时验证了三件事:
 *   1. 能力面注入 (ctx.get('slots'))
 *   2. list 型 slot 的 order 排序
 *   3. 卸载时占用被收回 (return 的 disposer)
 *
 * 这也是 docs/07 §6 里「UI 插件样例做什么」的答案: 会话统计挂侧栏 + 复制挂消息操作条。
 */

import type { PluginRuntime } from '@meng/modules'
import { Badge, IconButton, Tooltip } from '@meng/ui'

import { CopyIcon, MoreIcon, PaperclipIcon, SearchIcon, ShareIcon } from './icons.tsx'

export const DEMO_PLUGIN_ID = 'demo.usage'

interface FooterProps {
  messageCount?: number
  toolCount?: number
}

/** 侧栏底部: 会话统计 */
function UsageFooter({ messageCount = 0, toolCount = 0 }: FooterProps) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <Badge tone="neutral">{messageCount} 条消息</Badge>
      <Badge tone={toolCount > 0 ? 'accent' : 'neutral'}>{toolCount} 个工具调用</Badge>
    </div>
  )
}

interface ActionProps {
  text?: string
}

/** 助手消息下方的操作条 */
function CopyAction({ text = '' }: ActionProps) {
  return (
    <Tooltip label="复制这条回复">
      <IconButton
        size="sm"
        aria-label="复制这条回复"
        onClick={() => {
          void navigator.clipboard?.writeText(text)
        }}
      >
        <CopyIcon />
      </IconButton>
    </Tooltip>
  )
}

/* ── F2b 扩容的 5 个 slot, 每个都挂一个最小实现 ──
 * 它们存在的意义不是功能, 是证明「宿主声明了、布局留了点、插件能插进去」这条链真的通。 */

function SearchAction() {
  return (
    <Tooltip label="搜索会话">
      <IconButton size="sm" aria-label="搜索会话">
        <SearchIcon />
      </IconButton>
    </Tooltip>
  )
}

function SessionMore() {
  return (
    <Tooltip label="更多操作">
      <IconButton size="sm" aria-label="会话更多操作">
        <MoreIcon />
      </IconButton>
    </Tooltip>
  )
}

function ShareAction() {
  return (
    <Tooltip label="分享会话">
      <IconButton size="sm" aria-label="分享会话">
        <ShareIcon />
      </IconButton>
    </Tooltip>
  )
}

function AttachAction() {
  return (
    <Tooltip label="添加附件">
      <IconButton size="sm" aria-label="添加附件">
        <PaperclipIcon />
      </IconButton>
    </Tooltip>
  )
}

/** 状态条项: 顺便演示 live 色的正确用法 —— 它表示「活着」, 不是「成功」 */
function LiveStatus() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 'auto',
        color: 'var(--meng-alias-live)',
      }}
    >
      <i
        style={{
          width: 6,
          height: 6,
          borderRadius: 'var(--meng-specific-radius-full)',
          background: 'var(--meng-alias-live)',
        }}
      />
      demo.usage 在线
    </span>
  )
}

/** select 的返回值, 会作为 `matched` prop 传进来 */
interface ApprovalMatch {
  command: string
  approve: () => void
  reject: () => void
}

/**
 * 审批条 —— 一个会**自己退下去**的接管者。
 *
 * 它不跟输入框比 priority 高低, 只在「agent 正在等用户批准」这一小段时间里上台。
 * 用户点完, owner.approval 变空, select 返回 null, 输入框自动回来 ——
 * 而且是**原来那个**输入框: 草稿在、光标在 (overlay 保住了它, useChainFocus 还了焦点)。
 *
 * `data-autofocus` 是焦点落点的约定: 接管发生后焦点必须离开被藏起来的输入框,
 * 否则用户继续敲键盘, 字符会进那个看不见的框里。
 */
function ApprovalBar({ matched }: { matched: ApprovalMatch }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 24px 18px',
        flexWrap: 'wrap',
      }}
    >
      <Badge tone="warning">待审批</Badge>
      <code
        style={{
          fontFamily: 'var(--meng-specific-font-mono)',
          fontSize: 'var(--meng-specific-text-sm)',
          background: 'var(--meng-alias-bg-surface)',
          border: '1px solid var(--meng-alias-border-l2)',
          borderRadius: 6,
          padding: '2px 8px',
          color: 'var(--meng-alias-fg-primary)',
        }}
      >
        {matched.command}
      </code>
      <span style={{ color: 'var(--meng-alias-fg-muted)', fontSize: 'var(--meng-specific-text-sm)' }}>
        这条命令会删除文件，需要你确认
      </span>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button
          type="button"
          data-autofocus
          onClick={matched.reject}
          style={{
            font: 'inherit',
            fontSize: 'var(--meng-specific-text-sm)',
            padding: '5px 12px',
            borderRadius: 6,
            border: '1px solid var(--meng-alias-border-l2)',
            background: 'transparent',
            color: 'var(--meng-alias-fg-primary)',
            cursor: 'pointer',
          }}
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={matched.approve}
          style={{
            font: 'inherit',
            fontSize: 'var(--meng-specific-text-sm)',
            padding: '5px 12px',
            borderRadius: 6,
            border: 0,
            background: 'var(--meng-alias-accent)',
            color: 'var(--meng-alias-fg-on-accent)',
            cursor: 'pointer',
          }}
        >
          批准执行
        </button>
      </div>
    </div>
  )
}

/**
 * 插件出口。类型是 PluginRuntime —— 与后端插件同一份契约, 前端插件没有特权。
 */
export const demoRuntime: PluginRuntime = {
  name: '会话统计 (示例 UI 插件)',
  apply(ctx) {
    const slots = ctx.get('slots') as
      | { register: (id: string, reg: Record<string, unknown>) => () => void }
      | undefined

    if (!slots) {
      // fail-loud: 缺能力面就说清楚缺哪个, 不要静默什么都不显示
      throw new Error('demo.usage 需要 slots 能力面')
    }

    const offFooter = slots.register(DEMO_PLUGIN_ID, {
      name: 'sidebar.footer',
      order: 10,
      component: UsageFooter,
    })

    const offAction = slots.register(DEMO_PLUGIN_ID, {
      name: 'conversation.actions',
      order: 0,
      component: CopyAction,
    })

    /**
     * chain 的成员: 不抢座位, 只声明「什么时候该我上」。
     * priority 10 只是**排队顺序** (先问我), 真正的判断在 select 里。
     */
    const offApproval = slots.register(DEMO_PLUGIN_ID, {
      name: 'composer',
      priority: 10,
      component: ApprovalBar,
      select: (owner: { approval?: ApprovalMatch }) => owner.approval ?? null,
    })

    /**
     * F2b 扩容的 5 个位置。全部用一个插件挂, 是为了让「一个插件跨 5 处占位」
     * 这件事也被跑到 —— 卸载时 5 处必须同时消失, 不能剩半截。
     */
    const offAddons = (
      [
        ['sidebar.header', SearchAction],
        ['sidebar.item.actions', SessionMore],
        ['topbar.actions', ShareAction],
        ['composer.actions', AttachAction],
        ['statusbar.item', LiveStatus],
      ] as const
    ).map(([name, component]) =>
      slots.register(DEMO_PLUGIN_ID, { name, order: 0, component }),
    )

    return () => {
      offFooter()
      offAction()
      offApproval()
      for (const off of offAddons) off()
    }
  },
}
