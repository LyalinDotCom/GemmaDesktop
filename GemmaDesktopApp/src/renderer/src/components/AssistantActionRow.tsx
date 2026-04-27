import { Check, Copy, Loader2, Square, TextSelect, Volume2 } from 'lucide-react'
import type { ReadAloudButtonState } from '@/hooks/useReadAloudPlayer'

/**
 * Shared action row rendered beneath a non-streaming assistant turn.
 * Shows the turn's elapsed duration on the left, and up to three optional
 * icon buttons on the right: select (sentence pinning), read aloud, and
 * copy.
 *
 * Callers pass only the actions they support. The row vanishes entirely
 * when there is no duration and no visible action. Main chat and the
 * assistant chat both use this component so the two surfaces stay in sync.
 */

export interface SelectionAction {
  /** Currently in selection mode? */
  active: boolean
  /** Action is present but temporarily unavailable (e.g. still streaming). */
  disabled: boolean
  /** Tooltip reflecting active / disabled state. */
  title: string
  onToggle: () => void
}

export interface CopyAction {
  disabled: boolean
  title: string
  copied: boolean
  onCopy: () => void | Promise<void>
}

export interface AssistantActionRowProps {
  durationLabel?: string | null
  selection?: SelectionAction
  readAloud?: ReadAloudButtonState
  copy?: CopyAction
  /**
   * When true, this row belongs to the most recent assistant turn and should
   * always show the duration label and action buttons. When false, the
   * duration is hidden and the buttons only appear when the user hovers the
   * surrounding message (via the parent's `group` class).
   */
  isLatestTurn?: boolean
}

function iconButtonClass({
  disabled,
  active,
}: {
  disabled?: boolean
  active?: boolean
}): string {
  if (disabled) {
    return 'assistant-action-button inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600'
  }

  if (active) {
    return 'assistant-action-button inline-flex h-4 w-4 items-center justify-center rounded border border-indigo-300 bg-indigo-50 text-indigo-700 transition-colors hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/60'
  }

  return 'assistant-action-button inline-flex h-4 w-4 items-center justify-center rounded border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200'
}

export function AssistantActionRow({
  durationLabel,
  selection,
  readAloud,
  copy,
  isLatestTurn = false,
}: AssistantActionRowProps) {
  const hasAnyAction =
    Boolean(selection) || Boolean(readAloud?.visible) || Boolean(copy)

  // Only the latest turn shows the duration label; older turns keep the
  // buttons only (revealed on hover below).
  const effectiveDurationLabel = isLatestTurn ? durationLabel : null

  if (!effectiveDurationLabel && !hasAnyAction) {
    return null
  }

  // For non-latest turns, hide the action cluster until the user hovers the
  // parent message (Message.tsx wraps each row in a `group` container).
  const actionVisibilityClass = isLatestTurn
    ? ''
    : 'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {effectiveDurationLabel ? (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {effectiveDurationLabel}
        </span>
      ) : null}

      {hasAnyAction ? (
        <div className={`ml-auto flex items-center gap-1 ${actionVisibilityClass}`}>
          {selection ? (
            <button
              type="button"
              onClick={() => {
                if (!selection.disabled) selection.onToggle()
              }}
              disabled={selection.disabled}
              data-active={selection.active ? 'true' : undefined}
              className={iconButtonClass({
                disabled: selection.disabled,
                active: selection.active,
              })}
              title={selection.title}
              aria-label={selection.title}
            >
              <TextSelect size={10} />
            </button>
          ) : null}

          {readAloud?.visible ? (
            <button
              type="button"
              onClick={() => {
                readAloud.onClick?.()
              }}
              disabled={readAloud.disabled}
              data-active={readAloud.active ? 'true' : undefined}
              className={iconButtonClass({
                disabled: readAloud.disabled,
                active: readAloud.active,
              })}
              title={readAloud.title}
              aria-label={readAloud.ariaLabel}
            >
              {readAloud.icon === 'loader' ? (
                <Loader2 size={10} className="animate-spin" />
              ) : readAloud.icon === 'stop' ? (
                <Square size={10} />
              ) : (
                <Volume2 size={10} />
              )}
            </button>
          ) : null}

          {copy ? (
            <button
              type="button"
              onClick={() => {
                if (!copy.disabled) void copy.onCopy()
              }}
              disabled={copy.disabled}
              className={iconButtonClass({ disabled: copy.disabled })}
              title={copy.title}
              aria-label={copy.title}
            >
              {copy.copied ? <Check size={10} /> : <Copy size={10} />}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
