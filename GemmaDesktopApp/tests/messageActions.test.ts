import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Message } from '../src/renderer/src/components/Message'
import type { ChatMessage } from '../src/renderer/src/types'

function buildAssistantMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'Streaming answer' }],
    timestamp: 1_700_000_000_000,
  }
}

describe('message actions', () => {
  it('hides all assistant action buttons while streaming', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessage(),
        isStreaming: true,
        showSelectionAction: true,
        showCopyAction: true,
        readAloudAction: {
          visible: false,
          ariaLabel: 'Read aloud',
          title: '',
          disabled: true,
          active: false,
          icon: 'volume',
        },
      }),
    )

    expect(html).not.toContain('aria-label="Read aloud"')
    expect(html).not.toContain('aria-label="Copy turn"')
    expect(html).not.toContain('aria-label="Select sentences to quote in the next message"')
  })

  it('shows active assistant actions after streaming completes', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessage(),
        showSelectionAction: true,
        showCopyAction: true,
        onToggleSelectionMode: () => {},
        onCopyTurn: () => {},
        readAloudAction: {
          visible: true,
          ariaLabel: 'Read this response aloud',
          title: 'Read this response aloud',
          disabled: false,
          active: false,
          icon: 'volume',
          onClick: () => {},
        },
      }),
    )

    expect(html).toContain('aria-label="Select sentences to quote in the next message"')
    expect(html).toContain('aria-label="Read this response aloud"')
    expect(html).toContain('aria-label="Copy turn"')
    expect(html).not.toContain('disabled=""')
  })

  it('does not wrap assistant text in sentence spans outside selection mode', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: {
          ...buildAssistantMessage(),
          content: [{ type: 'text', text: 'One sentence. Another sentence.' }],
        },
        showSelectionAction: true,
        onToggleSelectionMode: () => {},
        onToggleSentence: () => {},
      }),
    )

    expect(html).not.toContain('data-sentence-key')
  })

  it('wraps assistant text in sentence spans while selection mode is active', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: {
          ...buildAssistantMessage(),
          content: [{ type: 'text', text: 'One sentence. Another sentence.' }],
        },
        selectionMode: true,
        showSelectionAction: true,
        onToggleSelectionMode: () => {},
        onToggleSentence: () => {},
      }),
    )

    expect(html).toContain('data-sentence-key')
  })
})
