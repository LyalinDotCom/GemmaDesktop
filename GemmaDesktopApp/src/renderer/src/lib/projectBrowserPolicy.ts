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
