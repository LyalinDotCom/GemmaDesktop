import { useEffect } from 'react'
import { TalkPanel } from '@/components/TalkPanel'
import type {
  ChatMessage,
  LiveActivitySnapshot,
  MessageContent,
  PendingCompaction,
} from '@/types'

interface TalkOverlayProps {
  open: boolean
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
  liveActivity: LiveActivitySnapshot | null
  loading: boolean
  error: string | null
  enterToSend: boolean
  onClose: () => void
  onRetry: () => Promise<void>
  onSend: (text: string) => Promise<void>
  onCancel: () => Promise<void>
  onCompact: () => Promise<void>
  onSaveDraft: (draftText: string) => Promise<void>
  onClearSession: () => Promise<void>
}

export function TalkOverlay({
  open,
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
  liveActivity,
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
}: TalkOverlayProps) {
  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-x-0 bottom-0 top-14 z-[75]">
      <div
        className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.14),transparent_24%),linear-gradient(to_bottom,rgba(255,255,255,0.06),rgba(24,24,27,0.18))] backdrop-blur-[4px] dark:bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_24%),linear-gradient(to_bottom,rgba(9,9,11,0.18),rgba(9,9,11,0.52))]"
        onPointerDown={onClose}
        aria-hidden="true"
      />
      <div className="relative flex h-full justify-center px-4 pb-6 pt-4 sm:px-6">
        <div className="no-drag flex h-[min(82vh,52rem)] w-full max-w-[48rem] flex-col">
          <TalkPanel
            variant="overlay"
            title={title}
            targetKind={targetKind}
            sessionId={sessionId}
            messages={messages}
            draftText={draftText}
            streamingContent={streamingContent}
            isGenerating={isGenerating}
            isCompacting={isCompacting}
            conversationRunDisabledReason={conversationRunDisabledReason}
            pendingCompaction={pendingCompaction}
            liveActivity={liveActivity}
            loading={loading}
            error={error}
            enterToSend={enterToSend}
            onClose={onClose}
            onRetry={onRetry}
            onSend={onSend}
            onCancel={onCancel}
            onCompact={onCompact}
            onSaveDraft={onSaveDraft}
            onClearSession={onClearSession}
          />
        </div>
      </div>
    </div>
  )
}
