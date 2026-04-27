import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
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
  buildTurnDurationLabel,
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
  autoExpandActiveBlocks?: boolean
  showThinkingBlocks?: boolean
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
  /**
   * True when this message is the most recent assistant turn in the chat.
   * The latest turn shows its duration label permanently and keeps the
   * action buttons visible; older turns hide the duration and only reveal
   * the buttons on hover.
   */
  isLatestAssistantTurn?: boolean
}

interface ContentBlockProps {
  sessionId?: string | null
  content: MessageContent
  isActive: boolean
  autoExpandWhenActive: boolean
  contentBlockIndex?: number
  selectionContext?: SelectionBlockContextValue | null
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
        <div className="my-1.5 text-sm text-red-600 dark:text-red-400">
          <span className="font-medium">{content.message}</span>
          {content.details && (
            <span className="ml-1 text-red-500/70 dark:text-red-400/60">
              — {content.details}
            </span>
          )}
        </div>
      )
    case 'warning':
      return (
        <div className="my-1.5 text-sm text-amber-600 dark:text-amber-400">
          {content.message}
        </div>
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
        return <BackgroundProcessNotice content={content} />
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

function getBackgroundProcessStatusLabel(
  content: Extract<MessageContent, { type: 'shell_session' }>,
): string {
  switch (content.status) {
    case 'running':
      return 'Running'
    case 'exited':
      return content.exitCode == null ? 'Exited' : `Exited ${content.exitCode}`
    case 'killed':
      return 'Stopped'
    case 'error':
      return 'Error'
    case 'interrupted':
      return 'Interrupted'
  }
}

function BackgroundProcessNotice({
  content,
}: {
  content: Extract<MessageContent, { type: 'shell_session' }>
}) {
  const statusLabel = getBackgroundProcessStatusLabel(content)

  return (
    <div className="my-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2 text-[12px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/45 dark:text-zinc-300">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-medium text-zinc-800 dark:text-zinc-100">
          Background process
        </span>
        <span className="text-zinc-400 dark:text-zinc-500">·</span>
        <span>{statusLabel}</span>
        <span className="text-zinc-400 dark:text-zinc-500">·</span>
        <code className="min-w-0 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
          {content.command}
        </code>
      </div>
    </div>
  )
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
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!activity) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activity])

  const presentation = activity
    ? buildLiveActivityPresentation(activity, now)
    : null
  const label = presentation
    ? presentation.label.toLowerCase()
    : 'working'
  const detail = presentation?.detail ?? ''

  return (
    <div
      className={`relative inline-flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="inline-flex items-center gap-2 rounded-full border border-sky-200/80 bg-gradient-to-r from-sky-50 via-indigo-50 to-emerald-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-[0_12px_24px_-18px_rgba(14,165,233,0.85)] dark:border-sky-500/20 dark:from-sky-500/10 dark:via-indigo-500/10 dark:to-emerald-500/10 dark:text-zinc-100">
        <span className="relative h-3.5 w-3.5 shrink-0" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-[conic-gradient(from_210deg,_#38bdf8,_#818cf8,_#f472b6,_#f59e0b,_#22c55e,_#38bdf8)] motion-reduce:animate-none motion-safe:animate-spin" />
          <span className="absolute inset-[2px] rounded-full bg-white/95 dark:bg-zinc-950/90" />
          <span className="absolute inset-[2px] rounded-full border border-white/70 dark:border-white/10" />
          <span className="absolute inset-[5px] rounded-full bg-sky-100/90 shadow-[0_0_12px_rgba(56,189,248,0.7)] motion-reduce:animate-none motion-safe:animate-pulse dark:bg-sky-200/80" />
        </span>
        <span className="tracking-[0.02em] text-zinc-700 dark:text-zinc-100">
          {label}
        </span>
        {detail ? (
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{detail}</span>
        ) : null}
      </div>
      <span className="font-mono tabular-nums opacity-70">{elapsedClock}</span>

      {presentation && (
        <div
          className={`pointer-events-none absolute bottom-full left-0 z-[70] mb-2 w-[260px] rounded-lg border border-sky-200/80 bg-sky-50/95 p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 dark:border-sky-800/70 dark:bg-zinc-950/95 ${
            open ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
          }`}
          role="tooltip"
          aria-hidden={!open}
        >
          <p className="text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
            {presentation.note}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {presentation.metrics.map((metric) => (
              <div key={metric.label} className="rounded-md bg-sky-100/60 px-2 py-1.5 dark:bg-zinc-900/90">
                <div className="text-[9px] uppercase tracking-[0.16em] text-sky-700/60 dark:text-sky-300/60">
                  {metric.label}
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  {metric.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StreamingDots() {
  return (
    <span
      className="assistant-streaming-dots mt-2"
      aria-label="Working"
      role="status"
    >
      <span className="assistant-streaming-dot">.</span>
      <span className="assistant-streaming-dot">.</span>
      <span className="assistant-streaming-dot">.</span>
    </span>
  )
}

export function Message({
  sessionId = null,
  message,
  isStreaming,
  liveActivity,
  streamingStartedAt,
  showStreamingStatus = true,
  autoExpandActiveBlocks = true,
  showThinkingBlocks = true,
  showCopyAction = false,
  onCopyTurn,
  readAloudAction,
  queuedState,
  selectionMode,
  pinnedSentenceKeys,
  showSelectionAction = false,
  onToggleSelectionMode,
  onToggleSentence,
  isLatestAssistantTurn = false,
}: MessageProps) {
  const isUser = message.role === 'user'
  const [copiedTurn, setCopiedTurn] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const durationLabel = !isStreaming && !isUser
    ? buildTurnDurationLabel(message.content, message.durationMs)
    : null
  const shouldEnableSentenceSelection =
    Boolean(selectionMode)
    || (pinnedSentenceKeys?.size ?? 0) > 0

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
      selectionActive: Boolean(selectionMode),
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

  const activeIndex = findActiveBlockIndex(
    visibleContent,
    Boolean(isStreaming),
  )
  const selectionButtonVisible = showSelectionAction
  const selectionButtonDisabled = selectionButtonVisible
    && (Boolean(isStreaming) || !onToggleSelectionMode)
  const selectionButtonTitle = selectionButtonDisabled
    ? 'Wait for the response to finish before selecting sentences.'
    : selectionMode
      ? 'Exit selection'
      : 'Select sentences to quote in the next message'
  const copyButtonVisible = showCopyAction
  const copyButtonDisabled = copyButtonVisible
    && (Boolean(isStreaming) || !onCopyTurn)
  const copyButtonTitle = copyButtonDisabled
    ? 'Wait for the response to finish before copying this turn.'
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
            {visibleContent.map((content, i) => (
              <ContentBlock
                key={i}
                sessionId={sessionId}
                content={content}
                isActive={i === activeIndex}
                autoExpandWhenActive={autoExpandActiveBlocks}
                contentBlockIndex={i}
                selectionContext={selectionContext}
              />
            ))}
          </div>

          {isStreaming && showStreamingStatus && (
            <StreamingStatus
              elapsedClock={elapsedClock ?? '00:00'}
              activity={liveActivity}
            />
          )}

          {isStreaming && !showStreamingStatus && (
            <StreamingDots />
          )}

          <AssistantActionRow
            isLatestTurn={isLatestAssistantTurn}
            durationLabel={durationLabel}
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
