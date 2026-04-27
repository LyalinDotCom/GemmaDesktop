import {
  ChevronDown,
  Maximize2,
  Minimize2,
  RotateCcw,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { AppTerminalState } from '@shared/appTerminal'
import { useXtermTerminal } from '@/hooks/useXtermTerminal'

interface TerminalDrawerProps {
  state: AppTerminalState
  expanded: boolean
  onStart: () => void | Promise<void>
  onCollapse: () => void
  onToggleExpanded: () => void
  onTerminate: () => void | Promise<void>
}

export function TerminalDrawer({
  state,
  expanded,
  onStart,
  onCollapse,
  onToggleExpanded,
  onTerminate,
}: TerminalDrawerProps) {
  const terminalEnabled = state.terminalId !== null && state.status !== 'idle'
  const { containerRef, focus } = useXtermTerminal({
    enabled: terminalEnabled,
    terminalId: state.terminalId,
    transcript: state.transcript,
    running: state.status === 'running',
    onData: (data) => {
      void window.gemmaDesktopBridge.terminalDrawer.writeInput(data).catch((error) => {
        console.error('Failed to write terminal drawer input:', error)
      })
    },
    onResize: (cols, rows) => {
      void window.gemmaDesktopBridge.terminalDrawer.resize(cols, rows).catch((error) => {
        console.error('Failed to resize terminal drawer:', error)
      })
    },
  })

  const heightClass = expanded ? 'h-[300px]' : 'h-[176px]'
  const canRestart = state.status !== 'running'
  const showEndedHint = state.status !== 'idle' && state.status !== 'running'

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white/95 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200/80 px-2.5 py-1.5 dark:border-zinc-800/80">
        <div className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
          {state.workingDirectory || ''}
        </div>
        <div className="flex items-center gap-0.5">
          {canRestart && (
            <button
              type="button"
              onClick={() => {
                void onStart()
              }}
              className="rounded-sm p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              title={state.status === 'idle' ? 'Start terminal' : 'Restart terminal'}
              aria-label={state.status === 'idle' ? 'Start terminal' : 'Restart terminal'}
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleExpanded}
            className="rounded-sm p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            title={expanded ? 'Compact' : 'Expand'}
            aria-label={expanded ? 'Compact' : 'Expand'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={onCollapse}
            className="rounded-sm p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            title="Hide terminal"
            aria-label="Hide terminal"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              void onTerminate()
            }}
            disabled={state.status !== 'running'}
            className="rounded-sm p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            title="Terminate shell"
            aria-label="Terminate shell"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {state.status === 'idle' ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-300">
            <SquareTerminal size={18} />
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              No shell running yet
            </div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Start an app-wide terminal below the composer. It launches in the active project when available and stays put until you restart it.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void onStart()
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/45"
          >
            <SquareTerminal size={14} />
            Start terminal
          </button>
        </div>
      ) : (
        <>
          <div className="bg-[#101218] px-2 py-2">
            <div
              ref={containerRef}
              className={`${heightClass} w-full overflow-hidden rounded-b-lg`}
              onClick={focus}
            />
          </div>
          {showEndedHint && (
            <div className="border-t border-zinc-200/80 px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
              This shell is no longer running. Restart to open a fresh session.
            </div>
          )}
        </>
      )}
    </div>
  )
}
