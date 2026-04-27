import { useEffect, useState } from 'react'
import { buildLiveActivityPresentation } from '@/lib/liveActivityPresentation'
import type { LiveActivitySnapshot, PendingCompaction } from '@/types'

interface LiveActivityIndicatorProps {
  activity: LiveActivitySnapshot | null
  isCompacting?: boolean
  pendingCompaction?: PendingCompaction | null
  layout?: 'default' | 'titlebar'
}

function getToneClasses(
  tone: 'streaming' | 'thinking' | 'working' | 'starting',
  stale: boolean,
): {
  shell: string
  dot: string
  text: string
  pulse: boolean
  badge: string
  popover: string
  metricBg: string
} {
  if (stale) {
    return {
      shell: 'border-sky-200/80 bg-sky-50/90 shadow-[0_18px_40px_-28px_rgba(14,116,144,0.55)] dark:border-sky-800/70 dark:bg-zinc-950/90',
      dot: 'bg-sky-500 dark:bg-sky-400',
      text: 'text-sky-700 dark:text-sky-300',
      pulse: true,
      badge: 'bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300',
      popover: 'border-sky-200/80 bg-sky-50/95 dark:border-sky-800/70 dark:bg-zinc-950/95',
      metricBg: 'bg-sky-100/60 dark:bg-zinc-900/90',
    }
  }

  switch (tone) {
    case 'streaming':
      return {
        shell: 'border-emerald-200/80 bg-emerald-50/90 shadow-[0_18px_40px_-28px_rgba(5,150,105,0.5)] dark:border-emerald-800/70 dark:bg-zinc-950/90',
        dot: 'bg-emerald-500 dark:bg-emerald-400',
        text: 'text-emerald-700 dark:text-emerald-300',
        pulse: true,
        badge: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
        popover: 'border-emerald-200/80 bg-emerald-50/95 dark:border-emerald-800/70 dark:bg-zinc-950/95',
        metricBg: 'bg-emerald-100/60 dark:bg-zinc-900/90',
      }
    case 'thinking':
      return {
        shell: 'border-amber-200/80 bg-amber-50/90 shadow-[0_18px_40px_-28px_rgba(217,119,6,0.5)] dark:border-amber-800/70 dark:bg-zinc-950/90',
        dot: 'bg-amber-500 dark:bg-amber-400',
        text: 'text-amber-700 dark:text-amber-300',
        pulse: true,
        badge: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
        popover: 'border-amber-200/80 bg-amber-50/95 dark:border-amber-800/70 dark:bg-zinc-950/95',
        metricBg: 'bg-amber-100/60 dark:bg-zinc-900/90',
      }
    case 'starting':
      return {
        shell: 'border-sky-200/80 bg-sky-50/90 shadow-[0_18px_40px_-28px_rgba(14,116,144,0.45)] dark:border-sky-800/70 dark:bg-zinc-950/90',
        dot: 'bg-sky-500 dark:bg-sky-400',
        text: 'text-sky-700 dark:text-sky-300',
        pulse: true,
        badge: 'bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300',
        popover: 'border-sky-200/80 bg-sky-50/95 dark:border-sky-800/70 dark:bg-zinc-950/95',
        metricBg: 'bg-sky-100/60 dark:bg-zinc-900/90',
      }
    case 'working':
    default:
      return {
        shell: 'border-indigo-200/80 bg-indigo-50/90 shadow-[0_18px_40px_-28px_rgba(79,70,229,0.45)] dark:border-indigo-800/70 dark:bg-zinc-950/90',
        dot: 'bg-indigo-500 dark:bg-indigo-400',
        text: 'text-indigo-700 dark:text-indigo-300',
        pulse: true,
        badge: 'bg-indigo-500/10 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-300',
        popover: 'border-indigo-200/80 bg-indigo-50/95 dark:border-indigo-800/70 dark:bg-zinc-950/95',
        metricBg: 'bg-indigo-100/60 dark:bg-zinc-900/90',
      }
  }
}

const COMPACTING_TONE = {
  shell: 'border-orange-200/80 bg-orange-50/90 dark:border-orange-800/70 dark:bg-zinc-950/90',
  dot: 'bg-orange-500 dark:bg-orange-400',
  text: 'text-orange-700 dark:text-orange-300',
  pulse: true,
  popover: 'border-orange-200/80 bg-orange-50/95 dark:border-orange-800/70 dark:bg-zinc-950/95',
  metricBg: 'bg-orange-100/60 dark:bg-zinc-900/90',
}

export function LiveActivityIndicator({
  activity,
  isCompacting = false,
  pendingCompaction = null,
  layout = 'default',
}: LiveActivityIndicatorProps) {
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!activity && !isCompacting) {
      return
    }

    setNow(Date.now())
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [activity, isCompacting])

  // Compacting state takes priority
  if (isCompacting || (pendingCompaction && pendingCompaction.status === 'running')) {
    const isTitlebar = layout === 'titlebar'
    const popoverClass = isTitlebar
      ? `pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-[220px] -translate-x-1/2 rounded-lg border p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 ${COMPACTING_TONE.popover} ${COMPACTING_TONE.text} ${
          open ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`
      : `pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 w-[220px] rounded-lg border p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 ${COMPACTING_TONE.popover} ${COMPACTING_TONE.text} ${
          open ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        }`

    return (
      <div
        className="relative inline-block"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-left backdrop-blur ${COMPACTING_TONE.shell}`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full animate-pulse ${COMPACTING_TONE.dot}`} />
          <span className={`text-[11px] font-medium leading-none ${COMPACTING_TONE.text}`}>
            compacting
          </span>
        </span>
        <div className={popoverClass} role="tooltip" aria-hidden={!open}>
          <p className={`text-[11px] leading-relaxed ${COMPACTING_TONE.text}`}>
            {pendingCompaction?.reason ?? 'Compacting conversation history to free context space.'}
          </p>
        </div>
      </div>
    )
  }

  if (!activity) {
    return null
  }

  const presentation = buildLiveActivityPresentation(activity, now)
  const tone = getToneClasses(presentation.tone, presentation.stale)
  const isTitlebar = layout === 'titlebar'
  const popoverClass = isTitlebar
    ? `pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-[260px] -translate-x-1/2 rounded-lg border p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 ${tone.popover} ${tone.text} ${
        open
          ? 'translate-y-0 opacity-100'
          : 'translate-y-1 opacity-0'
      }`
    : `pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 w-[260px] rounded-lg border p-2.5 text-xs shadow-lg backdrop-blur transition-all duration-150 ${tone.popover} ${tone.text} ${
        open
          ? 'translate-y-0 opacity-100'
          : '-translate-y-1 opacity-0'
      }`

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-left backdrop-blur transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${tone.shell}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${presentation.label}. ${presentation.note}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone.dot} ${tone.pulse ? 'animate-pulse' : ''}`}
        />
        <span className={`truncate text-[11px] font-medium leading-none ${tone.text}`}>
          {presentation.label.toLowerCase()}
        </span>
        <span className="truncate text-[10px] leading-none text-zinc-400 dark:text-zinc-500">
          {presentation.detail}
        </span>
      </button>

      <div
        className={popoverClass}
        role="dialog"
        aria-hidden={!open}
      >
        <p className={`text-[11px] leading-relaxed ${tone.text}`}>
          {presentation.note}
        </p>

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {presentation.metrics.map((metric) => (
            <div key={metric.label} className={`rounded-md px-2 py-1.5 ${tone.metricBg}`}>
              <div className={`text-[9px] uppercase tracking-[0.16em] opacity-60 ${tone.text}`}>
                {metric.label}
              </div>
              <div className={`mt-0.5 text-[11px] font-medium ${tone.text}`}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
