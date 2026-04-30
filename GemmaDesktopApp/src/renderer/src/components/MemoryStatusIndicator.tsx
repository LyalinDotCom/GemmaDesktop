import { useEffect, useState } from 'react'
import { ChevronDown, Layers } from 'lucide-react'
import type {
  ModelSummary,
  ModelTokenUsageReport,
  ModelTokenUsageSnapshot,
  SystemStats,
} from '@/types'

/**
 * Compact RAM usage button plus the pinned model-memory panel used by the
 * sidebar. The button is intentionally tiny; the persistent panel carries the
 * dense runtime/model details behind native expandable rows.
 */

interface MemoryStatusDetailProps {
  systemStats: SystemStats
  models: ModelSummary[]
  modelTokenUsage?: ModelTokenUsageReport
  selectedModelId?: string
  selectedRuntimeId?: string
  helperModelId?: string
  helperRuntimeId?: string
}

interface MemoryStatusIndicatorProps extends MemoryStatusDetailProps {
  panelOpen: boolean
  onTogglePanel: () => void
}

export function describeMemoryModelBadges(input: {
  model: Pick<ModelSummary, 'id' | 'runtimeId'>
  selectedModelId?: string
  selectedRuntimeId?: string
  helperModelId?: string
  helperRuntimeId?: string
}): string[] {
  const badges: string[] = []

  if (
    input.model.id === input.selectedModelId
    && input.model.runtimeId === input.selectedRuntimeId
  ) {
    badges.push('Main')
  }

  if (
    input.model.id === input.helperModelId
    && (!input.helperRuntimeId || input.model.runtimeId === input.helperRuntimeId)
  ) {
    badges.push('Assistant helper')
  }

  return badges
}

export function isMemoryModelVisible(
  model: Pick<ModelSummary, 'status'>,
): boolean {
  return model.status === 'loaded' || model.status === 'loading'
}

export function describeMemoryModelStatus(
  model: Pick<ModelSummary, 'status'>,
): string | null {
  if (model.status === 'loading') {
    return 'Loading'
  }
  if (model.status === 'loaded') {
    return 'Loaded'
  }
  return null
}

export function describeMemoryModelStack(
  model: Pick<ModelSummary, 'runtimeId' | 'runtimeName'>,
): string {
  switch (model.runtimeId) {
    case 'ollama-native':
      return 'Ollama native'
    case 'ollama-openai':
      return 'Ollama OpenAI'
    case 'lmstudio-native':
      return 'LM Studio native'
    case 'lmstudio-openai':
      return 'LM Studio OpenAI'
    case 'omlx-openai':
      return 'oMLX OpenAI'
    default:
      return model.runtimeName
  }
}

export function isMemoryModelMlxOptimized(
  model: Pick<ModelSummary, 'runtimeId' | 'optimizationTags' | 'runtimeConfig'>,
): boolean {
  if (model.runtimeId.startsWith('omlx') || model.runtimeConfig?.provider === 'omlx') {
    return true
  }

  return model.optimizationTags?.some((tag) => tag.toLowerCase().includes('mlx')) ?? false
}

const OLLAMA_PARAMETER_ORDER = [
  'max_context_window',
  'context_length',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'num_predict',
  'repeat_penalty',
  'min_p',
  'seed',
] as const

function formatContextLengthLabel(contextLength?: number): string | null {
  if (!contextLength || contextLength <= 0) {
    return null
  }
  if (contextLength >= 1000) {
    const rounded = contextLength / 1000
    const whole = Math.round(rounded)
    const value = Math.abs(rounded - whole) < 0.05
      ? `${whole}k`
      : `${rounded.toFixed(1)}k`
    return `${value} ctx`
  }
  return `${contextLength} ctx`
}

function formatParameterLabel(parameter: string): string {
  return parameter.replace(/_/g, ' ')
}

function formatParameterValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? `${value}` : `${value}`
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }

  return null
}

export function buildRuntimeParameterChips(model: ModelSummary): string[] {
  const runtimeConfig = model.runtimeConfig
  if (!runtimeConfig) {
    return []
  }

  const chips: string[] = []
  const requestedContext =
    runtimeConfig.requestedOptions?.max_context_window
    ?? runtimeConfig.requestedOptions?.context_length
    ?? runtimeConfig.requestedOptions?.num_ctx
  const runtimeContext =
    runtimeConfig.loadedContextLength
    ?? model.contextLength
  if (
    runtimeConfig.provider === 'omlx'
    && requestedContext
    && runtimeContext
    && requestedContext !== runtimeContext
  ) {
    const requestedLabel = formatContextLengthLabel(requestedContext)
    const runtimeLabel = formatContextLengthLabel(runtimeContext)
    if (requestedLabel) {
      chips.push(`${requestedLabel} requested`)
    }
    if (runtimeLabel) {
      chips.push(`${runtimeLabel} runtime`)
    }
  } else {
    const contextLabel = formatContextLengthLabel(runtimeContext ?? requestedContext)
    if (contextLabel) {
      chips.push(contextLabel)
    }
  }

  if (typeof runtimeConfig.approxGpuResidencyPercent === 'number') {
    chips.push(`${runtimeConfig.approxGpuResidencyPercent}% GPU`)
  }

  const parameterSource: Record<string, unknown> = {
    ...(runtimeConfig.baseParameters ?? {}),
    ...(runtimeConfig.requestedOptions ?? {}),
  }

  const seen = new Set<string>()
  const emit = (parameter: string) => {
    if (
      seen.has(parameter)
      || parameter === 'num_ctx'
      || parameter === 'context_length'
      || parameter === 'max_context_window'
    ) {
      return
    }
    const value = formatParameterValue(parameterSource[parameter])
    if (!value) {
      return
    }
    seen.add(parameter)
    chips.push(`${formatParameterLabel(parameter)} ${value}`)
  }

  for (const parameter of OLLAMA_PARAMETER_ORDER) {
    emit(parameter)
  }

  for (const parameter of Object.keys(parameterSource).sort()) {
    emit(parameter)
  }

  return chips
}

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US')

export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0'
  }
  if (count >= 1_000_000) {
    const millions = count / 1_000_000
    return `${millions.toFixed(millions >= 10 ? 1 : 2)}M`
  }
  if (count >= 10_000) {
    const thousands = count / 1000
    return `${thousands.toFixed(thousands >= 100 ? 0 : 1)}k`
  }
  return TOKEN_FORMATTER.format(Math.round(count))
}

export function findTokenUsageForModel(
  usage: ModelTokenUsageSnapshot[] | undefined,
  model: Pick<ModelSummary, 'id' | 'runtimeId'>,
): ModelTokenUsageSnapshot | null {
  if (!usage) {
    return null
  }
  const exact = usage.find(
    (entry) => entry.runtimeId === model.runtimeId && entry.modelId === model.id,
  )
  if (exact) {
    return exact
  }
  return usage.find((entry) => entry.modelId === model.id) ?? null
}

function formatElapsedSince(startedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function buildVisibleMemoryModels(input: MemoryStatusDetailProps): ModelSummary[] {
  return [...input.models]
    .filter(isMemoryModelVisible)
    .sort((left, right) => {
      const leftCurrent =
        left.id === input.selectedModelId
        && left.runtimeId === input.selectedRuntimeId
      const rightCurrent =
        right.id === input.selectedModelId
        && right.runtimeId === input.selectedRuntimeId

      if (leftCurrent && !rightCurrent) return -1
      if (rightCurrent && !leftCurrent) return 1
      if (left.status === 'loading' && right.status !== 'loading') return -1
      if (right.status === 'loading' && left.status !== 'loading') return 1
      return left.name.localeCompare(right.name)
    })
}

export function MemoryStatusPanel({
  systemStats,
  models,
  modelTokenUsage,
  selectedModelId,
  selectedRuntimeId,
  helperModelId,
  helperRuntimeId,
}: MemoryStatusDetailProps) {
  const [now, setNow] = useState(() => Date.now())
  const visibleModels = buildVisibleMemoryModels({
    systemStats,
    models,
    modelTokenUsage,
    selectedModelId,
    selectedRuntimeId,
    helperModelId,
    helperRuntimeId,
  })
  const usageEntries = modelTokenUsage?.usage ?? []
  const sessionTotalTokens = usageEntries.reduce(
    (sum, entry) => sum + (entry.totalTokens ?? 0),
    0,
  )
  const sessionTotalTurns = usageEntries.reduce(
    (sum, entry) => sum + (entry.turns ?? 0),
    0,
  )
  const sessionStartedAtMs = modelTokenUsage?.startedAtMs ?? now
  const elapsedLabel = formatElapsedSince(sessionStartedAtMs, now)

  useEffect(() => {
    setNow(Date.now())
    const handle = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(handle)
  }, [])

  return (
    <section
      className="flex h-full min-h-0 flex-col border-t border-zinc-200/80 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40"
      aria-label="Model memory"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          <Layers size={12} className="shrink-0" />
          <span className="truncate">
            Model Memory
            {visibleModels.length > 0 ? ` (${visibleModels.length})` : ''}
          </span>
        </div>
        <div className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
          RAM {systemStats.memoryUsedGB}/{systemStats.memoryTotalGB} GB
        </div>
      </div>
      <div className="mt-2 rounded-lg bg-white/85 px-3 py-2 shadow-sm ring-1 ring-zinc-200/70 dark:bg-zinc-900/70 dark:ring-zinc-800">
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
          <span className="font-medium">
            Session tokens
          </span>
          <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-100">
            {formatTokenCount(sessionTotalTokens)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
          <span>
            {sessionTotalTurns} turn{sessionTotalTurns === 1 ? '' : 's'}
            {' · since app start'}
          </span>
          <span className="font-mono tabular-nums">{elapsedLabel}</span>
        </div>
      </div>
      {visibleModels.length > 0 ? (
        <div className="scrollbar-thin mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          {visibleModels.map((model) => {
            const details = [
              model.parameterCount,
              model.quantization,
            ].filter(Boolean)
            const runtimeChips = buildRuntimeParameterChips(model)
            const badges = describeMemoryModelBadges({
              model,
              selectedModelId,
              selectedRuntimeId,
              helperModelId,
              helperRuntimeId,
            })
            const statusLabel = describeMemoryModelStatus(model)
            const usageForModel = findTokenUsageForModel(usageEntries, model)
            const stackLabel = describeMemoryModelStack(model)
            const mlxOptimized = isMemoryModelMlxOptimized(model)

            return (
              <details
                key={`${model.runtimeId}:${model.id}`}
                className="group rounded-lg border border-zinc-200/80 bg-white/90 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/80"
              >
                <summary className="flex cursor-pointer list-none items-start gap-2 px-2.5 py-1.5 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:hover:bg-zinc-900/80 dark:focus-visible:ring-zinc-700 [&::-webkit-details-marker]:hidden">
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-180 dark:text-zinc-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <span className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                        {model.name}
                      </span>
                      {statusLabel && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            model.status === 'loading'
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                              : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                          }`}
                        >
                          {statusLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[10px] text-zinc-500 dark:text-zinc-400">
                      <span className="truncate">{stackLabel}</span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-px font-medium ${
                          mlxOptimized
                            ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                            : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
                        }`}
                      >
                        {mlxOptimized ? 'MLX' : 'Not MLX'}
                      </span>
                    </div>
                  </div>
                </summary>
                <div className="border-t border-zinc-200/70 px-3 pb-2 pt-1.5 dark:border-zinc-800">
                  {badges.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {badges.map((badge) => (
                        <span
                          key={`${model.runtimeId}:${model.id}:${badge}`}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            badge === 'Assistant helper'
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                              : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                          }`}
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {details.length > 0 ? details.join(' · ') : stackLabel}
                  </div>
                  {runtimeChips.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {runtimeChips.map((chip) => (
                        <span
                          key={`${model.runtimeId}:${model.id}:${chip}`}
                          className="rounded-full bg-zinc-200/80 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-dashed border-zinc-200/70 pt-1.5 text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <span className="font-medium uppercase tracking-wide">
                      Tokens
                    </span>
                    <span className="font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
                      {usageForModel
                        ? formatTokenCount(usageForModel.totalTokens)
                        : '0'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] text-zinc-400 dark:text-zinc-500">
                    <span>
                      in{' '}
                      <span className="font-mono tabular-nums">
                        {usageForModel ? formatTokenCount(usageForModel.inputTokens) : '0'}
                      </span>
                      {' · out '}
                      <span className="font-mono tabular-nums">
                        {usageForModel ? formatTokenCount(usageForModel.outputTokens) : '0'}
                      </span>
                      {usageForModel && usageForModel.reasoningTokens > 0 ? (
                        <>
                          {' · reason '}
                          <span className="font-mono tabular-nums">
                            {formatTokenCount(usageForModel.reasoningTokens)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span>
                      {usageForModel ? usageForModel.turns : 0} turn
                      {usageForModel?.turns === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {model.id}
                  </div>
                </div>
              </details>
            )
          })}
        </div>
      ) : (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          No models are loaded or loading yet.
        </p>
      )}
    </section>
  )
}

export function MemoryStatusIndicator({
  systemStats,
  models,
  modelTokenUsage,
  selectedModelId,
  selectedRuntimeId,
  panelOpen,
  onTogglePanel,
}: MemoryStatusIndicatorProps) {
  const visibleModels = buildVisibleMemoryModels({
    systemStats,
    models,
    modelTokenUsage,
    selectedModelId,
    selectedRuntimeId,
  })
  const loadedModelCount = visibleModels.filter((model) => model.status === 'loaded').length
  const loadingModelCount = visibleModels.filter((model) => model.status === 'loading').length
  const usageEntries = modelTokenUsage?.usage ?? []
  const sessionTotalTokens = usageEntries.reduce(
    (sum, entry) => sum + (entry.totalTokens ?? 0),
    0,
  )
  const memoryRatio =
    systemStats.memoryTotalGB > 0
      ? systemStats.memoryUsedGB / systemStats.memoryTotalGB
      : 0
  const memoryTone =
    memoryRatio > 0.85
      ? 'text-red-500'
      : memoryRatio > 0.7
        ? 'text-amber-500'
        : 'text-zinc-500 dark:text-zinc-400'

  return (
    <button
      type="button"
      onClick={onTogglePanel}
      aria-label={`${panelOpen ? 'Hide' : 'Show'} model memory. RAM ${systemStats.memoryUsedGB} of ${systemStats.memoryTotalGB} GB. ${loadedModelCount} loaded model${loadedModelCount === 1 ? '' : 's'} and ${loadingModelCount} loading model${loadingModelCount === 1 ? '' : 's'}. ${formatTokenCount(sessionTotalTokens)} tokens processed this session.`}
      aria-pressed={panelOpen}
      aria-expanded={panelOpen}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums outline-none transition-colors hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-zinc-300 dark:hover:bg-zinc-800 dark:focus-visible:ring-zinc-600 ${
        panelOpen
          ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
          : memoryTone
      }`}
      title={panelOpen ? 'Hide model memory' : 'Show model memory'}
    >
      <Layers size={11} className="shrink-0 opacity-70" />
      <span className="sr-only">
        {panelOpen ? 'Hide model memory' : 'Show model memory'}
      </span>
      <span aria-hidden="true">
        <span>{systemStats.memoryUsedGB}GB</span>
      </span>
    </button>
  )
}
