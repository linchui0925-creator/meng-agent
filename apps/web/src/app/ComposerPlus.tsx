/**
 * 输入框最左侧那个 ＋。
 *
 * 2026-11-17 之前它在**下面那条环境栏中间**（夹在分隔线和模型之间），用户原话是
 * "➕号放在输入框最左侧"。位置不只是审美问题：＋ 是"往这条消息里加东西"，
 * 它属于**输入**，不属于"这段会话在什么环境里跑"那一条。
 *
 * ── 为什么菜单里没有「权限模式 / 模型」了 ──
 * 它们原来在这里是快捷方式，点一下切到环境栏的菜单。现在 ＋ 挪到了另一行：
 * 点它会关掉自己、然后在**屏幕底部另一个位置**弹出菜单 —— 手指跟着走一趟，
 * 而且那两个开关本来就已经在下面那条上明摆着。菜单里只留"加东西"。
 *
 * ── 为什么"上传文件 / 链接"在这里，而不在输入框里另起一个按钮 ──
 * 用户原话："上传文件链接是属于加号功能里的"。这句话是对的：＋ 就是"往这条消息里
 * 加东西"的唯一入口，附件、链接、引用、技能都该从这一个口子进。之前 fixture 里
 * 还有一个演示用的回形针（`composer.actions` 槽位），和 ＋ 并排摆着两个"添加"，
 * 已经撤掉了 —— 槽位还在契约里（语音、斜杠命令将来会用它），只是不再占着位置。
 *
 * ── 四项全是灰的，为什么还要画 ──
 * 添加文件 / 添加链接 / 引用文件 / 技能连接器都要后端（上传接口、抓取网页、列目录、
 * 插件市场）。藏起来用户会以为这个产品没有附件概念；画出来并写明"待接"，至少诚实。
 * 菜单底部那句是说给"为什么整排都不能点"的。
 */

import { useEffect, useRef, useState } from 'react'

import { PlusIcon } from './icons.tsx'
import styles from './ComposerPlus.module.css'

export function ComposerPlus({ onPickFiles, onPickReference, onBackgroundCommand }: { onPickFiles: () => void; onPickReference: () => void; onBackgroundCommand?: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={styles.wrap} ref={root}>
      <button
        type="button"
        className={styles.btn}
        data-chip="plus"
        data-active={open ? '' : undefined}
        aria-label="添加"
        aria-haspopup="menu"
        aria-expanded={open}
        title="往这条消息里加东西"
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon />
      </button>

      {open && (
        <div className={styles.pop} role="menu" data-menu="plus">
          <Item
            icon="📎"
            label="添加文件"
            hint="上传 PNG / JPEG / WebP / GIF 图片"
            onClick={() => {
              onPickFiles()
              setOpen(false)
            }}
          />
          <Item
            icon="@"
            label="引用文件"
            hint="选择工作区文件，把相对路径插入消息"
            onClick={() => {
              onPickReference()
              setOpen(false)
            }}
          />
          <Item
            icon="▶"
            label="后台运行命令"
            hint="启动后继续留在当前会话，运行状态显示在任务托盘"
            onClick={onBackgroundCommand === undefined ? undefined : () => {
              onBackgroundCommand()
              setOpen(false)
            }}
          />
          <Item icon="🧩" label="技能 / 连接器" hint="这个仓库还没有插件市场" />
          <p className={styles.note}>图片也可以直接拖入输入框或从剪贴板粘贴。</p>
        </div>
      )}
    </div>
  )
}

function Item({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: string
  label: string
  hint: string
  onClick?: () => void
}) {
  return (
    <button type="button" role="menuitem" className={styles.item} disabled={onClick === undefined} title={hint} onClick={onClick}>
      <span className={styles.itemIcon}>{icon}</span>
      {label}
      {onClick === undefined && <span className={styles.pending}>待接</span>}
    </button>
  )
}
