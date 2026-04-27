import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Message } from '../src/renderer/src/components/Message'
import type { ChatMessage } from '../src/renderer/src/types'

function buildAssistantMessage(): ChatMessage {
  return {
    id: 'assistant-thinking-1',
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'private reasoning preview' },
      { type: 'text', text: 'Visible answer' },
    ],
    timestamp: 1_700_000_000_000,
  }
}

function buildAssistantMessageWithSummary(): ChatMessage {
  return {
    id: 'assistant-thinking-summary-1',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        text: 'private reasoning preview that should stay hidden in the collapsed preview',
        summary: 'Checking the JetBlue flight tracker directly',
      },
      { type: 'text', text: 'Visible answer' },
    ],
    timestamp: 1_700_000_000_000,
  }
}

describe('message thinking visibility', () => {
  it('shows thinking blocks by default', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessage(),
      }),
    )

    expect(html).toContain('Thinking')
    expect(html).toContain('private reasoning preview')
    expect(html).toContain('Visible answer')
  })

  it('can hide thinking blocks while keeping the final answer visible', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessage(),
        showThinkingBlocks: false,
      }),
    )

    expect(html).not.toContain('private reasoning preview')
    expect(html).toContain('Visible answer')
  })

  it('prefers the helper summary over raw thinking text in the collapsed preview', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessageWithSummary(),
      }),
    )

    expect(html).toContain('Checking the JetBlue flight tracker directly')
    expect(html).not.toContain('private reasoning preview that should stay hidden')
  })

  it('keeps active thinking collapsed when auto expansion is disabled', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessageWithSummary(),
        isStreaming: true,
        autoExpandActiveBlocks: false,
      }),
    )

    expect(html).toContain('Checking the JetBlue flight tracker directly')
    expect(html).not.toContain('private reasoning preview that should stay hidden')
  })
})
