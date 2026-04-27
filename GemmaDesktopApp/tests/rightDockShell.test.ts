import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RightDockShell } from '../src/renderer/src/components/RightDockShell'

describe('RightDockShell', () => {
  it('keeps header controls and toolbar above the title-bar drag layer', () => {
    const markup = renderToStaticMarkup(
      createElement(RightDockShell, {
        title: 'Files',
        description: 'Workspace browser',
        toolbar: createElement('div', { 'data-testid': 'toolbar' }, 'Filters'),
        onClose: () => {},
        onRefresh: () => {},
        rootPath: '/tmp/project',
        children: createElement('div', null, 'Body'),
      }),
    )

    expect(markup).toContain('class="no-drag relative z-[60] flex items-start gap-2 px-3 py-2"')
    expect(markup).toContain('class="no-drag relative z-[60] px-3 pb-2"')
    expect(markup).toContain('aria-label="Open folder in Finder"')
    expect(markup).toContain('aria-label="Refresh"')
    expect(markup).toContain('aria-label="Close panel"')
    expect(markup).toContain('data-testid="toolbar"')
  })
})
