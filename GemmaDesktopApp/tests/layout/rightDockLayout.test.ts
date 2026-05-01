import { describe, expect, it } from 'vitest'
import { getRightDockLayoutClasses } from '../../src/renderer/src/lib/rightDockLayout'

function classes(value: string): string[] {
  return value.split(/\s+/).filter(Boolean)
}

describe('right dock layout spacing', () => {
  it('reserves a right gutter for the floating rail when no panel is pinned', () => {
    const layout = getRightDockLayoutClasses(false)

    expect(classes(layout.splitContainer)).toContain('pr-14')
    expect(classes(layout.splitContainer)).not.toContain('px-4')
    expect(classes(layout.mainPane)).not.toContain('pr-4')
    expect(classes(layout.statusBar)).toContain('pr-14')
    expect(classes(layout.statusBar)).not.toContain('px-4')
    expect(classes(layout.statusBarMain)).toContain('px-6')
    expect(classes(layout.statusBarMain)).not.toContain('px-4')
    expect(classes(layout.statusBarMain)).not.toContain('pr-4')
  })

  it('keeps pinned right panels on the shared app-shell padding rhythm', () => {
    const layout = getRightDockLayoutClasses(true)

    expect(classes(layout.splitContainer)).toContain('px-4')
    expect(classes(layout.splitContainer)).not.toContain('pr-14')
    expect(classes(layout.mainPane)).not.toContain('pr-4')
    expect(classes(layout.rightPanel)).toContain('pt-16')
    expect(classes(layout.rightPanel)).toContain('pr-6')
    expect(classes(layout.rightPanelResizeHandle)).toContain('top-16')
    expect(classes(layout.rightPanelResizeHandle)).toContain('bottom-0')
    expect(classes(layout.rightPanelResizeHandle)).not.toContain('h-full')
    expect(classes(layout.rightPanelInner)).not.toContain('pl-2')
    expect(classes(layout.statusBar)).toContain('px-4')
    expect(classes(layout.statusBar)).not.toContain('pr-14')
    expect(classes(layout.statusBarMain)).toContain('px-4')
    expect(classes(layout.statusBarMain)).not.toContain('px-6')
    expect(classes(layout.statusBarMain)).not.toContain('pr-4')
    expect(classes(layout.statusBarSpacer)).toContain('pr-6')
  })
})
