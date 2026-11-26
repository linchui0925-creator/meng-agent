import type { ReactNode } from 'react'

import { THEME_NAV_OPTIONS, themeNavOption, type ThemeMode, type ThemeNavIcon } from './theme-nav.ts'

export interface ThemeNavProps {
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
}

export function ThemeNav({ themeMode, onThemeChange }: ThemeNavProps) {
  const current = themeNavOption(themeMode)
  return (
    <div className="theme-group" data-theme-nav-group="">
      <div className="theme-head">
        <span>主题</span>
        <span className="theme-current">{current.label}</span>
      </div>
      <div className="theme-items" role="group" aria-label="主题">
        {THEME_NAV_OPTIONS.map((option) => {
          const active = option.id === current.id
          return (
            <button
              key={option.id}
              type="button"
              className="theme-item"
              data-active={active ? '' : undefined}
              aria-current={active ? 'true' : undefined}
              aria-label={option.label}
              title={option.label}
              onClick={() => onThemeChange(option.id)}
              data-theme-option={option.id}
            >
              <ThemeIcon icon={option.icon} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ThemeIcon({ icon }: { icon: ThemeNavIcon }): ReactNode {
  if (icon === 'sun') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
      </svg>
    )
  }
  if (icon === 'moon') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.2" y="3" width="11.6" height="8" rx="1.4" />
      <path d="M6 13.4h4M8 11v2.4" />
    </svg>
  )
}
