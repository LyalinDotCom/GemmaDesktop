import { describe, expect, it, vi } from 'vitest'
import {
  __testing as agentBrowserTesting,
  executeAgentBrowserTool,
  isBrowserMutatingActionName,
} from '../../src/main/agentBrowser'

type BrowserCli = Parameters<typeof executeAgentBrowserTool>[0]['cli']

function createCliMocks(
  execJsonImpl: (sessionId: string | null, args: string[]) => Promise<unknown>,
) {
  const execJson = vi.fn(
    async <T>(sessionId: string | null, args: string[]) =>
      await execJsonImpl(sessionId, args) as {
        success?: boolean
        data?: T
        error?: string | null
        warning?: unknown
      },
  )
  const execText = vi.fn(async () => '')

  return {
    cli: {
      execJson,
      execText,
    } as BrowserCli,
    execJson,
    execText,
  }
}

describe('agentBrowser helpers', () => {
  it('marks only mutating browser actions as approval-gated', () => {
    expect(isBrowserMutatingActionName('open')).toBe(true)
    expect(isBrowserMutatingActionName('evaluate')).toBe(true)
    expect(isBrowserMutatingActionName('tabs')).toBe(false)
    expect(isBrowserMutatingActionName('snapshot')).toBe(false)
  })

  it('treats empty-output and network-style browser failures as retryable', () => {
    expect(
      agentBrowserTesting.isRetryableBrowserCommandFailure(
        'Managed browser returned no output.',
      ),
    ).toBe(true)
    expect(
      agentBrowserTesting.isRetryableBrowserCommandFailure(
        'Navigation timeout of 30000ms exceeded',
      ),
    ).toBe(true)
    expect(
      agentBrowserTesting.isRetryableBrowserCommandFailure(
        'Browser action "open" requires url.',
      ),
    ).toBe(false)
  })

  it('formats browser command failures with retry context', () => {
    expect(
      agentBrowserTesting.formatBrowserCommandFailureMessage([
        { attempt: 1, message: 'Managed browser returned no output.' },
        { attempt: 2, message: 'Managed browser returned no output.' },
      ]),
    ).toContain('transient browser, site, or network stall')
  })

  it('opens a new tab and returns the current tab list', async () => {
    const { cli, execJson } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'tab' && args[1] === 'new') {
          return {
            success: true,
            data: {
              title: 'Example Domain',
              url: 'https://example.com/',
            },
          }
        }

        if (args[0] === 'tab' && args.length === 1) {
          return {
            success: true,
            data: {
              tabs: [
                { tabId: 't1', url: 'about:blank', active: false },
                {
                  tabId: 't2',
                  title: 'Example Domain',
                  url: 'https://example.com/',
                  active: true,
                },
              ],
            },
          }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-open',
      args: {
        action: 'open',
        url: 'https://example.com',
      },
      cli,
    })

    expect(execJson).toHaveBeenNthCalledWith(
      1,
      'session-open',
      ['tab', 'new', 'https://example.com'],
    )
    expect(execJson).toHaveBeenNthCalledWith(2, 'session-open', ['tab'])
    expect(result.output).toContain('Opened a new browser tab for https://example.com.')
    expect(result.output).toContain('t2 [active]: Example Domain — https://example.com/')
    expect(result.structuredOutput).toEqual(expect.objectContaining({
      action: 'open',
      url: 'https://example.com',
      tabId: 't2',
      title: 'Example Domain',
      tabs: [
        expect.objectContaining({ tabId: 't1', url: 'about:blank' }),
        expect.objectContaining({
          tabId: 't2',
          title: 'Example Domain',
          url: 'https://example.com/',
          active: true,
        }),
      ],
    }))
  })

  it('supports load-state waits for dynamic pages', async () => {
    const { cli, execJson } = createCliMocks(async () => ({ success: true, data: {} }))

    const result = await executeAgentBrowserTool({
      sessionId: 'session-wait',
      args: {
        action: 'wait',
        waitForLoadState: 'networkidle',
      },
      cli,
    })

    expect(execJson).toHaveBeenCalledWith(
      'session-wait',
      ['wait', '--load', 'networkidle'],
    )
    expect(result.output).toContain('Reached load state: networkidle')
    expect(result.structuredOutput).toEqual({
      action: 'wait',
      waitForLoadState: 'networkidle',
    })
  })

  it('normalizes snapshot refs into @eN handles', async () => {
    const { cli, execJson } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'snapshot') {
          return {
            success: true,
            data: {
              origin: 'https://example.com/',
              refs: {
                e1: { role: 'link', name: 'Learn more' },
              },
              snapshot: '- link "Learn more" [ref=e1]',
            },
          }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-snapshot',
      args: {
        action: 'snapshot',
      },
      cli,
    })

    expect(execJson).toHaveBeenCalledWith('session-snapshot', ['snapshot'])
    expect(result.output).toContain('Captured a browser snapshot.')
    expect(result.output).toContain('ref=@e1')
    expect(result.structuredOutput).toEqual({
      action: 'snapshot',
      snapshotMode: 'full',
      origin: 'https://example.com/',
      refs: {
        e1: { role: 'link', name: 'Learn more' },
      },
    })
  })

  it('falls back to an interactive snapshot when the full snapshot is empty', async () => {
    const { cli, execJson } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'snapshot' && args.length === 1) {
          return {
            success: true,
            data: {
              origin: 'https://example.com/',
              refs: {},
              snapshot: '',
            },
          }
        }

        if (args[0] === 'snapshot' && args[1] === '-i') {
          return {
            success: true,
            data: {
              origin: 'https://example.com/',
              refs: {
                e1: { role: 'heading', name: 'Static headline' },
              },
              snapshot: '- heading "Static headline" [level=1, ref=e1]\n- StaticText "Story body"',
            },
          }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-snapshot-fallback',
      args: {
        action: 'snapshot',
      },
      cli,
    })

    expect(execJson).toHaveBeenNthCalledWith(1, 'session-snapshot-fallback', ['snapshot'])
    expect(execJson).toHaveBeenNthCalledWith(2, 'session-snapshot-fallback', ['snapshot', '-i'])
    expect(result.output).toContain('Static headline')
    expect(result.output).toContain('ref=@e1')
    expect(result.structuredOutput).toEqual({
      action: 'snapshot',
      snapshotMode: 'interactive',
      origin: 'https://example.com/',
      refs: {
        e1: { role: 'heading', name: 'Static headline' },
      },
    })
  })

  it('invokes model-supplied evaluate functions before passing them to agent-browser', async () => {
    const { cli, execJson } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'eval') {
          return {
            success: true,
            data: {
              origin: 'https://example.com/',
              result: ['Static headline'],
            },
          }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-evaluate',
      args: {
        action: 'evaluate',
        function: '(selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent?.trim())',
        args: ['h1'],
      },
      cli,
    })

    expect(execJson).toHaveBeenCalledWith(
      'session-evaluate',
      [
        'eval',
        '((selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent?.trim()))(...["h1"])',
      ],
    )
    expect(result.output).toContain('Static headline')
  })

  it('passes already-invoked evaluate expressions through unchanged', async () => {
    const script = '(() => document.title)()'
    const { cli, execJson } = createCliMocks(async () => ({
      success: true,
      data: {
        result: 'Example Domain',
      },
    }))

    await executeAgentBrowserTool({
      sessionId: 'session-evaluate-expression',
      args: {
        action: 'evaluate',
        function: script,
      },
      cli,
    })

    expect(execJson).toHaveBeenCalledWith('session-evaluate-expression', ['eval', script])
  })

  it('accepts snapshot-style ref handles when clicking', async () => {
    const { cli, execJson } = createCliMocks(async () => ({ success: true, data: {} }))

    const result = await executeAgentBrowserTool({
      sessionId: 'session-click',
      args: {
        action: 'click',
        ref: '@e15',
      },
      cli,
    })

    expect(execJson).toHaveBeenCalledWith('session-click', ['click', '@e15'])
    expect(result.structuredOutput).toEqual({
      action: 'click',
      ref: '@e15',
    })
  })
})
