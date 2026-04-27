import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { ChatCanvas } from '@/components/ChatCanvas'
import { RightDockHeader } from '@/components/RightDockHeader'
import { TalkInputBar } from '@/components/TalkInputBar'
import { ToolApprovalCard } from '@/components/ToolApprovalCard'
import type { ReadAloudButtonState } from '@/hooks/useReadAloudPlayer'
import type {
  ChatMessage,
  LiveActivitySnapshot,
  MessageContent,
  PendingToolApproval,
  PendingCompaction,
  SessionContext,
} from '@/types'

const TALK_DOCKED_SHOW_THINKING_STORAGE_KEY = 'gemma-desktop-talk-docked-show-thinking'

interface TalkPanelProps {
  variant: 'overlay' | 'docked' | 'tray' | 'dropdown'
  title: string
  targetKind: 'fallback' | 'assigned'
  sessionId: string | null
  messages: ChatMessage[]
  draftText: string
  streamingContent: MessageContent[] | null
  isGenerating: boolean
  isCompacting: boolean
  conversationRunDisabledReason?: string | null
  pendingCompaction: PendingCompaction | null
  pendingToolApproval?: PendingToolApproval | null
  liveActivity: LiveActivitySnapshot | null
  sessionContext?: Pick<SessionContext, 'tokensUsed' | 'contextLength'>
  loading: boolean
  error: string | null
  enterToSend: boolean
  onClose?: () => void
  onRetry: () => Promise<void>
  onSend: (text: string) => Promise<void>
  onCancel: () => Promise<void>
  onCompact: () => Promise<void>
  onSaveDraft: (draftText: string) => Promise<void>
  onClearSession: () => Promise<void>
  onResolveToolApproval?: (approvalId: string, approved: boolean) => Promise<void>
  getReadAloudButtonState?: (
    message: ChatMessage,
    options?: { isStreaming?: boolean },
  ) => ReadAloudButtonState
}

export function TalkPanel({
  variant,
  title,
  targetKind,
  sessionId,
  messages,
  draftText,
  streamingContent,
  isGenerating,
  isCompacting,
  conversationRunDisabledReason = null,
  pendingCompaction,
  pendingToolApproval = null,
  liveActivity,
  sessionContext,
  loading,
  error,
  enterToSend,
  onClose,
  onRetry,
  onSend,
  onCancel,
  onCompact,
  onSaveDraft,
  onClearSession,
  onResolveToolApproval,
  getReadAloudButtonState,
}: TalkPanelProps) {
  const isDocked = variant === 'docked'
  const isTray = variant === 'tray'
  const isDropdown = variant === 'dropdown'
  const [showThinking, setShowThinking] = useState<boolean>(() => {
    if (!isDocked) {
      return true
    }

    try {
      return window.localStorage.getItem(TALK_DOCKED_SHOW_THINKING_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!isDocked) {
      return
    }

    try {
      window.localStorage.setItem(
        TALK_DOCKED_SHOW_THINKING_STORAGE_KEY,
        String(showThinking),
      )
    } catch {
      // Ignore storage failures and keep the in-memory preference.
    }
  }, [isDocked, showThinking])
  const statusLabel = isCompacting
    ? 'Compacting'
    : isGenerating
      ? 'Answering'
      : pendingCompaction?.required
        ? 'Needs compaction'
        : liveActivity?.activeToolLabel
          ? liveActivity.activeToolLabel
          : 'Ready'

  const shellClass = isDocked || isTray || isDropdown
    ? 'min-h-0 flex-1'
    : 'h-full rounded-[1.85rem] border border-cyan-200/70 bg-white/96 shadow-[0_42px_120px_-54px_rgba(8,145,178,0.45)] ring-1 ring-cyan-200/45 dark:border-cyan-900/60 dark:bg-zinc-950/96 dark:shadow-[0_48px_128px_-58px_rgba(8,145,178,0.4)] dark:ring-cyan-900/40'
  const accentGlowClass = isDocked || isTray
    ? ''
    : isDropdown
      ? 'bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.1),transparent_38%)]'
    : 'bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.22),transparent_36%),radial-gradient(circle_at_top_right,rgba(250,204,21,0.14),transparent_30%)]'
  const laneBadgeClass = 'rounded-full border border-cyan-200/80 bg-cyan-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-700 dark:border-cyan-800/70 dark:bg-cyan-950/45 dark:text-cyan-200'
  const statusBadgeClass = 'rounded-full border border-amber-200/80 bg-amber-50/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200'
  const loadingPillClass = isDocked || isTray || isDropdown
    ? 'border-zinc-200/80 bg-white/92 text-zinc-700 dark:border-zinc-800/80 dark:bg-zinc-950/90 dark:text-zinc-200'
    : 'border-cyan-200/80 bg-white/90 text-cyan-700 dark:border-cyan-900/60 dark:bg-zinc-950/90 dark:text-cyan-200'
  const dockedDescription = targetKind === 'assigned'
    ? `Using ${title}`
    : 'Built-in assistant chat'
  const overlayDescription = targetKind === 'assigned'
    ? `Uses the conversation "${title}" everywhere the Assistant Chat surface appears.`
    : 'Built-in assistant chat that stays available while the main app keeps running.'

  return (
    <div className={`relative flex min-h-0 flex-col overflow-hidden ${shellClass}`}>
      {accentGlowClass ? (
        <div className={`pointer-events-none absolute inset-0 ${accentGlowClass}`} />
      ) : null}

      {isDocked ? (
        <RightDockHeader
          title="Assistant Chat"
          description={dockedDescription}
          onClose={onClose}
        />
      ) : isTray || isDropdown ? null : (
        <div className="relative px-4 py-3 border-b border-cyan-100/80 dark:border-cyan-950/50">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className={laneBadgeClass}>
                  Assistant Chat
                </div>
                <div className={statusBadgeClass}>
                  {statusLabel}
                </div>
              </div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                {title}
              </div>
              <div className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {overlayDescription}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  title="Close Assistant Chat"
                  aria-label="Close Assistant Chat"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm shadow-sm ${loadingPillClass}`}>
              <Loader2 size={14} className="animate-spin" />
              Loading Assistant Chat…
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-md rounded-3xl border border-red-200 bg-red-50/90 px-5 py-4 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
              <div className="font-medium">Assistant Chat could not load.</div>
              <div className="mt-1 text-red-700/80 dark:text-red-200/80">
                {error}
              </div>
              <button
                type="button"
                onClick={() => {
                  void onRetry()
                }}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-xs font-medium text-red-800 transition-colors hover:bg-red-100 dark:border-red-800 dark:text-red-100 dark:hover:bg-red-900/40"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.length > 0 || streamingContent ? (
              <ChatCanvas
                sessionId={sessionId}
                messages={messages}
                streamingContent={streamingContent}
                isGenerating={isGenerating}
                isCompacting={isCompacting}
                autoExpandActiveBlocks={false}
                showThinkingBlocks={showThinking}
                debugEnabled={false}
                debugLogs={[]}
                debugSession={null}
                sessionTitle={title}
                forceAutoScroll
                liveActivity={liveActivity}
                pendingCompaction={pendingCompaction}
                pendingToolApproval={pendingToolApproval}
                getReadAloudButtonState={getReadAloudButtonState}
              />
            ) : (
              <div className="flex-1" />
            )}

            {pendingToolApproval && onResolveToolApproval ? (
              <div className="px-4 pb-2">
                <ToolApprovalCard
                  approval={pendingToolApproval}
                  onResolve={(approved) =>
                    onResolveToolApproval(pendingToolApproval.id, approved)
                  }
                />
              </div>
            ) : null}

            {sessionId && (
              <TalkInputBar
                variant={isDocked ? 'docked' : isTray ? 'tray' : 'overlay'}
                sessionId={sessionId}
                initialDraftText={draftText}
                messages={messages}
                streamingContent={streamingContent}
                sessionTitle={title}
                isGenerating={isGenerating}
                isCompacting={isCompacting}
                conversationRunDisabledReason={conversationRunDisabledReason}
                sessionContext={sessionContext}
                enterToSend={enterToSend}
                onSend={onSend}
                onCancel={onCancel}
                onCompact={onCompact}
                onSaveDraft={onSaveDraft}
                onClearSession={onClearSession}
                showThinking={showThinking}
                onToggleShowThinking={
                  isDocked
                    ? () => setShowThinking((current) => !current)
                    : undefined
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
