import { useCallback, useEffect, useRef, useState } from 'react'
import { GEMINI_LIVE_VOICE_MODEL } from '@shared/geminiModels'
import { normalizeGeminiLiveVoice } from '@shared/voiceMode'
import {
  VoiceLiveSession,
  type VoiceLiveSessionEvent,
} from '@/lib/voiceLiveSession'
import {
  VOICE_LIVE_APP_CONTEXT_TOOL_NAME,
  VOICE_LIVE_NEW_CHAT_TOOL_NAME,
  VOICE_LIVE_RESEARCH_TOOL_NAME,
  VOICE_LIVE_SEND_TOOL_NAME,
  buildAppContextResult,
  buildChatAcceptedResult,
  buildChatBusyResult,
  buildChatEmptyResponseUpdate,
  buildChatErrorUpdate,
  buildChatRejectedResult,
  buildChatResponseUpdate,
  buildCreationFailedUpdate,
  buildCreationStartingResult,
  buildNewChatStartedUpdate,
  buildResearchStartedUpdate,
  buildVoiceLiveSystemInstruction,
  buildVoiceLiveToolDeclarations,
  normalizeVoiceLiveError,
  type VoiceLiveAppCapabilities,
  type VoiceLiveHistoryTurn,
} from '@/lib/voiceLivePrompt'

export type VoiceModeStatus =
  | 'off'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error'

export interface VoiceModeCreatedConversation {
  surfaceKey: string
  sessionId: string
  title: string
}

export interface VoiceModeDelegate {
  isChatBusy: () => boolean
  // Sends one prompt into the bound conversation and resolves with the new
  // assistant text once the turn completes (null when the turn produced no
  // readable text). Rejects on send failure.
  sendToChat: (prompt: string) => Promise<string | null>
  // Same contract, but targets an explicit session (used right after this
  // hook creates a conversation, before the App re-render catches up).
  sendToSession: (sessionId: string, prompt: string) => Promise<string | null>
  // Reality-based snapshot of what the app can do right now; rebuilt on every
  // call so mid-session changes (CoBrowse, model swaps) are visible.
  getCapabilities: () => VoiceLiveAppCapabilities
  getHistoryTurns: () => VoiceLiveHistoryTurn[]
  startNewChat: (input: { title?: string }) => Promise<VoiceModeCreatedConversation>
  startResearchChat: (input: {
    title?: string
  }) => Promise<VoiceModeCreatedConversation>
}

export interface UseVoiceModeOptions {
  apiKey: string
  // Prebuilt Gemini Live voice for spoken replies. Applied on the next voice
  // session start; normalized against the supported voice catalog.
  voiceName: string
  // Identity of the conversation surface voice mode is bound to. A change
  // turns voice mode off and drops the live context — unless the change was
  // initiated by a voice tool (new chat / research), in which case the hook
  // adopts the new surface and the session continues.
  surfaceKey: string
  surfaceLabel: string
  delegate: VoiceModeDelegate
}

export interface VoiceModeHandle {
  status: VoiceModeStatus
  active: boolean
  hasApiKey: boolean
  chatPending: boolean
  errorMessage: string | null
  toggle: () => void
  stop: () => void
  dismissError: () => void
}

export function useVoiceMode(options: UseVoiceModeOptions): VoiceModeHandle {
  const [status, setStatus] = useState<VoiceModeStatus>('off')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [chatPending, setChatPending] = useState(false)

  const optionsRef = useRef(options)
  optionsRef.current = options

  const sessionRef = useRef<VoiceLiveSession | null>(null)
  const chatPendingRef = useRef(false)
  const creationPendingRef = useRef(false)
  // While a voice-initiated conversation creation is in flight, surface-key
  // changes are adopted instead of stopping the session.
  const adoptSurfaceChangesRef = useRef(false)
  const boundSurfaceKeyRef = useRef(options.surfaceKey)

  const hasApiKey = options.apiKey.trim().length > 0

  const setPending = useCallback((pending: boolean) => {
    chatPendingRef.current = pending
    setChatPending(pending)
  }, [])

  const stopSession = useCallback((nextStatus: VoiceModeStatus = 'off') => {
    const session = sessionRef.current
    sessionRef.current = null
    setPending(false)
    creationPendingRef.current = false
    adoptSurfaceChangesRef.current = false
    if (session) {
      void session.stop()
    }
    setStatus(nextStatus)
    if (nextStatus !== 'error') {
      setErrorMessage(null)
    }
  }, [setPending])

  const failSession = useCallback((raw: unknown) => {
    setErrorMessage(normalizeVoiceLiveError(raw))
    stopSession('error')
  }, [stopSession])

  // Runs one delegated chat request and feeds the outcome back into the live
  // session as an update message.
  const runDelegatedChatRequest = useCallback((
    session: VoiceLiveSession,
    run: () => Promise<string | null>,
  ) => {
    setPending(true)
    run()
      .then((responseText) => {
        if (sessionRef.current !== session) return
        session.sendSystemUpdate(
          responseText
            ? buildChatResponseUpdate(responseText)
            : buildChatEmptyResponseUpdate(),
        )
      })
      .catch((error: unknown) => {
        if (sessionRef.current !== session) return
        session.sendSystemUpdate(
          buildChatErrorUpdate(normalizeVoiceLiveError(error)),
        )
      })
      .finally(() => {
        if (sessionRef.current === session) {
          setPending(false)
        }
      })
  }, [setPending])

  const handleCreationToolCall = useCallback((
    session: VoiceLiveSession,
    kind: 'chat' | 'research',
    args: Record<string, unknown>,
  ) => {
    const delegate = optionsRef.current.delegate
    const availability = kind === 'research'
      ? delegate.getCapabilities().canStartResearchChat
      : delegate.getCapabilities().canStartNewChat
    if (!availability.ok) {
      return buildChatRejectedResult(
        availability.reason ?? 'Creating a conversation is unavailable right now.',
      )
    }
    if (creationPendingRef.current) {
      return buildChatRejectedResult('Another conversation is already being created. Wait for its update first.')
    }

    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const researchGoal = typeof args.research_goal === 'string'
      ? args.research_goal.trim()
      : ''
    const firstMessage = typeof args.first_message === 'string'
      ? args.first_message.trim()
      : ''
    if (kind === 'research' && !researchGoal) {
      return buildChatRejectedResult('research_goal was empty. Ask the user what to research and try again.')
    }

    creationPendingRef.current = true
    adoptSurfaceChangesRef.current = true

    const create = kind === 'research'
      ? delegate.startResearchChat({ title: title || undefined })
      : delegate.startNewChat({ title: title || undefined })

    create
      .then((created) => {
        boundSurfaceKeyRef.current = created.surfaceKey
        if (sessionRef.current !== session) return
        if (kind === 'research') {
          session.sendSystemUpdate(buildResearchStartedUpdate(created.title))
          runDelegatedChatRequest(session, () =>
            optionsRef.current.delegate.sendToSession(created.sessionId, researchGoal))
        } else {
          session.sendSystemUpdate(
            buildNewChatStartedUpdate(created.title, firstMessage.length > 0),
          )
          if (firstMessage) {
            runDelegatedChatRequest(session, () =>
              optionsRef.current.delegate.sendToSession(created.sessionId, firstMessage))
          }
        }
      })
      .catch((error: unknown) => {
        if (sessionRef.current !== session) return
        session.sendSystemUpdate(
          buildCreationFailedUpdate(kind, normalizeVoiceLiveError(error)),
        )
      })
      .finally(() => {
        creationPendingRef.current = false
        adoptSurfaceChangesRef.current = false
      })

    return buildCreationStartingResult(kind)
  }, [runDelegatedChatRequest])

  const handleToolCall = useCallback((call: { name: string; args: Record<string, unknown> }) => {
    const session = sessionRef.current
    if (!session) {
      return buildChatRejectedResult('Voice mode is shutting down.') as unknown as Record<string, unknown>
    }

    if (call.name === VOICE_LIVE_APP_CONTEXT_TOOL_NAME) {
      return buildAppContextResult(
        optionsRef.current.delegate.getCapabilities(),
      ) as unknown as Record<string, unknown>
    }

    if (call.name === VOICE_LIVE_NEW_CHAT_TOOL_NAME) {
      return handleCreationToolCall(session, 'chat', call.args) as unknown as Record<string, unknown>
    }
    if (call.name === VOICE_LIVE_RESEARCH_TOOL_NAME) {
      return handleCreationToolCall(session, 'research', call.args) as unknown as Record<string, unknown>
    }

    if (call.name !== VOICE_LIVE_SEND_TOOL_NAME) {
      return buildChatRejectedResult(`Unknown tool: ${call.name}`) as unknown as Record<string, unknown>
    }

    const prompt = typeof call.args.prompt === 'string' ? call.args.prompt.trim() : ''
    if (!prompt) {
      return buildChatRejectedResult('The prompt was empty. Ask the user what they want and try again.') as unknown as Record<string, unknown>
    }
    if (chatPendingRef.current || optionsRef.current.delegate.isChatBusy()) {
      return buildChatBusyResult() as unknown as Record<string, unknown>
    }

    runDelegatedChatRequest(session, () =>
      optionsRef.current.delegate.sendToChat(prompt))
    return buildChatAcceptedResult() as unknown as Record<string, unknown>
  }, [handleCreationToolCall, runDelegatedChatRequest])

  const start = useCallback(() => {
    if (sessionRef.current || !optionsRef.current.apiKey.trim()) {
      return
    }
    setErrorMessage(null)
    setStatus('connecting')
    boundSurfaceKeyRef.current = optionsRef.current.surfaceKey

    const session = new VoiceLiveSession({
      apiKey: optionsRef.current.apiKey.trim(),
      model: GEMINI_LIVE_VOICE_MODEL,
      voiceName: normalizeGeminiLiveVoice(optionsRef.current.voiceName),
      systemInstruction: buildVoiceLiveSystemInstruction({
        surfaceLabel: optionsRef.current.surfaceLabel,
        capabilities: optionsRef.current.delegate.getCapabilities(),
        historyTurns: optionsRef.current.delegate.getHistoryTurns(),
      }),
      functionDeclarations: buildVoiceLiveToolDeclarations(),
      onToolCall: handleToolCall,
      onEvent: (event: VoiceLiveSessionEvent) => {
        if (sessionRef.current !== session) return
        if (event.type === 'open') {
          setStatus('listening')
        } else if (event.type === 'speaking') {
          setStatus(event.speaking ? 'speaking' : 'listening')
        } else if (event.type === 'error') {
          failSession(event.message)
        } else if (event.type === 'close') {
          // Server-side close (network blip, session limit) without a prior
          // error: return to off so the user can simply start again.
          stopSession('off')
        }
      },
    })
    sessionRef.current = session

    session.start().catch((error: unknown) => {
      if (sessionRef.current !== session) return
      failSession(error)
    })
  }, [failSession, handleToolCall, stopSession])

  const stop = useCallback(() => {
    if (sessionRef.current) {
      stopSession('off')
    }
  }, [stopSession])

  const toggle = useCallback(() => {
    if (sessionRef.current) {
      stopSession('off')
      return
    }
    if (status === 'error') {
      setErrorMessage(null)
      setStatus('off')
    }
    start()
  }, [start, status, stopSession])

  const dismissError = useCallback(() => {
    setErrorMessage(null)
    setStatus((current) => (current === 'error' ? 'off' : current))
  }, [])

  // Manual surface switches (Assistant Chat ↔ project session, or another
  // session) turn voice mode off and reset the live context. Voice-initiated
  // switches — a creation tool is in flight or just resolved to this exact
  // key — are adopted so the session keeps going in the new conversation.
  useEffect(() => {
    if (boundSurfaceKeyRef.current === options.surfaceKey) {
      return
    }
    if (sessionRef.current && adoptSurfaceChangesRef.current) {
      boundSurfaceKeyRef.current = options.surfaceKey
      return
    }
    boundSurfaceKeyRef.current = options.surfaceKey
    if (sessionRef.current) {
      stopSession('off')
    } else {
      setErrorMessage(null)
      setStatus('off')
    }
  }, [options.surfaceKey, stopSession])

  // Losing the API key (cleared in settings) ends an active session.
  useEffect(() => {
    if (!hasApiKey && sessionRef.current) {
      stopSession('off')
    }
  }, [hasApiKey, stopSession])

  useEffect(() => () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session) {
      void session.stop()
    }
  }, [])

  return {
    status,
    active: status === 'connecting' || status === 'listening' || status === 'speaking',
    hasApiKey,
    chatPending,
    errorMessage,
    toggle,
    stop,
    dismissError,
  }
}
