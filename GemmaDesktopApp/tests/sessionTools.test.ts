import { describe, expect, it } from 'vitest'
import {
  ASK_GEMINI_SESSION_TOOL_ID,
  ASK_GEMINI_TOOL_NAME,
  CHROME_BROWSER_TOOL_NAME,
  CHROME_BROWSER_TOOL_NAME_SET,
  CHROME_DEVTOOLS_SESSION_TOOL_ID,
  getDefaultSelectedSessionToolIds,
  getScopedSessionToolDefinitions,
  getSelectedSessionToolInstructions,
  getSelectedSessionToolNames,
  getSessionToolDefinitions,
} from '../src/shared/sessionTools'

describe('session tools', () => {
  it('exposes only chat-specific session tools', () => {
    const tools = getSessionToolDefinitions({
      chromeMcpEnabled: true,
    })

    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      expect(tools).toEqual([
        expect.objectContaining({
          id: CHROME_DEVTOOLS_SESSION_TOOL_ID,
          name: 'Chrome DevTools',
        }),
        expect.objectContaining({
          id: ASK_GEMINI_SESSION_TOOL_ID,
          name: 'Ask Gemini',
        }),
      ])
      return
    }

    expect(tools).toEqual([])
  })

  it('returns no default selected ids for globally available browser access', () => {
    expect(getDefaultSelectedSessionToolIds({
      chromeMcpEnabled: true,
      chromeMcpDefaultSelected: true,
    })).toEqual([])

    expect(getDefaultSelectedSessionToolIds({
      chromeMcpEnabled: true,
      chromeMcpDefaultSelected: false,
    })).toEqual([])
  })

  it('builds instructions and names for selected session tools', () => {
    expect(getSelectedSessionToolNames(
      [CHROME_DEVTOOLS_SESSION_TOOL_ID, ASK_GEMINI_SESSION_TOOL_ID],
      { chromeMcpEnabled: true },
    )).toEqual(['Chrome DevTools', 'Ask Gemini'])

    expect(getSelectedSessionToolInstructions(
      [CHROME_DEVTOOLS_SESSION_TOOL_ID],
      { chromeMcpEnabled: true },
    )).toContain('chrome_devtools')
    expect(getSelectedSessionToolInstructions(
      [CHROME_DEVTOOLS_SESSION_TOOL_ID],
      { chromeMcpEnabled: true },
    )).toContain('advanced Chrome debugging')

    expect(getSelectedSessionToolInstructions(
      [ASK_GEMINI_SESSION_TOOL_ID],
      { chromeMcpEnabled: true },
    )).toContain(ASK_GEMINI_TOOL_NAME)
    expect(getSelectedSessionToolInstructions(
      [ASK_GEMINI_SESSION_TOOL_ID],
      { chromeMcpEnabled: true },
    )).toContain('second opinion')
  })

  it('hides Chrome DevTools when the session does not allow the build-only flip toggle', () => {
    const tools = getSessionToolDefinitions({
      chromeMcpEnabled: true,
      chromeDevtoolsAllowed: false,
    })

    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      expect(tools).toEqual([
        expect.objectContaining({
          id: ASK_GEMINI_SESSION_TOOL_ID,
          name: 'Ask Gemini',
        }),
      ])
      expect(getSelectedSessionToolNames(
        [CHROME_DEVTOOLS_SESSION_TOOL_ID, ASK_GEMINI_SESSION_TOOL_ID],
        {
          chromeMcpEnabled: true,
          chromeDevtoolsAllowed: false,
        },
      )).toEqual(['Ask Gemini'])
      return
    }

    expect(tools).toEqual([])
  })

  it('scopes Chrome DevTools to normal Build chats while keeping Assistant on Browser-only tools', () => {
    const buildTools = getScopedSessionToolDefinitions({
      chromeMcpEnabled: true,
      conversationKind: 'normal',
      workMode: 'build',
      planMode: false,
      surface: 'default',
    })
    const assistantTools = getScopedSessionToolDefinitions({
      chromeMcpEnabled: true,
      conversationKind: 'normal',
      workMode: 'build',
      planMode: false,
      surface: 'assistant',
    })
    const exploreTools = getScopedSessionToolDefinitions({
      chromeMcpEnabled: true,
      conversationKind: 'normal',
      workMode: 'explore',
      planMode: false,
      surface: 'default',
    })

    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      expect(buildTools.map((tool) => tool.id)).toEqual([
        CHROME_DEVTOOLS_SESSION_TOOL_ID,
        ASK_GEMINI_SESSION_TOOL_ID,
      ])
      expect(assistantTools.map((tool) => tool.id)).toEqual([
        ASK_GEMINI_SESSION_TOOL_ID,
      ])
      expect(exploreTools.map((tool) => tool.id)).toEqual([
        ASK_GEMINI_SESSION_TOOL_ID,
      ])
      return
    }

    expect(buildTools).toEqual([])
    expect(assistantTools).toEqual([])
    expect(exploreTools).toEqual([])
  })

  it('keeps the curated browser tool surface stable', () => {
    expect(CHROME_BROWSER_TOOL_NAME).toBe('browser')
    expect(CHROME_BROWSER_TOOL_NAME_SET.has('browser')).toBe(true)
    expect(CHROME_BROWSER_TOOL_NAME_SET.has('list_pages')).toBe(false)
  })
})
