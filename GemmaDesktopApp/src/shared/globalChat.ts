export const GLOBAL_CHAT_LABEL = 'Assistant Chat'
export const GLOBAL_CHAT_FALLBACK_SESSION_ID = 'talk-assistant'
export const GLOBAL_CHAT_CHANGED_CHANNEL = 'global-chat:changed'
export const GLOBAL_CHAT_OPEN_IN_APP_REQUESTED_CHANNEL = 'global-chat:open-in-app-requested'

export interface GlobalChatFallbackTarget {
  kind: 'fallback'
  sessionId: typeof GLOBAL_CHAT_FALLBACK_SESSION_ID
}

export interface GlobalChatAssignedTarget {
  kind: 'assigned'
  sessionId: string
}

export type GlobalChatTarget =
  | GlobalChatFallbackTarget
  | GlobalChatAssignedTarget

export interface GlobalChatState {
  assignedSessionId: string | null
  target: GlobalChatTarget
}

export interface GlobalChatOpenInAppRequest {
  target: GlobalChatTarget
}

export function buildFallbackGlobalChatState(): GlobalChatState {
  return {
    assignedSessionId: null,
    target: {
      kind: 'fallback',
      sessionId: GLOBAL_CHAT_FALLBACK_SESSION_ID,
    },
  }
}

export function isAssignedGlobalChatTarget(
  target: GlobalChatTarget,
): target is GlobalChatAssignedTarget {
  return target.kind === 'assigned'
}
