import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  FolderOpen,
  Loader2,
  Play,
  Save,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import type {
  AutomationDetail,
  AutomationRunRecord,
  AutomationSchedule,
  GemmaInstallState,
  InstalledSkillRecord,
  ModelSummary,
  SessionMode,
} from '@/types'
import { ModelSelector } from '@/components/ModelSelector'
import { isGuidedGemmaMissing } from '@/lib/guidedModels'
import { findGemmaCatalogEntryByTag } from '@shared/gemmaCatalog'

interface AutomationDraft {
  id?: string
  name: string
  prompt: string
  modelId: string
  runtimeId: string
  selectedSkillIds: string[]
  workingDirectory: string
  enabled: boolean
  scheduleKind: 'once' | 'interval'
  onceAt: string
  intervalEvery: number
  intervalUnit: 'minutes' | 'hours' | 'days'
  intervalStartAt: string
}

interface AutomationsPanelProps {
  activeAutomation: AutomationDetail | null
  models: ModelSummary[]
  gemmaInstallStates: GemmaInstallState[]
  installedSkills: InstalledSkillRecord[]
  defaultWorkingDirectory: string
  defaultModelTarget: { modelId: string; runtimeId: string }
  newAutomationSeed: number
  onEnsureGemmaModel: (tag: string) => Promise<{
    ok: boolean
    tag: string
    installed: boolean
    cancelled?: boolean
    error?: string
  }>
  onCreateAutomation: (input: {
    name: string
    prompt: string
    runtimeId: string
    modelId: string
    mode: SessionMode
    selectedSkillIds?: string[]
    workingDirectory: string
    enabled: boolean
    schedule: AutomationSchedule
  }) => Promise<AutomationDetail>
  onUpdateAutomation: (
    automationId: string,
    patch: Partial<{
      name: string
      prompt: string
      runtimeId: string
      modelId: string
      mode: SessionMode
      selectedSkillIds: string[]
      workingDirectory: string
      enabled: boolean
      schedule: AutomationSchedule
    }>,
  ) => Promise<AutomationDetail>
  onDeleteAutomation: (automationId: string) => Promise<void>
  onRunNow: (automationId: string) => Promise<void>
  onCancelRun: (automationId: string) => Promise<void>
  onClose?: () => void
}

type RunTab = 'latest' | 'previous'

function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseDatetimeLocal(value: string, fallback: number): number {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatTimestamp(timestamp?: number | null): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return 'Not scheduled'
  }

  return new Date(timestamp).toLocaleString()
}

function formatOperationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function singularUnit(unit: AutomationDraft['intervalUnit']): string {
  return unit.endsWith('s') ? unit.slice(0, -1) : unit
}

function buildScheduleFromDraft(draft: AutomationDraft): AutomationSchedule {
  if (draft.scheduleKind === 'once') {
    return {
      kind: 'once',
      runAt: parseDatetimeLocal(draft.onceAt, Date.now() + 60 * 60 * 1000),
    }
  }

  return {
    kind: 'interval',
    every: Math.max(1, draft.intervalEvery),
    unit: draft.intervalUnit,
    startAt: parseDatetimeLocal(
      draft.intervalStartAt,
      Date.now() + 60 * 60 * 1000,
    ),
  }
}

function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'once') {
    return `Runs once on ${formatTimestamp(schedule.runAt)}`
  }

  const unitLabel =
    schedule.every === 1 ? singularUnit(schedule.unit) : schedule.unit

  return `Runs every ${schedule.every} ${unitLabel}, starting ${formatTimestamp(schedule.startAt)}`
}

function createDefaultDraft(
  defaultModelTarget: { modelId: string; runtimeId: string },
  defaultWorkingDirectory: string,
): AutomationDraft {
  const defaultStart = Date.now() + 60 * 60 * 1000

  return {
    name: 'New Automation',
    prompt: '',
    modelId: defaultModelTarget.modelId,
    runtimeId: defaultModelTarget.runtimeId,
    selectedSkillIds: [],
    workingDirectory: defaultWorkingDirectory,
    enabled: true,
    scheduleKind: 'once',
    onceAt: toDatetimeLocal(defaultStart),
    intervalEvery: 1,
    intervalUnit: 'hours',
    intervalStartAt: toDatetimeLocal(defaultStart),
  }
}

function draftFromAutomation(detail: AutomationDetail): AutomationDraft {
  const fallbackStart = Date.now() + 60 * 60 * 1000

  return {
    id: detail.id,
    name: detail.name,
    prompt: detail.prompt,
    modelId: detail.modelId,
    runtimeId: detail.runtimeId,
    selectedSkillIds: detail.selectedSkillIds,
    workingDirectory: detail.workingDirectory,
    enabled: detail.enabled,
    scheduleKind: detail.schedule.kind,
    onceAt:
      detail.schedule.kind === 'once'
        ? toDatetimeLocal(detail.schedule.runAt)
        : toDatetimeLocal(fallbackStart),
    intervalEvery:
      detail.schedule.kind === 'interval' ? detail.schedule.every : 1,
    intervalUnit:
      detail.schedule.kind === 'interval' ? detail.schedule.unit : 'hours',
    intervalStartAt:
      detail.schedule.kind === 'interval'
        ? toDatetimeLocal(detail.schedule.startAt)
        : toDatetimeLocal(fallbackStart),
  }
}

function runStatusTone(status: AutomationRunRecord['status'] | undefined): string {
  switch (status) {
    case undefined:
      return 'text-zinc-500 dark:text-zinc-400'
    case 'running':
      return 'text-amber-600 dark:text-amber-400'
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'cancelled':
      return 'text-zinc-600 dark:text-zinc-300'
    case 'error':
      return 'text-red-600 dark:text-red-400'
  }
}

function formatRunTrigger(trigger: AutomationRunRecord['trigger']): string {
  return trigger === 'manual' ? 'Manual' : 'Scheduled'
}

function formatRunPerformance(run: AutomationRunRecord): string {
  const parts: string[] = []
  if (run.tokensPerSecond != null) {
    parts.push(`${run.tokensPerSecond.toFixed(1)} TPS`)
  }
  if (run.generatedTokens != null) {
    parts.push(`${run.generatedTokens} tokens`)
  }
  return parts.length > 0 ? parts.join(' • ') : ''
}

const INPUT_CLASS =
  'w-full rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-600'

const INLINE_INPUT_CLASS =
  'rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-900 outline-none transition-colors focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-600'

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
      {children}
    </div>
  )
}

function HeaderButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'neutral' | 'primary' | 'danger' | 'warning'
  title?: string
}) {
  const className =
    tone === 'primary'
      ? 'border border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200'
      : tone === 'danger'
        ? 'border border-zinc-200 text-zinc-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-red-900/60 dark:hover:bg-red-950/20 dark:hover:text-red-400'
        : tone === 'warning'
          ? 'border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300 dark:hover:bg-amber-950/40'
          : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === option.value
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function RunDetailPanel({
  run,
  emptyMessage,
}: {
  run: AutomationRunRecord | null
  emptyMessage: string
}) {
  if (!run) {
    return (
      <div className="rounded-md border border-dashed border-zinc-200 px-4 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {emptyMessage}
      </div>
    )
  }

  const output =
    run.errorMessage
    ?? run.outputText
    ?? (run.status === 'running'
      ? 'Run in progress...'
      : 'No output captured for this run.')

  const performance = formatRunPerformance(run)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={`font-medium uppercase tracking-[0.12em] ${runStatusTone(run.status)}`}>
          {run.status}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">·</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {formatRunTrigger(run.trigger)}
        </span>
        <span className="text-zinc-400 dark:text-zinc-600">·</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {formatTimestamp(run.startedAt)}
        </span>
        {run.finishedAt && (
          <>
            <span className="text-zinc-400 dark:text-zinc-600">→</span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {formatTimestamp(run.finishedAt)}
            </span>
          </>
        )}
        {performance && (
          <>
            <span className="text-zinc-400 dark:text-zinc-600">·</span>
            <span className="text-zinc-500 dark:text-zinc-400">{performance}</span>
          </>
        )}
      </div>

      {run.summary && (
        <div className="text-sm text-zinc-700 dark:text-zinc-300">
          {run.summary}
        </div>
      )}

      <pre className="max-h-60 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        {output}
      </pre>

      <details className="group rounded-md border border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
          Detailed log
          <ChevronDown size={14} className="text-zinc-400 transition-transform group-open:rotate-180" />
        </summary>
        <pre className="max-h-[360px] overflow-y-auto border-t border-zinc-200 bg-white p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
          {run.logs.length > 0
            ? run.logs
                .map((log) =>
                  [
                    `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.layer} ${log.event}`,
                    `summary: ${log.summary}`,
                    JSON.stringify(log.data, null, 2),
                  ].join('\n'),
                )
                .join('\n\n')
            : 'No logs for this run.'}
        </pre>
      </details>
    </div>
  )
}

export function AutomationsPanel({
  activeAutomation,
  models,
  gemmaInstallStates,
  installedSkills,
  defaultWorkingDirectory,
  defaultModelTarget,
  newAutomationSeed,
  onEnsureGemmaModel,
  onCreateAutomation,
  onUpdateAutomation,
  onDeleteAutomation,
  onRunNow,
  onCancelRun,
  onClose,
}: AutomationsPanelProps) {
  const defaultDraft = useMemo(
    () => createDefaultDraft(defaultModelTarget, defaultWorkingDirectory),
    [
      defaultModelTarget.modelId,
      defaultModelTarget.runtimeId,
      defaultWorkingDirectory,
    ],
  )
  const [draft, setDraft] = useState<AutomationDraft>(() => defaultDraft)
  const [editorSource, setEditorSource] = useState<string | 'new'>('new')
  const [activeTab, setActiveTab] = useState<RunTab>('latest')
  const [selectedPreviousRunId, setSelectedPreviousRunId] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [lastHandledNewAutomationSeed, setLastHandledNewAutomationSeed] = useState(
    newAutomationSeed,
  )

  useEffect(() => {
    if (activeAutomation) {
      if (editorSource !== activeAutomation.id) {
        setDraft(draftFromAutomation(activeAutomation))
        setEditorSource(activeAutomation.id)
        setActiveTab('latest')
        setOperationError(null)
      }
      return
    }

    if (
      editorSource !== 'new'
      || lastHandledNewAutomationSeed !== newAutomationSeed
    ) {
      setDraft(defaultDraft)
      setEditorSource('new')
      setActiveTab('latest')
      setSelectedPreviousRunId(null)
      setAdvancedOpen(false)
      setOperationError(null)
      setLastHandledNewAutomationSeed(newAutomationSeed)
    }
  }, [
    activeAutomation,
    defaultDraft,
    editorSource,
    lastHandledNewAutomationSeed,
    newAutomationSeed,
  ])

  const orderedRuns = useMemo(
    () =>
      activeAutomation
        ? [...activeAutomation.runs].sort((left, right) => right.startedAt - left.startedAt)
        : [],
    [activeAutomation],
  )
  const latestRun = orderedRuns[0] ?? null
  const previousRuns = orderedRuns.slice(1)

  useEffect(() => {
    if (!previousRuns.length) {
      setSelectedPreviousRunId(null)
      return
    }

    const selectionStillExists = selectedPreviousRunId
      ? previousRuns.some((run) => run.id === selectedPreviousRunId)
      : false

    if (!selectionStillExists) {
      setSelectedPreviousRunId(previousRuns[0]?.id ?? null)
    }
  }, [previousRuns, selectedPreviousRunId])

  const selectedPreviousRun = useMemo(
    () =>
      previousRuns.find((run) => run.id === selectedPreviousRunId)
      ?? previousRuns[0]
      ?? null,
    [previousRuns, selectedPreviousRunId],
  )
  const schedule = useMemo(() => buildScheduleFromDraft(draft), [draft])
  const scheduleDescription = useMemo(
    () => describeSchedule(schedule),
    [schedule],
  )
  const isEditing = Boolean(draft.id)
  const isRunning = activeAutomation?.lastRunStatus === 'running'
  const canSubmit =
    draft.name.trim().length > 0
    && draft.prompt.trim().length > 0
    && draft.modelId.length > 0
    && draft.workingDirectory.trim().length > 0
  const headerTitle = isEditing ? draft.name : 'New automation'
  const headerSubtitle = isEditing
    ? `${scheduleDescription}${activeAutomation?.enabled === false ? ' · Paused' : ''}`
    : scheduleDescription

  const persistDraft = async (): Promise<AutomationDetail | null> => {
    if (!canSubmit) {
      return null
    }

    setSaving(true)
    setOperationError(null)
    try {
      const gemmaEntry = findGemmaCatalogEntryByTag(draft.modelId)
      if (
        gemmaEntry
        && draft.runtimeId === 'ollama-native'
        && isGuidedGemmaMissing(models, draft.modelId, gemmaInstallStates)
      ) {
        const result = await onEnsureGemmaModel(draft.modelId)
        if (!result.ok) {
          return null
        }
      }

      const savedAutomation = draft.id
        ? await onUpdateAutomation(draft.id, {
            name: draft.name,
            prompt: draft.prompt,
            runtimeId: draft.runtimeId,
            modelId: draft.modelId,
            mode: 'build',
            selectedSkillIds: draft.selectedSkillIds,
            workingDirectory: draft.workingDirectory,
            enabled: draft.enabled,
            schedule,
          })
        : await onCreateAutomation({
            name: draft.name,
            prompt: draft.prompt,
            runtimeId: draft.runtimeId,
            modelId: draft.modelId,
            mode: 'build',
            selectedSkillIds: draft.selectedSkillIds,
            workingDirectory: draft.workingDirectory,
            enabled: true,
            schedule,
          })

      setDraft(draftFromAutomation(savedAutomation))
      setEditorSource(savedAutomation.id)
      setActiveTab('latest')
      return savedAutomation
    } catch (error) {
      setOperationError(formatOperationError(error))
      return null
    } finally {
      setSaving(false)
    }
  }

  const persistAndRun = async (): Promise<void> => {
    const savedAutomation = await persistDraft()
    if (!savedAutomation) {
      return
    }

    setRunningNow(true)
    setOperationError(null)
    try {
      await onRunNow(savedAutomation.id)
    } catch (error) {
      setOperationError(formatOperationError(error))
    } finally {
      setRunningNow(false)
    }
  }

  const cancelRun = async (): Promise<void> => {
    if (!draft.id) {
      return
    }

    setCancelling(true)
    setOperationError(null)
    try {
      await onCancelRun(draft.id)
    } catch (error) {
      setOperationError(formatOperationError(error))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="surface-canvas flex h-full min-h-0 flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 px-6 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {headerTitle}
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
            {headerSubtitle}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {onClose ? (
            <HeaderButton
              onClick={onClose}
              title="Close automations"
            >
              <X size={13} />
            </HeaderButton>
          ) : null}
          {isEditing ? (
            <>
              <HeaderButton
                onClick={() => void persistDraft()}
                disabled={!canSubmit || saving || runningNow}
                tone="primary"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </HeaderButton>
              <HeaderButton
                onClick={() => void persistAndRun()}
                disabled={!canSubmit || saving || runningNow || isRunning || cancelling}
              >
                {runningNow ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Run now
              </HeaderButton>
              {isRunning && (
                <HeaderButton
                  onClick={() => void cancelRun()}
                  disabled={!draft.id || cancelling}
                  tone="warning"
                >
                  {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />}
                  Cancel
                </HeaderButton>
              )}
              <HeaderButton
                onClick={() => {
                  if (!draft.id) {
                    return
                  }

                  setOperationError(null)
                  void onDeleteAutomation(draft.id).catch((error) => {
                    setOperationError(formatOperationError(error))
                  })
                }}
                disabled={!draft.id || saving || runningNow || cancelling}
                tone="danger"
                title="Delete automation"
              >
                <Trash2 size={13} />
              </HeaderButton>
            </>
          ) : (
            <>
              <HeaderButton
                onClick={() => void persistDraft()}
                disabled={!canSubmit || saving || runningNow}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </HeaderButton>
              <HeaderButton
                onClick={() => void persistAndRun()}
                disabled={!canSubmit || saving || runningNow}
                tone="primary"
              >
                {runningNow ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Save & run
              </HeaderButton>
            </>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          <div className="flex gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">YOLO execution</div>
              <div className="mt-0.5 leading-5">
                Automations run unattended in YOLO mode and can execute allowed build tools without asking first. Schedule only prompts and workspaces you trust.
              </div>
            </div>
          </div>

          {operationError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
              {operationError}
            </div>
          )}

          {/* Name */}
          <div>
            <SectionLabel>Name</SectionLabel>
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              className={INPUT_CLASS}
            />
          </div>

          {/* Schedule */}
          <div>
            <SectionLabel>Schedule</SectionLabel>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                options={[
                  { value: 'once', label: 'Once' },
                  { value: 'interval', label: 'Recurring' },
                ]}
                value={draft.scheduleKind}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    scheduleKind: value,
                  }))
                }
              />

              {draft.scheduleKind === 'once' ? (
                <input
                  type="datetime-local"
                  value={draft.onceAt}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      onceAt: event.target.value,
                    }))
                  }
                  className={INLINE_INPUT_CLASS}
                />
              ) : (
                <>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Every</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.intervalEvery}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        intervalEvery: Number(event.target.value) || 1,
                      }))
                    }
                    className={`${INLINE_INPUT_CLASS} w-16`}
                  />
                  <select
                    value={draft.intervalUnit}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        intervalUnit: event.target.value as 'minutes' | 'hours' | 'days',
                      }))
                    }
                    className={INLINE_INPUT_CLASS}
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">from</span>
                  <input
                    type="datetime-local"
                    value={draft.intervalStartAt}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        intervalStartAt: event.target.value,
                      }))
                    }
                    className={INLINE_INPUT_CLASS}
                  />
                </>
              )}
            </div>
            <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              {scheduleDescription}
            </p>
          </div>

          {/* Prompt */}
          <div>
            <SectionLabel>Prompt</SectionLabel>
            <textarea
              value={draft.prompt}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  prompt: event.target.value,
                }))
              }
              rows={10}
              placeholder="Describe the recurring build task you want Gemma Desktop to run."
              className={`${INPUT_CLASS} leading-6`}
            />
          </div>

          {/* Advanced */}
          <details
            open={advancedOpen}
            onToggle={(event) => {
              setAdvancedOpen(event.currentTarget.open)
            }}
            className="rounded-md border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/50"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                Advanced
                <span className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
                  Model · Working directory · Skills{isEditing ? ' · State' : ''}
                </span>
              </span>
              <ChevronDown
                size={14}
                className={`text-zinc-400 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              />
            </summary>
            <div className="space-y-4 border-t border-zinc-200 p-3 dark:border-zinc-800">
              <div>
                <SectionLabel>Model</SectionLabel>
                      <ModelSelector
                        models={models}
                        gemmaInstallStates={gemmaInstallStates}
                        selectedModelId={draft.modelId}
                        selectedRuntimeId={draft.runtimeId}
                        mode="build"
                        layout="expanded"
                  rootClassName="relative w-full"
                  menuPlacement="bottom"
                  menuClassName="absolute right-0 top-full z-50 mt-2 w-[36rem] max-w-[calc(100vw-5rem)] max-h-[360px] overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
                  onSelect={async ({ modelId, runtimeId }) => {
                    const gemmaEntry = findGemmaCatalogEntryByTag(modelId)
                    if (
                      gemmaEntry
                      && runtimeId === 'ollama-native'
                      && isGuidedGemmaMissing(models, modelId, gemmaInstallStates)
                    ) {
                      const result = await onEnsureGemmaModel(modelId)
                      if (!result.ok) {
                        return
                      }
                    }

                    setDraft((current) => ({
                      ...current,
                      runtimeId,
                      modelId,
                    }))
                  }}
                />
              </div>

              <div>
                <SectionLabel>Working directory</SectionLabel>
                <div className="flex items-center gap-2">
                  <input
                    value={draft.workingDirectory}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        workingDirectory: event.target.value,
                      }))
                    }
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const nextPath = await window.gemmaDesktopBridge.folders.pickDirectory(
                        draft.workingDirectory,
                      )
                      if (nextPath) {
                        setDraft((current) => ({
                          ...current,
                          workingDirectory: nextPath,
                        }))
                      }
                    }}
                    className="flex-shrink-0 rounded-md border border-zinc-200 bg-white p-2 text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    title="Pick working directory"
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              <div>
                <SectionLabel>Skills</SectionLabel>
                {installedSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {installedSkills.map((skill) => {
                      const selected = draft.selectedSkillIds.includes(skill.id)
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              selectedSkillIds: selected
                                ? current.selectedSkillIds.filter((id) => id !== skill.id)
                                : [...current.selectedSkillIds, skill.id],
                            }))
                          }
                          className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                            selected
                              ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
                          }`}
                          title={skill.description}
                        >
                          {skill.name}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    No skills installed yet.
                  </div>
                )}
              </div>

              {isEditing && (
                <div>
                  <SectionLabel>State</SectionLabel>
                  <SegmentedControl
                    options={[
                      { value: 'active', label: 'Active' },
                      { value: 'paused', label: 'Paused' },
                    ]}
                    value={draft.enabled ? 'active' : 'paused'}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        enabled: value === 'active',
                      }))
                    }
                  />
                </div>
              )}
            </div>
          </details>

          {/* Run Results — only when editing */}
          {isEditing && (
            <div className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
              <div className="mb-3 flex items-center justify-between gap-3">
                <SectionLabel>Run results</SectionLabel>
                <SegmentedControl
                  options={[
                    { value: 'latest', label: 'Latest' },
                    { value: 'previous', label: 'Previous' },
                  ]}
                  value={activeTab}
                  onChange={setActiveTab}
                />
              </div>

              {activeTab === 'latest' ? (
                <RunDetailPanel
                  run={latestRun}
                  emptyMessage="No runs yet. Hit Run now to trigger one."
                />
              ) : previousRuns.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
                  <div className="space-y-1.5">
                    {previousRuns.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => setSelectedPreviousRunId(run.id)}
                        className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                          selectedPreviousRun?.id === run.id
                            ? 'border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900'
                            : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900'
                        }`}
                      >
                        <div className={`text-[10px] font-medium uppercase tracking-[0.12em] ${runStatusTone(run.status)}`}>
                          {run.status}
                        </div>
                        <div className="mt-0.5 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          {run.summary}
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          {formatTimestamp(run.startedAt)}
                        </div>
                      </button>
                    ))}
                  </div>
                  <RunDetailPanel
                    run={selectedPreviousRun}
                    emptyMessage="Select a previous run to inspect it."
                  />
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-zinc-200 px-4 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  No previous runs yet.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
