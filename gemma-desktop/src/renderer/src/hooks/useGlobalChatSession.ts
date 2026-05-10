import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildFallbackGlobalChatState,
  GLOBAL_CHAT_LABEL,
  type GlobalChatState,
  type GlobalChatConversationSummary,
} from '@shared/globalChat'
import {
  isConversationExecutionBlockedError,
  stripConversationExecutionBlockedErrorCode,
} from '@shared/conversationExecutionPolicy'
import { appendChatMessage, updateChatMessage } from '@/lib/messageState'
import type {
  LiveActivitySnapshot,
  MessageContent,
  PendingCompaction,
  PendingToolApproval,
  SessionDetail,
  SessionStreamEvent,
} from '@/types'

interface GlobalChatSessionState {
  loading: boolean
  error: string | null
  globalChat: GlobalChatState
  sessionId: string | null
  session: SessionDetail | null
  streamingContent: MessageContent[] | null
  isGenerating: boolean
  isCompacting: boolean
  pendingCompaction: PendingCompaction | null
  pendingToolApproval: PendingToolApproval | null
  liveActivity: LiveActivitySnapshot | null
  talkSessions: GlobalChatConversationSummary[]
}

const INITIAL_STATE: GlobalChatSessionState = {
  loading: true,
  error: null,
  globalChat: buildFallbackGlobalChatState(),
  sessionId: null,
  session: null,
  streamingContent: null,
  isGenerating: false,
  isCompacting: false,
  pendingCompaction: null,
  pendingToolApproval: null,
  liveActivity: null,
  talkSessions: [],
}

function stateFromDetail(detail: SessionDetail): Pick<
  GlobalChatSessionState,
  | 'sessionId'
  | 'session'
  | 'streamingContent'
  | 'isGenerating'
  | 'isCompacting'
  | 'pendingCompaction'
  | 'pendingToolApproval'
> {
  return {
    sessionId: detail.id,
    session: detail,
    streamingContent: detail.streamingContent ?? null,
    isGenerating: detail.isGenerating,
    isCompacting: detail.isCompacting,
    pendingCompaction: detail.pendingCompaction ?? null,
    pendingToolApproval: detail.pendingToolApproval ?? null,
  }
}

export function useGlobalChatSession() {
  const [state, setState] = useState<GlobalChatSessionState>(INITIAL_STATE)
  const startupWelcomeRequestedRef = useRef(false)

  const refreshSession = useCallback(async (sessionId: string) => {
    const detail = await window.gemmaDesktopBridge.sessions.get(sessionId)
    setState((current) => ({
      ...current,
      ...stateFromDetail(detail),
      loading: false,
      error: null,
    }))
    return detail
  }, [])

  const loadGlobalChat = useCallback(async (nextState?: GlobalChatState) => {
    const detail = await window.gemmaDesktopBridge.globalChat.getSession()
    const globalChat = nextState ?? await window.gemmaDesktopBridge.globalChat.getState()
    const talkSessions = await window.gemmaDesktopBridge.talk.listSessions()

    setState((current) => ({
      ...current,
      globalChat,
      ...stateFromDetail(detail),
      loading: false,
      error: null,
      liveActivity: null,
      talkSessions,
    }))

    return detail
  }, [])

  const refreshTalkSessions = useCallback(async () => {
    const talkSessions = await window.gemmaDesktopBridge.talk.listSessions()
    setState((current) => ({
      ...current,
      talkSessions,
    }))
    return talkSessions
  }, [])

  useEffect(() => {
    let cancelled = false

    void loadGlobalChat()
      .catch((error) => {
        if (cancelled) {
          return
        }

        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })

    const unsubscribe = window.gemmaDesktopBridge.globalChat.onChanged((nextGlobalChat) => {
      void loadGlobalChat(nextGlobalChat).catch((error) => {
        if (cancelled) {
          return
        }

        setState((current) => ({
          ...current,
          globalChat: nextGlobalChat,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [loadGlobalChat])

  useEffect(() => {
    if (!state.sessionId) {
      return
    }

    const sessionId = state.sessionId
    const unsubscribe = window.gemmaDesktopBridge.events.onSessionEvent(
      sessionId,
      (event) => {
        const next = event as SessionStreamEvent
        setState((current) => {
          if (current.sessionId !== sessionId) {
            return current
          }

          switch (next.type) {
            case 'session_reset':
              return {
                ...current,
                ...stateFromDetail(next.session),
                error: null,
              }
            case 'user_message':
            case 'message_appended':
              return current.session
                ? {
                    ...current,
                    session: {
                      ...current.session,
                      messages: appendChatMessage(current.session.messages, next.message),
                    },
                  }
                : current
            case 'message_updated':
              return current.session
                ? {
                    ...current,
                    session: {
                      ...current.session,
                      messages: updateChatMessage(current.session.messages, next.message),
                    },
                  }
                : current
            case 'generation_started':
              return {
                ...current,
                isGenerating: true,
                isCompacting: false,
              }
            case 'content_delta':
              return {
                ...current,
                streamingContent: next.blocks,
              }
            case 'content_delta_append': {
              const blocks = current.streamingContent ?? []
              const lastBlock = blocks[blocks.length - 1]
              const canAppend =
                lastBlock
                && lastBlock.type === next.blockType
                && typeof lastBlock.text === 'string'

              return {
                ...current,
                streamingContent: canAppend
                  ? [
                      ...blocks.slice(0, -1),
                      {
                        ...lastBlock,
                        text: `${lastBlock.text}${next.delta}`,
                      },
                    ]
                  : [
                      ...blocks,
                      {
                        type: next.blockType,
                        text: next.delta,
                      },
                    ],
              }
            }
            case 'live_activity':
              return {
                ...current,
                liveActivity: next.activity,
              }
            case 'turn_complete':
              void refreshTalkSessions().catch(() => {})
              return current.session
                ? {
                    ...current,
                    session: {
                      ...current.session,
                      messages: appendChatMessage(current.session.messages, next.message),
                    },
                    streamingContent: null,
                    isGenerating: false,
                    liveActivity: null,
                  }
                : current
            case 'generation_stopping':
              return {
                ...current,
                isGenerating: false,
              }
            case 'generation_cancelled':
              return {
                ...current,
                isGenerating: false,
                streamingContent: null,
                liveActivity: null,
              }
            case 'compaction_state':
              return {
                ...current,
                pendingCompaction: next.pendingCompaction,
                isCompacting: next.isCompacting,
              }
            case 'plan_question':
            case 'plan_question_cleared':
            case 'plan_exit_ready':
            case 'plan_exit_cleared':
              return current
            case 'tool_approval':
              return {
                ...current,
                pendingToolApproval: next.approval,
              }
            case 'tool_approval_cleared':
              return {
                ...current,
                pendingToolApproval: null,
              }
          }
        })
      },
    )

    return unsubscribe
  }, [refreshTalkSessions, state.sessionId])

  useEffect(() => {
    if (
      !state.sessionId
      || state.globalChat.target.kind !== 'fallback'
      || startupWelcomeRequestedRef.current
    ) {
      return
    }

    startupWelcomeRequestedRef.current = true
    void window.gemmaDesktopBridge.talk.maybeStartStartupWelcome()
      .catch((error) => {
        console.warn('Startup Assistant Chat welcome failed:', error)
      })
  }, [state.globalChat.target.kind, state.sessionId])

  const sendMessage = useCallback(async (text: string) => {
    if (!state.sessionId) {
      return
    }

    try {
      setState((current) => ({
        ...current,
        isGenerating: true,
        isCompacting: false,
      }))
      await window.gemmaDesktopBridge.sessions.sendMessage(state.sessionId, { text })
    } catch (error) {
      setState((current) => ({
        ...current,
        isGenerating: false,
      }))
      if (error instanceof Error && isConversationExecutionBlockedError(error.message)) {
        throw new Error(stripConversationExecutionBlockedErrorCode(error.message))
      }
      throw error
    }
  }, [state.sessionId])

  const setOptimisticGenerating = useCallback((isGenerating: boolean) => {
    setState((current) => ({
      ...current,
      isGenerating,
      isCompacting: isGenerating ? false : current.isCompacting,
    }))
  }, [])

  const compactSession = useCallback(async () => {
    if (!state.sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.compact(state.sessionId)
  }, [state.sessionId])

  const cancelGeneration = useCallback(async () => {
    if (!state.sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.cancelGeneration(state.sessionId)
  }, [state.sessionId])

  const saveDraft = useCallback(async (draftText: string) => {
    if (!state.sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.saveDraft(state.sessionId, draftText)
    setState((current) =>
      current.session
        ? {
            ...current,
            session: {
              ...current.session,
              draftText,
            },
          }
        : current,
    )
  }, [state.sessionId])

  const clearSession = useCallback(async () => {
    setState((current) => ({
      ...current,
      session: current.session
        ? {
            ...current.session,
            messages: [],
            draftText: '',
            lastMessage: '',
            updatedAt: Date.now(),
          }
        : current.session,
      streamingContent: null,
      isGenerating: false,
      isCompacting: false,
      pendingCompaction: null,
      liveActivity: null,
      error: null,
    }))

    try {
      if (state.globalChat.target.kind === 'fallback') {
        await window.gemmaDesktopBridge.talk.clearSession()
      } else if (state.sessionId) {
        await window.gemmaDesktopBridge.sessions.clearHistory(state.sessionId)
      }

      await loadGlobalChat()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState((current) => ({
        ...current,
        error: message,
      }))

      if (state.sessionId) {
        await refreshSession(state.sessionId).catch(() => {})
      }

      throw error
    }
  }, [loadGlobalChat, refreshSession, state.globalChat.target.kind, state.sessionId])

  const startNewSession = useCallback(async () => {
    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }))

    try {
      await window.gemmaDesktopBridge.talk.startSession()
      await loadGlobalChat()
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  }, [loadGlobalChat])

  const selectTalkSession = useCallback(async (sessionId: string) => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId || normalizedSessionId === state.sessionId) {
      return
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: null,
    }))

    try {
      await window.gemmaDesktopBridge.talk.switchSession(normalizedSessionId)
      await loadGlobalChat()
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  }, [loadGlobalChat, state.sessionId])

  const retry = useCallback(async () => {
    if (!state.sessionId) {
      await loadGlobalChat()
      return
    }

    await refreshSession(state.sessionId)
  }, [loadGlobalChat, refreshSession, state.sessionId])

  const resolveToolApproval = useCallback(async (approvalId: string, approved: boolean) => {
    if (!state.sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.resolveToolApproval(
      state.sessionId,
      approvalId,
      approved,
    )

    setState((current) => ({
      ...current,
      pendingToolApproval: null,
    }))
  }, [state.sessionId])

  return useMemo(() => ({
    ...state,
    messages: state.session?.messages ?? [],
    draftText: state.session?.draftText ?? '',
    title: state.session?.title ?? GLOBAL_CHAT_LABEL,
    targetKind: state.globalChat.target.kind,
    sendMessage,
    compactSession,
    cancelGeneration,
    saveDraft,
    clearSession,
    retry,
    resolveToolApproval,
    setOptimisticGenerating,
    startNewSession,
    selectTalkSession,
  }), [
    cancelGeneration,
    clearSession,
    compactSession,
    resolveToolApproval,
    retry,
    saveDraft,
    sendMessage,
    setOptimisticGenerating,
    startNewSession,
    selectTalkSession,
    state,
  ])
}
