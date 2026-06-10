import { useCallback, useEffect, useRef, useState } from 'react'
import { GEMINI_LIVE_VOICE_MODEL } from '@shared/geminiModels'
import {
  VoiceLiveSession,
  type VoiceLiveSessionEvent,
} from '@/lib/voiceLiveSession'
import {
  VOICE_LIVE_SEND_TOOL_NAME,
  buildChatAcceptedResult,
  buildChatBusyResult,
  buildChatEmptyResponseUpdate,
  buildChatErrorUpdate,
  buildChatRejectedResult,
  buildChatResponseUpdate,
  buildVoiceLiveSystemInstruction,
  buildVoiceLiveToolDeclarations,
  normalizeVoiceLiveError,
} from '@/lib/voiceLivePrompt'

export type VoiceModeStatus =
  | 'off'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error'

export interface VoiceModeDelegate {
  isChatBusy: () => boolean
  // Sends one prompt into the active conversation and resolves with the new
  // assistant text once the turn completes (null when the turn produced no
  // readable text). Rejects on send failure.
  sendToChat: (prompt: string) => Promise<string | null>
}

export interface UseVoiceModeOptions {
  apiKey: string
  // Identity of the conversation surface voice mode is bound to. Any change
  // (Assistant Chat ↔ project session, or switching sessions) turns voice
  // mode off and drops the live context so conversations never bleed over.
  surfaceKey: string
  surfaceLabel: string
  modelLabel: string
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

  const hasApiKey = options.apiKey.trim().length > 0

  const setPending = useCallback((pending: boolean) => {
    chatPendingRef.current = pending
    setChatPending(pending)
  }, [])

  const stopSession = useCallback((nextStatus: VoiceModeStatus = 'off') => {
    const session = sessionRef.current
    sessionRef.current = null
    setPending(false)
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

  const handleToolCall = useCallback((call: { name: string; args: Record<string, unknown> }) => {
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

    const session = sessionRef.current
    setPending(true)
    optionsRef.current.delegate
      .sendToChat(prompt)
      .then((responseText) => {
        if (sessionRef.current !== session || !session) return
        session.sendSystemUpdate(
          responseText
            ? buildChatResponseUpdate(responseText)
            : buildChatEmptyResponseUpdate(),
        )
      })
      .catch((error: unknown) => {
        if (sessionRef.current !== session || !session) return
        session.sendSystemUpdate(
          buildChatErrorUpdate(normalizeVoiceLiveError(error)),
        )
      })
      .finally(() => {
        if (sessionRef.current === session) {
          setPending(false)
        }
      })

    return buildChatAcceptedResult() as unknown as Record<string, unknown>
  }, [setPending])

  const start = useCallback(() => {
    if (sessionRef.current || !optionsRef.current.apiKey.trim()) {
      return
    }
    setErrorMessage(null)
    setStatus('connecting')

    const session = new VoiceLiveSession({
      apiKey: optionsRef.current.apiKey.trim(),
      model: GEMINI_LIVE_VOICE_MODEL,
      systemInstruction: buildVoiceLiveSystemInstruction({
        surfaceLabel: optionsRef.current.surfaceLabel,
        modelLabel: optionsRef.current.modelLabel,
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

  // Switching conversation surfaces always turns voice mode off and resets
  // the live context (fresh session on next start).
  const previousSurfaceKeyRef = useRef(options.surfaceKey)
  useEffect(() => {
    if (previousSurfaceKeyRef.current !== options.surfaceKey) {
      previousSurfaceKeyRef.current = options.surfaceKey
      if (sessionRef.current) {
        stopSession('off')
      } else {
        setErrorMessage(null)
        setStatus('off')
      }
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
