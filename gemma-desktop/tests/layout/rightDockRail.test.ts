import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RightDockRail } from '../../src/renderer/src/components/RightDockRail'

describe('RightDockRail', () => {
  it('renders a dedicated terminal toggle alongside the dock actions', () => {
    const markup = renderToStaticMarkup(
      createElement(RightDockRail, {
        activeView: 'research',
        terminalActive: true,
        terminalBusy: true,
        onSelect: () => {},
        onToggleTerminal: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Research"')
    expect(markup).toContain('aria-label="Terminal"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('aria-label="Global Chat"')
    expect(markup).not.toContain('aria-label="Browser"')
  })

  it('shows the browser action below files when available', () => {
    const markup = renderToStaticMarkup(
      createElement(RightDockRail, {
        activeView: 'browser',
        browserAvailable: true,
        onSelect: () => {},
      }),
    )

    const filesIndex = markup.indexOf('aria-label="Files"')
    const browserIndex = markup.indexOf('aria-label="Browser"')
    expect(filesIndex).toBeGreaterThan(-1)
    expect(browserIndex).toBeGreaterThan(filesIndex)
    expect(markup).toContain('aria-pressed="true"')
  })
})
