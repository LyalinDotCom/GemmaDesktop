export const COBROWSE_USER_CONTROL_COMPOSER_LOCK_REASON =
  'Release browser control before sending another CoBrowse request.'
export const COBROWSE_TAKE_CONTROL_BUSY_REASON =
  'Wait for the assistant to finish before taking browser control.'

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

export function getCoBrowseTakeControlDisabledReason(input: {
  coBrowseActive: boolean
  projectBrowserSessionId: string | null
  activeSessionId: string | null
  activeSessionBusy: boolean
  globalChatSessionId: string | null
  globalChatBusy: boolean
}): string | null {
  if (!input.coBrowseActive) {
    return null
  }

  const browserSessionId = input.projectBrowserSessionId
  const busy =
    browserSessionId == null
      ? input.globalChatBusy || input.activeSessionBusy
      : (
          (browserSessionId === input.activeSessionId && input.activeSessionBusy)
          || (browserSessionId === input.globalChatSessionId && input.globalChatBusy)
        )

  return busy ? COBROWSE_TAKE_CONTROL_BUSY_REASON : null
}
