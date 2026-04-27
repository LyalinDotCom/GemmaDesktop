import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  ClipboardCheck,
  Download,
  FilePen,
  Link as LinkIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Quote,
  Search,
  Sparkles,
  TerminalSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type {
  ToolProgressEntry,
  ToolWorkerDetail,
  ToolWorkerTimelineEntry,
} from '@/types'
import {
  buildToolBlockCollapsedSummary,
  buildWorkerMetricItems,
  buildWorkerResultSections,
  buildWorkerTechnicalDetails,
  deriveToolBlockAutoExpansion,
  type WorkerMetricItem,
} from '@/lib/workerInspector'

interface ToolCallBlockProps {
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'success' | 'error'
  summary?: string
  startedAt?: number
  completedAt?: number
  progressEntries?: ToolProgressEntry[]
  worker?: ToolWorkerDetail
  isActive?: boolean
  autoExpandWhenActive?: boolean
}

interface ActivityStyle {
  icon: LucideIcon
  describe: (count: number) => string
  streams?: boolean
}

const ACTIVITY_STYLES: Record<string, ActivityStyle> = {
  Searches: {
    icon: Search,
    describe: (n) => `${n} search ${n === 1 ? 'query' : 'queries'} issued`,
  },
  Fetched: {
    icon: Download,
    describe: (n) => `${n} ${n === 1 ? 'page' : 'pages'} fetched`,
  },
  Sources: {
    icon: LinkIcon,
    describe: (n) => `${n} ${n === 1 ? 'source' : 'sources'} retained`,
  },
  Evidence: {
    icon: Quote,
    describe: (n) => `${n} evidence ${n === 1 ? 'snippet' : 'snippets'} collected`,
  },
  Files: {
    icon: FilePen,
    describe: (n) => `${n} ${n === 1 ? 'file' : 'files'} touched`,
  },
  Commands: {
    icon: TerminalSquare,
    describe: (n) => `${n} ${n === 1 ? 'command' : 'commands'} run`,
  },
  'Tool calls': {
    icon: Wrench,
    describe: (n) => `${n} tool ${n === 1 ? 'call' : 'calls'} made by the worker`,
  },
  'Tool results': {
    icon: ClipboardCheck,
    describe: (n) => `${n} tool ${n === 1 ? 'result' : 'results'} returned to the worker`,
  },
  Assistant: {
    icon: Sparkles,
    describe: (n) => `${n} assistant message update${n === 1 ? '' : 's'} streamed`,
    streams: true,
  },
  Reasoning: {
    icon: Brain,
    describe: (n) => `${n} reasoning update${n === 1 ? '' : 's'} streamed`,
    streams: true,
  },
  Runtime: {
    icon: Activity,
    describe: (n) => `${n} runtime lifecycle event${n === 1 ? '' : 's'}`,
  },
}

type TimelineState = 'running' | 'completed' | 'warning' | 'error'

function formatProgressOffset(
  timestamp: number,
  startedAt?: number,
): string {
  const reference = startedAt ?? timestamp
  const seconds = Math.max(0, Math.round((timestamp - reference) / 1000))
  return `+${seconds}s`
}

function ActivityPill({
  metric,
  streaming,
}: {
  metric: WorkerMetricItem
  streaming: boolean
}) {
  const style = ACTIVITY_STYLES[metric.label]
  const Icon = style?.icon ?? Activity
  const numericValue = Number(metric.value)
  const tooltipCount = Number.isFinite(numericValue) ? numericValue : 0
  const tooltip = style
    ? style.describe(tooltipCount)
    : `${metric.label}: ${metric.value}`
  const pulse = streaming && style?.streams === true

  return (
    <span
      title={tooltip}
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/80 px-2 py-0.5 text-[11px] text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300"
    >
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        <Icon size={12} className="text-zinc-500 dark:text-zinc-400" strokeWidth={2} />
        {pulse && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/70 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
          </span>
        )}
      </span>
      <span className="text-zinc-500 dark:text-zinc-400">{metric.label}</span>
      <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
        {metric.value}
      </span>
    </span>
  )
}

function TimelineStepIcon({ state }: { state: TimelineState }) {
  if (state === 'running') {
    return (
      <span className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400">
        <AlertTriangle size={9} strokeWidth={2.5} />
      </span>
    )
  }
  if (state === 'warning') {
    return (
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
        <AlertTriangle size={9} strokeWidth={2.5} />
      </span>
    )
  }
  return (
    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400">
      <Check size={9} strokeWidth={3} />
    </span>
  )
}

function resolveTimelineState(
  tone: ToolWorkerTimelineEntry['tone'],
  isLatest: boolean,
  toolStatus: ToolCallBlockProps['status'],
): TimelineState {
  if (tone === 'warning') return 'warning'
  if (isLatest && toolStatus === 'error') return 'error'
  if (isLatest && toolStatus === 'running') return 'running'
  return 'completed'
}

export function ToolCallBlock({
  toolName,
  input,
  output,
  status,
  summary,
  startedAt,
  completedAt,
  progressEntries = [],
  worker,
  isActive = false,
  autoExpandWhenActive = true,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [fullHeight, setFullHeight] = useState(false)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const userToggled = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const nextState = deriveToolBlockAutoExpansion({
      expanded,
      fullHeight,
      isActive,
      autoExpandWhenActive,
      userToggled: userToggled.current,
    })

    if (!nextState) {
      return
    }

    setExpanded(nextState.expanded)
    setFullHeight(nextState.fullHeight)
  }, [autoExpandWhenActive, expanded, fullHeight, isActive])

  useLayoutEffect(() => {
    if (!expanded || !isActive) return

    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [expanded, isActive, output, progressEntries, worker])

  const handleToggle = () => {
    userToggled.current = true
    setExpanded((current) => !current)
    if (expanded) {
      setFullHeight(false)
      setTechnicalOpen(false)
    }
  }

  useEffect(() => {
    if (status !== 'running' || startedAt == null) {
      return
    }

    setNow(Date.now())
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [startedAt, status])

  const isRunning = status === 'running'
  const durationLabel =
    startedAt != null && completedAt != null
      ? `${Math.max(1, Math.round((completedAt - startedAt) / 1000))}s`
      : startedAt != null && isRunning
        ? `${Math.max(1, Math.floor((now - startedAt) / 1000))}s`
        : null
  const collapsedSummary = buildToolBlockCollapsedSummary({
    worker,
    progressEntries,
    summary,
    input,
  })
  const workerMetrics = buildWorkerMetricItems(worker)
  const workerSections = buildWorkerResultSections(worker)
  const workerTechnical = buildWorkerTechnicalDetails(worker)
  const timelineEntries: ToolWorkerTimelineEntry[] = (
    worker?.timeline
    ?? progressEntries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      timestamp: entry.timestamp,
      tone: entry.tone,
      detail: undefined,
    }))
  )
  const currentAction = worker?.currentAction
  const hasTechnical =
    workerTechnical.length > 0
    || worker?.traceText != null
    || Object.keys(input).length > 0
  const headerStatusLabel = durationLabel
    ? isRunning
      ? `Running · ${durationLabel}`
      : status === 'error'
        ? `Failed after ${durationLabel}`
        : `Completed in ${durationLabel}`
    : null

  return (
    <div className="my-1">
      <button
        onClick={handleToggle}
        className="group/tool flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      >
        {isRunning ? (
          <Loader2 size={11} className="animate-spin flex-shrink-0" />
        ) : (
          <ChevronRight
            size={11}
            className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <span className="font-medium">{toolName}</span>
        {worker?.label && <span className="opacity-60">{worker.label}</span>}
        {collapsedSummary && !expanded && (
          <span className="truncate opacity-60">{collapsedSummary}</span>
        )}
        {durationLabel && (
          <span className="ml-auto font-mono tabular-nums opacity-60">
            {durationLabel}
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-4 mt-1.5 rounded-xl border border-zinc-200 bg-white/70 p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">
                  {worker?.label ?? toolName}
                </span>
                {headerStatusLabel && (
                  <>
                    <span className="text-zinc-300 dark:text-zinc-700">·</span>
                    <span className="tabular-nums">{headerStatusLabel}</span>
                  </>
                )}
              </div>
              {isRunning && currentAction && (
                <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-zinc-50/80 px-2.5 py-1 text-[11.5px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
                  <span className="relative inline-flex h-2 w-2 flex-shrink-0">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                  </span>
                  <span className="truncate">{currentAction}</span>
                </div>
              )}
            </div>
            <button
              onClick={() => setFullHeight((current) => !current)}
              className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title={fullHeight ? 'Collapse' : 'Expand'}
              aria-label={fullHeight ? 'Collapse' : 'Expand'}
            >
              {fullHeight ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          </div>

          <div
            ref={scrollRef}
            className={`scrollbar-thin mt-2.5 space-y-3 overflow-y-auto ${
              fullHeight ? '' : 'max-h-60'
            }`}
          >
            {worker?.goal && (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Goal
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {worker.goal}
                </div>
              </div>
            )}

            {workerMetrics.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {workerMetrics.map((metric) => (
                  <ActivityPill
                    key={metric.label}
                    metric={metric}
                    streaming={isRunning}
                  />
                ))}
              </div>
            )}

            {timelineEntries.length > 0 && (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Progress
                </div>
                <ol className="mt-1.5 space-y-1">
                  {timelineEntries.map((entry, index) => {
                    const isLatest = index === timelineEntries.length - 1
                    const state = resolveTimelineState(entry.tone, isLatest, status)
                    return (
                      <li
                        key={entry.id}
                        className="flex items-start gap-2.5"
                      >
                        <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                          <TimelineStepIcon state={state} />
                        </span>
                        <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed">
                          <span
                            className={
                              state === 'error'
                                ? 'text-red-600 dark:text-red-400'
                                : state === 'warning'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : state === 'running'
                                    ? 'text-zinc-800 dark:text-zinc-200'
                                    : 'text-zinc-600 dark:text-zinc-400'
                            }
                          >
                            {entry.label}
                          </span>
                          {entry.detail && (
                            <span className="ml-1 text-zinc-400 dark:text-zinc-500">
                              {entry.detail}
                            </span>
                          )}
                        </div>
                        <span className="flex-shrink-0 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                          {formatProgressOffset(entry.timestamp, startedAt)}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            )}

            {worker?.resultSummary && (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Result
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {worker.resultSummary}
                </div>
              </div>
            )}

            {workerSections.map((section) => (
              <div key={section.label}>
                <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  {section.label}
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {section.values.map((value) => (
                    <div
                      key={value}
                      className="text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400"
                    >
                      {value}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {output && output !== worker?.resultSummary && (
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Parent Result
                </div>
                <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {output.length > 2400 ? `${output.slice(0, 2400)}\n...` : output}
                </pre>
              </div>
            )}

            {hasTechnical && (
              <div>
                <button
                  type="button"
                  onClick={() => setTechnicalOpen((current) => !current)}
                  className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                >
                  <ChevronRight
                    size={9}
                    className={`transition-transform ${technicalOpen ? 'rotate-90' : ''}`}
                  />
                  Technical
                </button>

                {technicalOpen && (
                  <div className="mt-1 space-y-1.5">
                    {workerTechnical.length > 0 && (
                      <div className="space-y-0.5">
                        {workerTechnical.map((entry) => (
                          <div key={entry.label} className="text-[11px]">
                            <span className="text-zinc-400 dark:text-zinc-500">{entry.label}:</span>{' '}
                            <span className="break-all font-mono text-zinc-600 dark:text-zinc-400">{entry.value}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {JSON.stringify(input, null, 2)}
                    </pre>

                    {worker?.traceText && (
                      <pre className={`overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400 ${fullHeight ? '' : 'max-h-40'}`}>
                        {worker.traceText}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
