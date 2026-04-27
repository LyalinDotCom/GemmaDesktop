import { Brain, Loader2 } from 'lucide-react'

export interface HelperActivityBlockProps {
  status: 'pending' | 'running' | 'success' | 'error'
  summary?: string
  restartInstruction?: string
}

export function HelperActivityBlock({
  status,
  summary,
  restartInstruction,
}: HelperActivityBlockProps) {
  const isRunning = status === 'running' || status === 'pending'

  if (isRunning) {
    return (
      <div
        className="my-1 flex items-center gap-1.5 px-1 text-[11.5px] text-zinc-400 dark:text-zinc-500"
        data-helper-state="running"
        aria-live="polite"
      >
        <Loader2 size={12} className="flex-shrink-0 animate-spin" aria-hidden="true" />
        <span className="italic">Helper checking…</span>
      </div>
    )
  }

  if (restartInstruction) {
    return (
      <div
        className="my-1 rounded-lg bg-amber-50/60 px-2 py-1.5 text-[11.5px] dark:bg-amber-950/25"
        data-helper-state="restart"
      >
        <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <Brain size={12} className="flex-shrink-0" aria-hidden="true" />
          <span className="font-medium">Looks like we&apos;re not done yet:</span>
        </div>
        <div className="mt-0.5 pl-[18px] italic text-zinc-600 dark:text-zinc-400">
          {restartInstruction}
        </div>
      </div>
    )
  }

  return (
    <div
      className="my-1 flex items-center gap-1.5 px-1 text-[11.5px] text-zinc-400 dark:text-zinc-500"
      data-helper-state="done"
    >
      <Brain size={12} className="flex-shrink-0" aria-hidden="true" />
      <span>{summary?.trim() || 'Checked final answer'}</span>
    </div>
  )
}
