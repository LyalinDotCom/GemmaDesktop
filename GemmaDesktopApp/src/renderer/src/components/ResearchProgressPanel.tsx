import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Globe, Loader2 } from 'lucide-react'
import type {
  ResearchPanelStepStatus,
  ResearchPanelTopicStep,
  ResearchPanelViewModel,
} from '@/types'

interface ResearchProgressPanelProps {
  panel: ResearchPanelViewModel
  isActive: boolean
}

function formatElapsedSeconds(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (seconds === 0) {
    return `${minutes}m`
  }
  return `${minutes}m ${seconds}s`
}

function shortDomainLabel(domain: string): string {
  const trimmed = domain.replace(/^www\./, '')
  return trimmed.length > 40 ? `${trimmed.slice(0, 37)}…` : trimmed
}

function domainMonogram(domain: string): string {
  const segments = domain.replace(/^www\./, '').split('.').filter(Boolean)
  const letters = segments
    .slice(0, 2)
    .map((segment) => segment.charAt(0).toUpperCase())
    .join('')
  return letters || '?'
}

function normalizeIconDomain(domain: string): string | null {
  const trimmed = domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase()

  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(trimmed) ? trimmed : null
}

export function buildDomainIconCandidates(domain: string): string[] {
  const normalized = normalizeIconDomain(domain)
  if (!normalized) {
    return []
  }

  const candidates = [
    `https://${normalized}/favicon.ico`,
  ]

  candidates.push(
    `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(`https://${normalized}`)}&sz=64`,
  )

  return [...new Set(candidates)]
}

function StepIcon({ status, animate = true }: { status: ResearchPanelStepStatus; animate?: boolean }) {
  if (status === 'running') {
    return (
      <span className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
      </span>
    )
  }
  if (status === 'completed') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400">
        <Check size={10} strokeWidth={3} />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400">
        <AlertTriangle size={10} strokeWidth={2.5} />
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      </span>
    )
  }
  return (
    <span className={`inline-block h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600 ${animate ? '' : ''}`} />
  )
}

function DomainBadge({ domain }: { domain: string }) {
  const monogram = domainMonogram(domain)
  const iconCandidates = useMemo(() => buildDomainIconCandidates(domain), [domain])
  const [iconIndex, setIconIndex] = useState(0)
  const iconUrl = iconCandidates[iconIndex]

  useEffect(() => {
    setIconIndex(0)
  }, [domain])

  return (
    <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-[10px] font-semibold tracking-wide text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      <span className="flex h-full w-full items-center justify-center">
        {monogram.length > 0 ? monogram : <Globe size={12} />}
      </span>
      {iconUrl && (
        <img
          src={iconUrl}
          alt=""
          className="absolute inset-0 h-full w-full bg-white object-contain p-0.5 dark:bg-zinc-900"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          aria-hidden="true"
          onError={() => setIconIndex((index) => index + 1)}
        />
      )}
    </span>
  )
}

function DomainRow({
  domain,
  count,
  maxCount,
}: {
  domain: string
  count: number
  maxCount: number
}) {
  const pct = maxCount > 0 ? Math.max(6, Math.round((count / maxCount) * 100)) : 0
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <DomainBadge domain={domain} />
      <span
        className="truncate text-[12px] text-zinc-700 dark:text-zinc-300"
        title={domain}
      >
        {shortDomainLabel(domain)}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span className="tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400">
          {count} {count === 1 ? 'source' : 'sources'}
        </span>
        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800 sm:inline-block">
          <span
            className="block h-full rounded-full bg-zinc-400/70 dark:bg-zinc-500/60"
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </div>
  )
}

function TopicRow({ topic }: { topic: ResearchPanelTopicStep }) {
  return (
    <div className="group flex items-start gap-2.5 py-1">
      <span className="mt-1.5 flex-shrink-0">
        <StepIcon status={topic.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={
              topic.status === 'pending' || topic.status === 'cancelled'
                ? 'text-[12.5px] text-zinc-500 dark:text-zinc-500'
                : 'text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200'
            }
          >
            {topic.label}
          </span>
          {topic.sourceCount > 0 && (
            <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
              {topic.sourceCount} {topic.sourceCount === 1 ? 'source' : 'sources'}
            </span>
          )}
        </div>
        {topic.goal && topic.status !== 'completed' && (
          <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {topic.goal}
          </div>
        )}
        {topic.summary && topic.status === 'completed' && (
          <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {topic.summary}
          </div>
        )}
        {topic.lastError && (
          <div className="mt-0.5 text-[11px] text-red-500 dark:text-red-400">
            {topic.lastError}
          </div>
        )}
      </div>
    </div>
  )
}

function StepHeader({
  status,
  label,
  meta,
  expandable = false,
  expanded = false,
  onToggle,
}: {
  status: ResearchPanelStepStatus
  label: string
  meta?: string
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const content = (
    <div className="flex items-center gap-2.5">
      <StepIcon status={status} />
      <span
        className={
          status === 'pending' || status === 'cancelled'
            ? 'text-[13px] text-zinc-500 dark:text-zinc-500'
            : 'text-[13px] font-medium text-zinc-800 dark:text-zinc-200'
        }
      >
        {label}
      </span>
      {meta && (
        <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {meta}
        </span>
      )}
      {expandable && (
        <ChevronDown
          size={12}
          className={`ml-auto text-zinc-400 transition-transform dark:text-zinc-500 ${expanded ? 'rotate-180' : ''}`}
        />
      )}
    </div>
  )

  if (expandable && onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="group flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40"
      >
        {content}
      </button>
    )
  }

  return <div className="flex items-center gap-2.5 px-1 py-1">{content}</div>
}

export function ResearchProgressPanel({
  panel,
  isActive,
}: ResearchProgressPanelProps) {
  const [domainsExpanded, setDomainsExpanded] = useState(true)
  const [, setTick] = useState(0)

  // Tick every second while the run is live so elapsed/"since last event" stay fresh.
  useEffect(() => {
    if (!isActive || panel.runStatus !== 'running') {
      return
    }
    const interval = window.setInterval(() => setTick((v) => v + 1), 1000)
    return () => window.clearInterval(interval)
  }, [isActive, panel.runStatus])

  const liveElapsed = useMemo(() => {
    if (panel.runStatus === 'running' && panel.startedAt != null) {
      return formatElapsedSeconds(Math.max(Date.now() - panel.startedAt, 1))
    }
    return panel.elapsedLabel
  }, [panel.elapsedLabel, panel.runStatus, panel.startedAt])

  const maxDomainCount = panel.sources.topDomains.reduce(
    (max, entry) => Math.max(max, entry.count),
    0,
  )

  const showDomains = panel.sources.topDomains.length > 0
  const sourcesMeta =
    panel.sources.totalSources > 0
      ? `${panel.sources.totalSources}${
          panel.sources.targetSources > 0 ? ` / ${panel.sources.targetSources}` : ''
        } sources · ${panel.sources.distinctDomains} domain${panel.sources.distinctDomains === 1 ? '' : 's'}`
      : undefined

  const headerElapsed = liveElapsed
    ? panel.runStatus === 'running'
      ? `Running · ${liveElapsed}`
      : panel.runStatus === 'completed'
        ? `Completed in ${liveElapsed}`
        : panel.runStatus === 'failed'
          ? `Failed after ${liveElapsed}`
          : `Cancelled after ${liveElapsed}`
    : null

  return (
    <div className="my-2 rounded-2xl border border-zinc-200 bg-white/70 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {panel.title && (
            <div className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
              {panel.title}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <span>Deep research</span>
            {panel.modelLabel && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span className="truncate">{panel.modelLabel}</span>
              </>
            )}
            {headerElapsed && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span className="tabular-nums">{headerElapsed}</span>
              </>
            )}
          </div>
        </div>
        {panel.runStatus === 'running' && (
          <Loader2 size={14} className="mt-1 flex-shrink-0 animate-spin text-zinc-400 dark:text-zinc-500" />
        )}
      </div>

      <ol className="relative mt-3 space-y-1 pl-1">
        <li>
          <StepHeader
            status={panel.plan.status}
            label={panel.plan.label}
            meta={
              panel.plan.status === 'completed' && panel.plan.topicCount > 0
                ? `${panel.plan.topicCount} topic${panel.plan.topicCount === 1 ? '' : 's'}`
                : undefined
            }
          />
        </li>

        <li>
          <StepHeader
            status={panel.sources.status}
            label={panel.sources.label}
            meta={sourcesMeta}
            expandable={showDomains}
            expanded={domainsExpanded}
            onToggle={() => setDomainsExpanded((v) => !v)}
          />
          {showDomains && domainsExpanded && (
            <div className="ml-6 mt-1 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
              {panel.sources.topDomains.map((entry) => (
                <DomainRow
                  key={entry.domain}
                  domain={entry.domain}
                  count={entry.count}
                  maxCount={maxDomainCount}
                />
              ))}
              {panel.sources.otherDomainCount > 0 && (
                <div className="mt-1 flex items-center gap-2.5 border-t border-zinc-200/70 pt-1.5 text-[11.5px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-zinc-400 dark:text-zinc-500">
                    <ChevronRight size={11} />
                  </span>
                  <span>
                    {panel.sources.otherDomainSourceCount > 0
                      ? `${panel.sources.otherDomainSourceCount} sources from ${panel.sources.otherDomainCount} other domain${panel.sources.otherDomainCount === 1 ? '' : 's'}`
                      : `${panel.sources.otherDomainCount} other domain${panel.sources.otherDomainCount === 1 ? '' : 's'}`}
                  </span>
                </div>
              )}
              {panel.sources.currentPass != null && panel.sources.status === 'running' && (
                <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Gather pass {panel.sources.currentPass}
                  {panel.sources.passCount && panel.sources.passCount > 1
                    ? ` of ${panel.sources.passCount}`
                    : ''}
                </div>
              )}
            </div>
          )}
        </li>

        <li>
          <StepHeader
            status={panel.depth.status}
            label={panel.depth.label}
          />
        </li>

        {panel.topics.map((topic) => (
          <li key={topic.id}>
            <TopicRow topic={topic} />
          </li>
        ))}

        <li>
          <StepHeader
            status={panel.synthesis.status}
            label={panel.synthesis.label}
          />
        </li>
      </ol>

      {panel.liveHint && panel.runStatus === 'running' && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-zinc-50/80 px-3 py-1.5 text-[11.5px] text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          <span className="truncate">{panel.liveHint}</span>
        </div>
      )}

      {panel.errorMessage && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-1.5 text-[11.5px] text-red-600 dark:bg-red-900/30 dark:text-red-300">
          {panel.errorMessage}
        </div>
      )}

      {panel.warningMessages && panel.warningMessages.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {panel.warningMessages.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-200"
            >
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
