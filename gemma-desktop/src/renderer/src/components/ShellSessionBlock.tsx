import { useMemo } from 'react'
import { X } from 'lucide-react'
import type { ShellSessionContentBlock } from '@/types'
import { useXtermTerminal } from '@/hooks/useXtermTerminal'
import { summarizeShellTranscript } from '@shared/shellSession'

interface ShellSessionBlockProps {
  sessionId?: string | null
  content: ShellSessionContentBlock
}

function getStatusLabel(content: ShellSessionContentBlock): string {
  switch (content.status) {
    case 'running':
      return 'Running'
    case 'exited':
      return content.exitCode == null ? 'Exited' : `Exited ${content.exitCode}`
    case 'killed':
      return 'Killed'
    case 'error':
      return 'Error'
    case 'interrupted':
      return 'Interrupted'
  }
}

function getStatusClassName(status: ShellSessionContentBlock['status']): string {
  switch (status) {
    case 'running':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300'
    case 'exited':
      return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/40 dark:text-sky-300'
    case 'killed':
    case 'interrupted':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300'
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300'
  }
}

export function ShellSessionBlock({
  sessionId = null,
  content,
}: ShellSessionBlockProps) {
  const transcriptSummary = useMemo(
    () => summarizeShellTranscript(content.transcript),
    [content.transcript],
  )
  const { containerRef, focus } = useXtermTerminal({
    enabled: !content.collapsed,
    terminalId: content.terminalId,
    transcript: content.transcript,
    running: content.status === 'running',
    onData: (data) => {
      if (!sessionId) {
        return
      }

      void window.gemmaDesktopBridge.sessions.writeShellInput(
        sessionId,
        content.terminalId,
        data,
      ).catch((error) => {
        console.error('Failed to write shell input:', error)
      })
    },
    onResize: (cols, rows) => {
      if (!sessionId) {
        return
      }

      void window.gemmaDesktopBridge.sessions.resizeShell(
        sessionId,
        content.terminalId,
        cols,
        rows,
      ).catch((error) => {
        console.error('Failed to resize shell terminal:', error)
      })
    },
  })

  const handleClose = () => {
    if (!sessionId) {
      return
    }

    void window.gemmaDesktopBridge.sessions.closeShell(
      sessionId,
      content.terminalId,
    ).catch((error) => {
      console.error('Failed to close shell terminal:', error)
    })
  }

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70">
      <div className="flex items-start justify-between gap-3 border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-800/80">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] text-zinc-900 dark:text-zinc-100">
            !{content.command}
          </div>
          <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {content.workingDirectory}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${getStatusClassName(content.status)}`}>
            {getStatusLabel(content)}
          </div>
          {!content.collapsed && sessionId && (
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              aria-label="Close shell"
              title="Close shell"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {content.collapsed ? (
        <div className="px-3 py-3">
          <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
            Shell summary
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-50 px-3 py-2 font-mono text-[12px] text-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-200">
            {transcriptSummary || 'No output recorded.'}
          </pre>
        </div>
      ) : (
        <div className="bg-[#101218] px-3 py-3">
          <div
            ref={containerRef}
            className="min-h-[220px] w-full overflow-hidden rounded-xl"
            onClick={focus}
          />
        </div>
      )}
    </div>
  )
}
