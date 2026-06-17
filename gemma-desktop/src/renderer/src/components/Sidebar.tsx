import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  FolderOpen,
  GripVertical,
  Loader2,
  PanelLeftClose,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Power,
  Search,
  SmilePlus,
  SquareTerminal,
  Sparkles,
  Stethoscope,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { GpuWave } from '@/components/GpuWave'
import {
  MemoryStatusIndicator,
  MemoryStatusPanel,
} from '@/components/MemoryStatusIndicator'
import {
  basenameFromPath,
  buildSidebarModel,
  findActiveProjectForSession,
  type SessionIconGroup,
  type SessionProjectGroup,
} from '@/lib/sidebarModel'
import type {
  AppSettings,
  AppView,
  AutomationSummary,
  ModelSummary,
  ModelTokenUsageReport,
  PrimaryModelAvailabilityIssue,
  SessionSearchResult,
  SessionSummary,
  SidebarState,
  SystemStats,
  TerminalAppInfo,
} from '@/types'
import type {
  DefaultModelLifecycleStepResult,
  LoadDefaultModelsResult,
} from '@shared/modelLifecycle'
import { normalizeConversationIcon } from '@shared/conversationIcon'
import {
  DEFAULT_MODEL_SELECTION_SETTINGS,
  normalizeProviderRuntimeId,
} from '@shared/sessionModelDefaults'
import {
  buildModelTargetOptions,
  groupModelTargetOptions,
  type ModelTargetOption,
  type ModelTargetOptionGroup,
} from '@/components/ModelTargetPicker'
import { ModelOptimizationBadges } from '@/components/ModelOptimizationBadges'
import { Toggle } from '@/components/settings/Primitives'

type SidebarSearchStatus = 'idle' | 'searching' | 'ready' | 'error'

const CONVERSATION_ICON_SUGGESTIONS = [
  { emoji: '⭐', words: 'star favorite important pinned' },
  { emoji: '🔥', words: 'fire hot urgent active' },
  { emoji: '🧪', words: 'test experiment lab regression' },
  { emoji: '🚀', words: 'rocket launch shipping release' },
  { emoji: '🧠', words: 'brain thinking research idea' },
  { emoji: '🛠️', words: 'tools build fix maintenance' },
  { emoji: '📚', words: 'docs documentation reading reference' },
  { emoji: '💬', words: 'chat conversation talk support' },
  { emoji: '🎯', words: 'target goal focus priority' },
  { emoji: '✅', words: 'done complete verified check' },
  { emoji: '⚙️', words: 'settings config runtime system' },
  { emoji: '🔒', words: 'security private locked auth' },
  { emoji: '📦', words: 'package release dependency bundle' },
  { emoji: '🌐', words: 'web browser network internet' },
  { emoji: '💡', words: 'idea insight note lightbulb' },
]

function normalizeIconInput(input: string): string {
  return normalizeConversationIcon(input) ?? ''
}

function modelSelectionFeedbackKey(modelSelection: AppSettings['modelSelection']): string {
  return [
    modelSelection.mainModel.runtimeId,
    modelSelection.mainModel.modelId,
    modelSelection.helperModelEnabled ? 'helper-on' : 'helper-off',
    modelSelection.helperModelEnabled ? modelSelection.helperModel.runtimeId : '',
    modelSelection.helperModelEnabled ? modelSelection.helperModel.modelId : '',
  ].join('\u001f')
}

interface SidebarInitialSearchState {
  query: string
  status: SidebarSearchStatus
  results: SessionSearchResult[]
  errorMessage?: string | null
}

interface SidebarProps {
  sessions: SessionSummary[]
  sidebarState: SidebarState
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateProject: () => void
  onCreateSessionInProject: (path: string) => void
  conversationCreationPending?: boolean
  onOpenProject: (path: string) => void
  onCloseProject: (path: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, title: string, conversationIcon: string | null) => void
  onCloseProcess: (sessionId: string, terminalId: string) => void
  onOpenProcessPreview?: (sessionId: string, previewUrl: string) => void
  onPinSession: (id: string) => void
  onUnpinSession: (id: string) => void
  onFlagFollowUp: (id: string) => void
  onUnflagFollowUp: (id: string) => void
  onMovePinnedSession: (id: string, toIndex: number) => void
  onMoveProjectSession: (id: string, toIndex: number) => void
  onClearSessionOrder: (id: string) => void
  onMoveProject: (projectPath: string, toIndex: number) => void
  onClearProjectOrder: (projectPath: string) => void
  automations: AutomationSummary[]
  activeAutomationId: string | null
  onSelectAutomation: (id: string) => void
  onNewAutomation: () => void
  currentView: AppView
  modeToolbar?: ReactNode
  onOpenSettings: () => void
  onOpenDoctor: () => void
  doctorOpen?: boolean
  preferredTerminalId?: string | null
  onOpenSkills: () => void
  selectedSkillCount: number
  onCollapse?: () => void
  systemStats: SystemStats
  models: ModelSummary[]
  modelSelection?: AppSettings['modelSelection']
  defaultModelSelection?: AppSettings['modelSelection']
  modelAvailabilityIssues?: PrimaryModelAvailabilityIssue[]
  modelTokenUsage?: ModelTokenUsageReport
  activeModelId?: string | null
  activeRuntimeId?: string | null
  helperModelId?: string | null
  helperRuntimeId?: string | null
  modelSelectionDisabledReason?: string | null
  reloadModelsDisabledReason?: string | null
  onLoadModelSelection?: (
    modelSelection: AppSettings['modelSelection'],
  ) => Promise<LoadDefaultModelsResult> | void
  onReloadModels?: () => Promise<LoadDefaultModelsResult> | void
  initialSearchState?: SidebarInitialSearchState
}

type ModelSelectionLoadFeedback = {
  tone: 'info' | 'success' | 'error'
  message: string
  details: string[]
  selectionKey: string
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`

  return new Date(timestamp).toLocaleDateString()
}

function automationStatusTone(status?: AutomationSummary['lastRunStatus']): string {
  switch (status) {
    case undefined:
      return 'bg-zinc-400'
    case 'running':
      return 'bg-amber-500'
    case 'success':
      return 'bg-emerald-500'
    case 'cancelled':
      return 'bg-zinc-500'
    case 'error':
      return 'bg-red-500'
  }
}

function modelTargetValue(target: { modelId: string; runtimeId: string }): string {
  return `${normalizeProviderRuntimeId(target.runtimeId)}\u001f${target.modelId}`
}

function modelTargetsMatch(
  left: { modelId: string; runtimeId: string },
  right: { modelId: string; runtimeId: string },
): boolean {
  return modelTargetValue(left) === modelTargetValue(right)
}

function findModelTargetOption(
  target: { modelId: string; runtimeId: string },
  options: ModelTargetOption[],
): ModelTargetOption | undefined {
  return options.find((candidate) => modelTargetsMatch(candidate, target))
}

function findModelAvailabilityIssue(
  target: { modelId: string; runtimeId: string },
  issues: PrimaryModelAvailabilityIssue[],
): PrimaryModelAvailabilityIssue | null {
  const runtimeId = normalizeProviderRuntimeId(target.runtimeId)
  return issues.find((issue) =>
    issue.modelId === target.modelId
    && normalizeProviderRuntimeId(issue.runtimeId) === runtimeId
  ) ?? null
}

function formatModelContextLength(contextLength: number | undefined): string | null {
  if (!contextLength) {
    return null
  }
  if (contextLength >= 1024) {
    return `${Math.round(contextLength / 1024)}K ctx`
  }
  return `${contextLength} ctx`
}

function formatModelStatus(status: ModelTargetOption['status']): string | null {
  switch (status) {
    case 'loaded':
      return 'Loaded'
    case 'loading':
      return 'Loading'
    case 'available':
      return 'Available'
    case undefined:
      return null
  }
}

function modelStatusClassName(status: ModelTargetOption['status']): string {
  switch (status) {
    case 'loaded':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25'
    case 'loading':
      return 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25'
    case 'available':
    case undefined:
      return 'bg-zinc-100 text-zinc-500 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700'
  }
}

function modelOptionSearchText(option: ModelTargetOption): string {
  return [
    option.label,
    option.modelId,
    option.runtimeId,
    option.providerLabel,
    option.inferenceTypeLabel,
    option.parameterCount,
    option.quantization,
    option.contextLength != null ? String(option.contextLength) : undefined,
    ...(option.optimizationTags ?? []),
  ].filter(Boolean).join(' ').toLowerCase()
}

function SelectedModelSummary({
  roleLabel,
  target,
  options,
  issue,
  muted = false,
}: {
  roleLabel: string
  target: { modelId: string; runtimeId: string }
  options: ModelTargetOption[]
  issue: PrimaryModelAvailabilityIssue | null
  muted?: boolean
}) {
  const option = findModelTargetOption(target, options)
  const details = option
    ? [
        option.providerLabel,
        option.parameterCount,
        option.quantization,
        formatModelContextLength(option.contextLength) ?? undefined,
      ].filter(Boolean).join(' - ')
    : normalizeProviderRuntimeId(target.runtimeId)

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        muted
          ? 'border-zinc-200/70 bg-zinc-50/70 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-500'
          : 'border-zinc-200 bg-zinc-50/80 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/45 dark:text-zinc-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
            {roleLabel}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
            <span className="truncate">{option?.label ?? target.modelId}</span>
            {issue && (
              <AlertTriangle
                size={12}
                className="shrink-0 text-red-500 dark:text-red-400"
                aria-label={`${roleLabel} model failed to load`}
              />
            )}
          </div>
        </div>
        <ModelOptimizationBadges tags={option?.optimizationTags} compact />
      </div>
      <div className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
        {muted ? 'Off' : details}
      </div>
    </div>
  )
}

function ModelSelectionDialog({
  modelSelection,
  modelTargetGroups,
  modelTargetOptions,
  primaryModelIssue,
  secondaryModelIssue,
  modelSelectionDisabledReason,
  reloadModelsDisabledReason,
  modelSelectionLoadPending,
  modelSelectionLoadFeedback,
  onClose,
  onLoadModelSelection,
}: {
  modelSelection: AppSettings['modelSelection']
  modelTargetGroups: ModelTargetOptionGroup[]
  modelTargetOptions: ModelTargetOption[]
  primaryModelIssue: PrimaryModelAvailabilityIssue | null
  secondaryModelIssue: PrimaryModelAvailabilityIssue | null
  modelSelectionDisabledReason: string | null
  reloadModelsDisabledReason: string | null
  modelSelectionLoadPending: boolean
  modelSelectionLoadFeedback: ModelSelectionLoadFeedback | null
  onClose: () => void
  onLoadModelSelection: (modelSelection: AppSettings['modelSelection']) => void
}) {
  const [activeRole, setActiveRole] = useState<'mainModel' | 'helperModel'>('mainModel')
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [draftSelection, setDraftSelection] =
    useState<AppSettings['modelSelection']>(modelSelection)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const providerLabels = modelTargetGroups.map((group) => group.providerLabel)
  const selectedTarget = draftSelection[activeRole]
  const selectedOption = findModelTargetOption(selectedTarget, modelTargetOptions)
  const selectedProvider = activeProvider && providerLabels.includes(activeProvider)
    ? activeProvider
    : selectedOption?.providerLabel ?? providerLabels[0] ?? null
  const normalizedQuery = query.trim().toLowerCase()
  const providerGroups = selectedProvider
    ? modelTargetGroups.filter((group) => group.providerLabel === selectedProvider)
    : modelTargetGroups
  const visibleGroups = (normalizedQuery ? modelTargetGroups : providerGroups)
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        !normalizedQuery || modelOptionSearchText(option).includes(normalizedQuery),
      ),
    }))
    .filter((group) => group.options.length > 0)
  const modelListDisabled =
    Boolean(modelSelectionDisabledReason)
    || (activeRole === 'helperModel' && !draftSelection.helperModelEnabled)
  const primaryDraftIssue = modelTargetsMatch(draftSelection.mainModel, modelSelection.mainModel)
    ? primaryModelIssue
    : null
  const secondaryDraftIssue =
    draftSelection.helperModelEnabled
    && modelTargetsMatch(draftSelection.helperModel, modelSelection.helperModel)
      ? secondaryModelIssue
      : null
  const activeIssue = activeRole === 'mainModel' ? primaryDraftIssue : secondaryDraftIssue
  const draftSelectionKey = modelSelectionFeedbackKey(draftSelection)
  const savedSelectionKey = modelSelectionFeedbackKey(modelSelection)
  const hasDraftChanges = draftSelectionKey !== savedSelectionKey
  const footerStatus = modelSelectionLoadFeedback
    ? modelSelectionLoadFeedback
    : activeIssue
      ? {
          tone: 'error' as const,
          message: activeIssue.message,
          details: [],
          selectionKey: draftSelectionKey,
        }
      : reloadModelsDisabledReason
        ? {
            tone: 'info' as const,
            message: reloadModelsDisabledReason,
            details: [],
            selectionKey: draftSelectionKey,
          }
        : {
            tone: 'info' as const,
            message: hasDraftChanges ? 'Ready to save and load.' : 'Ready',
            details: [],
            selectionKey: draftSelectionKey,
          }

  useEffect(() => {
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  useEffect(() => {
    setDraftSelection(modelSelection)
  }, [modelSelection])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    setActiveProvider(null)
  }, [activeRole])

  const selectOption = (option: ModelTargetOption) => {
    if (modelListDisabled) {
      return
    }
    setDraftSelection((current) => ({
      ...current,
      [activeRole]: {
        modelId: option.modelId,
        runtimeId: option.runtimeId,
      },
    }))
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-zinc-950/35 p-4 backdrop-blur-sm dark:bg-black/55"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global model settings"
        className="flex h-[min(760px,calc(100vh-2rem))] w-[min(1040px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_28px_90px_-40px_rgba(24,24,27,0.75)] dark:border-zinc-700 dark:bg-zinc-950 dark:shadow-[0_34px_110px_-42px_rgba(0,0,0,0.95)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              Global Models
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>{modelTargetOptions.length} selectable models</span>
              <span>{providerLabels.length} providers</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:focus-visible:ring-zinc-700"
            aria-label="Close global model settings"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 overflow-y-auto border-b border-zinc-200 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/35 md:border-b-0 md:border-r">
            <div className="space-y-2">
              <SelectedModelSummary
                roleLabel="Primary"
                target={draftSelection.mainModel}
                options={modelTargetOptions}
                issue={primaryDraftIssue}
              />
              <SelectedModelSummary
                roleLabel="Secondary"
                target={draftSelection.helperModel}
                options={modelTargetOptions}
                issue={secondaryDraftIssue}
                muted={!draftSelection.helperModelEnabled}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-zinc-200/70 p-1 dark:bg-zinc-800/80">
              {([
                ['mainModel', 'Primary'],
                ['helperModel', 'Secondary'],
              ] as const).map(([role, label]) => {
                const selected = activeRole === role
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setActiveRole(role)}
                    className={`min-w-0 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                      selected
                        ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-zinc-50'
                        : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
              <div>
                <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  Secondary Model
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {draftSelection.helperModelEnabled ? 'On' : 'Off'}
                </div>
              </div>
              <Toggle
                size="sm"
                ariaLabel="Toggle secondary model"
                checked={draftSelection.helperModelEnabled}
                disabled={Boolean(modelSelectionDisabledReason)}
                onChange={() => {
                  setDraftSelection((current) => ({
                    ...current,
                    helperModelEnabled: !current.helperModelEnabled,
                  }))
                }}
              />
            </div>
            {modelSelectionDisabledReason && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
                {modelSelectionDisabledReason}
              </div>
            )}
          </aside>

          <section className="flex min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    {activeRole === 'mainModel' ? 'Primary Model' : 'Secondary Model'}
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                    <span className="truncate">
                      {selectedOption?.label ?? selectedTarget.modelId}
                    </span>
                    <ModelOptimizationBadges tags={selectedOption?.optimizationTags} compact />
                    {activeIssue && (
                      <AlertTriangle
                        size={14}
                        className="shrink-0 text-red-500 dark:text-red-400"
                        aria-label={`${activeRole === 'mainModel' ? 'Primary' : 'Secondary'} model failed to load`}
                      />
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                  <Search size={14} className="shrink-0 text-zinc-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search models"
                    className="min-w-[220px] flex-1 bg-transparent text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>

              {providerLabels.length > 0 && (
                <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
                  {providerLabels.map((providerLabel) => {
                    const selected = providerLabel === selectedProvider && !normalizedQuery
                    const count = modelTargetGroups.find((group) => group.providerLabel === providerLabel)?.options.length ?? 0
                    return (
                      <button
                        key={providerLabel}
                        type="button"
                        onClick={() => {
                          setQuery('')
                          setActiveProvider(providerLabel)
                        }}
                        className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                          selected
                            ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                            : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-950 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                        }`}
                      >
                        {providerLabel}
                        <span className={selected ? 'ml-1 text-zinc-300 dark:text-zinc-600' : 'ml-1 text-zinc-400'}>
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div
              role="listbox"
              aria-label={activeRole === 'mainModel' ? 'Primary model' : 'Secondary model'}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
            >
              {activeRole === 'helperModel' && !draftSelection.helperModelEnabled ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                  Secondary model is off.
                </div>
              ) : visibleGroups.length === 0 ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                  No models match this search.
                </div>
              ) : (
                <div className="space-y-5">
                  {visibleGroups.map((group) => (
                    <div key={group.providerLabel}>
                      {normalizedQuery && (
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-500">
                          {group.providerLabel}
                        </div>
                      )}
                      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                        {group.options.map((option) => {
                          const selected = modelTargetsMatch(option, selectedTarget)
                          const statusLabel = formatModelStatus(option.status)
                          const contextLabel = formatModelContextLength(option.contextLength)
                          const detailChips = [
                            option.parameterCount,
                            option.quantization,
                            contextLabel ?? undefined,
                          ].filter(Boolean)
                          return (
                            <button
                              key={modelTargetValue(option)}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              disabled={modelListDisabled}
                              onClick={() => selectOption(option)}
                              className={`flex h-[112px] w-full flex-col overflow-hidden rounded-lg border px-3 py-3 text-left outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                                selected
                                  ? 'border-indigo-300 bg-indigo-50 text-zinc-950 ring-1 ring-indigo-200 dark:border-indigo-500/50 dark:bg-indigo-500/10 dark:text-zinc-50 dark:ring-indigo-500/25'
                                  : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:focus-visible:ring-zinc-700'
                              }`}
                            >
                              <span className="flex min-w-0 items-start justify-between gap-3">
                                <span className="min-w-0">
                                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                                    <span className="truncate">{option.label}</span>
                                    <ModelOptimizationBadges
                                      tags={option.optimizationTags}
                                      selected={selected}
                                      compact
                                    />
                                  </span>
                                  <span className="mt-1 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                    {option.runtimeId}
                                  </span>
                                </span>
                                <span
                                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                                    selected
                                      ? 'bg-indigo-600 text-white dark:bg-indigo-400 dark:text-zinc-950'
                                      : 'opacity-0'
                                  }`}
                                  aria-hidden="true"
                                >
                                  <Check size={14} />
                                </span>
                              </span>
                              <span className="mt-auto flex h-6 flex-wrap gap-1.5 overflow-hidden">
                                {statusLabel && (
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${modelStatusClassName(option.status)}`}>
                                    {statusLabel}
                                  </span>
                                )}
                                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800">
                                  {option.inferenceTypeLabel}
                                </span>
                                {detailChips.map((detail) => (
                                  <span
                                    key={detail}
                                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800"
                                  >
                                    {detail}
                                  </span>
                                ))}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="h-[148px] shrink-0 border-t border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    disabled={
                      modelSelectionLoadPending
                      || Boolean(reloadModelsDisabledReason)
                    }
                    onClick={() => onLoadModelSelection(draftSelection)}
                    className="inline-flex h-9 w-40 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-semibold text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                    title={
                      reloadModelsDisabledReason
                        ?? 'Save and load the global model selection'
                    }
                  >
                    {modelSelectionLoadPending
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Power size={13} />}
                    {modelSelectionLoadPending ? 'Loading...' : 'Save and Load'}
                  </button>
                  {reloadModelsDisabledReason && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {reloadModelsDisabledReason}
                    </div>
                  )}
                </div>
                <div
                  aria-live="polite"
                  className={`mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border px-3 py-2 text-xs leading-5 ${
                    footerStatus.tone === 'success'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
                      : footerStatus.tone === 'error'
                        ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300'
                  }`}
                >
                  <div className="font-medium">{footerStatus.message}</div>
                  {footerStatus.details.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {footerStatus.details.map((detail, index) => (
                        <li key={`${detail}-${index}`}>{detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function formatDefaultModelLoadStep(
  step: DefaultModelLifecycleStepResult,
): string {
  const target = step.runtimeId && step.modelId
    ? `${step.runtimeId}/${step.modelId}`
    : ''
  const roles = step.roles && step.roles.length > 0
    ? `${step.roles.join(' + ')} model`
    : ''
  const label = [roles, target].filter(Boolean).join(' - ')
  const body = step.error ?? step.message ?? 'Operation did not complete.'
  return label ? `${label}: ${body}` : body
}

function buildProcessHoverText(
  command: string,
  workingDirectory: string,
  previewText: string,
): string {
  return [
    command,
    workingDirectory,
    previewText || 'No output recorded yet.',
  ].join('\n\n')
}

export function getSkillsButtonClassName(selectedSkillCount: number): string {
  if (selectedSkillCount > 0) {
    return 'relative rounded-lg border px-2 py-1.5 shadow-sm transition-all border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 text-sky-700 hover:border-sky-300 hover:from-sky-100 hover:to-cyan-100 dark:border-sky-500/25 dark:bg-gradient-to-br dark:from-sky-950/70 dark:to-cyan-950/55 dark:text-sky-300 dark:hover:border-sky-400/35 dark:hover:from-sky-950/80 dark:hover:to-cyan-950/65'
  }

  return 'relative rounded-lg border px-2 py-1.5 shadow-sm transition-all border-cyan-200/80 bg-gradient-to-br from-cyan-50 to-teal-50 text-cyan-700 hover:border-cyan-300 hover:from-cyan-100 hover:to-teal-100 dark:border-cyan-500/20 dark:bg-gradient-to-br dark:from-cyan-950/65 dark:to-teal-950/55 dark:text-cyan-300 dark:hover:border-cyan-400/30 dark:hover:from-cyan-950/80 dark:hover:to-teal-950/70'
}

export function Sidebar({
  sessions,
  sidebarState,
  activeSessionId,
  onSelectSession,
  onCreateProject,
  onCreateSessionInProject,
  conversationCreationPending = false,
  onOpenProject,
  onCloseProject,
  onDeleteSession,
  onRenameSession,
  onCloseProcess,
  onOpenProcessPreview,
  onPinSession,
  onUnpinSession,
  onFlagFollowUp,
  onUnflagFollowUp,
  onMovePinnedSession,
  onMoveProjectSession,
  onClearSessionOrder,
  onMoveProject,
  onClearProjectOrder,
  automations,
  activeAutomationId,
  onSelectAutomation,
  onNewAutomation,
  currentView,
  modeToolbar,
  onOpenSettings,
  onOpenDoctor,
  doctorOpen = false,
  preferredTerminalId = null,
  onOpenSkills,
  selectedSkillCount,
  onCollapse,
  systemStats,
  models,
  modelSelection = DEFAULT_MODEL_SELECTION_SETTINGS,
  defaultModelSelection,
  modelAvailabilityIssues = [],
  modelTokenUsage,
  activeModelId = null,
  activeRuntimeId = null,
  helperModelId = null,
  helperRuntimeId = null,
  modelSelectionDisabledReason = null,
  reloadModelsDisabledReason = null,
  onLoadModelSelection,
  onReloadModels,
  initialSearchState,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string
    x: number
    y: number
  } | null>(null)
  const [installedTerminals, setInstalledTerminals] = useState<TerminalAppInfo[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmCloseProject, setConfirmCloseProject] = useState<{
    path: string
    name: string
  } | null>(null)
  const [quickCreateMenuPinned, setQuickCreateMenuPinned] = useState(false)
  const [modelSelectionPanelOpen, setModelSelectionPanelOpen] = useState(false)
  const [modelSelectionLoadFeedback, setModelSelectionLoadFeedback] =
    useState<ModelSelectionLoadFeedback | null>(null)
  const [modelMemoryPanelOpen, setModelMemoryPanelOpen] = useState(false)
  const [modelReloadPending, setModelReloadPending] = useState(false)
  const [modelSelectionLoadPending, setModelSelectionLoadPending] = useState(false)
  const [renameDialog, setRenameDialog] = useState<{
    sessionId: string
    title: string
    icon: string
  } | null>(null)
  const [renameIconSearch, setRenameIconSearch] = useState('')
  const [expandedIcon, setExpandedIcon] = useState<string | null>(null)
  const [draggedPinnedSessionId, setDraggedPinnedSessionId] = useState<string | null>(null)
  const [pinnedDropTarget, setPinnedDropTarget] = useState<{
    sessionId: string
    placement: 'before' | 'after'
  } | null>(null)
  const [draggedProjectSession, setDraggedProjectSession] = useState<{
    sessionId: string
    projectKey: string
  } | null>(null)
  const [projectSessionDropTarget, setProjectSessionDropTarget] = useState<{
    projectKey: string
    sessionId: string
    placement: 'before' | 'after'
  } | null>(null)
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null)
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectKey: string
    placement: 'before' | 'after'
  } | null>(null)
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const [searchQuery, setSearchQuery] = useState(initialSearchState?.query ?? '')
  const [searchStatus, setSearchStatus] = useState<SidebarSearchStatus>(
    initialSearchState?.status ?? 'idle',
  )
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>(
    initialSearchState?.results ?? [],
  )
  const [searchErrorMessage, setSearchErrorMessage] = useState<string | null>(
    initialSearchState?.errorMessage ?? null,
  )
  const renameTitleInputRef = useRef<HTMLInputElement>(null)
  const renameIconInputRef = useRef<HTMLInputElement>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const sessionRequestRunning = sessions.some(
    (session) => session.isGenerating || session.isCompacting,
  )
  const effectiveModelSelectionDisabledReason =
    modelSelectionDisabledReason
    ?? (sessionRequestRunning
      ? 'Finish or stop the running request before changing models.'
      : null)
  const effectiveReloadModelsDisabledReason =
    reloadModelsDisabledReason
    ?? (sessionRequestRunning
      ? 'Finish or stop the running request before reloading models.'
      : null)
  const searchRequestRef = useRef(0)

  const sidebarModel = useMemo(
    () => buildSidebarModel(sessions, sidebarState),
    [sessions, sidebarState],
  )
  const pinnedSessionIds = useMemo(
    () => new Set(sidebarState.pinnedSessionIds),
    [sidebarState.pinnedSessionIds],
  )
  const followUpSessionIds = useMemo(
    () => new Set(sidebarState.followUpSessionIds),
    [sidebarState.followUpSessionIds],
  )
  const activeProject = useMemo(
    () => findActiveProjectForSession(sessions, activeSessionId),
    [sessions, activeSessionId],
  )
  const visibleSessionIdsKey = useMemo(
    () => sidebarModel.visibleSessionIds.join('\u001f'),
    [sidebarModel.visibleSessionIds],
  )
  const expandedIconGroup =
    expandedIcon
      ? sidebarModel.iconGroups.find((group) => group.icon === expandedIcon) ?? null
      : null
  const hasActiveSearch = currentView === 'chat' && searchQuery.trim().length > 0
  const modelTargetOptions = useMemo(
    () =>
      buildModelTargetOptions({
        models,
        modelSelection,
        defaultModelSelection,
      }),
    [defaultModelSelection, modelSelection, models],
  )
  const modelTargetGroups = useMemo(
    () => groupModelTargetOptions(modelTargetOptions),
    [modelTargetOptions],
  )
  const primaryModelIssue = findModelAvailabilityIssue(
    modelSelection.mainModel,
    modelAvailabilityIssues,
  )
  const secondaryModelIssue = findModelAvailabilityIssue(
    modelSelection.helperModel,
    modelAvailabilityIssues,
  )
  const currentModelSelectionKey = useMemo(
    () => modelSelectionFeedbackKey(modelSelection),
    [modelSelection],
  )
  const currentModelSelectionKeyRef = useRef(currentModelSelectionKey)

  useEffect(() => {
    currentModelSelectionKeyRef.current = currentModelSelectionKey
    setModelSelectionLoadFeedback((feedback) =>
      feedback && feedback.selectionKey !== currentModelSelectionKey ? null : feedback,
    )
  }, [currentModelSelectionKey])

  useEffect(() => {
    if (renameDialog && renameTitleInputRef.current) {
      renameTitleInputRef.current.focus()
      renameTitleInputRef.current.select()
    }
  }, [renameDialog?.sessionId])

  useEffect(() => {
    if (
      expandedIcon
      && !sidebarModel.iconGroups.some((group) => group.icon === expandedIcon)
    ) {
      setExpandedIcon(null)
    }
  }, [expandedIcon, sidebarModel.iconGroups])

  useEffect(() => {
    const handler = () => {
      setContextMenu(null)
      setQuickCreateMenuPinned(false)
      setModelSelectionPanelOpen(false)
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    if (currentView !== 'chat' && quickCreateMenuPinned) {
      setQuickCreateMenuPinned(false)
    }
  }, [currentView, quickCreateMenuPinned])

  const handleLoadModelSelection = async (
    selectionInput: AppSettings['modelSelection'] = modelSelection,
  ) => {
    if (!onLoadModelSelection) {
      return
    }
    if (effectiveReloadModelsDisabledReason) {
      setModelSelectionLoadFeedback({
        tone: 'error',
        message: effectiveReloadModelsDisabledReason,
        details: [],
        selectionKey: currentModelSelectionKey,
      })
      return
    }

    const requestSelectionKey = modelSelectionFeedbackKey(selectionInput)
    currentModelSelectionKeyRef.current = requestSelectionKey
    setModelSelectionLoadPending(true)
    setModelSelectionLoadFeedback({
      tone: 'info',
      message: 'Loading selected models...',
      details: [],
      selectionKey: requestSelectionKey,
    })

    try {
      const result = await onLoadModelSelection(selectionInput)
      if (!result) {
        setModelSelectionLoadFeedback(null)
        return
      }

      const resultSelectionKey = modelSelectionFeedbackKey(result.selection)
      if (
        resultSelectionKey !== requestSelectionKey
        || currentModelSelectionKeyRef.current !== resultSelectionKey
      ) {
        return
      }

      setModelSelectionLoadFeedback({
        tone: result.ok ? 'success' : 'error',
        message: result.message,
        details: [
          ...result.errors.map(formatDefaultModelLoadStep),
          ...result.skipped.map(formatDefaultModelLoadStep),
        ],
        selectionKey: resultSelectionKey,
      })
    } catch (error) {
      if (currentModelSelectionKeyRef.current !== requestSelectionKey) {
        return
      }
      setModelSelectionLoadFeedback({
        tone: 'error',
        message: error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : 'Could not load the selected models.',
        details: [],
        selectionKey: requestSelectionKey,
      })
    } finally {
      setModelSelectionLoadPending(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    void window.gemmaDesktopBridge.terminals.listInstalled()
      .then((terminals) => {
        if (!cancelled) {
          setInstalledTerminals(terminals)
        }
      })
      .catch((error) => {
        console.error('Failed to inspect installed terminals:', error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
      }
      searchRequestRef.current += 1
    },
    [],
  )

  useEffect(() => {
    if (currentView !== 'chat') {
      return
    }

    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }

    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      searchRequestRef.current += 1
      setSearchStatus('idle')
      setSearchResults([])
      setSearchErrorMessage(null)
      return
    }

    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    setSearchStatus('searching')
    setSearchResults([])
    setSearchErrorMessage(null)

    searchTimeoutRef.current = window.setTimeout(() => {
      void window.gemmaDesktopBridge.sessions.search({
        query: trimmedQuery,
        sessionIds: sidebarModel.visibleSessionIds,
      })
        .then((results) => {
          if (requestId !== searchRequestRef.current) {
            return
          }

          setSearchResults(results)
          setSearchStatus('ready')
        })
        .catch((error) => {
          if (requestId !== searchRequestRef.current) {
            return
          }

          setSearchResults([])
          setSearchStatus('error')
          setSearchErrorMessage(
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'Search failed.',
          )
        })
    }, 250)

    return () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
    }
  }, [currentView, searchQuery, sidebarModel.visibleSessionIds, visibleSessionIdsKey])

  const clearSearch = () => {
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }
    searchRequestRef.current += 1
    setSearchQuery('')
    setSearchStatus('idle')
    setSearchResults([])
    setSearchErrorMessage(null)
  }

  const createActionLabel =
    currentView === 'automations'
      ? 'Create a new automation'
      : null
  const createActionHint =
    currentView === 'automations'
      ? 'Set up a scheduled workflow'
      : null
  const quickCreateConversationDisabled =
    conversationCreationPending || activeProject === null
  const quickCreateConversationTitle = activeProject
    ? conversationCreationPending
      ? `Creating conversation in ${activeProject.name}`
      : `Add conversation to ${activeProject.name}`
    : 'Open a project before adding a conversation'
  const quickCreateConversationHint = activeProject
    ? activeProject.name
    : 'No project selected'
  const quickCreateMenuClassName = quickCreateMenuPinned
    ? 'pointer-events-auto translate-y-0 opacity-100'
    : 'pointer-events-none -translate-y-1 opacity-0 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100'
  const filteredConversationIcons = useMemo(() => {
    const query = renameIconSearch.trim().toLowerCase()
    if (!query) {
      return CONVERSATION_ICON_SUGGESTIONS
    }
    return CONVERSATION_ICON_SUGGESTIONS.filter((entry) =>
      entry.emoji.includes(query) || entry.words.includes(query),
    )
  }, [renameIconSearch])

  const updateRenameIconDraft = (value: string) => {
    setRenameDialog((current) =>
      current ? { ...current, icon: normalizeIconInput(value) } : current,
    )
  }

  const openSystemEmojiPanel = () => {
    renameIconInputRef.current?.focus()
    renameIconInputRef.current?.select()
    void window.gemmaDesktopBridge.system.openEmojiPanel().catch((error) => {
      console.error('Failed to open emoji picker:', error)
    })
  }

  const handleReloadModels = async () => {
    if (!onReloadModels || modelReloadPending || effectiveReloadModelsDisabledReason) {
      return
    }

    setModelReloadPending(true)
    try {
      await onReloadModels()
    } catch (error) {
      console.error('Failed to reload models:', error)
    } finally {
      setModelReloadPending(false)
    }
  }

  const startRenamingSession = (session: SessionSummary) => {
    setRenameDialog({
      sessionId: session.id,
      title: session.title,
      icon: session.conversationIcon ?? '',
    })
    setRenameIconSearch('')
    setContextMenu(null)
  }

  const saveRenameDialog = () => {
    if (!renameDialog) {
      return
    }

    const title = renameDialog.title.trim()
    if (!title) {
      return
    }

    onRenameSession(
      renameDialog.sessionId,
      title,
      normalizeIconInput(renameDialog.icon) || null,
    )
    setRenameDialog(null)
    setRenameIconSearch('')
  }

  const confirmDeleteSession = (sessionId: string) => {
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session || session.isGenerating || session.isCompacting) {
      setContextMenu(null)
      return
    }

    setConfirmDeleteId(sessionId)
    setContextMenu(null)
  }

  const contextSession = contextMenu
    ? sessions.find((session) => session.id === contextMenu.sessionId) ?? null
    : null
  const contextSessionPinned = contextSession ? pinnedSessionIds.has(contextSession.id) : false
  const contextSessionFollowUp = contextSession ? followUpSessionIds.has(contextSession.id) : false
  const canDeleteContextSession =
    contextMenu?.sessionId !== undefined
    && contextSession !== null
    && !contextSession.isGenerating
    && !contextSession.isCompacting

  const clearPinnedDragState = () => {
    setDraggedPinnedSessionId(null)
    setPinnedDropTarget(null)
  }

  const handlePinnedDragStart = (
    event: DragEvent<HTMLButtonElement>,
    sessionId: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
    setDraggedPinnedSessionId(sessionId)
  }

  const updatePinnedDropTarget = (
    event: DragEvent<HTMLDivElement>,
    sessionId: string,
  ) => {
    if (!draggedPinnedSessionId || draggedPinnedSessionId === sessionId) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setPinnedDropTarget({ sessionId, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handlePinnedDrop = (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string,
  ) => {
    event.preventDefault()

    const sourceSessionId =
      draggedPinnedSessionId || event.dataTransfer.getData('text/plain')
    if (!sourceSessionId || sourceSessionId === targetSessionId) {
      clearPinnedDragState()
      return
    }

    const sourceIndex = sidebarModel.pinnedSessions.findIndex(
      (session) => session.id === sourceSessionId,
    )
    const targetIndex = sidebarModel.pinnedSessions.findIndex(
      (session) => session.id === targetSessionId,
    )

    if (sourceIndex === -1 || targetIndex === -1) {
      clearPinnedDragState()
      return
    }

    const placement =
      pinnedDropTarget?.sessionId === targetSessionId
        ? pinnedDropTarget.placement
        : 'after'
    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex

    onMovePinnedSession(sourceSessionId, nextIndex)
    clearPinnedDragState()
  }

  const clearProjectSessionDragState = () => {
    setDraggedProjectSession(null)
    setProjectSessionDropTarget(null)
  }

  const handleProjectSessionDragStart = (
    event: DragEvent<HTMLButtonElement>,
    sessionId: string,
    projectKey: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
    setDraggedProjectSession({ sessionId, projectKey })
  }

  const updateProjectSessionDropTarget = (
    event: DragEvent<HTMLDivElement>,
    sessionId: string,
    projectKey: string,
  ) => {
    if (!draggedProjectSession) {
      return
    }
    if (draggedProjectSession.projectKey !== projectKey) {
      return
    }
    if (draggedProjectSession.sessionId === sessionId) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setProjectSessionDropTarget({ projectKey, sessionId, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handleProjectSessionDrop = (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string,
    projectKey: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const dragged = draggedProjectSession
    if (!dragged || dragged.projectKey !== projectKey) {
      clearProjectSessionDragState()
      return
    }

    const sourceSessionId = dragged.sessionId || event.dataTransfer.getData('text/plain')
    if (!sourceSessionId || sourceSessionId === targetSessionId) {
      clearProjectSessionDragState()
      return
    }

    const group = sidebarModel.projectGroups.find((entry) => entry.key === projectKey)
    if (!group) {
      clearProjectSessionDragState()
      return
    }

    const sourceIndex = group.sessions.findIndex((session) => session.id === sourceSessionId)
    const targetIndex = group.sessions.findIndex((session) => session.id === targetSessionId)
    if (sourceIndex === -1 || targetIndex === -1) {
      clearProjectSessionDragState()
      return
    }

    const placement =
      projectSessionDropTarget?.projectKey === projectKey
      && projectSessionDropTarget.sessionId === targetSessionId
        ? projectSessionDropTarget.placement
        : 'after'

    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex
    const clampedIndex = Math.max(0, Math.min(group.sessions.length - 1, nextIndex))

    onMoveProjectSession(sourceSessionId, clampedIndex)
    clearProjectSessionDragState()
  }

  const clearProjectDragState = () => {
    setDraggedProjectKey(null)
    setProjectDropTarget(null)
  }

  const handleProjectDragStart = (
    event: DragEvent<HTMLButtonElement>,
    projectKey: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectKey)
    setDraggedProjectKey(projectKey)
  }

  const updateProjectDropTarget = (
    event: DragEvent<HTMLDivElement>,
    projectKey: string,
  ) => {
    if (!draggedProjectKey || draggedProjectKey === projectKey) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setProjectDropTarget({ projectKey, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handleProjectDrop = (
    event: DragEvent<HTMLDivElement>,
    targetProjectKey: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const sourceProjectKey =
      draggedProjectKey || event.dataTransfer.getData('text/plain')
    if (!sourceProjectKey || sourceProjectKey === targetProjectKey) {
      clearProjectDragState()
      return
    }

    const sourceIndex = sidebarModel.projectGroups.findIndex(
      (group) => group.key === sourceProjectKey,
    )
    const targetIndex = sidebarModel.projectGroups.findIndex(
      (group) => group.key === targetProjectKey,
    )
    if (sourceIndex === -1 || targetIndex === -1) {
      clearProjectDragState()
      return
    }

    const sourceGroup = sidebarModel.projectGroups[sourceIndex]
    if (!sourceGroup || !sourceGroup.path) {
      clearProjectDragState()
      return
    }

    const placement =
      projectDropTarget?.projectKey === targetProjectKey
        ? projectDropTarget.placement
        : 'after'

    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex
    const clampedIndex = Math.max(
      0,
      Math.min(sidebarModel.projectGroups.length - 1, nextIndex),
    )

    onMoveProject(sourceGroup.path, clampedIndex)
    clearProjectDragState()
  }

  const preferredTerminal = (
    installedTerminals.find((terminal) => terminal.id === preferredTerminalId)
    ?? installedTerminals[0]
    ?? null
  )

  const renderSessionRow = (
    session: SessionSummary,
    options?: {
      inPinnedSection?: boolean
      inIconSection?: boolean
      projectKey?: string
    },
  ) => {
    const inPinnedSection = options?.inPinnedSection === true
    const inIconSection = options?.inIconSection === true
    const projectKey = options?.projectKey ?? null
    const isActiveSession = session.id === activeSessionId
    const isSessionRunning = session.isGenerating || session.isCompacting
    const isPinnedSession = pinnedSessionIds.has(session.id)
    const canDeleteSession = !isSessionRunning
    const hoverActionVisible = inPinnedSection || canDeleteSession || true
    const runningProcesses =
      !inPinnedSection && !inIconSection && session.runningProcesses
        ? session.runningProcesses
        : []
    const projectDropMatch =
      !inPinnedSection
      && !inIconSection
      && projectKey
      && projectSessionDropTarget?.projectKey === projectKey
      && projectSessionDropTarget.sessionId === session.id
        ? projectSessionDropTarget
        : null
    const dropIndicatorClass = inPinnedSection
      ? pinnedDropTarget?.sessionId === session.id
        ? pinnedDropTarget.placement === 'before'
          ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
          : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
        : ''
      : projectDropMatch
        ? projectDropMatch.placement === 'before'
          ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
          : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
        : ''
    const hasSessionOrderOverride = Boolean(
      sidebarState.sessionOrderOverrides
      && session.id in sidebarState.sessionOrderOverrides,
    )
    const rowKind = inPinnedSection ? 'pinned' : inIconSection ? 'icon' : 'project'

    return (
      <div key={`${rowKind}-${session.id}`}>
        <div
          onClick={() => onSelectSession(session.id)}
          onDoubleClick={() => startRenamingSession(session)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelectSession(session.id)
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({
              sessionId: session.id,
              x: event.clientX,
              y: event.clientY,
            })
          }}
          onDragOver={
            inPinnedSection
              ? (event) => updatePinnedDropTarget(event, session.id)
              : projectKey
                ? (event) => updateProjectSessionDropTarget(event, session.id, projectKey)
                : undefined
          }
          onDrop={
            inPinnedSection
              ? (event) => handlePinnedDrop(event, session.id)
              : projectKey
                ? (event) => handleProjectSessionDrop(event, session.id, projectKey)
                : undefined
          }
          role="button"
          tabIndex={0}
          className={`group relative flex items-center gap-2 rounded-xl py-2 pr-2 transition-colors focus:outline-none ${
            inPinnedSection || inIconSection ? 'pl-3' : 'pl-6'
          } ${
            isActiveSession
              ? 'bg-zinc-900/[0.09] dark:bg-white/[0.09]'
              : 'hover:bg-zinc-900/[0.035] dark:hover:bg-white/[0.04]'
          } ${dropIndicatorClass} ${isSessionRunning ? 'sidebar-session-running' : ''}`}
          aria-current={isActiveSession ? 'true' : undefined}
        >
          {inPinnedSection ? (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handlePinnedDragStart(event, session.id)}
              onDragEnd={clearPinnedDragState}
              className="cursor-grab rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 active:cursor-grabbing dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Drag to reorder pinned chats"
              aria-label={`Reorder pinned chat ${session.title}`}
            >
              <GripVertical size={13} />
            </button>
          ) : projectKey ? (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handleProjectSessionDragStart(event, session.id, projectKey)}
              onDragEnd={clearProjectSessionDragState}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (hasSessionOrderOverride) {
                  onClearSessionOrder(session.id)
                }
              }}
              className={`pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 cursor-grab rounded-md p-0.5 opacity-0 transition-opacity hover:bg-zinc-200 active:cursor-grabbing group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 dark:hover:bg-zinc-800 ${
                hasSessionOrderOverride
                  ? 'text-cyan-500/80 hover:text-cyan-600 dark:text-cyan-400/80 dark:hover:text-cyan-300'
                  : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
              title={
                hasSessionOrderOverride
                  ? 'Drag to reorder · double-click to reset to default'
                  : 'Drag to reorder'
              }
              aria-label={`Reorder ${session.title}`}
            >
              <GripVertical size={12} />
            </button>
          ) : null}

          <>
            {followUpSessionIds.has(session.id) && (
              <Flag size={12} className="flex-shrink-0 text-amber-500/70 dark:text-amber-400/60" />
            )}
            <div className="min-w-0 flex flex-1 items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-[15px] ${
                    isActiveSession
                      ? 'font-medium text-zinc-950 dark:text-zinc-50'
                      : 'text-zinc-700 dark:text-zinc-300'
                  }`}
                  title={session.title}
                >
                  {session.title}
                </span>
                {session.conversationKind === 'research' && (
                  <span
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300"
                    title="Research conversation"
                  >
                    <Sparkles size={9} />
                    Research
                  </span>
                )}
              </div>

              <div className={`relative h-5 flex-shrink-0 ${inPinnedSection ? 'w-[52px]' : 'w-[88px]'}`}>
                <span
                  className={`absolute inset-0 flex items-center justify-end gap-1 text-right text-xs text-zinc-400 dark:text-zinc-600 ${
                    hoverActionVisible
                      ? 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0'
                      : ''
                  }`}
                >
                  {session.conversationIcon && (
                    <span
                      className="inline-flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none"
                      title="Conversation icon"
                      role="img"
                      aria-label={`Conversation icon ${session.conversationIcon}`}
                    >
                      {session.conversationIcon}
                    </span>
                  )}
                  {formatRelativeTime(session.updatedAt)}
                </span>

                {inPinnedSection ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-end opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onUnpinSession(session.id)
                      }}
                      title="Unpin conversation"
                      aria-label={`Unpin ${session.title}`}
                      className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <PinOff size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (isPinnedSession) {
                          onUnpinSession(session.id)
                        } else {
                          onPinSession(session.id)
                        }
                      }}
                      title={isPinnedSession ? 'Unpin conversation' : 'Pin conversation'}
                      aria-label={isPinnedSession ? `Unpin ${session.title}` : `Pin ${session.title}`}
                      className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      {isPinnedSession ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    {canDeleteSession && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          confirmDeleteSession(session.id)
                        }}
                        title="Delete conversation"
                        aria-label={`Delete ${session.title}`}
                        className="rounded p-1 text-zinc-500 transition-colors hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
          </>
        </div>

        {runningProcesses.length > 0 && (
          <div className="ml-9 mt-1.5 space-y-1.5 pb-1">
            {runningProcesses.map((process) => (
              <div
                key={process.terminalId}
                className="group/process flex items-start gap-2 rounded-lg border border-l-4 border-emerald-200 border-l-emerald-500 bg-emerald-50/90 px-2.5 py-2 text-[11px] text-emerald-950 shadow-sm dark:border-emerald-900/70 dark:border-l-emerald-400 dark:bg-emerald-950/30 dark:text-emerald-50"
                title={buildProcessHoverText(
                  process.command,
                  process.workingDirectory,
                  process.previewText,
                )}
              >
                <SquareTerminal size={12} className="mt-0.5 flex-shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-200">
                    <Loader2 size={10} className="animate-spin" />
                    <span className="uppercase tracking-[0.14em]">
                      Live process
                    </span>
                  </div>
                  <div className="truncate font-mono text-zinc-900 dark:text-zinc-100">
                    {process.command}
                  </div>
                  {process.previewText && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-emerald-800/75 dark:text-emerald-100/75">
                      {process.previewText}
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  {process.previewUrl && onOpenProcessPreview ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpenProcessPreview(session.id, process.previewUrl ?? '')
                      }}
                      className="rounded p-0.5 text-emerald-700/80 transition-colors hover:bg-emerald-100 hover:text-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900/50 dark:hover:text-white"
                      aria-label={`Open Project Browser for process ${process.command}`}
                      title={`Open Project Browser at ${process.previewUrl}`}
                    >
                      <PanelRightOpen size={11} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onCloseProcess(session.id, process.terminalId)
                    }}
                    className="rounded p-0.5 text-emerald-700/80 transition-colors hover:bg-emerald-100 hover:text-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900/50 dark:hover:text-white"
                    aria-label={`Terminate process ${process.command}`}
                    title="Terminate process"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderIconButton = (group: SessionIconGroup) => {
    const active = expandedIcon === group.icon
    return (
      <button
        key={group.icon}
        type="button"
        onClick={() => setExpandedIcon((current) =>
          current === group.icon ? null : group.icon,
        )}
        className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-base leading-none transition-colors ${
          active
            ? 'bg-zinc-900/[0.08] text-zinc-950 ring-1 ring-zinc-900/10 dark:bg-white/[0.11] dark:text-zinc-50 dark:ring-white/10'
            : 'text-zinc-500 hover:bg-zinc-900/[0.045] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100'
        }`}
        title={`${group.sessions.length} conversation${group.sessions.length === 1 ? '' : 's'}`}
        aria-label={`Show ${group.icon} conversations`}
        aria-pressed={active}
      >
        <span role="img" aria-hidden="true">{group.icon}</span>
        <span className="ml-1.5 text-[10px] font-medium leading-none text-zinc-400 dark:text-zinc-500">
          {group.sessions.length}
        </span>
      </button>
    )
  }

  const renderPinnedAndIcons = () => (
    <section className="mb-4">
      <div className="mb-1 flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
        <Pin size={12} />
        <span className="min-w-0 flex-1">PINNED</span>
      </div>

      {sidebarModel.pinnedSessions.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {sidebarModel.pinnedSessions.map((session) =>
            renderSessionRow(session, { inPinnedSection: true }),
          )}
        </div>
      )}

      {sidebarModel.iconGroups.length > 0 && (
        <div className="space-y-1.5">
          <div
            className="flex flex-wrap items-center gap-1 px-2"
            aria-label="Conversation icons"
          >
            {sidebarModel.iconGroups.map((group) => renderIconButton(group))}
          </div>
          {expandedIconGroup && (
            <div className="space-y-0.5 border-t border-zinc-200/70 pt-1.5 dark:border-zinc-800">
              {expandedIconGroup.sessions.map((session) =>
                renderSessionRow(session, { inIconSection: true }),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )

  const renderProjectGroup = (group: SessionProjectGroup) => {
    const projectBusy = group.sessions.some(
      (session) => session.isGenerating || session.isCompacting,
    )
    const isCollapsed = collapsedProjectKeys.has(group.key)
    const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown
    const isProjectDraggable = group.path.length > 0
    const projectDropMatch =
      projectDropTarget?.projectKey === group.key ? projectDropTarget : null
    const projectDropClass = projectDropMatch
      ? projectDropMatch.placement === 'before'
        ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
        : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
      : ''
    const hasProjectOrderOverride = Boolean(
      group.path.length > 0
      && sidebarState.projectOrderOverrides
      && group.path in sidebarState.projectOrderOverrides,
    )

    return (
      <section key={group.key} className="mb-4">
        <div
          className={`group/project relative mb-1 flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm font-medium text-zinc-700 transition-colors dark:text-zinc-200 ${projectDropClass}`}
          title={group.path || 'No project folder selected'}
          onClick={() => {
            setCollapsedProjectKeys((prev) => {
              const next = new Set(prev)
              if (next.has(group.key)) {
                next.delete(group.key)
              } else {
                next.add(group.key)
              }
              return next
            })
          }}
          onDragOver={
            isProjectDraggable
              ? (event) => updateProjectDropTarget(event, group.key)
              : undefined
          }
          onDrop={
            isProjectDraggable
              ? (event) => handleProjectDrop(event, group.key)
              : undefined
          }
          aria-expanded={!isCollapsed}
        >
          {isProjectDraggable && (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handleProjectDragStart(event, group.key)}
              onDragEnd={clearProjectDragState}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (hasProjectOrderOverride) {
                  onClearProjectOrder(group.path)
                }
              }}
              className={`pointer-events-none absolute -left-0.5 top-1/2 -translate-y-1/2 cursor-grab rounded-md p-0.5 opacity-0 transition-opacity hover:bg-zinc-200 active:cursor-grabbing group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 dark:hover:bg-zinc-800 ${
                hasProjectOrderOverride
                  ? 'text-cyan-500/80 hover:text-cyan-600 dark:text-cyan-400/80 dark:hover:text-cyan-300'
                  : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
              title={
                hasProjectOrderOverride
                  ? 'Drag to reorder project · double-click to reset to default'
                  : 'Drag to reorder project'
              }
              aria-label={`Reorder project ${group.name}`}
            >
              <GripVertical size={12} />
            </button>
          )}
          <ChevronIcon
            size={14}
            className="flex-shrink-0 text-zinc-400 dark:text-zinc-500"
          />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          <div className="ml-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onCreateSessionInProject(group.path)
              }}
              disabled={conversationCreationPending || !group.path.trim()}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                group.path
                  ? `Add conversation to ${group.name}`
                  : 'No project folder selected'
              }
              aria-label={
                group.path
                  ? `Add conversation to ${group.name}`
                  : 'No project folder selected'
              }
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                if (group.path.trim()) {
                  onOpenProject(group.path)
                }
              }}
              disabled={!group.path.trim()}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                group.path
                  ? `Open ${group.name} in Finder`
                  : 'No project folder selected'
              }
              aria-label={
                group.path
                  ? `Open ${group.name} in Finder`
                  : 'No project folder selected'
              }
            >
              <FolderOpen size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                void window.gemmaDesktopBridge.terminals.openDirectory({
                  directoryPath: group.path,
                  terminalId: preferredTerminal?.id,
                }).catch((error) => {
                  console.error('Failed to open project in terminal:', error)
                })
              }}
              disabled={!group.path.trim() || preferredTerminal === null}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                preferredTerminal
                  ? `Open ${group.name} in ${preferredTerminal.label}`
                  : 'No supported terminal app detected'
              }
              aria-label={
                preferredTerminal
                  ? `Open ${group.name} in ${preferredTerminal.label}`
                  : 'No supported terminal app detected'
              }
            >
              <SquareTerminal size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setConfirmCloseProject({
                  path: group.path,
                  name: group.name,
                })
              }}
              disabled={!group.path.trim() || projectBusy}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                projectBusy
                  ? 'Stop active conversations before closing this project'
                  : 'Close project'
              }
              aria-label="Close project"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div className="space-y-0.5">
            {group.sessions.map((session) =>
              renderSessionRow(session, { projectKey: group.key }),
            )}
          </div>
        )}
      </section>
    )
  }

  const renderSearchResults = () => {
    if (searchStatus === 'searching') {
      return (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={14} className="animate-spin" />
          <span>Searching open conversations…</span>
        </div>
      )
    }

    if (searchStatus === 'error') {
      return (
        <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
          {searchErrorMessage ?? 'Search failed.'}
        </div>
      )
    }

    if (searchResults.length === 0) {
      return (
        <div className="px-3 py-6 text-center text-sm text-zinc-400">
          No open conversations matched &ldquo;{searchQuery.trim()}&rdquo;.
        </div>
      )
    }

    return (
      <section className="space-y-2 px-1">
        <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Search results
        </div>
        {searchResults.map((result) => {
          const isActiveResult = result.sessionId === activeSessionId
          const projectName = basenameFromPath(result.workingDirectory)

          return (
            <button
              key={result.sessionId}
              type="button"
              onClick={() => {
                clearSearch()
                onSelectSession(result.sessionId)
              }}
              className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${
                isActiveResult
                  ? 'bg-zinc-900/[0.06] dark:bg-white/[0.06]'
                  : 'hover:bg-zinc-900/[0.035] dark:hover:bg-white/[0.04]'
              }`}
              title={result.workingDirectory}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {result.title}
                </span>
                <span className="flex-shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {formatRelativeTime(result.updatedAt)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="truncate font-medium">{projectName}</span>
                <span className="truncate text-zinc-400 dark:text-zinc-500">
                  {result.workingDirectory}
                </span>
              </div>
              <div className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                {result.snippet}
              </div>
            </button>
          )
        })}
      </section>
    )
  }

  return (
    <div className="surface-rail flex h-full w-full min-w-0 flex-shrink-0 flex-col">
      <div className="drag-region relative px-3 pb-2 pt-10">
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="no-drag absolute right-3 top-3 z-[60] rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}

        {currentView === 'chat' ? (
          <div className="no-drag px-4">
            <div className="flex justify-center">
              {modeToolbar}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="sidebar-session-search" className="sr-only">
                  Search open conversations
                </label>
                <div
                  className="flex items-center gap-1.5 rounded-full bg-zinc-900/[0.045] px-3 py-1.5 text-sm transition-colors focus-within:bg-zinc-900/[0.07] dark:bg-white/[0.06] dark:focus-within:bg-white/[0.09]"
                >
                  <Search
                    size={13}
                    className="flex-shrink-0 text-zinc-400 dark:text-zinc-500"
                  />
                  <input
                    id="sidebar-session-search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && searchQuery.trim().length > 0) {
                        event.preventDefault()
                        clearSearch()
                      }
                    }}
                    placeholder="Search"
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                  {searchStatus === 'searching' ? (
                    <Loader2
                      size={13}
                      className="flex-shrink-0 animate-spin text-zinc-400 dark:text-zinc-500"
                    />
                  ) : searchQuery.trim().length > 0 ? (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-900/10 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-zinc-200"
                      title="Clear search"
                      aria-label="Clear search"
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="group relative flex-shrink-0">
                <div
                  role="menu"
                  aria-label="Quick create"
                  className={`absolute right-0 top-full z-[65] mt-2 w-60 transition-all duration-200 ease-out ${quickCreateMenuClassName}`}
                >
                  <div className="rounded-2xl border border-zinc-200 bg-white/95 p-1.5 shadow-[0_18px_40px_-28px_rgba(24,24,27,0.52)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-[0_22px_44px_-30px_rgba(0,0,0,0.86)]">
                    <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                      Quick create
                    </div>
                    <div className="space-y-1">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (!activeProject) {
                            return
                          }

                          setQuickCreateMenuPinned(false)
                          onCreateSessionInProject(activeProject.path)
                        }}
                        disabled={quickCreateConversationDisabled}
                        title={quickCreateConversationTitle}
                        aria-label={quickCreateConversationTitle}
                        className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                      >
                        <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                          <Plus size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Add conversation
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {quickCreateConversationHint}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.stopPropagation()
                          setQuickCreateMenuPinned(false)
                          onCreateProject()
                        }}
                        disabled={conversationCreationPending}
                        title="Open a project folder"
                        aria-label="Open a project folder"
                        className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                      >
                        <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                          <FolderOpen size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Open project
                          </span>
                          <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                            Pick a folder and open its latest or first conversation
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setQuickCreateMenuPinned((prev) => !prev)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setQuickCreateMenuPinned(false)
                    }
                  }}
                  disabled={conversationCreationPending}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 bg-white/95 text-zinc-700 shadow-[0_12px_28px_-20px_rgba(24,24,27,0.46)] backdrop-blur transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 hover:border-zinc-300 hover:bg-white hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:focus-visible:ring-zinc-600 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-white"
                  title="Quick create"
                  aria-label="Quick create"
                  aria-haspopup="menu"
                  aria-expanded={quickCreateMenuPinned}
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="no-drag px-1 pr-8">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Automations
            </div>
            <div className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Scheduled agents
            </div>
          </div>
        )}
      </div>

      <div
        className="scrollbar-thin min-h-[150px] flex-1 basis-0 overflow-y-auto border-y border-zinc-200/70 bg-white/30 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-950/20"
        aria-label={currentView === 'chat' ? 'Conversation history' : 'Automations'}
      >
        {currentView === 'chat' ? (
          hasActiveSearch ? renderSearchResults() : (
          <>
            {renderPinnedAndIcons()}

            {sidebarModel.projectGroups.map((group) => renderProjectGroup(group))}

            {sidebarModel.projectGroups.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-zinc-400">
                {sessions.length === 0
                  ? 'No conversations yet.'
                  : 'No open projects. Use New project to reopen a folder or start a new one.'}
              </div>
            )}
          </>)
        ) : (
          <>
            {automations.map((automation) => (
              <button
                key={automation.id}
                onClick={() => onSelectAutomation(automation.id)}
                className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                  automation.id === activeAutomationId
                    ? 'bg-zinc-200 dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${automationStatusTone(automation.lastRunStatus)}`}
                  />
                  <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    {automation.name}
                  </span>
                </div>
                <div className="mt-1 truncate pl-3.5 text-xs text-zinc-500 dark:text-zinc-500">
                  {automation.scheduleText}
                </div>
                <div className="mt-1 pl-3.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                  {automation.nextRunAt
                    ? new Date(automation.nextRunAt).toLocaleString()
                    : automation.enabled
                      ? 'No next run'
                      : 'Paused'}
                </div>
              </button>
            ))}

            {automations.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-zinc-400">
                No automations yet.
              </div>
            )}
          </>
        )}
      </div>

      {modelMemoryPanelOpen && (
        <div className="no-drag h-[44%] min-h-[260px] max-h-[390px] flex-shrink-0">
          <MemoryStatusPanel
            systemStats={systemStats}
            models={models}
            modelTokenUsage={modelTokenUsage}
            selectedModelId={activeModelId ?? undefined}
            selectedRuntimeId={activeRuntimeId ?? undefined}
            helperModelId={helperModelId ?? undefined}
            helperRuntimeId={helperRuntimeId ?? undefined}
            reloadModelsBusy={modelReloadPending}
            reloadModelsDisabledReason={effectiveReloadModelsDisabledReason}
            onReloadModels={handleReloadModels}
          />
        </div>
      )}

      <div className="no-drag px-3 pb-1 pt-2">
        <div className="rounded-xl border border-zinc-200 bg-white/95 p-2.5 text-zinc-700 shadow-[0_14px_30px_-24px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-300">
                <Sparkles size={14} />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  Models
                </div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {modelTargetOptions.length} available
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Global model selection"
              aria-haspopup="dialog"
              aria-expanded={modelSelectionPanelOpen}
              disabled={Boolean(effectiveModelSelectionDisabledReason)}
              title={effectiveModelSelectionDisabledReason ?? 'Change models'}
              onClick={(event) => {
                event.stopPropagation()
                if (effectiveModelSelectionDisabledReason) {
                  return
                }
                setModelSelectionPanelOpen(true)
                setQuickCreateMenuPinned(false)
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-xs font-semibold text-zinc-700 outline-none transition-colors hover:border-zinc-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:focus-visible:ring-zinc-700"
            >
              <Pencil size={13} />
              Change
            </button>
          </div>

          <div className="mt-2 space-y-1.5">
            <SelectedModelSummary
              roleLabel="Primary"
              target={modelSelection.mainModel}
              options={modelTargetOptions}
              issue={primaryModelIssue}
            />
            <SelectedModelSummary
              roleLabel="Secondary"
              target={modelSelection.helperModel}
              options={modelTargetOptions}
              issue={modelSelection.helperModelEnabled ? secondaryModelIssue : null}
              muted={!modelSelection.helperModelEnabled}
            />
          </div>
        </div>

        {modelSelectionPanelOpen && (
          <ModelSelectionDialog
            modelSelection={modelSelection}
            modelTargetGroups={modelTargetGroups}
            modelTargetOptions={modelTargetOptions}
            primaryModelIssue={primaryModelIssue}
            secondaryModelIssue={secondaryModelIssue}
            modelSelectionDisabledReason={effectiveModelSelectionDisabledReason}
            reloadModelsDisabledReason={
              !onLoadModelSelection
                ? 'Model loading is not available.'
                : effectiveReloadModelsDisabledReason
            }
            modelSelectionLoadPending={modelSelectionLoadPending}
            modelSelectionLoadFeedback={modelSelectionLoadFeedback}
            onClose={() => setModelSelectionPanelOpen(false)}
            onLoadModelSelection={(nextModelSelection) => {
              void handleLoadModelSelection(nextModelSelection)
            }}
          />
        )}
      </div>

      {currentView !== 'chat' && createActionLabel && createActionHint && (
        <div className="no-drag px-3 pb-3 pt-2">
          <div className="group relative flex justify-end">
            <div className="pointer-events-none absolute bottom-full right-0 mb-2 translate-y-1 opacity-0 transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
                <div className="rounded-xl border border-zinc-200 bg-white/95 px-3 py-2 text-right shadow-[0_14px_36px_-26px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-[0_18px_42px_-30px_rgba(0,0,0,0.82)]">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    New automation
                  </div>
                  <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {createActionHint}
                  </div>
                </div>
            </div>

            <button
              onClick={onNewAutomation}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-zinc-200 bg-white/95 text-zinc-700 shadow-[0_16px_34px_-22px_rgba(24,24,27,0.46)] backdrop-blur transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 hover:border-zinc-300 hover:bg-white hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:focus-visible:ring-zinc-600 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-white"
              title={createActionLabel}
              aria-label={createActionLabel}
            >
              <Plus size={18} />
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1 px-3 py-2">
        <button
          onClick={onOpenSettings}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
        <button
          onClick={onOpenDoctor}
          className={`rounded-md p-1.5 transition-colors ${
            doctorOpen
              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25'
              : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
          }`}
          title="Doctor"
          aria-label="Doctor"
        >
          <Stethoscope size={16} />
        </button>
        <button
          onClick={onOpenSkills}
          className={getSkillsButtonClassName(selectedSkillCount)}
          title="Skills"
          aria-label="Skills"
        >
          <Sparkles size={16} />
          {selectedSkillCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[17px] items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-medium leading-none text-white shadow-sm dark:bg-sky-300 dark:text-sky-950">
              {selectedSkillCount}
            </span>
          )}
        </button>
        <div className="flex-1" />
        <div className="flex flex-col items-end gap-0.5">
          <GpuWave stats={systemStats} />
          <MemoryStatusIndicator
            systemStats={systemStats}
            models={models}
            modelTokenUsage={modelTokenUsage}
            selectedModelId={activeModelId ?? undefined}
            selectedRuntimeId={activeRuntimeId ?? undefined}
            helperModelId={helperModelId ?? undefined}
            helperRuntimeId={helperRuntimeId ?? undefined}
            panelOpen={modelMemoryPanelOpen}
            onTogglePanel={() => setModelMemoryPanelOpen((open) => !open)}
          />
        </div>
      </div>

      {contextMenu && currentView === 'chat' && (
        <div
          className="fixed z-50 min-w-[170px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              if (contextSession) {
                startRenamingSession(contextSession)
              }
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            onClick={() => {
              if (!contextSession) {
                return
              }

              if (contextSessionPinned) {
                onUnpinSession(contextSession.id)
              } else {
                onPinSession(contextSession.id)
              }
              setContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Pin size={14} />
            {contextSessionPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={() => {
              if (!contextSession) {
                return
              }

              if (contextSessionFollowUp) {
                onUnflagFollowUp(contextSession.id)
              } else {
                onFlagFollowUp(contextSession.id)
              }
              setContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Flag size={14} />
            {contextSessionFollowUp ? 'Remove follow-up' : 'Follow up'}
          </button>
          <button
            onClick={() => {
              confirmDeleteSession(contextMenu.sessionId)
            }}
            disabled={!canDeleteContextSession}
            title={
              canDeleteContextSession
                ? 'Delete conversation'
                : 'Running conversation cannot be deleted'
            }
            aria-label={
              canDeleteContextSession
                ? 'Delete conversation'
                : 'Running conversation cannot be deleted'
            }
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
              canDeleteContextSession
                ? 'text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-800'
                : 'cursor-not-allowed text-zinc-400 dark:text-zinc-600'
            }`}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Delete conversation?
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500">
              This will permanently delete &ldquo;{sessions.find((session) => session.id === confirmDeleteId)?.title}&rdquo;, its history, and any saved attachments for that conversation. This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDeleteSession(confirmDeleteId)
                  setConfirmDeleteId(null)
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmCloseProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[28rem] rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Close project folder?
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500">
              This will hide &ldquo;{confirmCloseProject.name}&rdquo; from the sidebar. Its chats stay on disk, and any pinned chats from this project will be removed from Pinned until you reopen the folder.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmCloseProject(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onCloseProject(confirmCloseProject.path)
                  setConfirmCloseProject(null)
                }}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Close project
              </button>
            </div>
          </div>
        </div>
      )}

      {renameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            className="w-[24rem] rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
            role="dialog"
            aria-label="Rename conversation"
          >
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Rename conversation
            </h3>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="conversation-title-value" className="sr-only">
                  Conversation title
                </label>
                <input
                  ref={renameTitleInputRef}
                  id="conversation-title-value"
                  value={renameDialog.title}
                  onChange={(event) => {
                    const title = event.target.value
                    setRenameDialog((current) =>
                      current ? { ...current, title } : current,
                    )
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && renameDialog.title.trim()) {
                      event.preventDefault()
                      saveRenameDialog()
                    }
                    if (event.key === 'Escape') {
                      setRenameDialog(null)
                      setRenameIconSearch('')
                    }
                  }}
                  className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-sky-500/60 dark:focus:ring-sky-500/30"
                  aria-label="Conversation title"
                />
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="conversation-icon-value" className="sr-only">
                  Conversation icon
                </label>
                <input
                  ref={renameIconInputRef}
                  id="conversation-icon-value"
                  value={renameDialog.icon}
                  onChange={(event) => updateRenameIconDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-10 w-12 rounded-lg border border-zinc-200 bg-zinc-50 text-center text-xl leading-none text-zinc-900 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-sky-500/60 dark:focus:ring-sky-500/30"
                  aria-label="Conversation icon"
                />
                <button
                  type="button"
                  onClick={() => updateRenameIconDraft('')}
                  className="flex h-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                  title="Clear conversation icon"
                  aria-label="Clear conversation icon"
                >
                  <X size={14} />
                </button>
                <button
                  type="button"
                  onClick={openSystemEmojiPanel}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-600 transition-colors hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-sky-500/35 dark:hover:bg-sky-500/15 dark:hover:text-sky-300"
                  title="Open macOS emoji picker"
                  aria-label="Open macOS emoji picker"
                >
                  <SmilePlus size={16} />
                  <span>All macOS emoji</span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="conversation-icon-search" className="sr-only">
                  Filter suggestions
                </label>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950">
                  <Search size={14} className="flex-shrink-0 text-zinc-400 dark:text-zinc-500" />
                  <input
                    id="conversation-icon-search"
                    value={renameIconSearch}
                    onChange={(event) => setRenameIconSearch(event.target.value)}
                    placeholder="Filter suggestions"
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-8 gap-1">
                {filteredConversationIcons.map((entry) => (
                  <button
                    key={entry.emoji}
                    type="button"
                    onClick={() => updateRenameIconDraft(entry.emoji)}
                    className={`flex h-8 items-center justify-center rounded-lg text-lg transition-colors ${
                      renameDialog.icon === entry.emoji
                        ? 'bg-sky-100 ring-1 ring-sky-300 dark:bg-sky-500/20 dark:ring-sky-500/50'
                        : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                    title={entry.words}
                    aria-label={`Use ${entry.emoji}`}
                  >
                    {entry.emoji}
                  </button>
                ))}
              </div>
              {renameIconSearch.trim() && filteredConversationIcons.length === 0 && (
                <div className="text-xs text-zinc-500">
                  No matching suggestions.
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setRenameDialog(null)
                  setRenameIconSearch('')
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={saveRenameDialog}
                disabled={!renameDialog.title.trim()}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
