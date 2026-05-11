import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, AlertTriangle, Info, X } from 'lucide-react'
import { AssistantActionRow } from '@/components/AssistantActionRow'
import { MarkdownContent } from '@/components/MarkdownContent'
import { CodeBlock } from '@/components/CodeBlock'
import { DiffBlock } from '@/components/DiffBlock'
import { FileEditBlock } from '@/components/FileEditBlock'
import { FileExcerpt } from '@/components/FileExcerpt'
import { ShellSessionBlock } from '@/components/ShellSessionBlock'
import { ResearchProgressPanel } from '@/components/ResearchProgressPanel'
import { ToolCallBlock } from '@/components/ToolCallBlock'
import { HelperActivityBlock } from '@/components/HelperActivityBlock'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { resolveAttachmentPreviewUrl } from '@/lib/inputAttachments'
import type { PinnedQuote } from '@/lib/composeQuotedMessage'
import type { SelectionBlockContextValue } from '@/lib/selectionBlockContext'
import {
  getConversationUiActionLockedTitle,
  type ConversationUiControlLock,
} from '@/lib/conversationUiControls'
import {
  buildTurnDurationLabelParts,
  formatElapsedClock,
} from '@/lib/turnStatus'
import { buildLiveActivityPresentation } from '@/lib/liveActivityPresentation'
import type { ChatMessage, LiveActivitySnapshot, MessageContent } from '@/types'

interface MessageProps {
  sessionId?: string | null
  message: ChatMessage
  isStreaming?: boolean
  liveActivity?: LiveActivitySnapshot | null
  streamingStartedAt?: number
  showStreamingStatus?: boolean
  showStreamingDots?: boolean
  autoExpandActiveBlocks?: boolean
  showThinkingBlocks?: boolean
  collapseInlineEvents?: boolean
  collapsedEventMessages?: ChatMessage[]
  showCopyAction?: boolean
  onCopyTurn?: () => Promise<void> | void
  readAloudAction?: {
    visible: boolean
    ariaLabel: string
    title: string
    disabled: boolean
    active: boolean
    icon: 'volume' | 'loader' | 'stop'
    onClick?: () => void
  }
  queuedState?: {
    label: string
    tone: 'neutral' | 'error'
    details?: string
    onRemove?: () => void
  }
  /**
   * True when this assistant message is the one currently in "click to pin
   * sentences" mode. At most one message per session is in selection mode
   * at a time (managed in `useAppState`).
   */
  selectionMode?: boolean
  /**
   * Stable sentence keys pinned on THIS message — used to paint the indigo
   * highlight regardless of whether the message is currently in selection
   * mode. Empty set or undefined when nothing is pinned here.
   */
  pinnedSentenceKeys?: Set<string>
  /**
   * Fires when the user clicks the select icon in the action row. The parent
   * toggles `selectionMode` on this message (off for others).
   */
  showSelectionAction?: boolean
  onToggleSelectionMode?: (messageId: string) => void
  /**
   * Fires when the user clicks a sentence span inside this message while
   * `selectionMode` is true. Caller should dispatch `TOGGLE_PINNED_QUOTE`.
   */
  onToggleSentence?: (quote: PinnedQuote) => void
  assistantActionLock?: ConversationUiControlLock
  /**
   * True when this message is the most recent assistant turn in the chat.
   * The latest turn shows its duration label permanently and keeps the
   * action buttons visible; older turns hide the duration and only reveal
   * the buttons on hover.
   */
  isLatestAssistantTurn?: boolean
  fallbackPrimaryModelId?: string | null
}

interface ContentBlockProps {
  sessionId?: string | null
  content: MessageContent
  isActive: boolean
  autoExpandWhenActive: boolean
  contentBlockIndex?: number
  selectionContext?: SelectionBlockContextValue | null
}

type NoticeTone = 'error' | 'warning'

type AssistantEventContent = Extract<MessageContent, { type: 'thinking' | 'tool_call' }>

interface AssistantTimelineEvent {
  id: string
  content: AssistantEventContent
  messageId: string
  contentBlockIndex: number
}

function NoticeBlock({
  tone,
  message,
  details,
}: {
  tone: NoticeTone
  message: string
  details?: string
}) {
  const isError = tone === 'error'
  const Icon = isError ? AlertTriangle : Info
  const shellClass = isError
    ? 'border-red-200 bg-red-50/80 text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100'
    : 'border-amber-200 bg-amber-50/80 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
  const iconClass = isError
    ? 'text-red-500 dark:text-red-300'
    : 'text-amber-500 dark:text-amber-300'
  const detailClass = isError
    ? 'text-red-700/80 dark:text-red-100/70'
    : 'text-amber-700/80 dark:text-amber-100/70'

  return (
    <div className={`my-2 flex min-w-0 gap-2 rounded-lg border px-3 py-2 text-sm ${shellClass}`}>
      <Icon size={15} className={`mt-0.5 shrink-0 ${iconClass}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="min-w-0 break-words font-medium">{message}</div>
        {details && (
          <div className={`mt-1 min-w-0 break-words text-xs ${detailClass}`}>
            {details}
          </div>
        )}
      </div>
    </div>
  )
}

function formatAttachmentTimestampMs(timestampMs: number): string {
  const totalSeconds = Math.max(Math.round(timestampMs / 1000), 0)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function ContentBlock({
  sessionId,
  content,
  isActive,
  autoExpandWhenActive,
  contentBlockIndex,
  selectionContext,
}: ContentBlockProps) {
  switch (content.type) {
    case 'text':
      return (
        <MarkdownContent
          text={content.text}
          selectionContext={selectionContext}
          contentBlockIndex={contentBlockIndex}
        />
      )
    case 'image': {
      const imageUrl =
        resolveAttachmentPreviewUrl({ previewUrl: content.url })
        ?? content.url

      return (
        <div className="my-1.5">
          <img
            src={imageUrl}
            alt={content.alt ?? content.filename ?? 'Attached image'}
            className="max-h-[28rem] max-w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-800"
          />
          {(content.filename || content.source) && (
            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
              {[content.filename, content.source === 'camera' ? 'camera' : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      )
    }
    case 'pdf':
      return <PdfBlock content={content} />
    case 'audio':
      return <AudioBlock content={content} />
    case 'video':
      return <VideoBlock content={content} />
    case 'thinking':
      return (
        <ThinkingBlock
          text={content.text}
          summary={content.summary}
          isActive={isActive}
          autoExpandWhenActive={autoExpandWhenActive}
        />
      )
    case 'code':
      return (
        <CodeBlock
          code={content.code}
          language={content.language}
          filename={content.filename}
        />
      )
    case 'file_edit':
      return (
        <FileEditBlock
          path={content.path}
          changeType={content.changeType}
          addedLines={content.addedLines}
          removedLines={content.removedLines}
          diff={content.diff}
          truncated={content.truncated}
        />
      )
    case 'diff':
      return <DiffBlock filename={content.filename} diff={content.diff} />
    case 'file_excerpt':
      return (
        <FileExcerpt
          filename={content.filename}
          startLine={content.startLine}
          content={content.content}
          language={content.language}
        />
      )
    case 'tool_call':
      if (content.toolName === 'Gemma low helper') {
        const restartInstruction = content.input?.restartInstruction
        return (
          <HelperActivityBlock
            status={content.status}
            summary={typeof content.summary === 'string' ? content.summary : undefined}
            restartInstruction={
              typeof restartInstruction === 'string' ? restartInstruction : undefined
            }
          />
        )
      }
      return (
        <ToolCallBlock
          toolName={content.toolName}
          input={content.input}
          output={content.output}
          status={content.status}
          summary={content.summary}
          startedAt={content.startedAt}
          completedAt={content.completedAt}
          progressEntries={content.progressEntries}
          worker={content.worker}
          isActive={isActive}
          autoExpandWhenActive={autoExpandWhenActive}
        />
      )
    case 'research_panel':
      return <ResearchProgressPanel panel={content.panel} isActive={isActive} />
    case 'error':
      return (
        <NoticeBlock
          tone="error"
          message={content.message}
          details={content.details}
        />
      )
    case 'warning':
      return (
        <NoticeBlock tone="warning" message={content.message} />
      )
    case 'folder_link':
      return (
        <div className="my-2">
          <button
            onClick={() => {
              void window.gemmaDesktopBridge.folders.openPath(content.path)
            }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {content.label}
          </button>
          <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            {content.path}
          </div>
        </div>
      )
    case 'shell_session':
      if (content.displayMode === 'sidebar') {
        return null
      }

      return (
        <ShellSessionBlock
          sessionId={sessionId}
          content={content}
        />
      )
    default:
      return null
  }
}

function AudioBlock({
  content,
}: {
  content: Extract<MessageContent, { type: 'audio' }>
}) {
  const audioUrl =
    resolveAttachmentPreviewUrl({ previewUrl: content.url })
    ?? content.url

  return (
    <div className="my-2 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
        {content.filename}
      </div>
      <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        {[
          content.durationMs != null
            ? `${Math.max(content.durationMs / 1000, 0).toFixed(1)}s`
            : null,
          content.normalizedMediaType,
        ].filter(Boolean).join(' · ')}
      </div>
      <audio
        controls
        preload="metadata"
        src={audioUrl}
        className="mt-3 w-full"
      />
    </div>
  )
}

function VideoBlock({
  content,
}: {
  content: Extract<MessageContent, { type: 'video' }>
}) {
  const videoUrl =
    resolveAttachmentPreviewUrl({ previewUrl: content.url })
    ?? content.url
  const visibleThumbnails = content.thumbnails.slice(0, 4)

  return (
    <div className="my-2 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {content.filename}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {[
              content.durationMs != null
                ? `${Math.max(content.durationMs / 1000, 0).toFixed(1)}s`
                : null,
              `${content.sampledFrameCount} keyframe${content.sampledFrameCount === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      <video
        controls
        preload="metadata"
        src={videoUrl}
        className="mt-3 max-h-[28rem] w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-800"
      />

      {visibleThumbnails.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {visibleThumbnails.map((thumbnail, index) => {
            const thumbnailUrl =
              resolveAttachmentPreviewUrl({ previewUrl: thumbnail })
              ?? thumbnail
            const timestampLabel = content.sampledFrameTimestampsMs?.[index] != null
              ? formatAttachmentTimestampMs(content.sampledFrameTimestampsMs[index]!)
              : null
            return (
              <div
                key={`${thumbnail}-${index}`}
                className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
              >
                <img
                  src={thumbnailUrl}
                  alt={`${content.filename} keyframe ${index + 1}`}
                  className="max-h-40 w-full object-cover"
                />
                {timestampLabel && (
                  <div className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {timestampLabel}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PdfBlock({
  content,
}: {
  content: Extract<MessageContent, { type: 'pdf' }>
}) {
  const visibleThumbnails = content.previewThumbnails.slice(0, 4)
  const rangeLabel =
    content.processingMode === 'full_document'
      ? 'Full document'
      : `Pages ${content.processedRange.startPage}-${content.processedRange.endPage}`

  return (
    <div className="my-2 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {content.filename}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {[
              rangeLabel,
              `${content.pageCount} total page${content.pageCount === 1 ? '' : 's'}`,
              `${content.batchCount} worker batch${content.batchCount === 1 ? '' : 'es'}`,
              content.workerModelId ?? content.fitStatus,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          {content.fitStatus === 'ready' ? 'Ready' : content.fitStatus.replace('_', ' ')}
        </div>
      </div>

      {content.derivedSummary && (
        <div className="mt-3 rounded-xl border border-zinc-200/80 bg-white/70 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">
          {content.derivedSummary}
        </div>
      )}

      {content.derivedTextPath && (
        <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          Processed text artifact ready.
        </div>
      )}

      {visibleThumbnails.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {visibleThumbnails.map((thumbnail, index) => {
            const thumbnailUrl =
              resolveAttachmentPreviewUrl({ previewUrl: thumbnail })
              ?? thumbnail
            const pageNumber = content.processedRange.startPage + index
            return (
              <img
                key={`${thumbnail}-${index}`}
                src={thumbnailUrl}
                alt={`${content.filename} page ${pageNumber}`}
                className="max-h-48 w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-800"
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Determine which block index is "active" (should auto-expand).
 * Active = the last thinking or running tool_call block while streaming.
 */
function findActiveBlockIndex(
  content: MessageContent[],
  isStreaming: boolean,
): number {
  if (!isStreaming) return -1

  // Walk backwards to find the last expandable active block
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]!
    if (block.type === 'thinking') return i
    if (block.type === 'tool_call' && block.status === 'running') return i
    if (block.type === 'research_panel' && block.panel.runStatus === 'running') return i
    // If we hit completed text or a finished tool call, nothing is active
    if (block.type === 'text') return -1
    if (block.type === 'tool_call' && block.status !== 'running') continue
  }

  return -1
}

export type StreamingStatusTooltipPlacement = 'above' | 'below'

export function determineStreamingStatusTooltipPlacement(
  triggerTop: number,
  viewportHeight: number,
): StreamingStatusTooltipPlacement {
  const topEdgeThreshold = Math.min(180, Math.max(120, viewportHeight * 0.35))
  return triggerTop < topEdgeThreshold ? 'below' : 'above'
}

export function StreamingStatus({
  elapsedClock,
  activity,
  className = 'mt-2',
}: {
  elapsedClock: string
  activity?: LiveActivitySnapshot | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [tooltipPlacement, setTooltipPlacement] =
    useState<StreamingStatusTooltipPlacement>('above')
  const [now, setNow] = useState(() => Date.now())
  const statusRef = useRef<HTMLDivElement | null>(null)
  const tooltipId = useId()

  useEffect(() => {
    if (!activity) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activity])

  const presentation = activity
    ? buildLiveActivityPresentation(activity, now)
    : null
  const triggerLabel = presentation
    ? `${presentation.label}. ${presentation.note}`
    : 'Working'
  const tooltipPositionClass = tooltipPlacement === 'below'
    ? 'top-full mt-2'
    : 'bottom-full mb-2'
  const closedOffsetClass = tooltipPlacement === 'below'
    ? '-translate-y-1'
    : 'translate-y-1'

  const updateTooltipPlacement = useCallback(() => {
    const statusElement = statusRef.current
    if (!statusElement) return
    const rect = statusElement.getBoundingClientRect()
    setTooltipPlacement(
      determineStreamingStatusTooltipPlacement(rect.top, window.innerHeight),
    )
  }, [])

  const showTooltip = () => {
    updateTooltipPlacement()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return undefined
    const handleViewportChange = () => updateTooltipPlacement()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, updateTooltipPlacement])

  return (
    <div
      ref={statusRef}
      className={`relative inline-flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={() => setOpen(false)}
      onFocus={showTooltip}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="inline-flex h-6 min-w-8 items-center justify-center rounded-full px-1.5 text-left transition-colors hover:bg-sky-100/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 dark:hover:bg-sky-400/10"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-describedby={presentation ? tooltipId : undefined}
      >
        <StreamingDots
          className="assistant-streaming-dots-color"
          ariaHidden
        />
      </button>
      <span className="font-mono tabular-nums opacity-70">{elapsedClock}</span>

      {presentation && (
        <div
          id={tooltipId}
          className={`pointer-events-none absolute left-0 z-[70] w-[260px] rounded-lg border border-sky-200/80 bg-sky-50/95 p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 dark:border-sky-800/70 dark:bg-zinc-950/95 ${tooltipPositionClass} ${
            open ? 'translate-y-0 opacity-100' : `${closedOffsetClass} opacity-0`
          }`}
          role="tooltip"
          aria-hidden={!open}
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <div className="min-w-0 text-[11px] font-semibold leading-snug text-sky-700 dark:text-sky-300">
              {presentation.label}
            </div>
            {presentation.detail && presentation.detail !== 'session turn' && (
              <div className="min-w-0 text-[10px] leading-snug text-sky-700/55 dark:text-sky-300/55">
                {presentation.detail}
              </div>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
            {presentation.note}
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1">
            {presentation.metrics.map((metric) => (
              <Fragment key={metric.label}>
                <dt className="text-[10px] uppercase tracking-[0.14em] text-sky-700/55 dark:text-sky-300/55">
                  {metric.label}
                </dt>
                <dd className="text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  {metric.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

function StreamingDots({
  className = 'mt-2',
  ariaHidden = false,
}: {
  className?: string
  ariaHidden?: boolean
}) {
  return (
    <span
      className={`assistant-streaming-dots ${className}`}
      aria-hidden={ariaHidden ? 'true' : undefined}
      aria-label={ariaHidden ? undefined : 'Working'}
      role={ariaHidden ? undefined : 'status'}
    >
      <span className="assistant-streaming-dot">.</span>
      <span className="assistant-streaming-dot">.</span>
      <span className="assistant-streaming-dot">.</span>
    </span>
  )
}

function buildAssistantTimelineEvents(
  messages: ChatMessage[] | undefined,
  showThinkingBlocks: boolean,
): AssistantTimelineEvent[] {
  if (!messages?.length) {
    return []
  }

  return messages.flatMap((eventMessage) =>
    buildAssistantTimelineEventsFromContent({
      messageId: eventMessage.id,
      content: eventMessage.content,
      showThinkingBlocks,
    }),
  )
}

function isAssistantTimelineEventContent(
  content: MessageContent,
): content is AssistantEventContent {
  return content.type === 'thinking'
    || (content.type === 'tool_call' && content.toolName !== 'Gemma low helper')
}

function isInternalCollapsedAssistantEventContent(content: MessageContent): boolean {
  return content.type === 'tool_call' && content.toolName === 'Gemma low helper'
}

function buildAssistantTimelineEventsFromContent(input: {
  messageId: string
  content: MessageContent[]
  showThinkingBlocks: boolean
}): AssistantTimelineEvent[] {
  return input.content.flatMap((content, contentBlockIndex) => {
    if (content.type === 'thinking' && !input.showThinkingBlocks) {
      return []
    }
    if (!isAssistantTimelineEventContent(content)) {
      return []
    }

    return [{
      id: `${input.messageId}:${contentBlockIndex}`,
      messageId: input.messageId,
      content,
      contentBlockIndex,
    }]
  })
}

function formatEventDuration(content: AssistantEventContent): string | null {
  if (content.type !== 'tool_call') {
    return null
  }
  if (content.startedAt == null || content.completedAt == null) {
    return null
  }
  return `${Math.max(1, Math.round((content.completedAt - content.startedAt) / 1000))}s`
}

function getToolActionLabel(input: Record<string, unknown>): string | null {
  for (const key of ['operation', 'action', 'command', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function getAssistantTimelineEventLabel(content: AssistantEventContent): string {
  if (content.type === 'thinking') {
    return 'Thinking'
  }

  const actionLabel = getToolActionLabel(content.input)
  return actionLabel
    ? `${content.toolName} ${actionLabel}`
    : content.toolName
}

function getAssistantTimelineEventSummary(content: AssistantEventContent): string | null {
  if (content.type === 'thinking') {
    return content.summary?.trim() || content.text.trim().split(/\s+/).slice(0, 14).join(' ') || null
  }

  return content.summary?.trim() || content.worker?.currentAction?.trim() || null
}

function AssistantEventTimeline({
  sessionId,
  events,
}: {
  sessionId?: string | null
  events: AssistantTimelineEvent[]
}) {
  const [open, setOpen] = useState(false)
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)

  if (events.length === 0) {
    return null
  }

  return (
    <div
      data-assistant-event-timeline="true"
      className="mt-2 rounded-lg border border-zinc-200/70 bg-zinc-50/70 text-xs text-zinc-600 dark:border-zinc-800/80 dark:bg-zinc-900/35 dark:text-zinc-400"
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-100/70 dark:hover:bg-zinc-800/60"
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-600 dark:text-zinc-300">
          {getAssistantTimelineEventLabel(events.at(-1)!.content)}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
          {events.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-200/70 px-2.5 py-1.5 dark:border-zinc-800/80">
          {events.map((event, index) => {
            const expanded = expandedEventId === event.id
            const label = getAssistantTimelineEventLabel(event.content)
            const summary = getAssistantTimelineEventSummary(event.content)
            const duration = formatEventDuration(event.content)
            return (
              <div key={event.id} className={index > 0 ? 'mt-1' : ''}>
                <button
                  type="button"
                  onClick={() => setExpandedEventId((current) => current === event.id ? null : event.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
                  aria-expanded={expanded}
                >
                  <ChevronRight
                    size={11}
                    className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  />
                  <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-200">
                    {label}
                  </span>
                  {summary && (
                    <span className="min-w-0 flex-1 truncate text-zinc-400 dark:text-zinc-500">
                      {summary}
                    </span>
                  )}
                  {duration && (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                      {duration}
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="ml-4 mt-1 rounded-lg bg-white/60 px-2 py-1 dark:bg-zinc-950/35">
                    <ContentBlock
                      sessionId={sessionId}
                      content={event.content}
                      isActive
                      autoExpandWhenActive
                      contentBlockIndex={event.contentBlockIndex}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Message({
  sessionId = null,
  message,
  isStreaming,
  liveActivity,
  streamingStartedAt,
  showStreamingStatus = true,
  showStreamingDots = true,
  autoExpandActiveBlocks = true,
  showThinkingBlocks = true,
  collapseInlineEvents: collapseInlineEventsProp = false,
  collapsedEventMessages,
  showCopyAction = false,
  onCopyTurn,
  readAloudAction,
  queuedState,
  selectionMode,
  pinnedSentenceKeys,
  showSelectionAction = false,
  onToggleSelectionMode,
  onToggleSentence,
  assistantActionLock,
  isLatestAssistantTurn = false,
  fallbackPrimaryModelId = null,
}: MessageProps) {
  const isUser = message.role === 'user'
  const [copiedTurn, setCopiedTurn] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const primaryModelLabel =
    message.primaryModelId?.trim()
    || fallbackPrimaryModelId?.trim()
    || null
  const durationLabelParts = !isStreaming && !isUser
    ? buildTurnDurationLabelParts(
        message.content,
        message.durationMs,
        primaryModelLabel,
      )
    : null
  const durationLabel = !isStreaming && !isUser
    ? durationLabelParts?.label ?? null
    : null
  const shouldEnableSentenceSelection =
    Boolean(selectionMode)
    || (pinnedSentenceKeys?.size ?? 0) > 0
  const assistantActionsLocked = assistantActionLock?.locked ?? false

  // Build the sentence-selection context for this assistant message. Null for
  // user messages, streaming placeholders, and messages the parent opted out
  // of (no `onToggleSentence` callback).
  const selectionContext = useMemo<SelectionBlockContextValue | null>(() => {
    if (
      isUser
      || isStreaming
      || !onToggleSentence
      || !shouldEnableSentenceSelection
    ) {
      return null
    }
    return {
      selectionActive: Boolean(selectionMode) && !assistantActionsLocked,
      pinnedSentenceKeys: pinnedSentenceKeys ?? new Set<string>(),
      sourceMessageId: message.id,
      onToggleSentence: (sentenceKey, sentenceText, indices) => {
        onToggleSentence({
          id: sentenceKey,
          sourceMessageId: message.id,
          sourceTurnTimestamp: message.timestamp,
          contentBlockIndex: indices.contentBlockIndex,
          blockIndex: indices.blockIndex,
          sentenceIndex: indices.sentenceIndex,
          text: sentenceText,
          createdAt: Date.now(),
        })
      },
    }
  }, [
    isStreaming,
    isUser,
    message.id,
    message.timestamp,
    assistantActionsLocked,
    onToggleSentence,
    pinnedSentenceKeys,
    selectionMode,
    shouldEnableSentenceSelection,
  ])

  useEffect(() => {
    if (!isStreaming) {
      return
    }

    setNow(Date.now())
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [isStreaming, streamingStartedAt])

  const handleCopyTurn = async () => {
    if (!onCopyTurn) {
      return
    }

    await onCopyTurn()
    setCopiedTurn(true)
    window.setTimeout(() => setCopiedTurn(false), 1200)
  }

  const elapsedClock = isStreaming
    ? formatElapsedClock(
        Math.max(now - (streamingStartedAt ?? message.timestamp), 0),
      )
    : null
  const visibleContent = useMemo(
    () => (
      showThinkingBlocks
        ? message.content
        : message.content.filter((content) => content.type !== 'thinking')
    ),
    [message.content, showThinkingBlocks],
  )
  const hasCollapsedTimelineEvents = Boolean(
    collapsedEventMessages?.some((eventMessage) =>
      eventMessage.content.some((content) =>
        content.type === 'thinking'
          ? showThinkingBlocks
          : isAssistantTimelineEventContent(content)
      )
    ),
  )
  const collapseInlineEvents =
    collapseInlineEventsProp
    && !isUser
    && (visibleContent.some(isAssistantTimelineEventContent) || hasCollapsedTimelineEvents)
  const activeIndex = findActiveBlockIndex(
    visibleContent,
    Boolean(isStreaming),
  )
  const renderAssistantContentBlocks = () => {
    const nodes: React.ReactNode[] = []
    let pendingTimelineEvents: AssistantTimelineEvent[] = []
    let timelineRunIndex = 0

    const flushTimeline = () => {
      if (pendingTimelineEvents.length === 0) {
        return
      }

      const events = pendingTimelineEvents
      pendingTimelineEvents = []
      nodes.push(
        <AssistantEventTimeline
          key={`assistant-events-${timelineRunIndex}`}
          sessionId={sessionId}
          events={events}
        />,
      )
      timelineRunIndex += 1
    }

    visibleContent.forEach((content, i) => {
      if (collapseInlineEvents && isInternalCollapsedAssistantEventContent(content)) {
        return
      }

      const isTimelineEvent = isAssistantTimelineEventContent(content)
      if (collapseInlineEvents && isTimelineEvent) {
        pendingTimelineEvents.push({
          id: `${message.id}:${i}`,
          messageId: message.id,
          content,
          contentBlockIndex: i,
        })
        return
      }

      flushTimeline()
      nodes.push(
        <ContentBlock
          key={i}
          sessionId={sessionId}
          content={content}
          isActive={i === activeIndex}
          autoExpandWhenActive={autoExpandActiveBlocks}
          contentBlockIndex={i}
          selectionContext={selectionContext}
        />,
      )
    })

    if (collapseInlineEvents) {
      pendingTimelineEvents.push(
        ...buildAssistantTimelineEvents(collapsedEventMessages, showThinkingBlocks),
      )
    }
    flushTimeline()

    return nodes
  }
  const selectionButtonVisible = showSelectionAction
  const selectionButtonDisabled = selectionButtonVisible
    && (Boolean(isStreaming) || assistantActionsLocked || !onToggleSelectionMode)
  const selectionButtonTitle = selectionButtonDisabled
    ? assistantActionLock?.locked
      ? getConversationUiActionLockedTitle(assistantActionLock, 'selection')
      : 'Wait for the response to finish before selecting sentences.'
    : selectionMode
      ? 'Exit selection'
      : 'Select sentences to quote in the next message'
  const copyButtonVisible = showCopyAction
  const copyButtonDisabled = copyButtonVisible
    && (Boolean(isStreaming) || assistantActionsLocked || !onCopyTurn)
  const copyButtonTitle = copyButtonDisabled
    ? assistantActionLock?.locked
      ? getConversationUiActionLockedTitle(assistantActionLock, 'copy')
      : 'Wait for the response to finish before copying this turn.'
    : 'Copy turn'

  return (
    <div className={`group ${isUser ? 'mb-3' : 'mb-4'}`}>
      {isUser ? (
        <div className="rounded-xl bg-zinc-100 px-3.5 py-2.5 text-sm text-zinc-900 dark:bg-zinc-800/60 dark:text-zinc-100">
          {queuedState && (
            <div className="mb-2 flex items-center justify-between gap-3">
              <div
                className={`text-[11px] font-medium ${
                  queuedState.tone === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                {queuedState.label}
                {queuedState.details ? (
                  <span className="ml-1 opacity-80">{queuedState.details}</span>
                ) : null}
              </div>
              {queuedState.onRemove && (
                <button
                  type="button"
                  onClick={queuedState.onRemove}
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                  aria-label="Remove queued message"
                  title="Remove queued message"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {visibleContent.map((content, i) => (
              <ContentBlock
                key={i}
                sessionId={sessionId}
                content={content}
                isActive={false}
                autoExpandWhenActive={autoExpandActiveBlocks}
              />
          ))}
        </div>
      ) : (
        <div className="relative">
          <div
            className={`text-sm text-zinc-800 dark:text-zinc-200 ${
              selectionMode
                ? '-mx-2 rounded-xl px-2 py-1 ring-1 ring-indigo-200 dark:ring-indigo-800/60'
                : ''
            }`}
          >
            {renderAssistantContentBlocks()}
          </div>

          {isStreaming && showStreamingStatus && (
            <StreamingStatus
              elapsedClock={elapsedClock ?? '00:00'}
              activity={liveActivity}
            />
          )}

          {isStreaming && !showStreamingStatus && showStreamingDots && (
            <StreamingDots />
          )}

          <AssistantActionRow
            isLatestTurn={isLatestAssistantTurn}
            durationLabel={durationLabel}
            durationLabelParts={durationLabelParts}
            selection={
              selectionButtonVisible && onToggleSelectionMode
                ? {
                    active: Boolean(selectionMode),
                    disabled: selectionButtonDisabled,
                    title: selectionButtonTitle,
                    onToggle: () => onToggleSelectionMode(message.id),
                  }
                : undefined
            }
            readAloud={readAloudAction}
            copy={
              copyButtonVisible && onCopyTurn
                ? {
                    disabled: copyButtonDisabled,
                    title: copyButtonTitle,
                    copied: copiedTurn,
                    onCopy: handleCopyTurn,
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}
