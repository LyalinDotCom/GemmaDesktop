import { Loader2, SquareTerminal, X } from 'lucide-react'
import type { ShellSessionContentBlock } from '@/types'
import { summarizeShellTranscript } from '@shared/shellSession'

interface ConversationProcessStripProps {
  sessionId: string
  processes: ShellSessionContentBlock[]
  onCloseProcess: (sessionId: string, terminalId: string) => void
}

export function ConversationProcessStrip({
  sessionId,
  processes,
  onCloseProcess,
}: ConversationProcessStripProps) {
  if (processes.length === 0) {
    return null
  }

  return (
    <div className="border-b border-emerald-200/70 bg-emerald-50/45 px-6 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/10">
      <div className="mx-auto w-full max-w-chat">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-200">
          <Loader2 size={11} className="animate-spin" />
          Background processes running
        </div>
        <div className="space-y-2">
          {processes.map((process) => {
            const previewText = summarizeShellTranscript(process.transcript, 2)

            return (
              <div
                key={process.terminalId}
                className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-white/95 px-3 py-2 shadow-sm dark:border-emerald-900/70 dark:bg-zinc-950/80"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <SquareTerminal size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100">
                    <span className="truncate font-mono">{process.command}</span>
                    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300">
                      <Loader2 size={11} className="animate-spin" />
                      Running
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {process.workingDirectory}
                  </div>
                  {previewText && (
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-300">
                      {previewText}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onCloseProcess(sessionId, process.terminalId)}
                  className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-emerald-100 hover:text-emerald-800 dark:hover:bg-emerald-900/50 dark:hover:text-emerald-100"
                  aria-label={`Terminate process ${process.command}`}
                  title="Terminate process"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
