import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface RightDockHeaderProps {
  /** Short title shown bold at the top-left. */
  title: string
  /** Optional small description shown under the title. */
  description?: string
  /** Inline meta — e.g. a branch name, a row count. Appears to the right of the title. */
  meta?: ReactNode
  /** Panel-specific action buttons (refresh, open in finder). Appears before the close button. */
  actions?: ReactNode
  /** Close handler. When provided, an X button is rendered at the far right. */
  onClose?: () => void
}

export function RightDockHeader({
  title,
  description,
  meta,
  actions,
  onClose,
}: RightDockHeaderProps) {
  return (
    <div className="no-drag relative z-[60] flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            {title}
          </span>
          {meta ? (
            <span className="min-w-0 truncate text-[11px] font-normal text-slate-500 dark:text-slate-400">
              {meta}
            </span>
          ) : null}
        </div>
        {description ? (
          <div className="mt-0.5 truncate text-[11px] leading-tight text-slate-500 dark:text-slate-400">
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {actions}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
            title="Close panel"
            aria-label="Close panel"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
