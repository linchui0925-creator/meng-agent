/**
 * 图标。
 *
 * 不引图标库: 第一版只需要 6 个, 一个库动辄多几百 KB 且带来第二套尺寸约定。
 * 统一 16×16 viewBox、stroke=currentColor、stroke-width=1.6 —— 颜色由父级 color 决定,
 * 所以图标永远不会脱离 token。
 */

import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export function SendIcon() {
  return (
    <svg {...base}>
      <path d="M14 2 7.5 8.5" />
      <path d="M14 2 9.8 14l-2.3-5.5L2 6.2 14 2Z" />
    </svg>
  )
}

/** 把等待消息提到队首并立即发送。 */
export function InsertNowIcon() {
  return (
    <svg {...base}>
      <path d="M8 11.5V3.5" />
      <path d="M4.8 6.7 8 3.5l3.2 3.2" />
      <path d="M3.5 12.5h9" />
    </svg>
  )
}

/** 编辑等待中的消息。 */
export function EditIcon() {
  return (
    <svg {...base}>
      <path d="m10.8 2.8 2.4 2.4-7.2 7.2-3.1.7.7-3.1 7.2-7.2Z" />
      <path d="m9.6 4 2.4 2.4" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg {...base}>
      <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg {...base}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg {...base}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 11h1" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg {...base}>
      <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" />
    </svg>
  )
}

export function WrenchIcon() {
  return (
    <svg {...base}>
      <path d="M10.4 2.6a3.4 3.4 0 0 0-4.2 4.2L2.6 10.4a2 2 0 0 0 2.8 2.8l3.6-3.6a3.4 3.4 0 0 0 4.2-4.2l-1.7 1.7-1.4-1.4 1.7-1.7Z" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 14 14" />
    </svg>
  )
}

export function PaperclipIcon() {
  return (
    <svg {...base}>
      <path d="M12.5 7.2 8 11.7a3.2 3.2 0 0 1-4.5-4.5l5-5a2.2 2.2 0 0 1 3.1 3.1l-4.9 4.9a1.1 1.1 0 0 1-1.6-1.6l4.5-4.5" />
    </svg>
  )
}

export function MoreIcon() {
  return (
    <svg {...base}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ShareIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="4" cy="8" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="M5.6 7.1 10.4 4.4M5.6 8.9l4.8 2.7" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg {...base}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** 导出：一个往下的箭头落进托盘里 */
export function DownloadIcon() {
  return (
    <svg {...base}>
      <path d="M8 2.5v7.5" />
      <path d="M5 7.2 8 10.2l3-3" />
      <path d="M2.8 12.2v1.3h10.4v-1.3" />
    </svg>
  )
}

/** 归档：盒子表示隐藏收纳；恢复时加一条向上的箭头。 */
export function ArchiveIcon({ restored = false }: { restored?: boolean }) {
  return (
    <svg {...base}>
      <path d="M3 5.2h10v7.3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M2.2 2.5h11.6v2.7H2.2zM6.2 7.4h3.6" />
      {restored && <path d="M8 12V8.2M6.3 9.8 8 8.1l1.7 1.7" />}
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg {...base}>
      <path d="M2.8 4.2h10.4M6.2 2.5h3.6M4.2 4.2l.5 9.3h6.6l.5-9.3M6.5 6.5v4.5M9.5 6.5v4.5" />
    </svg>
  )
}

/** 文件夹。工作区、目录都用它 —— 一个形状认一种东西，别为「打开」和「关闭」画两套 */
export function FolderIcon() {
  return (
    <svg {...base}>
      <path d="M2 4.2h4l1.3 1.6h6.7v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  )
}

/** 盾牌。权限那一档用它：它说的是"能碰什么"，不是一个开关 */
export function ShieldIcon() {
  return (
    <svg {...base}>
      <path d="M8 2.2 13 4v4.1c0 2.9-2.1 4.9-5 5.7-2.9-.8-5-2.8-5-5.7V4z" />
    </svg>
  )
}

/** 分支。git 状态用它 —— 分支名旁边那个小标记 */
export function BranchIcon() {
  return (
    <svg {...base}>
      <circle cx="4.5" cy="3.6" r="1.6" />
      <circle cx="4.5" cy="12.4" r="1.6" />
      <circle cx="11.5" cy="6.4" r="1.6" />
      <path d="M4.5 5.2v5.6" />
      <path d="M11.5 8v1.2c0 1.4-1.1 2.4-2.5 2.4H6.1" />
    </svg>
  )
}

/** 加号。输入框那个「＋」菜单 */
export function PlusMenuIcon() {
  return (
    <svg {...base}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  )
}

/** 下拉箭头。用 CSS 三角形也行, 但那个在小尺寸下会糊 */
export function ChevronIcon() {
  return (
    <svg {...base}>
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  )
}

export function RefreshIcon() {
  return (
    <svg {...base}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" />
      <path d="M13.5 2.5V5h-2.5" />
    </svg>
  )
}

export function LayersIcon() {
  return (
    <svg {...base}>
      <path d="M8 2 14 5.2 8 8.4 2 5.2 8 2Z" />
      <path d="m2 8 6 3.2L14 8" />
      <path d="m2 10.8 6 3.2 6-3.2" />
    </svg>
  )
}

/**
 * 设置（齿轮）。齿做成八段短弧而不是一个圆 + 八个矩形:
 * 16px 下矩形的接缝会糊成毛边, 短弧在小尺寸更干净。
 */
export function GearIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
    </svg>
  )
}

