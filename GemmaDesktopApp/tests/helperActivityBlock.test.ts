import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Message } from '../src/renderer/src/components/Message'
import type { ChatMessage } from '../src/renderer/src/types'

function buildAssistantMessageWithHelper(args: {
  status: 'running' | 'success'
  input?: Record<string, unknown>
  summary?: string
}): ChatMessage {
  return {
    id: 'assistant-helper-render-1',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Visible answer' },
      {
        type: 'tool_call',
        toolName: 'Gemma low helper',
        input: args.input ?? {},
        status: args.status,
        summary: args.summary,
        startedAt: 1_700_000_000_000,
        completedAt: args.status === 'success' ? 1_700_000_001_000 : undefined,
      },
    ],
    timestamp: 1_700_000_000_000,
  }
}

describe('helper activity block rendering', () => {
  it('shows the running state while the helper is checking', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessageWithHelper({ status: 'running' }),
      }),
    )

    expect(html).toContain('data-helper-state="running"')
    expect(html).toContain('Helper checking')
    expect(html).not.toContain('Parent Result')
    expect(html).not.toContain('Progress')
  })

  it('shows a compact Done pill when the helper audit found no restart', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessageWithHelper({
          status: 'success',
          summary: 'Checked the final answer',
        }),
      }),
    )

    expect(html).toContain('data-helper-state="done"')
    expect(html).toContain('Checked the final answer')
    expect(html).not.toContain('Looks like we&#x27;re not done yet')
  })

  it('surfaces the restart instruction when the helper asked for a continuation', () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: buildAssistantMessageWithHelper({
          status: 'success',
          input: {
            restartInstruction:
              'Continue from the JetBlue tracker and read the route directly.',
          },
        }),
      }),
    )

    expect(html).toContain('data-helper-state="restart"')
    expect(html).toContain('Looks like we')
    expect(html).toContain(
      'Continue from the JetBlue tracker and read the route directly.',
    )
  })
})
