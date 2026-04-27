import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  FileDown,
  Layers,
  Loader2,
  MoreHorizontal,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import { ContextGauge } from '@/components/ContextGauge'
import { copyText } from '@/lib/clipboard'
import { serializeSessionHistory } from '@/lib/chatCopy'
import {
  COMPOSER_ACTIONS_SLOT,
  COMPOSER_FRAME_BASE,
  COMPOSER_TEXTAREA_BASE,
} from '@/lib/composerStyles'
import type { ChatMessage, MessageContent, SessionContext } from '@/types'

interface TalkInputBarProps {
  variant?: 'overlay' | 'docked' | 'tray'
  sessionId: string
  initialDraftText: string
  messages: ChatMessage[]
  streamingContent: MessageContent[] | null
  sessionTitle: string
  isGenerating: boolean
  isCompacting: boolean
  conversationRunDisabledReason?: string | null
  sessionContext?: Pick<SessionContext, 'tokensUsed' | 'contextLength'>
  enterToSend: boolean
  onSend: (text: string) => Promise<void>
  onCancel: () => Promise<void>
  onCompact: () => Promise<void>
  onSaveDraft: (draftText: string) => Promise<void>
  onClearSession: () => Promise<void>
  showThinking?: boolean
  onToggleShowThinking?: () => void
}

function focusTalkTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return
  }

  textarea.focus()
  const caret = textarea.value.length
  textarea.setSelectionRange(caret, caret)
}

export function TalkInputBar({
  variant = 'overlay',
  sessionId,
  initialDraftText,
  messages,
  streamingContent,
  sessionTitle,
  isGenerating,
  isCompacting,
  conversationRunDisabledReason = null,
  sessionContext,
  enterToSend,
  onSend,
  onCancel,
  onCompact,
  onSaveDraft,
  onClearSession,
  showThinking = true,
  onToggleShowThinking,
}: TalkInputBarProps) {
  const [text, setText] = useState(initialDraftText)
  const [submitting, setSubmitting] = useState(false)
  const [clearingSession, setClearingSession] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [copiedChat, setCopiedChat] = useState(false)
  const [exportedChat, setExportedChat] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)
  const draftPersistTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    setText(initialDraftText)
  }, [initialDraftText, sessionId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      focusTalkTextarea(textareaRef.current)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [sessionId])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [text])

  useEffect(() => {
    if (draftPersistTimeoutRef.current !== null) {
      window.clearTimeout(draftPersistTimeoutRef.current)
    }

    draftPersistTimeoutRef.current = window.setTimeout(() => {
      void onSaveDraft(text)
    }, 180)

    return () => {
      if (draftPersistTimeoutRef.current !== null) {
        window.clearTimeout(draftPersistTimeoutRef.current)
        draftPersistTimeoutRef.current = null
      }
    }
  }, [onSaveDraft, text])

  useEffect(() => {
    const handleWindowClick = (event: MouseEvent) => {
      if (!overflowOpen) {
        return
      }

      if (
        overflowRef.current
        && event.target instanceof Node
        && overflowRef.current.contains(event.target)
      ) {
        return
      }

      setOverflowOpen(false)
    }

    window.addEventListener('click', handleWindowClick)
    return () => window.removeEventListener('click', handleWindowClick)
  }, [overflowOpen])

  const clearPendingDraftSave = useCallback(() => {
    if (draftPersistTimeoutRef.current !== null) {
      window.clearTimeout(draftPersistTimeoutRef.current)
      draftPersistTimeoutRef.current = null
    }
  }, [])

  const actionBusy = isGenerating || isCompacting || submitting
  const conversationRunBlocked = Boolean(conversationRunDisabledReason)
  const busy = actionBusy || clearingSession
  const trimmedText = text.trim()
  const messagesForCopy = useMemo(
    () =>
      streamingContent
        ? [
            ...messages,
            {
              id: 'assistant-chat-streaming-copy',
              role: 'assistant' as const,
              content: streamingContent,
              timestamp: Date.now(),
            },
          ]
        : messages,
    [messages, streamingContent],
  )

  const handleSubmit = useCallback(async () => {
    if (busy || conversationRunBlocked || trimmedText.length === 0) {
      return
    }

    const outgoingText = trimmedText
    setSubmitting(true)
    setText('')
    try {
      await onSaveDraft('')
      await onSend(outgoingText)
    } catch (error) {
      setText(outgoingText)
      await onSaveDraft(outgoingText)
      throw error
    } finally {
      setSubmitting(false)
    }
  }, [busy, conversationRunBlocked, onSaveDraft, onSend, trimmedText])

  const handleCopyChat = useCallback(async () => {
    if (messagesForCopy.length === 0) {
      return
    }

    await copyText(
      serializeSessionHistory({
        messages: messagesForCopy,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        sessionTitle,
      }),
    )
    setCopiedChat(true)
    window.setTimeout(() => setCopiedChat(false), 1200)
  }, [messagesForCopy, sessionTitle])

  const handleExportChat = useCallback(async () => {
    if (messagesForCopy.length === 0) {
      return
    }

    const suggestedName = (sessionTitle.trim() || 'assistant-chat-history')
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()

    const result = await window.gemmaDesktopBridge.files.saveText({
      title: 'Export Assistant Chat History',
      defaultPath: `${suggestedName || 'assistant-chat-history'}.md`,
      content: serializeSessionHistory({
        messages: messagesForCopy,
        debugEnabled: false,
        debugLogs: [],
        debugSession: null,
        sessionTitle,
      }),
    })

    if (result.canceled) {
      return
    }

    setExportedChat(true)
    window.setTimeout(() => setExportedChat(false), 1200)
  }, [messagesForCopy, sessionTitle])

  const handleClearSession = useCallback(async () => {
    if (clearingSession) {
      return
    }

    clearPendingDraftSave()
    setClearingSession(true)
    setText('')

    try {
      await onSaveDraft('')
      await onClearSession()
      setOverflowOpen(false)
    } finally {
      setClearingSession(false)
    }
  }, [clearPendingDraftSave, clearingSession, onClearSession, onSaveDraft])

  const placeholder = isCompacting
    ? 'Compacting Assistant Chat...'
    : isGenerating
      ? 'Assistant Chat is answering...'
      : clearingSession
        ? 'Clearing Assistant Chat conversation...'
      : 'Message Assistant Chat'
  const canClearSession = messagesForCopy.length > 0 || text.trim().length > 0
  const handleRequestClearSession = useCallback(() => {
    if (busy || !canClearSession) {
      return
    }

    setOverflowOpen(false)
    const confirmed = window.confirm(
      'Clear this conversation and draft?',
    )
    if (!confirmed) {
      return
    }

    void handleClearSession().catch(() => {})
  }, [busy, canClearSession, handleClearSession])
  const panelLabel = variant === 'docked' ? 'Assistant Chat' : 'Floating Assistant Chat'
  const panelDescription = variant === 'docked'
    ? 'Always-available chat surface.'
    : 'Closes instantly, keeps the conversation.'
  const showPanelHeader = variant !== 'tray'
  const isTray = variant === 'tray'
  const containerClass = variant === 'docked' || variant === 'tray'
    ? 'border-zinc-200/80 bg-white/82 dark:border-zinc-800/80 dark:bg-zinc-950/86'
    : 'border-cyan-100/80 bg-white/82 dark:border-cyan-950/40 dark:bg-zinc-950/86'
  const labelClass = variant === 'docked' || variant === 'tray'
    ? 'text-zinc-600 dark:text-zinc-300'
    : 'text-cyan-700 dark:text-cyan-200'
  const frameClass = variant === 'docked' || variant === 'tray'
    ? 'border-zinc-200/80 bg-zinc-50/70 shadow-[0_18px_36px_-30px_rgba(24,24,27,0.22)] focus-within:border-zinc-300 focus-within:ring-1 focus-within:ring-zinc-300/50 dark:border-zinc-800/80 dark:bg-zinc-900/80 dark:focus-within:border-zinc-700 dark:focus-within:ring-zinc-700/40'
    : 'border-cyan-200/80 bg-white/78 shadow-[0_18px_34px_-30px_rgba(8,145,178,0.34)] focus-within:border-cyan-300 focus-within:ring-1 focus-within:ring-cyan-300/50 dark:border-cyan-900/50 dark:bg-zinc-900/82 dark:focus-within:border-cyan-700 dark:focus-within:ring-cyan-700/40'
  const menuClass = variant === 'docked' || variant === 'tray'
    ? 'border-zinc-200/80 bg-white/98 dark:border-zinc-800/80 dark:bg-zinc-950/96'
    : 'border-cyan-200/80 bg-white/98 dark:border-cyan-900/50 dark:bg-zinc-950/96'
  const dividerClass = variant === 'docked' || variant === 'tray'
    ? 'border-zinc-200/80 dark:border-zinc-800/80'
    : 'border-cyan-100/80 dark:border-cyan-950/50'
  const sendButtonClass = clearingSession || busy
    ? 'bg-zinc-700 hover:bg-zinc-800 text-white dark:bg-zinc-700 dark:text-white'
    : isTray
      ? 'bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
      : 'bg-cyan-600 text-white hover:bg-cyan-700'
  const compactActionButtonClass = clearingSession
    ? 'rounded-md bg-zinc-700 p-1.5 text-white transition-colors hover:bg-zinc-800 disabled:opacity-30'
    : isGenerating
      ? 'rounded-md bg-red-500 p-1.5 text-white transition-colors hover:bg-red-600 disabled:opacity-30'
      : isCompacting
        ? 'rounded-md bg-amber-500 p-1.5 text-white transition-colors hover:bg-amber-600 disabled:opacity-30'
        : 'rounded-md bg-zinc-900 p-1.5 text-white transition-colors hover:bg-zinc-800 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
  const canToggleThinking = variant === 'docked' && Boolean(onToggleShowThinking)

  if (variant === 'docked') {
    return (
      <div className={`flex-shrink-0 px-4 pb-[21px] pt-[7px] ${containerClass}`}>
        <div className={`${COMPOSER_FRAME_BASE} ${frameClass}`}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter'
                && !event.shiftKey
                && enterToSend
                && !busy
              ) {
                event.preventDefault()
                void handleSubmit()
              }
            }}
            rows={1}
            placeholder={placeholder}
            className={`${COMPOSER_TEXTAREA_BASE} flex-1 py-1`}
          />

          <div className={COMPOSER_ACTIONS_SLOT}>
            <div ref={overflowRef} className="relative">
              <button
                type="button"
                onClick={() => setOverflowOpen((current) => !current)}
                className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label="Assistant Chat actions"
                title="Assistant Chat actions"
              >
                <MoreHorizontal size={14} />
              </button>
              {overflowOpen && (
                <div className={`absolute bottom-full right-0 z-50 mb-2 min-w-[200px] rounded-xl border py-1 shadow-lg backdrop-blur ${menuClass}`}>
                  {canToggleThinking && (
                    <button
                      type="button"
                      onClick={() => {
                        onToggleShowThinking?.()
                        setOverflowOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {showThinking ? <Check size={12} /> : <span className="w-3" aria-hidden="true" />}
                      {showThinking ? 'Hide thinking' : 'Show thinking'}
                    </button>
                  )}
                  {canToggleThinking && <div className={`my-1 border-t ${dividerClass}`} />}
                  <button
                    type="button"
                    onClick={() => {
                      void handleCopyChat()
                      setOverflowOpen(false)
                    }}
                    disabled={messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {copiedChat ? <Check size={12} /> : <Copy size={12} />}
                    Copy chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleExportChat()
                      setOverflowOpen(false)
                    }}
                    disabled={messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {exportedChat ? <Check size={12} /> : <FileDown size={12} />}
                    Export chat
                  </button>
                  <div className={`my-1 border-t ${dividerClass}`} />
                  <button
                    type="button"
                    onClick={() => {
                      void onCompact()
                      setOverflowOpen(false)
                    }}
                    disabled={busy || conversationRunBlocked || messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <Layers size={12} />
                    Compact chat
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestClearSession}
                    disabled={busy || !canClearSession}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-950/30"
                    title="Clear this conversation history and draft"
                  >
                    <Trash2 size={12} />
                    Clear conversation
                  </button>
                </div>
              )}
            </div>

            {sessionContext ? (
              <ContextGauge
                tokensUsed={sessionContext.tokensUsed}
                contextLength={sessionContext.contextLength}
              />
            ) : null}

            <button
              type="button"
              onClick={() => {
                if (clearingSession) {
                  return
                }

                if (isGenerating || isCompacting) {
                  void onCancel()
                  return
                }

                void handleSubmit()
              }}
              disabled={
                clearingSession
                || conversationRunBlocked
                || (!actionBusy && trimmedText.length === 0)
              }
              className={compactActionButtonClass}
              title={
                clearingSession
                  ? 'Clearing conversation'
                  : conversationRunDisabledReason
                    ? conversationRunDisabledReason
                    : isGenerating
                    ? 'Cancel generation'
                    : isCompacting
                      ? 'Cancel compaction'
                      : 'Send message'
              }
            >
              {clearingSession ? (
                <Loader2 size={16} className="animate-spin" />
              ) : actionBusy ? (
                <Square size={16} />
              ) : (
                <Send size={16} />
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (isTray) {
    return (
      <div className={`border-t px-3 pb-2 pt-2 ${containerClass}`}>
        <div className={`flex items-end gap-1.5 rounded-lg border px-2.5 py-1.5 ${frameClass}`}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter'
                && !event.shiftKey
                && enterToSend
                && !busy
              ) {
                event.preventDefault()
                void handleSubmit()
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="min-h-[22px] max-h-[120px] flex-1 resize-none bg-transparent py-0.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />

          <div className="flex items-center gap-0.5 self-end">
            <div ref={overflowRef} className="relative">
              <button
                type="button"
                onClick={() => setOverflowOpen((current) => !current)}
                className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label="Assistant Chat actions"
                title="Assistant Chat actions"
              >
                <MoreHorizontal size={13} />
              </button>
              {overflowOpen && (
                <div className={`absolute bottom-full right-0 z-50 mb-2 min-w-[200px] rounded-xl border py-1 shadow-lg backdrop-blur ${menuClass}`}>
                  <button
                    type="button"
                    onClick={() => {
                      void handleCopyChat()
                      setOverflowOpen(false)
                    }}
                    disabled={messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {copiedChat ? <Check size={12} /> : <Copy size={12} />}
                    Copy chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleExportChat()
                      setOverflowOpen(false)
                    }}
                    disabled={messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {exportedChat ? <Check size={12} /> : <FileDown size={12} />}
                    Export chat
                  </button>
                  <div className={`my-1 border-t ${dividerClass}`} />
                  <button
                    type="button"
                    onClick={() => {
                      void onCompact()
                      setOverflowOpen(false)
                    }}
                    disabled={busy || conversationRunBlocked || messagesForCopy.length === 0}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <Layers size={12} />
                    Compact chat
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestClearSession}
                    disabled={busy || !canClearSession}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-950/30"
                    title="Clear this conversation history and draft"
                  >
                    <Trash2 size={12} />
                    Clear conversation
                  </button>
                </div>
              )}
            </div>

            {sessionContext ? (
              <ContextGauge
                tokensUsed={sessionContext.tokensUsed}
                contextLength={sessionContext.contextLength}
                size={18}
              />
            ) : null}

            <button
              type="button"
              onClick={() => {
                if (clearingSession) {
                  return
                }

                if (isGenerating || isCompacting) {
                  void onCancel()
                  return
                }

                void handleSubmit()
              }}
              disabled={
                clearingSession
                || conversationRunBlocked
                || (!actionBusy && trimmedText.length === 0)
              }
              className={`inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sendButtonClass}`}
              title={
                clearingSession
                  ? 'Clearing conversation'
                  : conversationRunDisabledReason
                    ? conversationRunDisabledReason
                    : isGenerating
                    ? 'Cancel generation'
                    : isCompacting
                      ? 'Cancel compaction'
                      : 'Send message'
              }
            >
              {clearingSession ? (
                <Loader2 size={12} className="animate-spin" />
              ) : actionBusy ? (
                <Square size={12} />
              ) : (
                <Send size={12} />
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`border-t px-4 pb-4 pt-3 ${containerClass}`}>
      <div className={`flex items-center ${showPanelHeader ? 'justify-between' : 'justify-end'} gap-3 pb-2`}>
        {showPanelHeader && (
          <div>
            <div className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${labelClass}`}>
              {panelLabel}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {panelDescription}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          {(isGenerating || isCompacting) && (
            <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
              <Loader2 size={11} className="animate-spin" />
              {isCompacting ? 'Compacting' : 'Answering'}
            </div>
          )}
          <div ref={overflowRef} className="relative">
            <button
              type="button"
              onClick={() => setOverflowOpen((current) => !current)}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              aria-label="Assistant Chat actions"
              title="Assistant Chat actions"
            >
              <MoreHorizontal size={14} />
            </button>
            {overflowOpen && (
              <div className={`absolute right-0 top-full z-50 mt-2 min-w-[200px] rounded-xl border py-1 shadow-lg backdrop-blur ${menuClass}`}>
                {canToggleThinking && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onToggleShowThinking?.()
                        setOverflowOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {showThinking ? <Check size={12} /> : <span className="w-3" aria-hidden="true" />}
                      {showThinking ? 'Hide thinking' : 'Show thinking'}
                    </button>
                    <div className={`my-1 border-t ${dividerClass}`} />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void handleCopyChat()
                    setOverflowOpen(false)
                  }}
                  disabled={messagesForCopy.length === 0}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {copiedChat ? <Check size={12} /> : <Copy size={12} />}
                  Copy chat
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleExportChat()
                    setOverflowOpen(false)
                  }}
                  disabled={messagesForCopy.length === 0}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {exportedChat ? <Check size={12} /> : <FileDown size={12} />}
                  Export chat
                </button>
                <div className={`my-1 border-t ${dividerClass}`} />
                <button
                  type="button"
                  onClick={() => {
                    void onCompact()
                    setOverflowOpen(false)
                  }}
                  disabled={busy || conversationRunBlocked || messagesForCopy.length === 0}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Layers size={12} />
                  Compact chat
                </button>
                <button
                  type="button"
                  onClick={handleRequestClearSession}
                  disabled={busy || !canClearSession}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-950/30"
                  title="Clear this conversation history and draft"
                >
                  <Trash2 size={12} />
                  Clear conversation
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`rounded-2xl border px-3 py-3 ${frameClass}`}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter'
              && !event.shiftKey
              && enterToSend
              && !busy
              && !conversationRunBlocked
            ) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="min-h-[72px] max-h-[180px] w-full resize-none bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />

        <div className={`mt-2 flex items-center justify-between gap-3 border-t pt-2 ${dividerClass}`}>
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {enterToSend ? 'Enter sends' : 'Enter adds a newline'}
          </div>
          <div className="flex items-center gap-2">
            {sessionContext ? (
              <ContextGauge
                tokensUsed={sessionContext.tokensUsed}
                contextLength={sessionContext.contextLength}
              />
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (clearingSession) {
                  return
                }

                if (isGenerating || isCompacting) {
                  void onCancel()
                  return
                }

                void handleSubmit()
              }}
              disabled={
                clearingSession
                || conversationRunBlocked
                || (!actionBusy && trimmedText.length === 0)
              }
              className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sendButtonClass}`}
            >
              {clearingSession ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Clearing
                </>
              ) : actionBusy ? (
                <>
                  <Square size={13} />
                  Stop
                </>
              ) : (
                <>
                  <Send size={14} />
                  Send
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      {conversationRunDisabledReason && (
        <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {conversationRunDisabledReason}
        </div>
      )}
    </div>
  )
}
