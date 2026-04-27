import { useCallback, useEffect, useMemo, useState } from 'react'
import { appendChatMessage, updateChatMessage } from '@/lib/messageState'
import type {
  LiveActivitySnapshot,
  MessageContent,
  PendingCompaction,
  SessionDetail,
  SessionStreamEvent,
} from '@/types'

interface TalkSessionState {
  loading: boolean
  error: string | null
  sessionId: string | null
  session: SessionDetail | null
  streamingContent: MessageContent[] | null
  isGenerating: boolean
  isCompacting: boolean
  pendingCompaction: PendingCompaction | null
  liveActivity: LiveActivitySnapshot | null
}

const INITIAL_STATE: TalkSessionState = {
  loading: true,
  error: null,
  sessionId: null,
  session: null,
  streamingContent: null,
  isGenerating: false,
  isCompacting: false,
  pendingCompaction: null,
  liveActivity: null,
}

function stateFromDetail(detail: SessionDetail): Pick<
  TalkSessionState,
  'sessionId' | 'session' | 'streamingContent' | 'isGenerating' | 'isCompacting' | 'pendingCompaction'
> {
  return {
    sessionId: detail.id,
    session: detail,
    streamingContent: detail.streamingContent ?? null,
    isGenerating: detail.isGenerating,
    isCompacting: detail.isCompacting,
    pendingCompaction: detail.pendingCompaction ?? null,
  }
}

export function useTalkSession() {
  const [state, setState] = useState<TalkSessionState>(INITIAL_STATE)

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

  useEffect(() => {
    let cancelled = false

    void window.gemmaDesktopBridge.talk.ensureSession()
      .then((detail) => {
        if (cancelled) {
          return
        }

        setState((current) => ({
          ...current,
          ...stateFromDetail(detail),
          loading: false,
          error: null,
        }))
      })
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

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!state.sessionId) {
      return
    }

    const sessionId = state.sessionId
    const unsub = window.gemmaDesktopBridge.events.onSessionEvent(
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
            case 'tool_approval':
            case 'tool_approval_cleared':
              return current
          }
        })
      },
    )

    return unsub
  }, [state.sessionId])

  const sendMessage = useCallback(async (text: string) => {
    if (!state.sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.sendMessage(state.sessionId, {
      text,
    })
  }, [state.sessionId])

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
      await window.gemmaDesktopBridge.talk.clearSession()
      const detail = await window.gemmaDesktopBridge.talk.ensureSession()
      setState((current) => ({
        ...current,
        ...stateFromDetail(detail),
        loading: false,
        error: null,
        liveActivity: null,
      }))
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
  }, [refreshSession, state.sessionId])

  const retry = useCallback(async () => {
    if (!state.sessionId) {
      const detail = await window.gemmaDesktopBridge.talk.ensureSession()
      setState((current) => ({
        ...current,
        ...stateFromDetail(detail),
        loading: false,
        error: null,
      }))
      return
    }

    await refreshSession(state.sessionId)
  }, [refreshSession, state.sessionId])

  return useMemo(() => ({
    ...state,
    messages: state.session?.messages ?? [],
    draftText: state.session?.draftText ?? '',
    title: state.session?.title ?? 'Talk',
    sendMessage,
    compactSession,
    cancelGeneration,
    saveDraft,
    clearSession,
    retry,
  }), [
    cancelGeneration,
    clearSession,
    compactSession,
    refreshSession,
    retry,
    saveDraft,
    sendMessage,
    state,
  ])
}
