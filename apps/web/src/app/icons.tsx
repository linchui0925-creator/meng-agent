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
