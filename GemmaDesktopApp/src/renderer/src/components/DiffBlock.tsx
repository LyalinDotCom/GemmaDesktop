import { useState } from 'react'
import { Copy, Check, GitBranch } from 'lucide-react'
import { copyText } from '@/lib/clipboard'

interface DiffBlockProps {
  filename: string
  diff: string
}

export function DiffBlock({ filename, diff }: DiffBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyText(diff)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const lines = diff.split('\n')

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between bg-zinc-100 px-3 py-1.5 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <GitBranch size={13} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">{filename}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          {copied ? (
            <>
              <Check size={12} className="text-emerald-500" />
              <span className="text-emerald-500">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              Copy
            </>
          )}
        </button>
      </div>

      {/* Diff content */}
      <div className="overflow-x-auto bg-zinc-950 p-4">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => {
              let lineClass = 'text-zinc-400'
              let bgClass = ''

              if (line.startsWith('+') && !line.startsWith('+++')) {
                lineClass = 'text-emerald-400'
                bgClass = 'bg-emerald-950/30'
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                lineClass = 'text-red-400'
                bgClass = 'bg-red-950/30'
              } else if (line.startsWith('@@')) {
                lineClass = 'text-indigo-400'
                bgClass = 'bg-indigo-950/20'
              }

              return (
                <tr key={i} className={bgClass}>
                  <td
                    className={`whitespace-pre font-mono text-xs leading-relaxed ${lineClass}`}
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
  )
}
