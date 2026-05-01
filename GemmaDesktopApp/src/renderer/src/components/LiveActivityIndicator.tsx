import { useEffect, useState } from 'react'
import {
  buildLiveActivityPresentation,
  type LiveActivityMetric,
} from '@/lib/liveActivityPresentation'
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

const PRIMARY_METRIC_LABELS = ['Elapsed', 'Last visible', 'First token', 'Last progress']
const DETAIL_METRIC_LABELS = new Set([
  'Status',
  'Active tool',
  'Context',
  ...PRIMARY_METRIC_LABELS,
])

function getMetric(metrics: LiveActivityMetric[], label: string): LiveActivityMetric | null {
  return metrics.find((metric) => metric.label === label) ?? null
}

function getPrimaryMetrics(metrics: LiveActivityMetric[]): LiveActivityMetric[] {
  return PRIMARY_METRIC_LABELS
    .map((label) => getMetric(metrics, label))
    .filter((metric): metric is LiveActivityMetric => metric != null)
}

function getDetailMetrics(metrics: LiveActivityMetric[]): LiveActivityMetric[] {
  return metrics.filter((metric) => !DETAIL_METRIC_LABELS.has(metric.label))
}

function ActivitySignal({
  dotClass,
  pulse = true,
  size = 'md',
}: {
  dotClass: string
  pulse?: boolean
  size?: 'sm' | 'md'
}) {
  const sizeClass = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2'

  return (
    <span className={`relative inline-flex ${sizeClass} flex-shrink-0 items-center justify-center`}>
      {pulse && (
        <span className={`absolute inline-flex h-full w-full rounded-full ${dotClass} opacity-40 animate-ping`} />
      )}
      <span className={`relative inline-flex ${sizeClass} rounded-full ${dotClass}`} />
    </span>
  )
}

function MetricTile({
  metric,
  tone,
}: {
  metric: LiveActivityMetric
  tone: ReturnType<typeof getToneClasses>
}) {
  return (
    <div className={`min-w-0 rounded-md border border-white/10 px-2 py-1.5 shadow-inner shadow-white/5 ${tone.metricBg}`}>
      <div className={`text-[8.5px] uppercase tracking-[0.12em] opacity-60 ${tone.text}`}>
        {metric.label}
      </div>
      <div className={`mt-0.5 min-w-0 text-[11px] font-semibold leading-tight tabular-nums ${tone.text} break-words [overflow-wrap:anywhere]`}>
        {metric.value}
      </div>
    </div>
  )
}

function MetricRow({
  metric,
  tone,
}: {
  metric: LiveActivityMetric
  tone: ReturnType<typeof getToneClasses>
}) {
  return (
    <div className="grid grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] items-baseline gap-2 px-2 py-1.5">
      <dt className={`min-w-0 text-[9px] uppercase tracking-[0.12em] opacity-60 ${tone.text}`}>
        {metric.label}
      </dt>
      <dd className={`min-w-0 text-right text-[11px] font-medium leading-snug tabular-nums ${tone.text} break-words [overflow-wrap:anywhere]`}>
        {metric.value}
      </dd>
    </div>
  )
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
      ? `pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-[18rem] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 overflow-hidden rounded-xl border p-3 text-xs shadow-[0_18px_48px_-24px_rgba(12,12,15,0.85)] backdrop-blur-xl transition-all duration-150 ${COMPACTING_TONE.popover} ${COMPACTING_TONE.text} ${
          open ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`
      : `pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 w-[18rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border p-3 text-xs shadow-[0_18px_48px_-24px_rgba(12,12,15,0.85)] backdrop-blur-xl transition-all duration-150 ${COMPACTING_TONE.popover} ${COMPACTING_TONE.text} ${
          open ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        }`

    return (
      <div
        className="relative inline-block"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <span
          className={`inline-flex max-w-[18rem] items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-left backdrop-blur ${COMPACTING_TONE.shell}`}
        >
          <ActivitySignal dotClass={COMPACTING_TONE.dot} size="sm" />
          <span className={`min-w-0 truncate text-[11px] font-medium leading-none ${COMPACTING_TONE.text}`}>
            compacting
          </span>
        </span>
        <div className={popoverClass} role="tooltip" aria-hidden={!open}>
          <p className={`text-[11px] leading-relaxed ${COMPACTING_TONE.text} break-words [overflow-wrap:anywhere]`}>
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
  const primaryMetrics = getPrimaryMetrics(presentation.metrics)
  const detailMetrics = getDetailMetrics(presentation.metrics)
  const contextMetric = getMetric(presentation.metrics, 'Context')
  const activeToolCaption = activity.activeToolLabel && activity.activeToolLabel !== presentation.label
    ? activity.activeToolLabel
    : null
  const showDetailPill = presentation.detail !== 'session turn'
  const popoverClass = isTitlebar
    ? `pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-[20rem] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 overflow-hidden rounded-xl border p-3 text-xs shadow-[0_20px_52px_-24px_rgba(8,47,73,0.7)] backdrop-blur-xl transition-all duration-150 ${tone.popover} ${tone.text} ${
        open
          ? 'translate-y-0 opacity-100'
          : 'translate-y-1 opacity-0'
      }`
    : `pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 w-[20rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border p-3 text-xs shadow-[0_20px_52px_-24px_rgba(8,47,73,0.7)] backdrop-blur-xl transition-all duration-150 ${tone.popover} ${tone.text} ${
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
        className={`inline-flex max-w-[18rem] items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-left backdrop-blur transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${tone.shell}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${presentation.label}. ${presentation.note}`}
      >
        <ActivitySignal dotClass={tone.dot} pulse={tone.pulse} size="sm" />
        <span className={`min-w-0 truncate text-[11px] font-medium leading-none ${tone.text}`}>
          {presentation.label.toLowerCase()}
        </span>
        <span className="min-w-0 truncate text-[10px] leading-none text-zinc-400 dark:text-zinc-500">
          {presentation.detail}
        </span>
      </button>

      <div
        className={popoverClass}
        role="dialog"
        aria-hidden={!open}
      >
        <div className="flex min-w-0 items-start gap-2">
          <ActivitySignal dotClass={tone.dot} pulse={tone.pulse} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <div className={`min-w-0 text-[12px] font-semibold leading-snug ${tone.text} break-words [overflow-wrap:anywhere]`}>
                {presentation.label}
              </div>
              {showDetailPill && (
                <span
                  className="max-w-full truncate rounded-full border border-white/10 bg-white/55 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-zinc-500 dark:bg-white/[0.04] dark:text-zinc-400"
                  title={presentation.detail}
                >
                  {presentation.detail}
                </span>
              )}
            </div>
            <p className={`mt-1 text-[11px] leading-relaxed opacity-80 ${tone.text} break-words [overflow-wrap:anywhere]`}>
              {presentation.note}
            </p>
          </div>
        </div>

        {primaryMetrics.length > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {primaryMetrics.map((metric) => (
              <MetricTile key={metric.label} metric={metric} tone={tone} />
            ))}
          </div>
        )}

        {(activity.activeToolName || contextMetric) && (
          <div className="mt-2 rounded-lg border border-white/10 bg-white/50 px-2 py-1.5 shadow-inner shadow-white/5 dark:bg-white/[0.03]">
            {activeToolCaption && (
              <div className={`text-[11px] font-medium leading-snug ${tone.text} break-words [overflow-wrap:anywhere]`}>
                {activeToolCaption}
              </div>
            )}
            {activity.activeToolName && (
              <code className={`mt-0.5 block min-w-0 text-[10px] leading-snug opacity-75 ${tone.text} break-words [overflow-wrap:anywhere]`}>
                {activity.activeToolName}
              </code>
            )}
            {contextMetric && (
              <div className={`mt-1 border-t border-white/10 pt-1 text-[10px] leading-snug opacity-75 ${tone.text} break-words [overflow-wrap:anywhere]`}>
                {contextMetric.value}
              </div>
            )}
          </div>
        )}

        {detailMetrics.length > 0 && (
          <dl className="mt-2 divide-y divide-white/10 overflow-hidden rounded-lg border border-white/10 bg-white/40 dark:bg-white/[0.025]">
            {detailMetrics.map((metric) => (
              <MetricRow key={metric.label} metric={metric} tone={tone} />
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}
