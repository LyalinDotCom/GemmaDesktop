import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { InlineDebugPanel } from '@/components/InlineDebugPanel'
import { Message, StreamingStatus } from '@/components/Message'
import type { ReadAloudButtonState } from '@/hooks/useReadAloudPlayer'
import { copyText } from '@/lib/clipboard'
import {
  buildSessionBootstrapCard,
  type InlineDebugCard,
  splitInlineDebugLogs,
} from '@/lib/debugTimeline'
import { getRenderableChatMessages } from '@/lib/messageState'
import { normalizeSelectedReadAloudText } from '@/lib/readAloudText'
import {
  applyLatestAssistantPrimaryModelFallback,
  serializeAssistantTurn,
} from '@/lib/chatCopy'
import {
  buildConversationUiControlLock,
  getConversationUiActionLockedTitle,
  type ConversationUiControlLock,
} from '@/lib/conversationUiControls'
import type { PinnedQuote } from '@/lib/composeQuotedMessage'
import type { ChatContentLayout } from '@/lib/rightDockLayout'
import { formatElapsedClock } from '@/lib/turnStatus'
import type {
  ChatMessage,
  DebugLogEntry,
  DebugSessionSnapshot,
  LiveActivitySnapshot,
  MessageContent,
  PendingCompaction,
  PendingToolApproval,
  QueuedUserMessage,
} from '@/types'

const EMPTY_DEBUG_LOGS: DebugLogEntry[] = []
const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 24

interface ChatCanvasProps {
  sessionId?: string | null
  messages: ChatMessage[]
  streamingContent: MessageContent[] | null
  isGenerating: boolean
  isCompacting: boolean
  autoExpandActiveBlocks?: boolean
  showThinkingBlocks?: boolean
  debugEnabled: boolean
  debugLogs: DebugLogEntry[]
  debugSession: DebugSessionSnapshot | null
  sessionTitle?: string
  queuedMessages?: QueuedUserMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  getReadAloudButtonState?: (
    message: ChatMessage,
    options?: { isStreaming?: boolean },
  ) => ReadAloudButtonState
  getSelectedTextReadAloudButtonState?: (
    selectedText: string,
  ) => ReadAloudButtonState
  /** Which assistant message is in sentence-selection mode (null = none). */
  selectionModeMessageId?: string | null
  /** Pinned-sentence keys grouped by source message id, for painting highlights. */
  pinnedSentenceKeysByMessageId?: Map<string, Set<string>>
  /** Toggle selection mode on/off for a specific assistant message. */
  onToggleSelectionMode?: (messageId: string) => void
  /** Toggle a specific sentence's pinned state. */
  onToggleSentence?: (quote: PinnedQuote) => void
  forceAutoScroll?: boolean
  liveActivity?: LiveActivitySnapshot | null
  pendingCompaction?: PendingCompaction | null
  pendingToolApproval?: PendingToolApproval | null
  controlLock?: ConversationUiControlLock
  latestAssistantFallbackPrimaryModelId?: string | null
  topPaddingClass?: string
  contentLayout?: ChatContentLayout
  streamingStatusPlacement?: 'inline' | 'bottom' | 'external'
}

interface SelectedTextBubble {
  text: string
  left: number
  top: number
}

function disableReadAloudActionWhileBusy(
  action: ReadAloudButtonState | null | undefined,
  lock: ConversationUiControlLock,
): ReadAloudButtonState | undefined {
  if (!action) {
    return undefined
  }

  if (!lock.locked) {
    return action
  }

  return {
    ...action,
    disabled: true,
    title: getConversationUiActionLockedTitle(lock, 'read_aloud'),
    ariaLabel: 'Read aloud is unavailable while the session run is active',
  }
}

function hasSameMessageReferences(
  a: ChatMessage[],
  b: ChatMessage[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((message, index) => message === b[index])
}

function isCompletedResearchReportMessage(message: ChatMessage | null): boolean {
  if (!message || message.role !== 'assistant') {
    return false
  }
  const hasArtifactLink = message.content.some((block) =>
    block.type === 'folder_link'
    && block.label === 'Open research artifacts')
  const hasLiveResearchPanel = message.content.some((block) => block.type === 'research_panel')
  return hasArtifactLink && !hasLiveResearchPanel
}

function isNodeWithin(
  container: HTMLElement,
  node: Node | null,
): boolean {
  if (!node) {
    return false
  }

  if (node instanceof HTMLElement) {
    return container.contains(node)
  }

  return Boolean(node.parentElement && container.contains(node.parentElement))
}

function resolveSelectedTextBubble(
  container: HTMLElement | null,
): SelectedTextBubble | null {
  if (!container) {
    return null
  }

  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }

  if (
    !isNodeWithin(container, selection.anchorNode)
    || !isNodeWithin(container, selection.focusNode)
  ) {
    return null
  }

  const selectedText = normalizeSelectedReadAloudText(selection.toString())
  if (selectedText.length === 0) {
    return null
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (
    !Number.isFinite(rect.left)
    || !Number.isFinite(rect.top)
    || (rect.width === 0 && rect.height === 0)
  ) {
    return null
  }

  const horizontalMargin = 84
  const overlayHeight = 44
  const gap = 12
  const centeredLeft = rect.left + (rect.width / 2)
  const left = Math.min(
    window.innerWidth - horizontalMargin,
    Math.max(horizontalMargin, centeredLeft),
  )
  const top =
    rect.top >= overlayHeight + gap + 12
      ? rect.top - overlayHeight - gap
      : rect.bottom + gap

  return {
    text: selectedText,
    left,
    top: Math.max(top, 12),
  }
}

export function ChatCanvas({
  sessionId = null,
  messages,
  streamingContent,
  isGenerating,
  isCompacting,
  autoExpandActiveBlocks = true,
  showThinkingBlocks = true,
  debugEnabled,
  debugLogs,
  debugSession,
  sessionTitle,
  queuedMessages = [],
  onRemoveQueuedMessage,
  getReadAloudButtonState,
  getSelectedTextReadAloudButtonState,
  selectionModeMessageId = null,
  pinnedSentenceKeysByMessageId,
  onToggleSelectionMode,
  onToggleSentence,
  forceAutoScroll = false,
  liveActivity = null,
  pendingCompaction = null,
  pendingToolApproval = null,
  controlLock,
  latestAssistantFallbackPrimaryModelId = null,
  topPaddingClass = 'pt-14',
  contentLayout = 'centered',
  streamingStatusPlacement = 'inline',
}: ChatCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldAutoFollowRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const forceScrollUntilRef = useRef(0)
  const visibleMessagesRef = useRef<ChatMessage[] | null>(null)
  const contentWidthClass = contentLayout === 'expanded'
    ? 'w-full'
    : 'mx-auto w-full max-w-chat'
  const contentPaddingClass = contentLayout === 'expanded' ? 'px-4' : 'px-6'
  const previousUserTailRef = useRef<string | null>(null)
  const previousQueuedTailRef = useRef<string | null>(null)
  const previousResearchReportTailRef = useRef<string | null>(null)
  const pointerSelectingRef = useRef(false)
  const [selectedTextBubble, setSelectedTextBubble] =
    useState<SelectedTextBubble | null>(null)
  const [statusNow, setStatusNow] = useState(() => Date.now())
  const visibleDebugLogs = debugEnabled ? debugLogs : EMPTY_DEBUG_LOGS
  const visibleDebugSession = debugEnabled ? debugSession : null
  const visibleMessages = useMemo(
    () => {
      const nextVisibleMessages = getRenderableChatMessages(messages)
      const previousVisibleMessages = visibleMessagesRef.current
      if (
        previousVisibleMessages
        && hasSameMessageReferences(previousVisibleMessages, nextVisibleMessages)
      ) {
        return previousVisibleMessages
      }

      visibleMessagesRef.current = nextVisibleMessages
      return nextVisibleMessages
    },
    [messages],
  )
  const latestMessage = visibleMessages.at(-1) ?? null
  const latestResearchReportMessageId =
    isCompletedResearchReportMessage(latestMessage) ? latestMessage?.id ?? null : null
  const latestQueuedMessageId = queuedMessages.at(-1)?.id ?? null
  const fallbackControlLock = useMemo(
    () => buildConversationUiControlLock({
      isGenerating,
      isCompacting,
      pendingCompaction,
      pendingToolApproval,
      liveActivity,
      streamingContent,
    }),
    [
      isCompacting,
      isGenerating,
      liveActivity,
      pendingCompaction,
      pendingToolApproval,
      streamingContent,
    ],
  )
  const assistantActionLock = controlLock ?? fallbackControlLock
  const showBottomStreamingStatus =
    streamingStatusPlacement === 'bottom'
    && Boolean(streamingContent || isGenerating || isCompacting)

  const distanceFromBottom = (container: HTMLDivElement): number =>
    Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight)

  const scrollToBottom = (
    behavior: ScrollBehavior = 'auto',
    options?: { force?: boolean },
  ) => {
    const shouldForce = options?.force || (
      forceAutoScroll && Date.now() < forceScrollUntilRef.current
    )

    if (!shouldForce && !shouldAutoFollowRef.current) {
      return
    }

    if (scrollFrameRef.current != null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null

      const container = containerRef.current
      if (!container || (!shouldForce && !shouldAutoFollowRef.current)) {
        return
      }

      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      })
    })
  }

  useLayoutEffect(() => {
    shouldAutoFollowRef.current = true
    if (forceAutoScroll) {
      forceScrollUntilRef.current = Date.now() + 400
    }
    scrollToBottom('auto', { force: true })
    if (!forceAutoScroll) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      scrollToBottom('auto', { force: true })
    }, 60)

    return () => window.clearTimeout(timeoutId)
  }, [forceAutoScroll, sessionId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      const nextScrollTop = container.scrollTop
      const nextDistanceFromBottom = distanceFromBottom(container)

      if (nextDistanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
        shouldAutoFollowRef.current = true
      } else if (nextScrollTop < lastScrollTopRef.current) {
        shouldAutoFollowRef.current = false
      }

      lastScrollTopRef.current = nextScrollTop
    }

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        shouldAutoFollowRef.current = false
      }
    }

    lastScrollTopRef.current = container.scrollTop
    handleScroll()
    container.addEventListener('scroll', handleScroll, { passive: true })
    container.addEventListener('wheel', handleWheel, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', handleWheel)
    }
  }, [])

  useLayoutEffect(() => {
    const latestUserTail = latestMessage?.role === 'user' ? latestMessage.id : null
    const shouldFollowNewUserTurn =
      latestUserTail != null
      && latestUserTail !== previousUserTailRef.current
    const shouldFollowQueuedTurn =
      latestQueuedMessageId != null
      && latestQueuedMessageId !== previousQueuedTailRef.current

    previousUserTailRef.current = latestUserTail
    previousQueuedTailRef.current = latestQueuedMessageId

    if (!shouldFollowNewUserTurn && !shouldFollowQueuedTurn) {
      return
    }

    shouldAutoFollowRef.current = true
    scrollToBottom(isGenerating || isCompacting ? 'auto' : 'smooth', {
      force: true,
    })
  }, [
    isCompacting,
    isGenerating,
    latestMessage,
    latestQueuedMessageId,
  ])

  useLayoutEffect(() => {
    if (
      latestResearchReportMessageId
      && latestResearchReportMessageId !== previousResearchReportTailRef.current
    ) {
      previousResearchReportTailRef.current = latestResearchReportMessageId
      shouldAutoFollowRef.current = false
      window.requestAnimationFrame(() => {
        const container = containerRef.current
        const reportNode = Array.from(
          container?.querySelectorAll<HTMLElement>('[data-research-report-id]') ?? [],
        ).find((node) => node.dataset.researchReportId === latestResearchReportMessageId)
        reportNode?.scrollIntoView({ block: 'start', behavior: 'auto' })
      })
      return
    }

    scrollToBottom(isGenerating || isCompacting ? 'auto' : 'smooth')
  }, [
    isCompacting,
    isGenerating,
    latestResearchReportMessageId,
    queuedMessages,
    streamingContent,
    visibleMessages,
    visibleDebugLogs,
    visibleDebugSession,
  ])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      scrollToBottom(isGenerating || isCompacting ? 'auto' : 'smooth')
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [isCompacting, isGenerating])

  useEffect(() => {
    if (!showBottomStreamingStatus) {
      return
    }

    setStatusNow(Date.now())
    const interval = window.setInterval(() => {
      setStatusNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [showBottomStreamingStatus])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    }
  }, [])

  const refreshSelectedTextBubble = useCallback((options?: {
    force?: boolean
  }) => {
    if (pointerSelectingRef.current && !options?.force) {
      setSelectedTextBubble(null)
      return
    }

    setSelectedTextBubble(resolveSelectedTextBubble(contentRef.current))
  }, [])

  useEffect(() => {
    const handleSelectionChange = () => {
      refreshSelectedTextBubble()
    }

    const handleResize = () => {
      refreshSelectedTextBubble()
    }

    const handlePointerDown = (event: PointerEvent) => {
      const content = contentRef.current
      const target = event.target
      if (!(content && target instanceof Node && content.contains(target))) {
        return
      }

      pointerSelectingRef.current = true
      setSelectedTextBubble(null)
    }

    const handlePointerUp = () => {
      if (!pointerSelectingRef.current) {
        return
      }

      pointerSelectingRef.current = false
      window.requestAnimationFrame(() => {
        refreshSelectedTextBubble({ force: true })
      })
    }

    const container = containerRef.current
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    window.addEventListener('resize', handleResize)
    container?.addEventListener('scroll', handleResize, { passive: true })

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      window.removeEventListener('resize', handleResize)
      container?.removeEventListener('scroll', handleResize)
    }
  }, [refreshSelectedTextBubble])

  useEffect(() => {
    refreshSelectedTextBubble()
  }, [
    refreshSelectedTextBubble,
    sessionId,
    streamingContent,
    visibleMessages,
  ])

  const debugTimeline = useMemo(
    () => splitInlineDebugLogs(visibleDebugLogs),
    [visibleDebugLogs],
  )

  const sessionBootstrapCard = useMemo(
    () =>
      debugEnabled
        ? buildSessionBootstrapCard(visibleDebugSession, sessionTitle)
        : null,
    [debugEnabled, sessionTitle, visibleDebugSession],
  )

  const conversation = useMemo(() => {
    const introMessages: ChatMessage[] = []
    const turns: Array<{ user: ChatMessage; responses: ChatMessage[] }> = []

    for (const message of visibleMessages) {
      if (message.role === 'user') {
        turns.push({ user: message, responses: [] })
        continue
      }

      if (turns.length === 0) {
        introMessages.push(message)
        continue
      }

      turns[turns.length - 1]?.responses.push(message)
    }

    return { introMessages, turns }
  }, [visibleMessages])

  const selectedTextReadAloudAction =
    selectedTextBubble && getSelectedTextReadAloudButtonState
      ? disableReadAloudActionWhileBusy(
          getSelectedTextReadAloudButtonState(selectedTextBubble.text),
          assistantActionLock,
        )
      : null

  const bottomStatusStartedAt = useMemo(() => {
    const latestTurn = conversation.turns.at(-1)
    if (
      (isGenerating || isCompacting)
      && latestTurn
      && latestTurn.responses.length === 0
    ) {
      return latestTurn.user.timestamp
    }

    return latestMessage?.timestamp ?? statusNow
  }, [
    conversation.turns,
    isCompacting,
    isGenerating,
    latestMessage?.timestamp,
    statusNow,
  ])

  // Id of the most recent assistant message. Only that row keeps its
  // duration label and buttons permanently visible; older assistant rows
  // hide their duration and reveal buttons on hover.
  const latestAssistantMessageId = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      if (visibleMessages[i]?.role === 'assistant') {
        return visibleMessages[i]!.id
      }
    }
    return null
  }, [visibleMessages])

  const messagesWithPrimaryModelFallback = useMemo(
    () =>
      applyLatestAssistantPrimaryModelFallback(
        visibleMessages,
        latestAssistantFallbackPrimaryModelId,
      ),
    [latestAssistantFallbackPrimaryModelId, visibleMessages],
  )

  const renderMessage = (message: ChatMessage) => {
    const researchReportId = isCompletedResearchReportMessage(message)
      ? message.id
      : undefined
    return (
      <div
        key={message.id}
        data-research-report-id={researchReportId}
      >
        <Message
          sessionId={sessionId}
          message={message}
          autoExpandActiveBlocks={autoExpandActiveBlocks}
          showThinkingBlocks={showThinkingBlocks}
          showCopyAction={message.role === 'assistant'}
          isLatestAssistantTurn={
            message.role === 'assistant' && message.id === latestAssistantMessageId
          }
          fallbackPrimaryModelId={
            message.role === 'assistant' && message.id === latestAssistantMessageId
              ? latestAssistantFallbackPrimaryModelId
              : null
          }
          onCopyTurn={
            message.role === 'assistant'
              ? async () => {
                  await copyText(
                    serializeAssistantTurn(messagesWithPrimaryModelFallback, message.id),
                  )
                }
              : undefined
          }
          readAloudAction={
            message.role === 'assistant'
              ? disableReadAloudActionWhileBusy(
                  getReadAloudButtonState?.(message),
                  assistantActionLock,
                )
              : undefined
          }
          selectionMode={
            message.role === 'assistant' && message.id === selectionModeMessageId
          }
          pinnedSentenceKeys={
            message.role === 'assistant'
              ? pinnedSentenceKeysByMessageId?.get(message.id)
              : undefined
          }
          showSelectionAction={
            message.role === 'assistant' && Boolean(onToggleSelectionMode)
          }
          onToggleSelectionMode={
            message.role === 'assistant' ? onToggleSelectionMode : undefined
          }
          onToggleSentence={
            message.role === 'assistant' ? onToggleSentence : undefined
          }
          assistantActionLock={assistantActionLock}
        />
      </div>
    )
  }

  const renderDebugCard = (card: InlineDebugCard) => (
    <InlineDebugPanel
      key={card.id}
      title={card.title}
      subtitle={card.subtitle}
      body={card.body}
      badge={card.badge}
      tone={card.tone}
    />
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto ${topPaddingClass}`}
      >
        <div
          ref={contentRef}
          className={`${contentWidthClass} ${contentPaddingClass} pb-4 pt-4`}
        >
          {debugEnabled && sessionBootstrapCard && renderDebugCard(sessionBootstrapCard)}

          {debugEnabled &&
            debugTimeline.interstitialLogs[0]?.map((card) => renderDebugCard(card))}

          {conversation.introMessages.map((message) => renderMessage(message))}

          {conversation.turns.map((turn, turnIndex) => {
            const turnLogs = debugTimeline.turnLogs[turnIndex]
            const betweenTurnLogs = debugTimeline.interstitialLogs[turnIndex + 1] ?? []
            const isPendingTurn =
              (isGenerating || isCompacting)
              && turn.responses.length === 0
              && turnIndex === conversation.turns.length - 1

            return (
              <Fragment key={turn.user.id}>
                {renderMessage(turn.user)}

                {debugEnabled &&
                  turnLogs?.beforeResult.map((card) => renderDebugCard(card))}

                {turn.responses.map((message) => renderMessage(message))}

                {isPendingTurn && (
                  <Message
                    sessionId={sessionId}
                    message={{
                      id: 'streaming',
                      role: 'assistant',
                      content: streamingContent ?? [],
                      timestamp: turn.user.timestamp,
                    }}
                    isStreaming
                    liveActivity={liveActivity}
                    showStreamingStatus={streamingStatusPlacement === 'inline'}
                    autoExpandActiveBlocks={autoExpandActiveBlocks}
                    showThinkingBlocks={showThinkingBlocks}
                    streamingStartedAt={turn.user.timestamp}
                    showCopyAction
                    showSelectionAction={Boolean(onToggleSelectionMode)}
                    readAloudAction={
                      disableReadAloudActionWhileBusy(
                        getReadAloudButtonState?.(
                          {
                            id: 'streaming',
                            role: 'assistant',
                            content: streamingContent ?? [],
                            timestamp: turn.user.timestamp,
                          },
                          { isStreaming: true },
                        ),
                        assistantActionLock,
                      )
                    }
                    assistantActionLock={assistantActionLock}
                  />
                )}

                {debugEnabled &&
                  turnLogs?.afterResult.map((card) => renderDebugCard(card))}

                {debugEnabled &&
                  betweenTurnLogs.map((card) => renderDebugCard(card))}
              </Fragment>
            )
          })}

          {(streamingContent || isGenerating || isCompacting) && conversation.turns.length === 0 && (
            <Message
              sessionId={sessionId}
              message={{
                id: 'streaming',
                role: 'assistant',
                content: streamingContent ?? [],
                timestamp: Date.now(),
              }}
              isStreaming
              liveActivity={liveActivity}
              showStreamingStatus={streamingStatusPlacement === 'inline'}
              autoExpandActiveBlocks={autoExpandActiveBlocks}
              showThinkingBlocks={showThinkingBlocks}
              showCopyAction
              showSelectionAction={Boolean(onToggleSelectionMode)}
              readAloudAction={
                disableReadAloudActionWhileBusy(
                  getReadAloudButtonState?.(
                    {
                      id: 'streaming',
                      role: 'assistant',
                      content: streamingContent ?? [],
                      timestamp: Date.now(),
                    },
                    { isStreaming: true },
                  ),
                  assistantActionLock,
                )
              }
              assistantActionLock={assistantActionLock}
            />
          )}

          {queuedMessages.map((queuedMessage) => (
            <Message
              key={queuedMessage.id}
              sessionId={sessionId}
              message={{
                id: queuedMessage.id,
                role: 'user',
                content: queuedMessage.content,
                timestamp: queuedMessage.timestamp,
              }}
              autoExpandActiveBlocks={autoExpandActiveBlocks}
              showThinkingBlocks={showThinkingBlocks}
              queuedState={{
                label:
                  queuedMessage.status === 'failed'
                    ? 'Queued message failed'
                    : 'Queued for the next turn',
                tone: queuedMessage.status === 'failed' ? 'error' : 'neutral',
                details: queuedMessage.error,
                onRemove:
                  onRemoveQueuedMessage
                    ? () => onRemoveQueuedMessage(queuedMessage.id)
                    : undefined,
              }}
            />
          ))}

        </div>
      </div>

      {showBottomStreamingStatus && (
        <div className={`${contentWidthClass} ${contentPaddingClass} pb-3`}>
          <StreamingStatus
            elapsedClock={formatElapsedClock(
              Math.max(statusNow - bottomStatusStartedAt, 0),
            )}
            activity={liveActivity}
            className="assistant-chat-bottom-status"
          />
        </div>
      )}

      {selectedTextBubble && selectedTextReadAloudAction?.visible && (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            selectedTextReadAloudAction.onClick?.()
          }}
          disabled={selectedTextReadAloudAction.disabled}
          title={selectedTextReadAloudAction.title}
          aria-label={selectedTextReadAloudAction.ariaLabel}
          className={`fixed z-30 inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium shadow-[0_16px_34px_-22px_rgba(24,24,27,0.5)] backdrop-blur transition-colors ${
            selectedTextReadAloudAction.disabled
              ? 'cursor-not-allowed border-zinc-200 bg-white/95 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950/95 dark:text-zinc-600'
              : selectedTextReadAloudAction.active
                ? 'border-indigo-300 bg-indigo-50/95 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/95 dark:text-indigo-300 dark:hover:bg-indigo-950'
                : 'border-zinc-200 bg-white/95 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950/95 dark:text-zinc-200 dark:hover:bg-zinc-900'
          }`}
          style={{
            left: selectedTextBubble.left,
            top: selectedTextBubble.top,
            transform: 'translateX(-50%)',
          }}
        >
          {selectedTextReadAloudAction.icon === 'loader' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : selectedTextReadAloudAction.icon === 'stop' ? (
            <Square size={13} />
          ) : (
            <Volume2 size={13} />
          )}
          <span>
            {selectedTextReadAloudAction.icon === 'loader'
              ? 'Preparing'
              : selectedTextReadAloudAction.icon === 'stop'
                ? 'Stop'
                : 'Read Aloud'}
          </span>
        </button>
      )}
    </div>
  )
}
