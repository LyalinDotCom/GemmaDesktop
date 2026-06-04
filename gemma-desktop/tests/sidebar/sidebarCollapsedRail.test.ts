import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSourcePath = process.cwd().endsWith('gemma-desktop')
  ? 'src/renderer/src/App.tsx'
  : 'gemma-desktop/src/renderer/src/App.tsx'
const appSource = readFileSync(appSourcePath, 'utf8')

describe('App collapsed sidebar rail', () => {
  it('reserves a docked gutter for reopening the sidebar', () => {
    expect(appSource).toContain('const SIDEBAR_COLLAPSED_RAIL_WIDTH = 40')
    expect(appSource).toContain(
      'style={{ width: state.sidebarOpen ? sidebarResize.width : SIDEBAR_COLLAPSED_RAIL_WIDTH }}',
    )
    expect(appSource).toContain('aria-label="Open sidebar"')
    expect(appSource).toContain('items-center justify-center')
  })

  it('does not use a fixed collapsed toggle or visible collapsed bar', () => {
    expect(appSource).not.toContain('fixed left-[76px]')
    expect(appSource).not.toContain('items-center justify-center border-r')
  })
})
