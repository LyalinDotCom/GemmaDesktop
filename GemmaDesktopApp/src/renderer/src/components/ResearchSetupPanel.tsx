import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Search } from 'lucide-react'
import { RightDockShell } from '@/components/RightDockShell'

interface ResearchSetupPanelProps {
  defaultTitle: string
  defaultPrompt?: string
  workingDirectory: string
  disabledReason?: string | null
  onClose?: () => void
  onSubmit: (input: { title: string; prompt: string }) => Promise<void> | void
  onPickWorkingDirectory?: () => Promise<void> | void
}

export function ResearchSetupPanel({
  defaultTitle,
  defaultPrompt = '',
  workingDirectory,
  disabledReason = null,
  onClose,
  onSubmit,
  onPickWorkingDirectory,
}: ResearchSetupPanelProps) {
  const [title, setTitle] = useState(defaultTitle)
  const [prompt, setPrompt] = useState(defaultPrompt)
  const [submitting, setSubmitting] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setTitle(defaultTitle)
    setPrompt(defaultPrompt)
    setSubmitting(false)
  }, [defaultPrompt, defaultTitle, workingDirectory])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const textarea = promptRef.current
      if (!textarea) {
        return
      }

      textarea.focus()
      const caret = textarea.value.length
      textarea.setSelectionRange(caret, caret)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [defaultPrompt, defaultTitle, workingDirectory])

  const workspaceReady = workingDirectory.trim().length > 0
  const blocked = Boolean(disabledReason)

  return (
    <RightDockShell
      title="Research"
      description="Create a research conversation that runs in its own lane."
      onClose={onClose}
      rootPath={workspaceReady ? workingDirectory : null}
    >
      <form
        className="space-y-4 px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (submitting || !workspaceReady || blocked) {
            return
          }

          setSubmitting(true)
          void Promise.resolve(onSubmit({
            title: title.trim() || defaultTitle,
            prompt: prompt.trim(),
          })).finally(() => {
            setSubmitting(false)
          })
        }}
      >
        <label className="block space-y-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
            Research Prompt
          </span>
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={7}
            placeholder="What should this research conversation investigate?"
            className="min-h-[168px] w-full resize-y rounded-2xl border border-rose-200 bg-rose-50/40 px-4 py-3 text-sm text-slate-900 outline-none transition-colors focus:border-rose-400 focus:ring-1 focus:ring-rose-400/50 dark:border-rose-900/60 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-rose-600 dark:focus:ring-rose-600/40"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
            Conversation Name
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={defaultTitle}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition-colors focus:border-rose-400 focus:ring-1 focus:ring-rose-400/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-rose-600 dark:focus:ring-rose-600/40"
          />
        </label>

        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/80">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                <FolderOpen size={13} />
                Workspace
              </div>
              <div
                className={`mt-1 font-mono text-xs ${
                  workspaceReady
                    ? 'truncate text-slate-700 dark:text-slate-300'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
                title={workingDirectory || 'Choose a folder to start research.'}
              >
                {workspaceReady
                  ? workingDirectory
                  : 'Choose a folder to start research.'}
              </div>
            </div>
            {onPickWorkingDirectory ? (
              <button
                type="button"
                onClick={() => {
                  void onPickWorkingDirectory()
                }}
                disabled={submitting}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800"
              >
                Choose Folder
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          {disabledReason ? (
            <p className="mr-auto text-xs text-amber-700 dark:text-amber-300">
              {disabledReason}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting || !workspaceReady || blocked}
            title={disabledReason ?? undefined}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Search size={14} />
            {submitting ? 'Creating...' : 'Create Research'}
          </button>
        </div>
      </form>
    </RightDockShell>
  )
}
