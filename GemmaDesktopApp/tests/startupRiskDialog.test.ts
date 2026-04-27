import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StartupRiskDialog } from '../src/renderer/src/components/StartupRiskDialog'

describe('StartupRiskDialog', () => {
  it('renders a mandatory startup warning with explicit risk copy and consent action', () => {
    const markup = renderToStaticMarkup(
      createElement(StartupRiskDialog, {
        onAgree: () => {},
      }),
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('Gemma Desktop is experimental software.')
    expect(markup).toContain('If you want polished and safe, use')
    expect(markup).toContain('Claude, ChatGPT, or Gemini instead.')
    expect(markup).toContain('Gemma Desktop is a fan project and is not affiliated with')
    expect(markup).toContain('endorsed by, or sponsored by Google.')
    expect(markup).toContain('Tools run without confirmation and can change your files.')
    expect(markup).toContain('No protection against prompt injection from files or the web.')
    expect(markup).toContain('Relies on community runtimes that may break unexpectedly.')
    expect(markup).toContain('Use at your own risk.')
    expect(markup).toContain('I Agree')
  })
})
