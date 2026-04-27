export const COBROWSE_USER_CONTROL_COMPOSER_LOCK_REASON =
  'Release browser control before sending another CoBrowse request.'

export function shouldCloseProjectBrowserForConversationSwitch(input: {
  projectBrowserOpen: boolean
  projectBrowserSessionId: string | null
  activeSessionId: string | null
  globalChatSessionId: string | null
}): boolean {
  if (!input.projectBrowserOpen || !input.projectBrowserSessionId) {
    return false
  }

  return (
    input.projectBrowserSessionId !== input.activeSessionId
    && input.projectBrowserSessionId !== input.globalChatSessionId
  )
}

export function isProjectBrowserCoBrowseState(input: {
  projectBrowserOpen: boolean
  projectBrowserCoBrowseActive: boolean
}): boolean {
  return input.projectBrowserOpen && input.projectBrowserCoBrowseActive
}

export function getCoBrowseUserControlComposerLockReason(input: {
  coBrowseActive: boolean
  projectBrowserCoBrowseActive: boolean
  projectBrowserControlOwner: 'agent' | 'user'
  projectBrowserSessionId: string | null
  targetSessionId: string | null
}): string | null {
  if (
    !input.coBrowseActive
    || !input.projectBrowserCoBrowseActive
    || input.projectBrowserControlOwner !== 'user'
    || !input.targetSessionId
    || input.projectBrowserSessionId !== input.targetSessionId
  ) {
    return null
  }

  return COBROWSE_USER_CONTROL_COMPOSER_LOCK_REASON
}
