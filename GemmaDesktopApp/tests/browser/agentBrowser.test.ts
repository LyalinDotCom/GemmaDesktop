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

  it('scans a CNN-style page with more stories after the default three scrolls', async () => {
    const linksByStep = [
      [
        {
          text: 'CNN fixture lead story about global markets and policy shifts',
          href: 'https://www.cnn.com/2026/05/01/business/global-markets-policy',
        },
        {
          text: 'CNN fixture live updates on severe weather across the US',
          href: 'https://www.cnn.com/2026/05/01/weather/live-updates',
        },
      ],
      [
        {
          text: 'CNN fixture live updates on severe weather across the US',
          href: 'https://www.cnn.com/2026/05/01/weather/live-updates',
        },
        {
          text: 'CNN fixture analysis of a major election night result',
          href: 'https://www.cnn.com/2026/05/01/politics/election-analysis',
        },
      ],
      [
        {
          text: 'CNN fixture health story on hospital staffing pressure',
          href: 'https://www.cnn.com/2026/05/01/health/hospital-staffing',
        },
      ],
      [
        {
          text: 'CNN fixture travel story about airport delays this weekend',
          href: 'https://www.cnn.com/2026/05/01/travel/airport-delays',
        },
      ],
    ]
    let stepIndex = 0
    const { cli, execJson } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'screenshot') {
          return {
            success: true,
            data: {
              path: `/tmp/cnn-scan-step-${stepIndex}.png`,
            },
          }
        }

        if (args[0] === 'eval') {
          return {
            success: true,
            data: {
              result: {
                scrollY: stepIndex * 900,
                viewportHeight: 720,
                documentHeight: 3600,
                links: linksByStep[stepIndex] ?? [],
              },
            },
          }
        }

        if (args[0] === 'scroll') {
          stepIndex += 1
          return { success: true, data: {} }
        }

        if (args[0] === 'wait') {
          return { success: true, data: {} }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-scan-page',
      args: {
        action: 'scan_page',
      },
      cli,
    })

    expect(execJson.mock.calls.slice(0, 2).map((call) => call[1][0])).toEqual([
      'screenshot',
      'eval',
    ])
    expect(execJson.mock.calls.filter((call) => call[1][0] === 'scroll')).toHaveLength(3)
    expect(result.output).toContain('scrolling added 3')
    expect(result.output).toContain('CNN fixture travel story')
    expect(result.structuredOutput).toEqual(expect.objectContaining({
      action: 'scan_page',
      scrolls: 3,
      screenshotCount: 4,
      firstViewportStoryCount: 2,
      uniqueStoryCount: 5,
      addedAfterFirstViewport: 3,
    }))
  })

  it('keeps the first scan screenshot and reports later scroll failures without failing', async () => {
    let screenshotCalls = 0
    const { cli } = createCliMocks(
      async (_sessionId: string | null, args: string[]) => {
        if (args[0] === 'screenshot') {
          screenshotCalls += 1
          if (screenshotCalls > 1) {
            throw new Error('page became unstable')
          }
          return {
            success: true,
            data: {
              path: '/tmp/first-scan.png',
            },
          }
        }

        if (args[0] === 'eval') {
          return {
            success: true,
            data: {
              result: {
                scrollY: 0,
                viewportHeight: 720,
                documentHeight: 1400,
                links: [
                  {
                    text: 'CNN fixture first story remains available after scan errors',
                    href: 'https://www.cnn.com/2026/05/01/us/first-story',
                  },
                ],
              },
            },
          }
        }

        if (args[0] === 'scroll') {
          throw new Error('scroll target detached')
        }

        if (args[0] === 'wait') {
          return { success: true, data: {} }
        }

        throw new Error(`unexpected args ${args.join(' ')}`)
      },
    )

    const result = await executeAgentBrowserTool({
      sessionId: 'session-scan-page-errors',
      args: {
        action: 'scan_page',
        scrolls: 1,
      },
      cli,
    })

    expect(result.output).toContain('/tmp/first-scan.png')
    expect(result.output).toContain('Warnings:')
    expect(result.output).toContain('scroll target detached')
    expect(result.output).toContain('page became unstable')
    expect(result.structuredOutput).toEqual(expect.objectContaining({
      action: 'scan_page',
      screenshotCount: 1,
      uniqueStoryCount: 1,
    }))
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
