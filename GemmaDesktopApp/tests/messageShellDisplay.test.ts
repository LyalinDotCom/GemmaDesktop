import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Message } from '../src/renderer/src/components/Message'

describe('Message shell display modes', () => {
  it('still renders chat shell sessions inside the transcript', () => {
    const markup = renderToStaticMarkup(
      createElement(Message, {
        sessionId: 'session-1',
        message: {
          id: 'message-1',
          role: 'assistant',
          timestamp: 1_000,
          content: [
            {
              type: 'shell_session',
              terminalId: 'terminal-1',
              command: 'npm run dev',
              workingDirectory: '/tmp/project',
              status: 'running',
              startedAt: 1_000,
              transcript: 'ready\n',
              collapsed: true,
              displayMode: 'chat',
            },
          ],
        },
      }),
    )

    expect(markup).toContain('npm run dev')
    expect(markup).toContain('Shell summary')
  })

  it('does not render sidebar shell sessions as chat transcript rows', () => {
    const markup = renderToStaticMarkup(
      createElement(Message, {
        sessionId: 'session-1',
        message: {
          id: 'message-1',
          role: 'assistant',
          timestamp: 1_000,
          content: [
            {
              type: 'shell_session',
              terminalId: 'terminal-1',
              command: 'npm start',
              workingDirectory: '/tmp/project',
              status: 'running',
              startedAt: 1_000,
              transcript: 'App listening at http://localhost:3000\n',
              collapsed: false,
              displayMode: 'sidebar',
            },
          ],
        },
      }),
    )

    expect(markup).not.toContain('Background process')
    expect(markup).not.toContain('npm start')
    expect(markup).not.toContain('Running')
    expect(markup).not.toContain('App listening at http://localhost:3000')
    expect(markup).not.toContain('Terminate process')
    expect(markup).not.toContain('Shell summary')
  })
})
