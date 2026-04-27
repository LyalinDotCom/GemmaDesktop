import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  getEffectiveTheme,
  getStoredTheme,
  THEME_STORAGE_KEY,
} from '../src/renderer/src/hooks/useTheme'

function createThemeRoot() {
  const classes = new Set<string>()

  return {
    classList: {
      add(token: string) {
        classes.add(token)
      },
      remove(token: string) {
        classes.delete(token)
      },
    },
    has(token: string) {
      return classes.has(token)
    },
  }
}

describe('theme sync', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: Window }).window
      return
    }

    ;(globalThis as { window?: Window }).window = originalWindow
  })

  it('resolves system theme against the current appearance preference', () => {
    expect(getEffectiveTheme('system', true)).toBe('dark')
    expect(getEffectiveTheme('system', false)).toBe('light')
    expect(getEffectiveTheme('dark', false)).toBe('dark')
  })

  it('applies the dark class and persists the selected theme', () => {
    const root = createThemeRoot()
    const setItem = vi.fn()

    const effectiveTheme = applyTheme('dark', {
      prefersDark: false,
      root,
      storage: { setItem },
    })

    expect(effectiveTheme).toBe('dark')
    expect(root.has('dark')).toBe(true)
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')
  })

  it('removes the dark class when system resolves to light', () => {
    const root = createThemeRoot()
    root.classList.add('dark')

    const effectiveTheme = applyTheme('system', {
      prefersDark: false,
      root,
      storage: null,
    })

    expect(effectiveTheme).toBe('light')
    expect(root.has('dark')).toBe(false)
  })

  it('reads only valid stored theme values', () => {
    ;(globalThis as { window?: Window }).window = {
      localStorage: {
        getItem: vi.fn().mockReturnValue('dark'),
      },
    } as unknown as Window

    expect(getStoredTheme()).toBe('dark')

    ;(globalThis as { window?: Window }).window = {
      localStorage: {
        getItem: vi.fn().mockReturnValue('midnight'),
      },
    } as unknown as Window

    expect(getStoredTheme()).toBe('system')
  })
})
