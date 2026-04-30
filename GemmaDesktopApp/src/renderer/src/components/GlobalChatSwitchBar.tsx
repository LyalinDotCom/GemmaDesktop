import { Brain, Pin } from 'lucide-react'

interface GlobalChatSwitchBarProps {
  assistantHomeVisible: boolean
  pinnedToDock: boolean
  busy: boolean
  coBrowseActive?: boolean
  onToggleHome: () => void
  onTogglePin: () => void
}

const COBROWSE_LOCK_REASON = 'Stop CoBrowse first'

export function GlobalChatSwitchBar({
  assistantHomeVisible,
  pinnedToDock,
  busy,
  coBrowseActive = false,
  onToggleHome,
  onTogglePin,
}: GlobalChatSwitchBarProps) {
  const baseToggleLabel = assistantHomeVisible
    ? 'Switch to Work mode'
    : 'Open Assistant Home'
  const basePinLabel = pinnedToDock
    ? 'Unpin Assistant Chat from the right dock'
    : 'Pin Assistant Chat to the right dock'
  const toggleLabel = coBrowseActive
    ? `${baseToggleLabel} (${COBROWSE_LOCK_REASON})`
    : baseToggleLabel
  const pinLabel = coBrowseActive
    ? `${basePinLabel} (${COBROWSE_LOCK_REASON})`
    : basePinLabel

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[76] flex justify-center px-4">
      <div className="no-drag pointer-events-auto flex h-12 w-full max-w-3xl items-center rounded-b-[28px] border border-t-0 border-white/10 bg-[#050817]/95 px-3 text-zinc-200 shadow-[0_24px_70px_-36px_rgba(0,0,0,0.85)] backdrop-blur-xl">
        <button
          type="button"
          onClick={onToggleHome}
          disabled={coBrowseActive}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-zinc-200 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-200"
        >
          <Brain size={19} className="shrink-0 text-zinc-100" />
        </button>

        <div className="ml-2 flex shrink-0 items-center gap-1">
          {busy ? (
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.8)]"
            />
          ) : null}
          <button
            type="button"
            onClick={onTogglePin}
            disabled={coBrowseActive}
            aria-pressed={pinnedToDock}
            aria-label={pinLabel}
            title={pinLabel}
            className={`rounded-2xl p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              pinnedToDock
                ? 'bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-300/30 hover:bg-cyan-400/25 disabled:hover:bg-cyan-400/15'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:hover:bg-transparent disabled:hover:text-zinc-400'
            }`}
          >
            <Pin size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
