import { useState } from 'react'
import { Copy, Check, File } from 'lucide-react'
import { copyText } from '@/lib/clipboard'

interface FileExcerptProps {
  filename: string
  startLine: number
  content: string
  language: string
}

export function FileExcerpt({
  filename,
  startLine,
  content,
  language: _language,
}: FileExcerptProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const lines = content.split('\n')

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between bg-zinc-100 px-3 py-1.5 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <File size={13} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">{filename}</span>
          <span className="text-[11px] text-zinc-400">
            L{startLine}&ndash;{startLine + lines.length - 1}
          </span>
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

      {/* Code with line numbers */}
      <div className="overflow-x-auto bg-zinc-950 p-4">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="leading-relaxed">
                <td className="select-none pr-4 text-right align-top font-mono text-xs text-zinc-600">
                  {startLine + i}
                </td>
                <td className="whitespace-pre font-mono text-xs text-zinc-200">
                  {line || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
