import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { ModelOptimizationBadges } from '@/components/ModelOptimizationBadges'
import type { AppSettings, ModelSummary } from '@/types'
import { normalizeProviderRuntimeId } from '@shared/sessionModelDefaults'

export interface ModelTargetOption {
  modelId: string
  runtimeId: string
  label: string
  providerLabel: string
  apiTypeLabel: string
  optimizationTags?: string[]
}

export interface ModelTargetOptionGroup {
  providerLabel: string
  options: ModelTargetOption[]
}

export function compareModelOptionText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function providerLabelForRuntime(
  runtimeId: string,
  runtimeName?: string,
): string {
  if (runtimeId.startsWith('ollama')) return 'Ollama'
  if (runtimeId.startsWith('lmstudio')) return 'LM Studio'
  if (runtimeId.startsWith('llamacpp')) return 'llama.cpp'
  if (runtimeId.startsWith('omlx')) return 'oMLX'
  return runtimeName?.trim() || runtimeId
}

export function apiTypeLabelForRuntime(runtimeId: string): string {
  if (runtimeId.endsWith('-openai')) return 'OpenAI-compatible API'
  if (runtimeId.endsWith('-native')) return 'Native API'
  if (runtimeId.endsWith('-server')) return 'Server API'
  return runtimeId
}

function modelTargetValue(target: {
  modelId: string
  runtimeId: string
}): string {
  return JSON.stringify([target.runtimeId, target.modelId])
}

function sameModelTarget(
  left: { modelId: string; runtimeId: string },
  right: { modelId: string; runtimeId: string },
): boolean {
  return left.modelId === right.modelId && left.runtimeId === right.runtimeId
}

function optionSearchText(option: ModelTargetOption): string {
  return [
    option.label,
    option.providerLabel,
    option.apiTypeLabel,
    option.runtimeId,
    option.modelId,
    ...(option.optimizationTags ?? []),
  ].join(' ').toLowerCase()
}

export function formatModelTargetOptionLabel(option: ModelTargetOption): string {
  const tagLabel = option.optimizationTags?.length
    ? ` - ${option.optimizationTags.join(', ')}`
    : ''
  return `${option.label} - ${option.providerLabel} - ${option.apiTypeLabel}${tagLabel}`
}

function compareModelTargetOptions(
  left: ModelTargetOption,
  right: ModelTargetOption,
): number {
  return (
    compareModelOptionText(left.label, right.label)
    || compareModelOptionText(left.providerLabel, right.providerLabel)
    || compareModelOptionText(left.apiTypeLabel, right.apiTypeLabel)
    || compareModelOptionText(left.runtimeId, right.runtimeId)
    || compareModelOptionText(left.modelId, right.modelId)
  )
}

function normalizeModelTargetOption(option: ModelTargetOption): ModelTargetOption {
  const runtimeId = normalizeProviderRuntimeId(option.runtimeId)
  return {
    ...option,
    runtimeId,
    providerLabel: providerLabelForRuntime(runtimeId, option.providerLabel),
    apiTypeLabel: apiTypeLabelForRuntime(runtimeId),
  }
}

export function groupModelTargetOptions(
  options: ModelTargetOption[],
): ModelTargetOptionGroup[] {
  const byProvider = new Map<string, ModelTargetOption[]>()
  const byValue = new Map<string, ModelTargetOption>()
  for (const option of options) {
    const normalizedOption = normalizeModelTargetOption(option)
    const value = modelTargetValue(normalizedOption)
    const existing = byValue.get(value)
    if (!existing || option.runtimeId === normalizedOption.runtimeId) {
      byValue.set(value, normalizedOption)
    }
  }

  for (const option of byValue.values()) {
    const providerOptions = byProvider.get(option.providerLabel) ?? []
    providerOptions.push(option)
    byProvider.set(option.providerLabel, providerOptions)
  }

  return [...byProvider.entries()]
    .sort(([left], [right]) => compareModelOptionText(left, right))
    .map(([providerLabel, providerOptions]) => ({
      providerLabel,
      options: [...providerOptions].sort(compareModelTargetOptions),
    }))
}

export function buildModelTargetOptions(input: {
  models: ModelSummary[]
  modelSelection: AppSettings['modelSelection']
  defaultModelSelection?: AppSettings['modelSelection']
}): ModelTargetOption[] {
  const byValue = new Map<string, ModelTargetOption>()
  const findTargetModel = (target: {
    modelId: string
    runtimeId: string
  }): ModelSummary | undefined =>
    input.models.find(
      (model) =>
        model.id === target.modelId
        && normalizeProviderRuntimeId(model.runtimeId) === normalizeProviderRuntimeId(target.runtimeId),
    )

  const addTarget = (target: { modelId: string; runtimeId: string }) => {
    const normalizedTarget = {
      ...target,
      runtimeId: normalizeProviderRuntimeId(target.runtimeId),
    }
    const value = modelTargetValue(normalizedTarget)
    if (byValue.has(value)) {
      return
    }
    const targetModel = findTargetModel(normalizedTarget) ?? findTargetModel(target)
    byValue.set(value, {
      ...normalizedTarget,
      label: targetModel?.name ?? target.modelId,
      providerLabel: providerLabelForRuntime(
        normalizedTarget.runtimeId,
        targetModel?.runtimeName,
      ),
      apiTypeLabel: apiTypeLabelForRuntime(normalizedTarget.runtimeId),
      optimizationTags: targetModel?.optimizationTags,
    })
  }

  addTarget(input.modelSelection.mainModel)
  addTarget(input.modelSelection.helperModel)
  if (input.defaultModelSelection) {
    addTarget(input.defaultModelSelection.mainModel)
    addTarget(input.defaultModelSelection.helperModel)
  }
  for (const model of input.models) {
    addTarget({
      modelId: model.id,
      runtimeId: model.runtimeId,
    })
  }

  return [...byValue.values()]
}

export function ModelTargetPicker({
  ariaLabel,
  value,
  groups,
  onSelect,
  initialOpen = false,
  disabled = false,
}: {
  ariaLabel: string
  value: { modelId: string; runtimeId: string }
  groups: ModelTargetOptionGroup[]
  onSelect: (target: { modelId: string; runtimeId: string }) => void
  initialOpen?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedOption = groups
    .flatMap((group) => group.options)
    .find((option) => sameModelTarget(option, value))
  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = normalizedQuery
    ? groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          optionSearchText(option).includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.options.length > 0)
    : groups

  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (!open || disabled) {
      setQuery('')
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [disabled, open])

  return (
    <div ref={rootRef} className={`relative ${open ? 'z-30' : 'z-0'}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setOpen((current) => !current)
          }
        }}
        className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:focus:border-indigo-700 ${
          disabled
            ? 'cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-600'
            : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700'
        }`}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-100">
            <span className="truncate">
              {selectedOption?.label ?? value.modelId}
            </span>
            <ModelOptimizationBadges
              tags={selectedOption?.optimizationTags}
              compact
            />
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {selectedOption
              ? `${selectedOption.providerLabel} - ${selectedOption.apiTypeLabel}`
              : value.runtimeId}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
              <Search size={13} className="shrink-0 text-zinc-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by model, provider, or API..."
                className="min-w-0 flex-1 bg-transparent text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200 dark:placeholder:text-zinc-500"
              />
            </div>
          </div>
          <div
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-64 overflow-y-auto overscroll-contain py-1"
            onWheel={(event) => event.stopPropagation()}
          >
            {visibleGroups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-zinc-500 dark:text-zinc-400">
                No models match this filter.
              </div>
            ) : visibleGroups.map((group) => (
              <div key={group.providerLabel}>
                <div className="bg-zinc-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:bg-zinc-950 dark:text-zinc-500">
                  {group.providerLabel}
                </div>
                {group.options.map((option) => {
                  const selected = sameModelTarget(option, value)
                  return (
                    <button
                      key={modelTargetValue(option)}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelect({
                          modelId: option.modelId,
                          runtimeId: option.runtimeId,
                        })
                        setOpen(false)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                        selected
                          ? 'bg-indigo-600 text-white'
                          : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                          <span className="truncate">
                            {option.label}
                          </span>
                          <ModelOptimizationBadges
                            tags={option.optimizationTags}
                            selected={selected}
                            compact
                          />
                        </span>
                        <span
                          className={`mt-0.5 block truncate text-[11px] ${
                            selected ? 'text-indigo-200' : 'text-zinc-400'
                          }`}
                        >
                          {option.apiTypeLabel} - {option.runtimeId}
                        </span>
                      </span>
                      {selected && (
                        <Check size={13} className="shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
