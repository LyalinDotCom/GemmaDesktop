import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatCanvas } from '../src/renderer/src/components/ChatCanvas'

describe('ChatCanvas layout', () => {
  it('uses the full available pane width in expanded split layout', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [],
        streamingContent: null,
        isGenerating: false,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        contentLayout: 'expanded',
      }),
    )

    expect(markup).toContain('class="w-full px-4 pb-4 pt-4"')
    expect(markup).not.toContain('max-w-chat')
  })
})
