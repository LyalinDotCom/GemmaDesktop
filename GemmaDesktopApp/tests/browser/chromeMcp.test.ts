import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  applyChromeToolArgumentDefaults,
  ChromeMcpService,
  CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS,
  CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS,
  DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
  DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
  executeChromeBrowserTool,
  extractChromePagesFromText,
  isChromeBrowserMutatingActionName,
  isNavigationTimeoutError,
  recoverNavigationTimeoutResult,
  resolveChromeToolRequestOptions,
} from '../../src/main/chromeMcp'

describe('chromeMcp helpers', () => {
  it('adds a default timeout to navigation tools when none is provided', () => {
    expect(applyChromeToolArgumentDefaults('new_page', {
      url: 'https://cnn.com',
    })).toEqual({
      url: 'https://cnn.com',
      timeout: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
    })

    expect(applyChromeToolArgumentDefaults('navigate_page', {
      type: 'url',
      url: 'https://cnn.com',
    })).toEqual({
      type: 'url',
      url: 'https://cnn.com',
      timeout: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
    })

    expect(applyChromeToolArgumentDefaults('list_pages', {})).toEqual({})
  })

  it('preserves an explicit timeout for navigation tools', () => {
    expect(applyChromeToolArgumentDefaults('new_page', {
      url: 'https://cnn.com',
      timeout: 5_000,
    })).toEqual({
      url: 'https://cnn.com',
      timeout: 5_000,
    })
  })

  it('recognizes navigation timeout errors', () => {
    expect(
      isNavigationTimeoutError(new Error('Navigation timeout of 10000 ms exceeded')),
    ).toBe(true)
    expect(isNavigationTimeoutError(new Error('Some other browser error'))).toBe(false)
  })

  it('uses tighter MCP request timeouts for Chrome tools', () => {
    expect(resolveChromeToolRequestOptions('list_pages', {})).toEqual({
      timeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
      maxTotalTimeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
    })

    expect(resolveChromeToolRequestOptions('navigate_page', {
      type: 'url',
      url: 'https://cnn.com',
      timeout: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
    })).toEqual({
      timeout: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS + CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS,
      maxTotalTimeout:
        DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS + CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS,
    })
  })
})

describe('navigation timeout recovery', () => {
  it('recovers from a timed out new_page after the tab is created', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '0: about:blank\n1: CNN https://cnn.com [selected]',
          },
        ],
      })

    const result = await recoverNavigationTimeoutResult({
      service: {
        callTool,
      },
      name: 'new_page',
      args: applyChromeToolArgumentDefaults('new_page', {
        url: 'https://cnn.com',
      }),
      error: new Error('Navigation timeout of 10000 ms exceeded'),
    })

    expect(callTool).toHaveBeenNthCalledWith(1, 'list_pages', {})
    expect(result).not.toBeNull()
    expect(result?.output).toContain('Chrome opened a new tab for https://cnn.com')
    expect(result?.output).toContain(
      `did not finish loading within ${DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS} ms`,
    )
    expect(result?.output).toContain('Open pages:')
    expect(result?.structuredOutput).toEqual(expect.objectContaining({
      recoveredFromNavigationTimeout: true,
      toolName: 'new_page',
      timeoutMs: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
    }))
  })

  it('does not recover unrelated errors', async () => {
    const result = await recoverNavigationTimeoutResult({
      service: {
        callTool: vi.fn(),
      },
      name: 'new_page',
      args: applyChromeToolArgumentDefaults('new_page', {
        url: 'https://cnn.com',
      }),
      error: new Error('Something else failed'),
    })

    expect(result).toBeNull()
  })

  it('recovers from an MCP request timeout during navigate_page', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '0: CNN https://cnn.com [selected]',
          },
        ],
      })

    const result = await recoverNavigationTimeoutResult({
      service: {
        callTool,
      },
      name: 'navigate_page',
      args: applyChromeToolArgumentDefaults('navigate_page', {
        type: 'url',
        url: 'https://cnn.com',
      }),
      error: new Error('Request timed out'),
    })

    expect(callTool).toHaveBeenNthCalledWith(1, 'list_pages', {})
    expect(result).not.toBeNull()
    expect(result?.output).toContain(
      `did not answer within ${
        DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS + CHROME_TOOL_REQUEST_TIMEOUT_GRACE_MS
      } ms`,
    )
    expect(result?.structuredOutput).toEqual(expect.objectContaining({
      recoveredFromNavigationTimeout: true,
      recoveryKind: 'mcp_request_timeout',
      toolName: 'navigate_page',
      timeoutMs: DEFAULT_CHROME_NAVIGATION_TIMEOUT_MS,
    }))
  })
})

describe('browser wrapper helpers', () => {
  it('marks only mutating browser actions as approval-gated', () => {
    expect(isChromeBrowserMutatingActionName('open')).toBe(true)
    expect(isChromeBrowserMutatingActionName('evaluate')).toBe(true)
    expect(isChromeBrowserMutatingActionName('tabs')).toBe(false)
    expect(isChromeBrowserMutatingActionName('snapshot')).toBe(false)
  })

  it('summarizes open actions and returns the current tab list', async () => {
    const callRawTool = vi.fn(async (name: string) => {
      if (name === 'new_page') {
        return {
          output: 'opened',
          structuredOutput: {
            pages: [
              { id: 1, url: 'https://www.youtube.com', selected: false },
              { id: 2, url: 'https://cnn.com', selected: true },
            ],
          },
        }
      }

      throw new Error(`unexpected tool ${name}`)
    })

    const result = await executeChromeBrowserTool({
      sessionId: 'session-open',
      args: {
        action: 'open',
        url: 'https://cnn.com',
      },
      callRawTool,
    })

    expect(callRawTool).toHaveBeenNthCalledWith(1, 'new_page', {
      url: 'https://cnn.com',
    })
    expect(result.output).toContain('Opened a new Chrome tab for https://cnn.com.')
    expect(result.output).toContain('2: https://cnn.com [selected]')
    expect(result.structuredOutput).toEqual({
      action: 'open',
      url: 'https://cnn.com',
      pageId: 2,
      pages: [
        { id: 1, url: 'https://www.youtube.com', selected: false },
        { id: 2, url: 'https://cnn.com', selected: true },
      ],
    })
  })

  it('passes the explicit pageId through to raw navigate_page calls', async () => {
    const callRawTool = vi.fn(async (name: string) => {
      if (name === 'select_page') {
        return {
          output: 'selected',
        }
      }

      if (name === 'navigate_page') {
        return {
          output: 'Successfully navigated to https://www.msnbc.com.',
        }
      }

      throw new Error(`unexpected tool ${name}`)
    })

    const result = await executeChromeBrowserTool({
      sessionId: 'session-navigate-explicit',
      args: {
        action: 'navigate',
        pageId: 2,
        url: 'https://www.msnbc.com',
      },
      callRawTool,
    })

    expect(callRawTool).toHaveBeenNthCalledWith(1, 'select_page', {
      pageId: 2,
    })
    expect(callRawTool).toHaveBeenNthCalledWith(2, 'navigate_page', {
      pageId: 2,
      type: 'url',
      url: 'https://www.msnbc.com',
    })
    expect(result.output).toContain('Updated the targeted Chrome tab to https://www.msnbc.com.')
    expect(result.output).toContain('Successfully navigated to https://www.msnbc.com.')
    expect(result.structuredOutput).toEqual({
      action: 'navigate',
      pageId: 2,
      url: 'https://www.msnbc.com',
      navigation: 'url',
    })
  })

  it('infers the selected pageId before navigating when none is provided', async () => {
    const callRawTool = vi.fn(async (name: string) => {
      if (name === 'list_pages') {
        const listPageCallCount = callRawTool.mock.calls.filter(
          ([toolName]) => toolName === 'list_pages',
        ).length
        if (listPageCallCount === 1) {
          return {
            output: 'pages',
            structuredOutput: {
              pages: [
                { id: 1, url: 'https://www.cnn.com', selected: false },
                { id: 2, url: 'https://news.ycombinator.com', selected: true },
              ],
            },
          }
        }

        return {
          output: 'pages',
          structuredOutput: {
            pages: [
              { id: 1, url: 'https://www.cnn.com', selected: false },
              { id: 2, url: 'https://www.msnbc.com', selected: true },
            ],
          },
        }
      }

      if (name === 'navigate_page') {
        return {
          output: 'Successfully navigated to https://www.msnbc.com.',
        }
      }

      throw new Error(`unexpected tool ${name}`)
    })

    const result = await executeChromeBrowserTool({
      sessionId: 'session-navigate-inferred',
      args: {
        action: 'navigate',
        url: 'https://www.msnbc.com',
      },
      callRawTool,
    })

    expect(callRawTool).toHaveBeenNthCalledWith(1, 'list_pages', {})
    expect(callRawTool).toHaveBeenNthCalledWith(2, 'navigate_page', {
      pageId: 2,
      type: 'url',
      url: 'https://www.msnbc.com',
    })
    expect(result.output).toContain('Updated the targeted Chrome tab to https://www.msnbc.com.')
    expect(result.output).toContain('Successfully navigated to https://www.msnbc.com.')
    expect(result.structuredOutput).toEqual({
      action: 'navigate',
      pageId: 2,
      url: 'https://www.msnbc.com',
      navigation: 'url',
    })
  })

  it('summarizes structured snapshots and persists oversized details to disk', async () => {
    const persistArtifact = vi.fn(async () => ({
      path: '/tmp/browser-snapshot.md',
      fileUrl: 'file:///tmp/browser-snapshot.md',
    }))
    const callRawTool = vi.fn(async (name: string) => {
      if (name !== 'take_snapshot') {
        throw new Error(`unexpected tool ${name}`)
      }

      return {
        output: 'raw snapshot',
        structuredOutput: {
          snapshot: {
            role: 'rootwebarea',
            name: 'CNN',
            children: Array.from({ length: 8 }, (_, index) => ({
              id: `node-${index + 1}`,
              role: 'link',
              name: `Headline ${index + 1} ${'x'.repeat(70)}`,
            })),
          },
        },
      }
    })

    const result = await executeChromeBrowserTool({
      sessionId: 'session-snapshot',
      args: {
        action: 'snapshot',
        maxChars: 220,
      },
      callRawTool,
      persistArtifact,
    })

    expect(callRawTool).toHaveBeenCalledWith('take_snapshot', {})
    expect(persistArtifact).toHaveBeenCalledTimes(1)
    expect(result.output).toContain('Captured a Chrome page snapshot.')
    expect(result.output).toContain('/tmp/browser-snapshot.md')
    expect(result.output).toContain('Headline 1')
    expect(result.structuredOutput).toBeDefined()
    expect(result.structuredOutput?.action).toBe('snapshot')
    expect(result.structuredOutput?.truncated).toBe(true)
    expect(result.structuredOutput?.artifactPath).toBe('/tmp/browser-snapshot.md')
    expect(result.structuredOutput?.artifactFileUrl).toBe('file:///tmp/browser-snapshot.md')
    expect(typeof result.structuredOutput?.originalChars).toBe('number')
  })
})

describe('ChromeMcpService', () => {
  const baseOptions = {
    disableUsageStatistics: false,
    disablePerformanceCrux: false,
    onStatus: vi.fn(),
  }

  function createFakeTransport(pid = 123) {
    return {
      pid,
      stderr: null,
      close: vi.fn().mockResolvedValue(undefined),
    }
  }

  function createFakeClient(toolImpl: Parameters<typeof vi.fn>[0]) {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'list_pages' }, { name: 'take_snapshot' }],
      }),
      callTool: vi.fn(toolImpl),
      close: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('waits for list_pages to succeed before treating attach as ready', async () => {
    const transport = createFakeTransport()
    const sleep = vi.fn().mockResolvedValue(undefined)
    const client = createFakeClient(async ({ name }: { name: string }) => {
      if (name === 'list_pages' && client.callTool.mock.calls.length === 1) {
        return {
          content: [{ type: 'text', text: 'attach still warming up' }],
          isError: true,
        }
      }
      if (name === 'list_pages') {
        return {
          content: [{ type: 'text', text: '1: https://cnn.com [selected]' }],
        }
      }
      if (name === 'take_snapshot') {
        return {
          content: [{ type: 'text', text: 'snapshot ok' }],
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const service = new ChromeMcpService('session-1', baseOptions, {
      createTransport: () => transport,
      createClient: () => client,
      sleep,
    })

    const result = await service.callTool('take_snapshot', {})

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(client.callTool).toHaveBeenNthCalledWith(
      1,
      { name: 'list_pages', arguments: {} },
      undefined,
      {
        timeout: CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS,
        maxTotalTimeout: CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS,
      },
    )
    expect(client.callTool).toHaveBeenNthCalledWith(
      2,
      { name: 'list_pages', arguments: {} },
      undefined,
      {
        timeout: CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS,
        maxTotalTimeout: CHROME_MCP_ATTACH_READY_PROBE_TIMEOUT_MS,
      },
    )
    expect(client.callTool).toHaveBeenNthCalledWith(
      3,
      { name: 'take_snapshot', arguments: {} },
      undefined,
      {
        timeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
        maxTotalTimeout: DEFAULT_CHROME_TOOL_REQUEST_TIMEOUT_MS,
      },
    )
    expect(result).toEqual({
      content: [{ type: 'text', text: 'snapshot ok' }],
      isError: undefined,
      structuredContent: undefined,
    })
  })

  it('parses text-only page listings into structured pages', async () => {
    const transport = createFakeTransport()
    const client = createFakeClient(async ({ name }: { name: string }) => {
      if (name === 'list_pages') {
        return {
          content: [{
            type: 'text',
            text: [
              '## Pages',
              '1: https://cnn.com [selected]',
              '2: https://example.com',
            ].join('\n'),
          }],
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const service = new ChromeMcpService('session-2', baseOptions, {
      createTransport: () => transport,
      createClient: () => client,
      sleep: vi.fn().mockResolvedValue(undefined),
    })

    const result = await service.callTool('list_pages', {})

    expect(result.structuredContent).toEqual({
      pages: [
        { id: 1, url: 'https://cnn.com', selected: true },
        { id: 2, url: 'https://example.com' },
      ],
    })
  })

  it('disconnects a stale transport so the next call reconnects cleanly', async () => {
    const transports = [createFakeTransport(111), createFakeTransport(222)]
    const clients = [
      createFakeClient(async ({ name }: { name: string }) => {
        if (name === 'list_pages') {
          return {
            content: [{ type: 'text', text: '1: https://cnn.com [selected]' }],
          }
        }
        if (name === 'take_snapshot') {
          throw new Error('The socket connection was closed unexpectedly')
        }
        throw new Error(`unexpected tool ${name}`)
      }),
      createFakeClient(async ({ name }: { name: string }) => {
        if (name === 'list_pages') {
          return {
            content: [{ type: 'text', text: '1: https://cnn.com [selected]' }],
          }
        }
        if (name === 'take_snapshot') {
          return {
            content: [{ type: 'text', text: 'snapshot ok after reconnect' }],
          }
        }
        throw new Error(`unexpected tool ${name}`)
      }),
    ]

    let transportIndex = 0
    let clientIndex = 0
    const service = new ChromeMcpService('session-3', baseOptions, {
      createTransport: () => transports[transportIndex++]!,
      createClient: () => clients[clientIndex++]!,
      sleep: vi.fn().mockResolvedValue(undefined),
    })

    await expect(service.callTool('take_snapshot', {})).rejects.toThrow(
      /socket connection was closed unexpectedly/i,
    )
    expect(clients[0]?.close).toHaveBeenCalledTimes(1)
    expect(transports[0]?.close).toHaveBeenCalledTimes(1)

    const result = await service.callTool('take_snapshot', {})

    expect(clientIndex).toBe(2)
    expect(transportIndex).toBe(2)
    expect(result).toEqual({
      content: [{ type: 'text', text: 'snapshot ok after reconnect' }],
      isError: undefined,
      structuredContent: undefined,
    })
  })

  it('ignores noisy Chrome MCP performance issue stderr lines', async () => {
    const stderr = new PassThrough()
    const transport = {
      pid: 123,
      stderr,
      close: vi.fn().mockResolvedValue(undefined),
    }
    const onLog = vi.fn()
    const client = createFakeClient(async ({ name }: { name: string }) => {
      if (name === 'list_pages') {
        return {
          content: [{ type: 'text', text: '1: https://cnn.com [selected]' }],
        }
      }
      if (name === 'take_snapshot') {
        return {
          content: [{ type: 'text', text: 'snapshot ok' }],
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const service = new ChromeMcpService('session-logs', {
      ...baseOptions,
      onLog,
    }, {
      createTransport: () => transport,
      createClient: () => client,
    })

    await service.callTool('take_snapshot', {})
    stderr.write('No handler registered for issue code PerformanceIssue\n')
    stderr.write('Actual useful log line\n')

    expect(onLog).toHaveBeenCalledTimes(1)
    expect(onLog).toHaveBeenCalledWith('session-logs', 'Actual useful log line')
  })
})

describe('page parsing helpers', () => {
  it('extracts page ids, urls, and selected state from text output', () => {
    expect(extractChromePagesFromText([
      '## Pages',
      '1: CNN https://cnn.com [selected]',
      '2: about:blank',
    ].join('\n'))).toEqual([
      { id: 1, url: 'https://cnn.com', selected: true },
      { id: 2, url: 'about:blank', selected: false },
    ])
  })
})
