import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Check, ChevronRight, ClipboardCopy } from 'lucide-react'
import { RightDockShell } from '@/components/RightDockShell'
import { copyText } from '@/lib/clipboard'
import type { DebugSessionSnapshot } from '@/types'

interface DebugPanelProps {
  sessionId: string | null
  sessionTitle?: string | null
  onClose?: () => void
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatModeText(mode: DebugSessionSnapshot['mode']): string {
  if (typeof mode === 'string') {
    return mode
  }
  return formatJson(mode)
}

function sessionInfoRows(snapshot: DebugSessionSnapshot): Array<[string, string]> {
  return [
    ['Session id', snapshot.sessionId],
    ['Model', snapshot.modelId],
    ['Runtime', snapshot.runtimeId],
    ['Working dir', snapshot.workingDirectory],
    ['History', `${snapshot.historyMessageCount} messages`],
    ['Started', snapshot.started ? 'yes' : 'no'],
    ['Saved at', snapshot.savedAt],
    ['Max steps', String(snapshot.maxSteps)],
  ]
}

function formatSessionAsText(snapshot: DebugSessionSnapshot): string {
  const rows = sessionInfoRows(snapshot)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `${rows}\n\nMode:\n${formatModeText(snapshot.mode)}`
}

function formatToolsAsText(snapshot: DebugSessionSnapshot): string {
  if (snapshot.tools.length === 0) {
    return '(no tools loaded)'
  }
  return snapshot.tools
    .map((tool) => `${tool.name}${tool.description ? `\n  ${tool.description}` : ''}`)
    .join('\n\n')
}

function formatPromptSourcesAsText(snapshot: DebugSessionSnapshot): string {
  return snapshot.systemPromptSections
    .map((section) => {
      const id = section.id ? `${section.source}:${section.id}` : section.source
      return `${id} — ${section.text.length.toLocaleString()} chars`
    })
    .join('\n')
}

function formatAllAsText(
  snapshot: DebugSessionSnapshot,
  sessionTitle?: string | null,
): string {
  const lines: string[] = []
  lines.push(`# Debug snapshot${sessionTitle ? ` — ${sessionTitle}` : ''}`)
  lines.push('')
  lines.push('## Session')
  for (const [k, v] of sessionInfoRows(snapshot)) {
    lines.push(`${k}: ${v}`)
  }
  lines.push('')
  lines.push('### Mode')
  lines.push(formatModeText(snapshot.mode))
  lines.push('')
  lines.push(
    `## System prompt (${snapshot.systemPrompt.length.toLocaleString()} chars · ${snapshot.systemPromptSections.length} sources)`,
  )
  lines.push('')
  lines.push(snapshot.systemPrompt || '(empty)')
  lines.push('')
  lines.push('### Sources')
  lines.push(formatPromptSourcesAsText(snapshot))
  lines.push('')
  lines.push(`## Tools (${snapshot.tools.length})`)
  lines.push('')
  lines.push(formatToolsAsText(snapshot))
  return lines.join('\n')
}

interface SectionProps {
  title: string
  meta?: string
  defaultOpen?: boolean
  getCopyText?: () => string
  copyTitle?: string
  children: ReactNode
}

function Section({
  title,
  meta,
  defaultOpen = false,
  getCopyText,
  copyTitle = 'Copy this section',
  children,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!getCopyText) {
        return
      }
      try {
        await copyText(getCopyText())
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      } catch (err) {
        console.error('Copy failed:', err)
      }
    },
    [getCopyText],
  )

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center bg-slate-50/60 dark:bg-slate-900/40">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-100/70 dark:hover:bg-slate-800/60"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${open ? 'rotate-90' : ''}`}
          />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            {title}
          </span>
          {meta ? (
            <span className="truncate text-[11px] text-slate-500 dark:text-slate-500">
              {meta}
            </span>
          ) : null}
        </button>
        {getCopyText ? (
          <button
            type="button"
            onClick={handleCopy}
            title={copyTitle}
            className="mr-2 inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {copied ? <Check size={10} /> : <ClipboardCopy size={10} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-800">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function DebugPanel({ sessionId, sessionTitle, onClose }: DebugPanelProps) {
  const [snapshot, setSnapshot] = useState<DebugSessionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)

  const load = useCallback(async () => {
    if (!sessionId) {
      setSnapshot(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.gemmaDesktopBridge.debug.getSessionConfig(sessionId)
      setSnapshot(result ?? null)
      setRefreshedAt(Date.now())
    } catch (err) {
      console.error('Failed to load debug snapshot:', err)
      setError(err instanceof Error ? err.message : 'Failed to load debug snapshot.')
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const handleCopyAll = useCallback(async () => {
    if (!snapshot) {
      return
    }
    try {
      await copyText(formatAllAsText(snapshot, sessionTitle))
      setCopiedAll(true)
      window.setTimeout(() => setCopiedAll(false), 1200)
    } catch (err) {
      console.error('Failed to copy snapshot:', err)
    }
  }, [snapshot, sessionTitle])

  const refreshedLabel = refreshedAt
    ? new Date(refreshedAt).toLocaleTimeString()
    : null

  return (
    <RightDockShell
      title="Debug"
      description={
        sessionTitle
          ? `Live system prompt and tool surface · ${sessionTitle}`
          : 'Live system prompt and tool surface for the active session.'
      }
      meta={
        loading
          ? 'Loading…'
          : refreshedLabel
            ? `Refreshed ${refreshedLabel}`
            : null
      }
      onClose={onClose}
      onRefresh={() => void load()}
      refreshing={loading}
      scrollBody
      bodyClassName="px-3"
    >
      <div className="flex flex-col gap-2 pb-3 pt-1">
        {!sessionId ? (
          <div className="rounded border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300">
            No active session. Open or start a session to inspect its system prompt.
          </div>
        ) : null}

        {error ? (
          <div className="rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {snapshot ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Click a section to expand. Each section can be copied on its own.
              </p>
              <button
                type="button"
                onClick={() => void handleCopyAll()}
                title="Copy a Markdown summary of every section"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {copiedAll ? <Check size={11} /> : <ClipboardCopy size={11} />}
                {copiedAll ? 'Copied' : 'Copy all'}
              </button>
            </div>

            <Section
              title="Session"
              meta={`${snapshot.modelId} · ${snapshot.runtimeId}`}
              getCopyText={() => formatSessionAsText(snapshot)}
            >
              <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                {sessionInfoRows(snapshot).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-slate-500 dark:text-slate-500">{key}</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Mode
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-slate-700 dark:text-slate-300">
                {formatModeText(snapshot.mode)}
              </pre>
            </Section>

            <Section
              title="System prompt"
              meta={`${snapshot.systemPrompt.length.toLocaleString()} chars · ${snapshot.systemPromptSections.length} sources`}
              defaultOpen
              copyTitle="Copy the assembled system prompt text"
              getCopyText={() => snapshot.systemPrompt}
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-slate-800 dark:text-slate-100">
                {snapshot.systemPrompt || '(empty)'}
              </pre>
            </Section>

            <Section
              title="Prompt sources"
              meta={`${snapshot.systemPromptSections.length} contributing`}
              copyTitle="Copy the source breakdown"
              getCopyText={() => formatPromptSourcesAsText(snapshot)}
            >
              {snapshot.systemPromptSections.length === 0 ? (
                <div className="text-[11px] italic text-slate-500 dark:text-slate-400">
                  No sources contributed to the prompt.
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {snapshot.systemPromptSections.map((section, index) => {
                    const id = section.id
                      ? `${section.source}:${section.id}`
                      : section.source
                    return (
                      <li
                        key={`${id}:${index}`}
                        className="flex items-baseline gap-2 font-mono text-[11px]"
                      >
                        <span className="text-indigo-600 dark:text-indigo-300">
                          {section.source}
                        </span>
                        {section.id ? (
                          <span className="text-slate-600 dark:text-slate-400">
                            {section.id}
                          </span>
                        ) : null}
                        <span className="ml-auto text-slate-400 dark:text-slate-500">
                          {section.text.length.toLocaleString()} chars
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>

            <Section
              title="Tools"
              meta={`${snapshot.toolNames.length} loaded`}
              copyTitle="Copy the list of tool names + descriptions"
              getCopyText={() => formatToolsAsText(snapshot)}
            >
              {snapshot.toolNames.length === 0 ? (
                <div className="text-[11px] italic text-slate-500 dark:text-slate-400">
                  No tools loaded.
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {snapshot.tools.map((tool) => (
                    <li key={tool.name}>
                      <div className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                        {tool.name}
                      </div>
                      {tool.description ? (
                        <div className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-400">
                          {tool.description}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              title="Raw snapshot"
              meta="JSON"
              copyTitle="Copy the full snapshot as JSON"
              getCopyText={() => formatJson(snapshot)}
            >
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-slate-700 dark:text-slate-300">
                {formatJson(snapshot)}
              </pre>
            </Section>
          </>
        ) : !loading && sessionId && !error ? (
          <div className="rounded border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300">
            No snapshot available for this session yet.
          </div>
        ) : null}
      </div>
    </RightDockShell>
  )
}
