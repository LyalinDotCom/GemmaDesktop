import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TerminalDrawer } from '../../src/renderer/src/components/TerminalDrawer'

describe('TerminalDrawer', () => {
  it('renders an idle start state before the shell has launched', () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalDrawer, {
        state: {
          terminalId: null,
          workingDirectory: '',
          status: 'idle',
          transcript: '',
        },
        expanded: false,
        onStart: () => {},
        onCollapse: () => {},
        onToggleExpanded: () => {},
        onTerminate: () => {},
      }),
    )

    expect(markup).not.toContain('Interactive terminal')
    expect(markup).toContain('No shell running yet')
    expect(markup).toContain('Start terminal')
    expect(markup).toContain('aria-label="Hide terminal"')
  })

  it('renders restart affordances and expanded height after the shell ends', () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalDrawer, {
        state: {
          terminalId: 'app-terminal-1',
          workingDirectory: '/tmp/project',
          status: 'killed',
          startedAt: 1_000,
          completedAt: 2_000,
          exitCode: 130,
          transcript: 'stopped\n',
        },
        expanded: true,
        onStart: () => {},
        onCollapse: () => {},
        onToggleExpanded: () => {},
        onTerminate: () => {},
      }),
    )

    expect(markup).toContain('/tmp/project')
    expect(markup).toContain('aria-label="Restart terminal"')
    expect(markup).toContain('This shell is no longer running')
    expect(markup).toContain('h-[300px]')
  })
})
