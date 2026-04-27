import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { copyText } from '@/lib/clipboard'

interface CodeBlockProps {
  code: string
  language: string
  filename?: string
}

export function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await copyText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const label = filename ?? language

  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-200/70 px-2.5 py-0.5 dark:border-zinc-800/70">
        <span className="font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
          {label}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
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
      <pre className="overflow-x-auto px-3 py-1.5">
        <code className="whitespace-pre font-mono text-[12px] leading-snug text-zinc-800 dark:text-zinc-200">
          {code}
        </code>
      </pre>
    </div>
  )
}
