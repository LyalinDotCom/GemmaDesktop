import { useState } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { copyText } from '@/lib/clipboard'

interface FileEditBlockProps {
  path: string
  changeType: 'created' | 'edited'
  addedLines: number
  removedLines: number
  diff: string
  truncated?: boolean
}

export function FileEditBlock({
  path,
  changeType,
  addedLines,
  removedLines,
  diff,
  truncated = false,
}: FileEditBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyText(diff)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const label = changeType === 'created' ? 'Created' : 'Edited'
  const lines = diff.split('\n')

  return (
    <div
      className="my-1"
      data-file-edit-state={expanded ? 'expanded' : 'collapsed'}
      data-file-edit-change={changeType}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        <ChevronRight
          size={11}
          className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">{label}</span>
        <span className="min-w-0 truncate opacity-70">{path}</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{addedLines}</span>
          <span className="text-red-600 dark:text-red-400">-{removedLines}</span>
        </span>
      </button>

      {expanded && (
        <div className="ml-4 mt-1.5 overflow-hidden rounded-xl border border-zinc-200 bg-white/80 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-800/80">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  {label}
                </span>
                <span className="truncate">{path}</span>
                {truncated && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                    Diff truncated
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              aria-label="Copy diff"
            >
              {copied ? (
                <>
                  <Check size={11} className="text-emerald-500" />
                  <span className="text-emerald-500">Copied</span>
                </>
              ) : (
                <>
                  <Copy size={11} />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          <div className="overflow-x-auto bg-zinc-50/90 px-3 py-2 dark:bg-zinc-950/60">
            <table className="w-full border-collapse">
              <tbody>
                {lines.map((line, index) => {
                  let lineClass = 'text-zinc-500 dark:text-zinc-400'
                  let bgClass = ''

                  if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineClass = 'text-emerald-700 dark:text-emerald-300'
                    bgClass = 'bg-emerald-500/5'
                  } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineClass = 'text-red-700 dark:text-red-300'
                    bgClass = 'bg-red-500/5'
                  } else if (line.startsWith('@@')) {
                    lineClass = 'text-indigo-700 dark:text-indigo-300'
                    bgClass = 'bg-indigo-500/5'
                  }

                  return (
                    <tr key={`${index}-${line}`} className={bgClass}>
                      <td
                        className={`whitespace-pre font-mono text-[11px] leading-relaxed ${lineClass}`}
                      >
                        {line || ' '}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
