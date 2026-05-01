import { describe, expect, it, vi } from 'vitest'
import {
  buildProjectBrowserGoogleSearchUrl,
  isAllowedProjectBrowserAgentUrl,
  getProjectBrowserDisplayUrl,
  getProjectBrowserDisplayTitle,
  isIgnorableProjectBrowserConsoleEntry,
  normalizeProjectBrowserAgentUrl,
  normalizeProjectBrowserUrl,
  normalizeProjectBrowserUserUrl,
  ProjectBrowserManager,
} from '../../src/main/projectBrowser'

describe('project browser helpers', () => {
  it('allows agent browser navigation to http and https pages', () => {
    expect(isAllowedProjectBrowserAgentUrl('http://localhost:3000')).toBe(true)
    expect(isAllowedProjectBrowserAgentUrl('https://127.0.0.1:4173/path')).toBe(true)
    expect(isAllowedProjectBrowserAgentUrl('http://app.localhost:8080')).toBe(true)
    expect(isAllowedProjectBrowserAgentUrl('https://example.com')).toBe(true)
    expect(isAllowedProjectBrowserAgentUrl('file:///tmp/index.html')).toBe(false)
  })

  it('normalizes agent website URLs', () => {
    expect(normalizeProjectBrowserAgentUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeProjectBrowserAgentUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeProjectBrowserUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeProjectBrowserUrl('https://example.com')).toBe('https://example.com/')
  })

  it('normalizes user-entered website addresses without the agent localhost restriction', () => {
    expect(normalizeProjectBrowserUserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeProjectBrowserUserUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeProjectBrowserUserUrl('localhost:3000')).toBe('http://localhost:3000/')

    expect(() => normalizeProjectBrowserUserUrl('file:///tmp/index.html')).toThrow(
      'http and https URLs',
    )
  })

  it('builds visible Google search URLs with domain filters', () => {
    const url = new URL(buildProjectBrowserGoogleSearchUrl({
      query: 'Gemma Desktop local inference',
      includeDomains: ['https://ai.google.dev/gemma', 'ollama.com/library/gemma3'],
      excludeDomains: ['example.com/docs'],
    }))

    expect(url.origin + url.pathname).toBe('https://www.google.com/search')
    expect(url.searchParams.get('q')).toBe(
      'Gemma Desktop local inference (site:ai.google.dev OR site:ollama.com) -site:example.com',
    )
    expect(() => buildProjectBrowserGoogleSearchUrl({ query: '   ' })).toThrow(
      'Google search requires a query.',
    )
  })

  it('keeps the requested URL when Electron shows an internal error page', () => {
    expect(getProjectBrowserDisplayUrl(
      'chrome-error://chromewebdata/',
      'http://localhost:3000/',
    )).toBe('http://localhost:3000/')

    expect(getProjectBrowserDisplayUrl(
      'http://localhost:4173/dashboard',
      'http://localhost:3000/',
    )).toBe('http://localhost:4173/dashboard')

    expect(getProjectBrowserDisplayUrl(
      'https://example.com/docs',
      'http://localhost:3000/',
    )).toBe('https://example.com/docs')
  })

  it('falls back to a stable title when the page has no document title', () => {
    expect(getProjectBrowserDisplayTitle('', null)).toBe('Untitled page')
    expect(getProjectBrowserDisplayTitle('  ', 'failed')).toBe('Page failed to load')
    expect(getProjectBrowserDisplayTitle('Gemma Desktop test page', null)).toBe('Gemma Desktop test page')
  })

  it('reports an empty console state before the browser has been opened', () => {
    const manager = new ProjectBrowserManager(() => {})
    const result = manager.getConsoleErrors()

    expect(manager.getState()).toMatchObject({
      open: false,
      sessionId: null,
      coBrowseActive: false,
      controlOwner: 'agent',
      controlReason: null,
      mounted: false,
      canGoBack: false,
      canGoForward: false,
      url: null,
      lastError: null,
    })

    expect(result.output).toContain('No console errors have been captured yet.')
    expect(result.structuredOutput).toEqual({
      url: null,
      totalErrorCount: 0,
      returnedErrorCount: 0,
      truncated: false,
      errors: [],
    })
  })

  it('labels captured console errors as failed browser verification evidence', () => {
    const manager = new ProjectBrowserManager(() => {})
    ;(manager as unknown as {
      pushConsoleEntry(input: {
        level: 'error'
        message: string
        sourceId?: string
        lineNumber?: number
      }): void
    }).pushConsoleEntry({
      level: 'error',
      message: 'Cannot read properties of undefined',
      sourceId: 'http://localhost:5173/src/main.ts',
      lineNumber: 42,
    })

    const result = manager.getConsoleErrors()

    expect(result.output).toContain('Verification status: failed (1 console error returned).')
    expect(result.output).toContain('Cannot read properties of undefined')
  })

  it('tracks CoBrowse browser ownership and rejects agent browser use while the user has control', () => {
    const manager = new ProjectBrowserManager(() => {})

    const userState = manager.releaseControlToUser({
      sessionId: 'session-1',
      reason: 'Complete the CAPTCHA.',
    })
    expect(userState).toMatchObject({
      sessionId: 'session-1',
      coBrowseActive: true,
      controlOwner: 'user',
      controlReason: 'Complete the CAPTCHA.',
    })
    expect(() => manager.assertAgentBrowserControl({
      sessionId: 'session-1',
      coBrowseActive: true,
    })).toThrow('must click Release control')
    expect(() => manager.assertAgentBrowserControl({
      sessionId: 'session-1',
      coBrowseActive: false,
    })).not.toThrow()

    const agentState = manager.releaseControlToAgent()
    expect(agentState).toMatchObject({
      controlOwner: 'agent',
      controlReason: null,
    })
    expect(() => manager.assertAgentBrowserControl({
      sessionId: 'session-1',
      coBrowseActive: true,
    })).not.toThrow()
  })

  it('ignores Electron CSP warning noise from arbitrary browser pages', () => {
    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'warning',
      message:
        'Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security Policy set.',
      sourceId: 'node:electron/js2c/sandbox_bundle',
    })).toBe(true)

    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'error',
      message:
        'Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security Policy set.',
      sourceId: 'node:electron/js2c/sandbox_bundle',
    })).toBe(false)

    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'warning',
      message: 'Electron Security Warning (Insecure Content-Security-Policy)',
      sourceId: 'https://example.com/app.js',
    })).toBe(false)
  })

  it('ignores noisy browser compatibility diagnostics from external pages', () => {
    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'error',
      message:
        'Unable to preventDefault inside passive event listener due to target being treated as passive. See https://www.chromestatus.com/feature/6662647093133312',
      pageUrl: 'https://www.google.com/search?q=Google+Cloud+Next+2026',
    })).toBe(true)

    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'warning',
      message: "Unrecognized feature: 'web-share'.",
      sourceId: 'https://www.google.com/xjs/app.js',
      pageUrl: 'https://www.google.com/search?q=Google+Cloud+Next+2026',
    })).toBe(true)

    expect(isIgnorableProjectBrowserConsoleEntry({
      level: 'error',
      message:
        'Unable to preventDefault inside passive event listener due to target being treated as passive.',
      pageUrl: 'http://localhost:3000/',
    })).toBe(false)
  })

  it('prints actionable hrefs in DOM search output', async () => {
    const manager = new ProjectBrowserManager(() => {})
    const executeJavaScript = vi.fn(async () => ({
      title: 'Google Search',
      url: 'https://www.google.com/search?q=Google+Cloud+Next+2026',
      matchCount: 1,
      returnedCount: 1,
      truncated: false,
      matches: [
        {
          kind: 'selector',
          pattern: 'a[href*="blog.google"]',
          tagName: 'a',
          text: "7 highlights from Google Cloud Next '26",
          attributes: {
            href: 'https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-cloud-next-26-recap/',
          },
        },
      ],
    }))

    ;(manager as unknown as {
      view: {
        webContents: {
          executeJavaScript: typeof executeJavaScript
        }
      }
    }).view = {
      webContents: {
        executeJavaScript,
      },
    }

    const result = await manager.searchDom({
      selectors: ['a[href*="blog.google"]'],
    })

    expect(result.output).toContain(
      'href="https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-cloud-next-26-recap/"',
    )
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('findTextMatchTarget'),
      true,
    )
  })
})
