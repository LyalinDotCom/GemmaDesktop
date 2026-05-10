import { describe, expect, it, vi } from 'vitest'
import { buildGemmaDesktopMenuBarTemplate } from '../../src/main/menuBar'

describe('buildGemmaDesktopMenuBarTemplate', () => {
  it('exposes the app controls in the tray menu', () => {
    const onShowApp = vi.fn()

    const template = buildGemmaDesktopMenuBarTemplate({
      onShowApp,
    })

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'Show Gemma',
      'separator',
      'Quit Gemma',
    ])

    const showAppItem = template[0]

    showAppItem?.click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as KeyboardEvent,
    )

    expect(onShowApp).toHaveBeenCalledOnce()
  })
})
