import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  measureProjectBrowserPanelBounds,
  ProjectBrowserPanel,
} from '../src/renderer/src/components/ProjectBrowserPanel'

describe('ProjectBrowserPanel', () => {
  it('renders the compact browser header with navigation controls and editable URL bar', () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectBrowserPanel, {
        state: {
          open: true,
          sessionId: 'session-1',
          coBrowseActive: false,
          controlOwner: 'agent',
          controlReason: null,
          mounted: true,
          loading: false,
          url: 'http://localhost:3000/',
          canGoBack: true,
          canGoForward: false,
          title: 'Gemma Desktop',
          consoleErrorCount: 2,
          recentConsoleErrors: ['[error] Failed to fetch /api/health', '[error] Unhandled promise'],
          lastError: null,
          lastUpdatedAt: 1,
        },
        onClose: () => {},
      }),
    )

    expect(markup).toContain('Browser')
    expect(markup).toContain('2 errors')
    expect(markup).toContain('Failed to fetch /api/health')
    expect(markup).toContain('aria-label="Back"')
    expect(markup).toContain('aria-label="Forward"')
    expect(markup).toContain('aria-label="Reload"')
    expect(markup).toContain('aria-label="Project Browser URL"')
    expect(markup).toContain('value="http://localhost:3000/"')
    expect(markup).not.toContain('Agent-controlled local site verification')
    expect(markup).not.toContain('Localhost-only agent browser')
  })

  it('shows the stop loading control while a page is loading', () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectBrowserPanel, {
        state: {
          open: true,
          sessionId: null,
          coBrowseActive: false,
          controlOwner: 'agent',
          controlReason: null,
          mounted: true,
          loading: true,
          url: 'https://example.com/',
          canGoBack: false,
          canGoForward: false,
          title: 'Loading…',
          consoleErrorCount: 0,
          recentConsoleErrors: [],
          lastError: null,
          lastUpdatedAt: 1,
        },
        onClose: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Stop loading"')
    expect(markup).not.toContain('aria-label="Reload"')
  })

  it('renders read-only CoBrowse while the agent owns browser control', () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectBrowserPanel, {
        state: {
          open: true,
          sessionId: 'session-1',
          coBrowseActive: true,
          controlOwner: 'agent',
          controlReason: null,
          mounted: true,
          loading: false,
          url: 'https://example.com/',
          canGoBack: false,
          canGoForward: false,
          title: 'Example',
          consoleErrorCount: 0,
          recentConsoleErrors: [],
          lastError: null,
          lastUpdatedAt: 1,
        },
        coBrowseActive: true,
        onTakeControl: () => {},
        onReleaseControl: () => {},
        onClose: () => {},
      }),
    )

    expect(markup).toContain('CoBrowse')
    expect(markup).toContain('agent control')
    expect(markup).toContain('Agent owns browser control')
    expect(markup).toContain('aria-label="Take over"')
    expect(markup).toContain('readOnly=""')
    expect(markup).toContain('lucide-mouse-pointer2')
  })

  it('renders Release control when the user has taken over CoBrowse', () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectBrowserPanel, {
        state: {
          open: true,
          sessionId: 'session-1',
          coBrowseActive: true,
          controlOwner: 'user',
          controlReason: 'Sign in to continue.',
          mounted: true,
          loading: false,
          url: 'https://example.com/login',
          canGoBack: true,
          canGoForward: false,
          title: 'Sign in',
          consoleErrorCount: 0,
          recentConsoleErrors: [],
          lastError: null,
          lastUpdatedAt: 1,
        },
        coBrowseActive: true,
        onTakeControl: () => {},
        onReleaseControl: () => {},
        onClose: () => {},
      }),
    )

    expect(markup).toContain('user control')
    expect(markup).toContain('User has browser control')
    expect(markup).toContain('Sign in to continue.')
    expect(markup).toContain('aria-label="Release control"')
    expect(markup).not.toContain('readOnly=""')
  })

  it('hides the native browser surface when another modal should cover it', () => {
    const element = {
      getBoundingClientRect: () => ({
        left: 12.4,
        top: 30.6,
        width: 420.2,
        height: 280.7,
      }),
    }

    expect(measureProjectBrowserPanelBounds(element, false)).toBeNull()
    expect(measureProjectBrowserPanelBounds(element, true)).toEqual({
      x: 12,
      y: 31,
      width: 420,
      height: 281,
    })
  })
})
