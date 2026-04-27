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

  it('disables assistant history actions while the agent is running', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatCanvas, {
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'Explain local models' }],
            timestamp: 1000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Local models run on your machine.' }],
            timestamp: 2000,
          },
        ],
        streamingContent: null,
        isGenerating: true,
        isCompacting: false,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        getReadAloudButtonState: () => ({
          visible: true,
          ariaLabel: 'Read aloud',
          title: 'Read aloud',
          disabled: false,
          active: false,
          icon: 'volume' as const,
        }),
        onToggleSelectionMode: () => {},
      }),
    )

    expect(markup).toContain('Wait for the session run to finish before selecting sentences.')
    expect(markup).toContain('Read aloud is unavailable while the session run is active')
    expect(markup).toContain('Wait for the session run to finish before copying this turn.')
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBe(3)
  })
})
