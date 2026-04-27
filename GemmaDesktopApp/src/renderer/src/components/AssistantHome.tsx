import { useState, type ReactNode } from 'react'
import { AudioLines, BookOpenText, Briefcase, Globe2, Maximize2, Minimize2, Pin, VolumeX } from 'lucide-react'
import {
  describeAssistantNarrationMode,
  type AssistantNarrationMode,
} from '@/lib/assistantNarrationMode'
import { NebulaField } from '@/components/NebulaField'

interface AssistantHomeProps {
  conversationSlot: ReactNode
  conversationStatusSlot?: ReactNode
  supportSlot?: ReactNode
  composerSlot: ReactNode
  coBrowseSlot?: ReactNode
  readAloudSlot?: ReactNode
  hasConversation: boolean
  busy: boolean
  pinnedToDock: boolean
  assistantNarrationMode?: AssistantNarrationMode
  assistantNarrationAvailable?: boolean
  assistantNarrationDisabledReason?: string | null
  onWorkMode: () => void
  onCoBrowse: () => void
  onExitCoBrowse?: () => void
  onTogglePin: () => void
  onToggleAssistantNarration?: () => void
}

// Shared visual language for the welcome action row. One ghost style for
// idle, one cyan-accent style for "this mode is on" — keeps the row legible
// by spending the only color budget on whichever toggle is currently live.
const ROW_PILL_BASE =
  'inline-flex h-12 items-center justify-center rounded-full border shadow-[0_22px_48px_-32px_rgba(255,255,255,0.42)] backdrop-blur-xl transition-colors'
const ROW_PILL_OFF =
  'border-white/12 bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08] hover:text-white'
const ROW_PILL_ON =
  'border-cyan-300/45 bg-cyan-300/15 text-cyan-50 shadow-[0_28px_64px_-30px_rgba(34,211,238,0.55)] hover:bg-cyan-300/20'

function rowPillIconOnly(active: boolean): string {
  return `${ROW_PILL_BASE} w-12 ${active ? ROW_PILL_ON : ROW_PILL_OFF}`
}

function rowPillLabeled(active: boolean): string {
  return `${ROW_PILL_BASE} gap-2 px-5 text-sm font-medium ${active ? ROW_PILL_ON : ROW_PILL_OFF}`
}

function AssistantHomeNebula({ busy }: { busy: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`assistant-home-nebula ${busy ? 'assistant-home-nebula-busy' : ''}`}
    >
      <NebulaField variant="vivid" busy={busy} />
    </div>
  )
}

export function AssistantHome({
  conversationSlot,
  conversationStatusSlot,
  supportSlot,
  composerSlot,
  coBrowseSlot,
  readAloudSlot,
  hasConversation,
  busy,
  pinnedToDock,
  assistantNarrationMode = 'off',
  assistantNarrationAvailable = true,
  assistantNarrationDisabledReason = null,
  onWorkMode,
  onCoBrowse,
  onExitCoBrowse,
  onTogglePin,
  onToggleAssistantNarration,
}: AssistantHomeProps) {
  const [transcriptExpanded, setTranscriptExpanded] = useState(false)
  const transcriptToggleLabel = transcriptExpanded
    ? 'Shrink chat'
    : 'Expand chat'
  const assistantNarrationTitle = assistantNarrationDisabledReason
    ?? describeAssistantNarrationMode(assistantNarrationMode)
  const coBrowseVisible = Boolean(coBrowseSlot)
  const coBrowseLockReason = 'Stop CoBrowse first'
  const exitCoBrowseBusyReason =
    'Wait for the assistant to finish before stopping CoBrowse'
  const pinChatBaseLabel = pinnedToDock
    ? 'Unpin Assistant Chat from the right dock'
    : 'Pin Assistant Chat to the right dock'
  const pinChatLabel = coBrowseVisible
    ? `${pinChatBaseLabel} (${coBrowseLockReason})`
    : pinChatBaseLabel
  const workModeTitle = coBrowseVisible ? coBrowseLockReason : undefined
  const exitCoBrowseDisabled = coBrowseVisible && busy
  const coBrowseLabel = coBrowseVisible
    ? exitCoBrowseDisabled
      ? `Exit CoBrowse (${exitCoBrowseBusyReason})`
      : 'Exit CoBrowse'
    : 'Start CoBrowse'
  const handleCoBrowseClick = coBrowseVisible
    ? (onExitCoBrowse ?? onCoBrowse)
    : onCoBrowse
  const narrationActive = assistantNarrationMode !== 'off'

  return (
    <div className="absolute inset-0 z-[70] overflow-hidden bg-[#05030d] text-white">
      <AssistantHomeNebula busy={busy} />
      <div className="drag-region absolute inset-x-0 top-0 z-10 h-12" />

      <div className="relative z-20 flex h-full min-h-0 flex-col px-5 pb-8 pt-12">
        <main
          className={
            coBrowseVisible
              ? 'assistant-home-cobrowse-shell mx-auto grid h-full min-h-0 w-full max-w-[1500px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4'
              : 'mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col items-center justify-center'
          }
        >
          <div className="assistant-home-chat-pane flex h-full min-h-0 min-w-0 flex-col items-center justify-center">
            <div
              className={`assistant-home-stage flex max-h-full w-full min-h-0 flex-col items-center ${
                hasConversation ? 'assistant-home-stage-with-conversation' : 'assistant-home-stage-empty'
              } ${transcriptExpanded ? 'assistant-home-stage-expanded' : ''}`}
            >
              {hasConversation && (
                <div
                  className={`assistant-home-transcript-shell w-full max-w-4xl ${
                    transcriptExpanded ? 'assistant-home-transcript-shell-expanded' : ''
                  }`}
                >
                  <div className="assistant-home-transcript-toolbar no-drag mb-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setTranscriptExpanded((current) => !current)}
                      aria-pressed={transcriptExpanded}
                      aria-label={transcriptToggleLabel}
                      title={transcriptToggleLabel}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-zinc-300 shadow-[0_16px_40px_-28px_rgba(255,255,255,0.55)] backdrop-blur transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {transcriptExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                  </div>
                  <section
                    className={`assistant-home-transcript w-full dark ${
                      transcriptExpanded ? 'assistant-home-transcript-expanded' : ''
                    }`}
                  >
                    {conversationSlot}
                  </section>
                  {conversationStatusSlot && (
                    <div className="assistant-home-transcript-status no-drag">
                      {conversationStatusSlot}
                    </div>
                  )}
                </div>
              )}

              <section className="w-full max-w-3xl flex-none">
                {supportSlot}
                {composerSlot}
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  {onToggleAssistantNarration && (
                    <button
                      type="button"
                      onClick={onToggleAssistantNarration}
                      disabled={!assistantNarrationAvailable || Boolean(assistantNarrationDisabledReason)}
                      aria-label={assistantNarrationTitle}
                      aria-pressed={narrationActive}
                      title={assistantNarrationTitle}
                      className={`${rowPillIconOnly(narrationActive)} disabled:opacity-50`}
                    >
                      {assistantNarrationMode === 'summary'
                        ? <AudioLines size={18} />
                        : assistantNarrationMode === 'full'
                          ? <BookOpenText size={18} />
                          : <VolumeX size={18} />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onWorkMode}
                    disabled={coBrowseVisible}
                    title={workModeTitle}
                    className={`${rowPillLabeled(false)} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <Briefcase size={18} />
                    Work mode
                  </button>
                  <button
                    type="button"
                    onClick={handleCoBrowseClick}
                    disabled={exitCoBrowseDisabled}
                    aria-pressed={coBrowseVisible}
                    aria-label={coBrowseLabel}
                    title={coBrowseLabel}
                    className={`${rowPillLabeled(coBrowseVisible)} disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <Globe2 size={18} />
                    CoBrowse
                    {coBrowseVisible && (
                      <span
                        aria-hidden="true"
                        className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_10px_rgba(34,211,238,0.85)]"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onTogglePin}
                    disabled={coBrowseVisible}
                    aria-pressed={pinnedToDock}
                    aria-label={pinChatLabel}
                    title={pinChatLabel}
                    className={`${rowPillIconOnly(pinnedToDock)} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <Pin size={18} />
                  </button>
                </div>
                {readAloudSlot}
              </section>
            </div>
          </div>

          {coBrowseVisible && (
            <aside className="assistant-home-cobrowse-panel no-drag relative z-30 flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[26px] border border-white/12 bg-white text-zinc-950 shadow-[0_36px_120px_-58px_rgba(34,211,238,0.52)]">
              {coBrowseSlot}
            </aside>
          )}
        </main>
      </div>
    </div>
  )
}
