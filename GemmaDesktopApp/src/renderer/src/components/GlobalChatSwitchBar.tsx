import { Pin } from 'lucide-react'
import { NebulaField } from '@/components/NebulaField'

interface GlobalChatSwitchBarProps {
  pinnedToDock: boolean
  busy: boolean
  onOpenHome: () => void
  onTogglePin: () => void
}

export function GlobalChatSwitchBar({
  pinnedToDock,
  busy,
  onOpenHome,
  onTogglePin,
}: GlobalChatSwitchBarProps) {
  const toggleLabel = 'Open Assistant Home'
  const basePinLabel = pinnedToDock
    ? 'Unpin Assistant Chat from the right dock'
    : 'Pin Assistant Chat to the right dock'

  return (
    <div className="no-drag pointer-events-none absolute inset-x-0 top-0 z-[95] flex justify-center px-4">
      <div
        className={`global-chat-switch-bar no-drag pointer-events-auto relative flex h-12 w-full max-w-3xl items-center overflow-hidden rounded-b-[28px] border border-t-0 border-white/10 bg-[#050817]/95 px-3 text-zinc-200 shadow-[0_24px_70px_-36px_rgba(0,0,0,0.85)] backdrop-blur-xl ${
          busy ? 'global-chat-switch-bar-busy' : ''
        }`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="global-chat-switch-bar-nebula assistant-home-nebula" aria-hidden="true">
          <NebulaField variant="vivid" busy={busy} />
        </div>
        <button
          type="button"
          onClick={onOpenHome}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="no-drag relative z-10 flex min-w-0 flex-1 self-stretch px-3 py-2 text-zinc-200"
        />

        <div className="relative z-10 ml-2 flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinnedToDock}
            aria-label={basePinLabel}
            title={basePinLabel}
            className={`no-drag cursor-pointer rounded-xl p-1.5 transition-colors ${
              pinnedToDock
                ? 'bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-300/30 hover:bg-cyan-400/25'
                : 'text-zinc-200 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Pin size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
