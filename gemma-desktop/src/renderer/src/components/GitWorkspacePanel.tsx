import { Loader2 } from 'lucide-react'
import { RightDockShell } from '@/components/RightDockShell'
import { useWorkspaceInspection } from '@/hooks/useWorkspaceInspection'
import type { WorkspaceGitStatus } from '@shared/workspace'

const STATUS_GLYPHS: Record<WorkspaceGitStatus, { letter: string; label: string; tone: string }> = {
  modified: { letter: 'M', label: 'modified', tone: 'text-amber-600 dark:text-amber-400' },
  added: { letter: 'A', label: 'added', tone: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { letter: 'D', label: 'deleted', tone: 'text-red-600 dark:text-red-400' },
  renamed: { letter: 'R', label: 'renamed', tone: 'text-violet-600 dark:text-violet-400' },
  copied: { letter: 'C', label: 'copied', tone: 'text-violet-600 dark:text-violet-400' },
  type_changed: { letter: 'T', label: 'type changed', tone: 'text-amber-600 dark:text-amber-400' },
  updated_unmerged: { letter: 'U', label: 'unmerged', tone: 'text-rose-600 dark:text-rose-400' },
  untracked: { letter: 'U', label: 'untracked', tone: 'text-sky-600 dark:text-sky-400' },
  ignored: { letter: '•', label: 'ignored', tone: 'text-slate-400 dark:text-slate-600' },
}

function filenameFromPath(value: string): string {
  const segments = value.split('/')
  return segments[segments.length - 1] ?? value
}

function parentPathFromPath(value: string): string {
  const lastSlash = value.lastIndexOf('/')
  return lastSlash === -1 ? '' : value.slice(0, lastSlash)
}

export function GitWorkspacePanel({
  workingDirectory,
  onClose,
}: {
  workingDirectory: string
  onClose?: () => void
}) {
  const {
    inspection,
    loading,
    error,
    refresh,
  } = useWorkspaceInspection(workingDirectory, true)

  const git = inspection?.git

  return (
    <RightDockShell
      title="Git"
      rootPath={inspection?.rootPath ?? workingDirectory}
      refreshing={loading}
      onRefresh={refresh}
      onClose={onClose}
      meta={git?.available ? (
        <span className="truncate text-[11px] font-normal text-slate-500 dark:text-slate-400">
          {git.branch ?? 'repo'}
          {git.entries.length > 0 ? ` · ${git.entries.length}` : ''}
        </span>
      ) : null}
    >
      {error ? (
        <div className="mx-2 rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      ) : loading && !inspection ? (
        <div className="flex min-h-[180px] items-center justify-center text-xs text-slate-500 dark:text-slate-400">
          <Loader2 size={13} className="mr-2 animate-spin" />
          Inspecting repository…
        </div>
      ) : !inspection?.exists ? (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Choose or open a session with a valid working directory.
        </div>
      ) : !git?.available ? (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          {git?.error ?? 'Not a git repository.'}
        </div>
      ) : git.entries.length === 0 ? (
        <div className="px-3 py-4 text-xs text-emerald-700 dark:text-emerald-300">
          Working tree clean on <span className="font-mono">{git.branch ?? 'current branch'}</span>.
        </div>
      ) : (
        <ul className="select-none">
          {git.entries.map((entry) => {
            const glyph = STATUS_GLYPHS[entry.status] ?? STATUS_GLYPHS.modified
            const parent = parentPathFromPath(entry.path)
            return (
              <li key={`${entry.statusCode}:${entry.path}`}>
                <button
                  type="button"
                  onClick={() => {
                    void window.gemmaDesktopBridge.folders.openPath(`${inspection.rootPath}/${entry.path}`)
                  }}
                  title={`${glyph.label} · ${entry.path}`}
                  className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] leading-none text-slate-800 hover:bg-slate-200/50 dark:text-slate-200 dark:hover:bg-slate-800/50"
                >
                  <span
                    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center font-mono text-[11px] font-semibold ${glyph.tone}`}
                    aria-label={glyph.label}
                  >
                    {glyph.letter}
                  </span>
                  <span className="truncate">{filenameFromPath(entry.path)}</span>
                  {parent ? (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400 dark:text-slate-500">
                      {parent}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </RightDockShell>
  )
}
