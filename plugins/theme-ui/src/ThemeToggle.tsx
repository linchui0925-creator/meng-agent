import { IconButton, Tooltip } from '@meng/ui'

export interface ThemeToggleProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function ThemeToggle({ theme, onToggleTheme }: ThemeToggleProps) {
  const target = theme === 'dark' ? '浅色' : '深色'
  return (
    <Tooltip label={`切到${target}`}>
      <IconButton aria-label="切换主题" size="sm" onClick={onToggleTheme} data-theme-toggle="">
        {theme === 'dark' ? (
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" />
          </svg>
        )}
      </IconButton>
    </Tooltip>
  )
}
