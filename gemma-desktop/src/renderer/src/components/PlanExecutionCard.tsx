import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Sparkles, X } from 'lucide-react'
import type { PendingPlanExit } from '@/types'

interface PlanExecutionCardProps {
  planExit: PendingPlanExit
  busy?: boolean
  onExit: (target?: 'current' | 'fresh_summary') => Promise<void>
  onRevise: (instructions: string) => Promise<void>
  onDismiss: () => Promise<void>
}

function formatWorkModeLabel(workMode: PendingPlanExit['workMode']): string {
  return workMode === 'build' ? 'Build Act' : 'Explore Act'
}

function formatFreshActionLabel(workMode: PendingPlanExit['workMode']): string {
  return workMode === 'build'
    ? 'Accept and Start New Build Chat'
    : 'Accept and Start New Act Chat'
}

function formatCurrentActionLabel(workMode: PendingPlanExit['workMode']): string {
  return workMode === 'build'
    ? 'Build in This Conversation'
    : 'Continue in This Conversation'
}

export function PlanExecutionCard({
  planExit,
  busy = false,
  onExit,
  onRevise,
  onDismiss,
}: PlanExecutionCardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(false)
  const [revisionText, setRevisionText] = useState('')

  useEffect(() => {
    setHighlighted(true)
    window.requestAnimationFrame(() => {
      containerRef.current?.focus()
    })

    const timeout = window.setTimeout(() => {
      setHighlighted(false)
    }, 1800)

    return () => window.clearTimeout(timeout)
  }, [planExit.attentionToken, planExit.id])

  const syntheticNote =
    planExit.source === 'synthetic'
      ? 'This exit card was prepared automatically after plan mode tried to use a work-only tool.'
      : null

  const handleExit = async (target: 'current' | 'fresh_summary') => {
    if (busy || submitting) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await onExit(target)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(
        message.includes('Wait for the current turn to finish')
          ? 'Switching will unlock as soon as the current turn is done.'
          : message,
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleRevise = async () => {
    const trimmed = revisionText.trim()
    if (!trimmed || busy || submitting) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await onRevise(trimmed)
      setRevisionText('')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(
        message.includes('Wait for the current turn to finish')
          ? 'Plan changes will unlock as soon as the current turn is done.'
          : message,
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`border-t border-zinc-200 bg-emerald-50/70 px-6 py-3 outline-none transition-shadow dark:border-zinc-800 dark:bg-emerald-950/20 ${
        highlighted
          ? 'shadow-[inset_0_0_0_1px_rgba(16,185,129,0.5),0_0_0_3px_rgba(16,185,129,0.18)]'
          : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            <Sparkles size={15} className="text-emerald-600 dark:text-emerald-400" />
            Plan is ready
          </div>
          <div className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
            {planExit.summary}
          </div>
          {planExit.details && (
            <div className="mt-2 whitespace-pre-wrap text-xs text-zinc-500 dark:text-zinc-400">
              {planExit.details}
            </div>
          )}
          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Switch this session back to {formatWorkModeLabel(planExit.workMode)} to keep working.
          </div>
          {syntheticNote && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {syntheticNote}
            </div>
          )}
          {busy && (
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Waiting for the current turn to finish before the switch is available.
            </div>
          )}
        </div>
        <button
          onClick={() => void onDismiss()}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          title="Dismiss plan exit"
        >
          <X size={14} />
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => void handleExit('fresh_summary')}
          disabled={busy || submitting}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1">
            <ArrowRight size={14} />
            {submitting
              ? 'Switching...'
              : formatFreshActionLabel(planExit.workMode)}
          </span>
        </button>
        <button
          onClick={() => void handleExit('current')}
          disabled={busy || submitting}
          className="rounded-md border border-emerald-300 bg-white/70 px-3 py-1.5 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:bg-transparent dark:text-emerald-200 dark:hover:bg-emerald-950/30"
        >
          {submitting
            ? 'Switching...'
            : formatCurrentActionLabel(planExit.workMode)}
        </button>
      </div>
      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Accepting starts a fresh work chat by default. Building here keeps the current conversation transcript.
      </div>

      <div className="mt-4 rounded-md border border-amber-200 bg-white/75 p-3 dark:border-amber-900/60 dark:bg-zinc-950/30">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Need plan changes first?
        </div>
        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Tell the planner what to adjust and we&apos;ll stay in plan mode.
        </div>
        <textarea
          value={revisionText}
          onChange={(event) => setRevisionText(event.target.value)}
          placeholder="What should change before implementation starts?"
          rows={3}
          className="mt-3 min-h-[84px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-amber-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-amber-500"
        />
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => void handleRevise()}
            disabled={!revisionText.trim() || busy || submitting}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200 dark:hover:bg-amber-950/30"
          >
            {submitting ? 'Sending...' : 'Keep Planning'}
          </button>
        </div>
      </div>
    </div>
  )
}
