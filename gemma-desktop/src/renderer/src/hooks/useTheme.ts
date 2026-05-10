import { useEffect } from 'react'

export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'gemma-desktop-theme'

type ThemeRoot = {
  classList: {
    add(token: string): void
    remove(token: string): void
  }
}

type ThemeStorage = {
  setItem(key: string, value: string): void
}

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') {
    return 'system'
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
      return storedTheme
    }
  } catch {
    // Ignore renderer storage read failures and fall back to the default theme.
  }

  return 'system'
}

export function getEffectiveTheme(
  theme: Theme,
  prefersDark: boolean,
): 'light' | 'dark' {
  if (theme !== 'system') {
    return theme
  }

  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(
  theme: Theme,
  options: {
    prefersDark?: boolean
    root?: ThemeRoot | null
    storage?: ThemeStorage | null
  } = {},
): 'light' | 'dark' {
  const prefersDark =
    options.prefersDark
    ?? (
      typeof window !== 'undefined'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
    )

  const effectiveTheme = getEffectiveTheme(theme, prefersDark)
  const root = options.root ?? (
    typeof document !== 'undefined' ? document.documentElement : null
  )
  const storage = options.storage ?? (
    typeof window !== 'undefined' ? window.localStorage : null
  )

  if (root) {
    if (effectiveTheme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }

  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Ignore renderer storage write failures and keep the in-memory theme applied.
  }

  return effectiveTheme
}

export function useTheme(theme: Theme) {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    applyTheme(theme, { prefersDark: mediaQuery.matches })

    if (theme !== 'system') {
      return
    }

    const handleChange = () => {
      applyTheme('system', { prefersDark: mediaQuery.matches })
    }

    mediaQuery.addEventListener('change', handleChange)

    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])
}
