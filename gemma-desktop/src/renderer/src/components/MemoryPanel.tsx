import { useCallback, useEffect, useState } from 'react'
import { RightDockShell } from '@/components/RightDockShell'

interface MemoryPanelProps {
  onClose?: () => void
}

interface SaveStatus {
  tone: 'success' | 'error'
  text: string
}

export function MemoryPanel({ onClose }: MemoryPanelProps) {
  const [text, setText] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null)
  const [saving, setSaving] = useState(false)

  const loadMemory = useCallback(async () => {
    setLoadError(null)
    try {
      const content = await window.gemmaDesktopBridge.memory.read()
      const next = typeof content === 'string' ? content : ''
      setText(next)
      setOriginalText(next)
      setLoaded(true)
    } catch (error) {
      console.error('Failed to load user memory:', error)
      setLoadError('Could not load memory file.')
    }
  }, [])

  useEffect(() => {
    void loadMemory()
  }, [loadMemory])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveStatus(null)
    try {
      const saved = await window.gemmaDesktopBridge.memory.write(text)
      const normalized = typeof saved === 'string' ? saved : text
      setText(normalized)
      setOriginalText(normalized)
      setSaveStatus({ tone: 'success', text: 'Memory saved.' })
    } catch (error) {
      console.error('Failed to save user memory:', error)
      setSaveStatus({
        tone: 'error',
        text:
          error instanceof Error && error.message
            ? `Could not save memory: ${error.message}`
            : 'Could not save memory.',
      })
    } finally {
      setSaving(false)
    }
  }, [text])

  const handleRevert = useCallback(() => {
    setText(originalText)
    setSaveStatus(null)
  }, [originalText])

  const dirty = loaded && text !== originalText
  const charCount = text.length
  const lineCount = text.length === 0 ? 0 : text.split('\n').length

  return (
    <RightDockShell
      title="Memory"
      description="Durable facts injected into every chat, research, and Assistant Chat session."
      meta={loaded ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} · ${charCount} chars` : null}
      onClose={onClose}
      scrollBody={false}
      bodyClassName="px-3"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 pt-1">
        <p className="text-[11px] leading-5 text-slate-500 dark:text-slate-400">
          Tip: in the main chat input, start a message with <span className="font-mono">#</span> to distill and append a new note without sending it as a chat turn.
        </p>

        {loadError ? (
          <div className="rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            {loadError}
          </div>
        ) : null}

        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            if (saveStatus) {
              setSaveStatus(null)
            }
          }}
          placeholder={loaded ? 'Empty. Add durable facts here, one per line.' : 'Loading…'}
          spellCheck={false}
          disabled={!loaded && loadError === null}
          className="scrollbar-thin block min-h-0 flex-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
        />

        <div className="flex flex-wrap items-center gap-2 pb-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500 bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300 disabled:text-slate-500 dark:disabled:border-slate-700 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleRevert}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:disabled:text-slate-600"
          >
            Revert
          </button>
          {saveStatus ? (
            <span
              className={`text-[11px] ${
                saveStatus.tone === 'success'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {saveStatus.text}
            </span>
          ) : null}
        </div>
      </div>
    </RightDockShell>
  )
}
