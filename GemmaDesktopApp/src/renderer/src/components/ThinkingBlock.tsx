import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Maximize2, Minimize2 } from 'lucide-react'
import { MarkdownContent } from '@/components/MarkdownContent'

interface ThinkingBlockProps {
  text: string
  summary?: string
  isActive?: boolean
  autoExpandWhenActive?: boolean
}

export function ThinkingBlock({
  text,
  summary,
  isActive = false,
  autoExpandWhenActive = true,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [fullHeight, setFullHeight] = useState(false)
  const userToggled = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-expand when active, auto-collapse when no longer active
  useEffect(() => {
    if (userToggled.current) return

    if (autoExpandWhenActive && isActive && !expanded) {
      setExpanded(true)
    } else if (!isActive && expanded) {
      setExpanded(false)
      setFullHeight(false)
    }
  }, [autoExpandWhenActive, expanded, isActive])

  // Auto-scroll to bottom as content streams in
  useLayoutEffect(() => {
    if (!expanded || !isActive) return

    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [text, expanded, isActive])

  const handleToggle = () => {
    userToggled.current = true
    setExpanded(!expanded)
    if (expanded) setFullHeight(false)
  }

  // Build a short preview from the first line of thinking
  const preview = summary?.trim()
    || text.split('\n').find((l) => l.trim())?.slice(0, 80)
    || ''

  return (
    <div className="my-1">
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        <ChevronRight
          size={11}
          className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">Thinking</span>
        {!expanded && preview && (
          <span className="truncate opacity-60">
            {preview}
            {!summary && preview.length >= 80 ? '...' : ''}
          </span>
        )}
      </button>

      {expanded && (
        <div className="relative ml-4 mt-1 border-l border-zinc-200 pl-3 dark:border-zinc-800">
          <div
            ref={scrollRef}
            className={`scrollbar-thin overflow-y-auto text-xs text-zinc-500 dark:text-zinc-400 ${
              fullHeight ? '' : 'max-h-40'
            }`}
          >
            {isActive ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                {text}
              </pre>
            ) : (
              <MarkdownContent text={text} />
            )}
          </div>
          <button
            onClick={() => setFullHeight(!fullHeight)}
            className="absolute right-0 top-0 rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            title={fullHeight ? 'Collapse' : 'Expand'}
            aria-label={fullHeight ? 'Collapse' : 'Expand'}
          >
            {fullHeight ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
          </button>
        </div>
      )}
    </div>
  )
}
