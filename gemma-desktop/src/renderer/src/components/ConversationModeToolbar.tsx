import type { ConversationKind, SessionMode } from '@/types'

export type ConversationRunMode = 'explore' | 'act' | 'plan'

interface ConversationModeToolbarProps {
  conversationKind: ConversationKind
  selectedMode: SessionMode
  planMode: boolean
  disabled?: boolean
  onSelectMode?: (mode: ConversationRunMode) => void
}

const NORMAL_MODE_TOOLTIP =
  'Switch to a normal or new conversation to use Explore, Act, or Plan.'

const MODE_OPTIONS: Array<{
  id: ConversationRunMode
  label: string
  title: string
  activeClassName: string
}> = [
  {
    id: 'explore',
    label: 'Explore',
    title: 'Switch to explore mode',
    activeClassName: 'bg-violet-600 text-white shadow-[0_10px_20px_-18px_rgba(124,58,237,0.9)]',
  },
  {
    id: 'act',
    label: 'Act',
    title: 'Switch to act mode',
    activeClassName: 'bg-sky-600 text-white shadow-[0_10px_20px_-18px_rgba(2,132,199,0.9)]',
  },
  {
    id: 'plan',
    label: 'Plan',
    title: 'Switch to plan mode',
    activeClassName: 'bg-emerald-600 text-white shadow-[0_10px_20px_-18px_rgba(5,150,105,0.9)]',
  },
]

function resolveActiveRunMode(
  selectedMode: SessionMode,
  planMode: boolean,
): ConversationRunMode {
  if (selectedMode === 'explore') {
    return 'explore'
  }

  return planMode ? 'plan' : 'act'
}

export function ConversationModeToolbar({
  conversationKind,
  selectedMode,
  planMode,
  disabled = false,
  onSelectMode,
}: ConversationModeToolbarProps) {
  const researchActive = conversationKind === 'research'
  const activeMode = resolveActiveRunMode(selectedMode, planMode)
  const modeDisabled = researchActive || disabled || !onSelectMode

  return (
    <div
      role="group"
      aria-label="Switch between Explore, Act, and Plan"
      className={`no-drag inline-flex items-center rounded-full border p-0.5 shadow-[0_10px_24px_-20px_rgba(24,24,27,0.8)] backdrop-blur ${
        activeMode === 'plan'
          ? 'border-emerald-300/90 bg-emerald-50/85 dark:border-emerald-800 dark:bg-emerald-950/25'
          : 'border-zinc-200/80 bg-white/90 dark:border-zinc-800 dark:bg-zinc-950/90'
      }`}
    >
      {MODE_OPTIONS.map((option) => {
        const selected = option.id === activeMode

        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelectMode?.(option.id)}
            disabled={modeDisabled}
            aria-pressed={selected}
            title={researchActive ? NORMAL_MODE_TOOLTIP : option.title}
            className={`rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              selected
                ? option.activeClassName
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
