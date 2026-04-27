import { useState } from 'react'
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
} from 'lucide-react'
import { copyText } from '@/lib/clipboard'
import type { DebugTone } from '@/lib/debugTimeline'

interface InlineDebugPanelProps {
  title: string
  subtitle?: string
  body: string
  badge: string
  tone?: DebugTone
}

function getToneClasses(tone: DebugTone): {
  frame: string
  badge: string
  icon: string
  title: string
  subtitle: string
  body: string
  copy: string
} {
  switch (tone) {
    case 'indigo':
      return {
        frame:
          'border-cyan-200/80 bg-cyan-50/75 dark:border-cyan-900/70 dark:bg-cyan-950/20',
        badge:
          'border-cyan-200 bg-white/80 text-cyan-700 dark:border-cyan-900/70 dark:bg-cyan-950/30 dark:text-cyan-200',
        icon: 'text-cyan-600 dark:text-cyan-300',
        title: 'text-cyan-950 dark:text-cyan-50',
        subtitle: 'text-cyan-800/70 dark:text-cyan-100/70',
        body:
          'border-t border-cyan-200/70 bg-white/75 text-cyan-950 dark:border-cyan-900/60 dark:bg-zinc-950/70 dark:text-cyan-50',
        copy:
          'text-cyan-700 hover:bg-cyan-100 hover:text-cyan-950 dark:text-cyan-300 dark:hover:bg-cyan-950/40 dark:hover:text-cyan-50',
      }
    case 'amber':
      return {
        frame:
          'border-amber-200/80 bg-amber-50/75 dark:border-amber-900/70 dark:bg-amber-950/20',
        badge:
          'border-amber-200 bg-white/80 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200',
        icon: 'text-amber-600 dark:text-amber-300',
        title: 'text-amber-950 dark:text-amber-50',
        subtitle: 'text-amber-800/70 dark:text-amber-100/70',
        body:
          'border-t border-amber-200/70 bg-white/75 text-amber-950 dark:border-amber-900/60 dark:bg-zinc-950/70 dark:text-amber-50',
        copy:
          'text-amber-700 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-300 dark:hover:bg-amber-950/40 dark:hover:text-amber-50',
      }
    case 'emerald':
      return {
        frame:
          'border-emerald-200/80 bg-emerald-50/75 dark:border-emerald-900/70 dark:bg-emerald-950/20',
        badge:
          'border-emerald-200 bg-white/80 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-200',
        icon: 'text-emerald-600 dark:text-emerald-300',
        title: 'text-emerald-950 dark:text-emerald-50',
        subtitle: 'text-emerald-800/70 dark:text-emerald-100/70',
        body:
          'border-t border-emerald-200/70 bg-white/75 text-emerald-950 dark:border-emerald-900/60 dark:bg-zinc-950/70 dark:text-emerald-50',
        copy:
          'text-emerald-700 hover:bg-emerald-100 hover:text-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-50',
      }
    case 'rose':
      return {
        frame:
          'border-rose-200/80 bg-rose-50/75 dark:border-rose-900/70 dark:bg-rose-950/20',
        badge:
          'border-rose-200 bg-white/80 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200',
        icon: 'text-rose-600 dark:text-rose-300',
        title: 'text-rose-950 dark:text-rose-50',
        subtitle: 'text-rose-800/70 dark:text-rose-100/70',
        body:
          'border-t border-rose-200/70 bg-white/75 text-rose-950 dark:border-rose-900/60 dark:bg-zinc-950/70 dark:text-rose-50',
        copy:
          'text-rose-700 hover:bg-rose-100 hover:text-rose-950 dark:text-rose-300 dark:hover:bg-rose-950/40 dark:hover:text-rose-50',
      }
    case 'slate':
    default:
      return {
        frame:
          'border-zinc-200/90 bg-zinc-50/90 dark:border-zinc-800/80 dark:bg-zinc-900/60',
        badge:
          'border-zinc-200 bg-white/80 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200',
        icon: 'text-zinc-500 dark:text-zinc-300',
        title: 'text-zinc-950 dark:text-zinc-50',
        subtitle: 'text-zinc-600 dark:text-zinc-400',
        body:
          'border-t border-zinc-200/80 bg-white/80 text-zinc-950 dark:border-zinc-800/80 dark:bg-zinc-950/80 dark:text-zinc-50',
        copy:
          'text-zinc-600 hover:bg-zinc-200 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50',
      }
  }
}

export function InlineDebugPanel({
  title,
  subtitle,
  body,
  badge,
  tone = 'slate',
}: InlineDebugPanelProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const classes = getToneClasses(tone)

  const handleCopy = async () => {
    await copyText(`Debug: ${title}\n\n${body}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={`my-4 overflow-hidden rounded-2xl border shadow-sm ${classes.frame}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="mt-0.5 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-100"
          aria-label={open ? 'Collapse debug panel' : 'Expand debug panel'}
          title={open ? 'Collapse debug panel' : 'Expand debug panel'}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${classes.badge}`}
            >
              <Bug size={11} className={classes.icon} />
              {badge}
            </span>
            {copied && (
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                Copied
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="mt-2 block text-left"
          >
            <div className={`text-sm font-semibold ${classes.title}`}>
              Debug: {title}
            </div>
            {subtitle && (
              <div className={`mt-1 text-[11px] leading-5 ${classes.subtitle}`}>
                {subtitle}
              </div>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className={`rounded-lg p-1.5 transition-colors ${classes.copy}`}
          aria-label="Copy debug details"
          title="Copy debug details"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {open && (
        <div className={classes.body}>
          <pre className="max-h-[32rem] overflow-auto px-4 py-4 font-mono text-[11px] leading-5 whitespace-pre-wrap">
            {body}
          </pre>
        </div>
      )}
    </div>
  )
}
