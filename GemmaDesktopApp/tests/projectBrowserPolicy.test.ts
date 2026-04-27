import { describe, expect, it } from 'vitest'
import {
  COBROWSE_USER_CONTROL_COMPOSER_LOCK_REASON,
  getCoBrowseUserControlComposerLockReason,
  isProjectBrowserCoBrowseState,
  shouldCloseProjectBrowserForConversationSwitch,
} from '../src/renderer/src/lib/projectBrowserPolicy'

describe('project browser conversation policy', () => {
  it('keeps CoBrowse open when it belongs to the global chat session', () => {
    expect(shouldCloseProjectBrowserForConversationSwitch({
      projectBrowserOpen: true,
      projectBrowserSessionId: 'global-chat',
      activeSessionId: 'work-chat',
      globalChatSessionId: 'global-chat',
    })).toBe(false)
  })

  it('keeps the browser open for the active work session', () => {
    expect(shouldCloseProjectBrowserForConversationSwitch({
      projectBrowserOpen: true,
      projectBrowserSessionId: 'work-chat',
      activeSessionId: 'work-chat',
      globalChatSessionId: 'global-chat',
    })).toBe(false)
  })

  it('closes the browser when it belongs to neither visible conversation', () => {
    expect(shouldCloseProjectBrowserForConversationSwitch({
      projectBrowserOpen: true,
      projectBrowserSessionId: 'old-chat',
      activeSessionId: 'work-chat',
      globalChatSessionId: 'global-chat',
    })).toBe(true)
  })

  it('does not close an unopened browser', () => {
    expect(shouldCloseProjectBrowserForConversationSwitch({
      projectBrowserOpen: false,
      projectBrowserSessionId: 'old-chat',
      activeSessionId: 'work-chat',
      globalChatSessionId: 'global-chat',
    })).toBe(false)
  })

  it('does not infer CoBrowse from a normal work browser session id', () => {
    expect(isProjectBrowserCoBrowseState({
      projectBrowserOpen: true,
      projectBrowserCoBrowseActive: false,
    })).toBe(false)

    expect(isProjectBrowserCoBrowseState({
      projectBrowserOpen: true,
      projectBrowserCoBrowseActive: true,
    })).toBe(true)

    expect(isProjectBrowserCoBrowseState({
      projectBrowserOpen: false,
      projectBrowserCoBrowseActive: true,
    })).toBe(false)
  })

  it('locks the matching CoBrowse composer while the user owns browser control', () => {
    expect(getCoBrowseUserControlComposerLockReason({
      coBrowseActive: true,
      projectBrowserCoBrowseActive: true,
      projectBrowserControlOwner: 'user',
      projectBrowserSessionId: 'global-chat',
      targetSessionId: 'global-chat',
    })).toBe(COBROWSE_USER_CONTROL_COMPOSER_LOCK_REASON)
  })

  it('does not lock other conversations or agent-owned CoBrowse browser state', () => {
    expect(getCoBrowseUserControlComposerLockReason({
      coBrowseActive: true,
      projectBrowserCoBrowseActive: true,
      projectBrowserControlOwner: 'user',
      projectBrowserSessionId: 'global-chat',
      targetSessionId: 'work-chat',
    })).toBeNull()

    expect(getCoBrowseUserControlComposerLockReason({
      coBrowseActive: true,
      projectBrowserCoBrowseActive: true,
      projectBrowserControlOwner: 'agent',
      projectBrowserSessionId: 'global-chat',
      targetSessionId: 'global-chat',
    })).toBeNull()
  })
})
