import { AlertTriangle } from 'lucide-react'

interface StartupRiskDialogProps {
  onAgree: () => void
}

export function StartupRiskDialog({ onAgree }: StartupRiskDialogProps) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-risk-dialog-title"
        aria-describedby="startup-risk-dialog-description"
        className="no-drag w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <AlertTriangle size={14} className="text-amber-500" />
          <h2
            id="startup-risk-dialog-title"
            className="text-sm font-semibold text-zinc-800 dark:text-zinc-200"
          >
            Before you use Gemma Desktop
          </h2>
        </div>

        <div
          id="startup-risk-dialog-description"
          className="space-y-3 px-5 py-4 text-sm text-zinc-600 dark:text-zinc-300"
        >
          <p>
            Gemma Desktop is experimental software. If you want polished and safe, use
            Claude, ChatGPT, or Gemini instead.
          </p>
          <p>
            Gemma Desktop is a fan project and is not affiliated with, endorsed by, or
            sponsored by Google.
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-zinc-500 dark:text-zinc-400">
            <li>Tools run without confirmation and can change your files.</li>
            <li>No protection against prompt injection from files or the web.</li>
            <li>Relies on community runtimes that may break unexpectedly.</li>
          </ul>
          <p className="text-zinc-700 dark:text-zinc-200">
            Use at your own risk.
          </p>
        </div>

        <div className="flex justify-end border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button
            type="button"
            autoFocus
            onClick={onAgree}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
          >
            I Agree
          </button>
        </div>
      </div>
    </div>
  )
}
