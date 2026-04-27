import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationProcessStrip } from '../src/renderer/src/components/ConversationProcessStrip'

describe('ConversationProcessStrip', () => {
  it('renders running process rows with terminate controls', () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationProcessStrip, {
        sessionId: 'session-1',
        processes: [
          {
            type: 'shell_session',
            terminalId: 'terminal-1',
            command: 'npm run dev',
            workingDirectory: '/tmp/project',
            status: 'running',
            startedAt: 1_000,
            transcript: 'App listening at http://localhost:3000\n',
            collapsed: false,
          },
        ],
        onCloseProcess: () => {},
      }),
    )

    expect(markup).toContain('Background processes running')
    expect(markup).toContain('npm run dev')
    expect(markup).toContain('/tmp/project')
    expect(markup).toContain('App listening at http://localhost:3000')
    expect(markup).toContain('Terminate process')
    expect(markup).toContain('Running')
  })
})
