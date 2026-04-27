import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationModeToolbar } from '../src/renderer/src/components/ConversationModeToolbar'

describe('ConversationModeToolbar', () => {
  it('renders a unified Explore/Act/Plan switcher', () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationModeToolbar, {
        conversationKind: 'normal',
        selectedMode: 'build',
        planMode: true,
        onSelectMode: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Switch between Explore, Act, and Plan"')
    expect(markup).toContain('title="Switch to explore mode"')
    expect(markup).toContain('title="Switch to act mode"')
    expect(markup).toContain('title="Switch to plan mode"')
  })
})
