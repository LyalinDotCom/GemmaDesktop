import type { ReactNode } from 'react'
import { Circle, Loader2, MessageSquarePlus } from 'lucide-react'
import type { ModelSummary, SessionMode } from '@/types'
import { runtimeFamilyFromId } from '@/lib/sessionModels'
import { buildOtherSelectableModels } from '@/lib/guidedModels'

interface ModelPickerListProps {
  models: ModelSummary[]
  selectedModelId: string
  selectedRuntimeId: string
  mode: SessionMode
  onSelect?: (modelId: string, runtimeId: string) => void
  hasMessages?: boolean
  emptyState?: ReactNode
  searchQuery?: string
  pinSelectedModel?: boolean
}

export function ModelPickerList({
  models,
  selectedModelId,
  selectedRuntimeId,
  mode,
  onSelect,
  hasMessages,
  emptyState,
  searchQuery = '',
  pinSelectedModel = false,
}: ModelPickerListProps) {
  const allSelectableModels = buildOtherSelectableModels(models, mode)
  const normalizedQuery = searchQuery.toLowerCase().trim()
  const selectedFamily = runtimeFamilyFromId(selectedRuntimeId)
  const selectedModel = allSelectableModels.find(
    (model) =>
      model.id === selectedModelId
      && model.family === selectedFamily,
  )
  const pinnedSelectedModel = pinSelectedModel ? selectedModel : undefined
  const selectedModelKey = pinnedSelectedModel?.key
  const modelMatchesSearch = (model: (typeof allSelectableModels)[number]) =>
    model.name.toLowerCase().includes(normalizedQuery)
    || model.runtimeLabel.toLowerCase().includes(normalizedQuery)
    || (model.parameterCount?.toLowerCase().includes(normalizedQuery))
    || (model.quantization?.toLowerCase().includes(normalizedQuery))
  const selectableModels = normalizedQuery
    ? allSelectableModels.filter(modelMatchesSearch)
    : allSelectableModels
  const listedModels = selectedModelKey
    ? selectableModels.filter((model) => model.key !== selectedModelKey)
    : selectableModels

  if (listedModels.length === 0 && !pinnedSelectedModel) {
    return (
      <>
        {hasMessages && (
          <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <MessageSquarePlus
              size={12}
              className="flex-shrink-0 text-zinc-400"
            />
            <span className="text-[11px] text-zinc-400">
              Switching model keeps this conversation and updates future turns
            </span>
          </div>
        )}
        {emptyState ?? (
          <div className="px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
            No models are available for this conversation mode yet.
          </div>
        )}
      </>
    )
  }

  const grouped: Record<string, typeof listedModels> = {}
  for (const model of listedModels) {
    const family = model.runtimeLabel
    if (!grouped[family]) grouped[family] = []
    grouped[family].push(model)
  }

  for (const key of Object.keys(grouped)) {
    const group = grouped[key]
    if (!group) continue
    group.sort((a, b) => {
      if (a.status === 'loaded' && b.status !== 'loaded') return -1
      if (b.status === 'loaded' && a.status !== 'loaded') return 1
      return 0
    })
  }

  return (
    <>
      {hasMessages && (
        <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <MessageSquarePlus
            size={12}
            className="flex-shrink-0 text-zinc-400"
          />
          <span className="text-[11px] text-zinc-400">
            Switching model keeps this conversation and updates future turns
          </span>
        </div>
      )}

      {pinnedSelectedModel && (
        <div className="border-b border-zinc-100 bg-indigo-50/70 px-2 py-2 dark:border-zinc-800 dark:bg-indigo-950/20">
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-indigo-500 dark:text-indigo-300">
            Selected model
          </div>
          <button
            type="button"
            onClick={() =>
              onSelect?.(pinnedSelectedModel.id, pinnedSelectedModel.preferredRuntimeId)}
            className="flex w-full items-center gap-3 rounded-lg bg-indigo-600 px-3 py-2 text-left text-white shadow-sm dark:bg-indigo-600"
          >
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium">
                {pinnedSelectedModel.name}
              </span>
              <div className="mt-0.5 text-[11px] text-indigo-200">
                {[
                  pinnedSelectedModel.runtimeLabel,
                  pinnedSelectedModel.parameterCount,
                  pinnedSelectedModel.quantization,
                  pinnedSelectedModel.contextLength
                    ? `${(pinnedSelectedModel.contextLength / 1024).toFixed(0)}K ctx`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            {pinnedSelectedModel.status === 'loaded' && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
                <Circle size={6} fill="currentColor" />
                Loaded
              </span>
            )}
            {pinnedSelectedModel.status === 'loading' && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
                <Loader2 size={10} className="animate-spin" />
              </span>
            )}
          </button>
        </div>
      )}

      {listedModels.length === 0 && (
        <div className="px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
          No other models match the current filter.
        </div>
      )}

      {Object.entries(grouped).map(([family, familyModels], groupIdx) => (
        <div key={family}>
          <div
            className={`flex items-center gap-2 px-3 py-2 ${
              groupIdx > 0 ? 'border-t border-zinc-100 dark:border-zinc-800' : ''
            }`}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
              {family}
            </span>
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          </div>

          {familyModels.map((model) => {
            const isSelected =
              model.id === selectedModelId
              && model.family === selectedFamily
            const details = [
              model.parameterCount,
              model.quantization,
              model.contextLength
                ? `${(model.contextLength / 1024).toFixed(0)}K ctx`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')

            return (
              <button
                key={model.key}
                type="button"
                onClick={() => onSelect?.(model.id, model.preferredRuntimeId)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? 'bg-indigo-600 dark:bg-indigo-600'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-xs font-medium ${
                      isSelected
                        ? 'text-white'
                        : 'text-zinc-800 dark:text-zinc-200'
                    }`}
                  >
                    {model.name}
                  </span>
                  {details && (
                    <div
                      className={`mt-0.5 text-[11px] ${
                        isSelected ? 'text-indigo-200' : 'text-zinc-400'
                      }`}
                    >
                      {details}
                    </div>
                  )}
                </div>
                {model.status === 'loaded' && (
                  <span
                    className={`flex items-center gap-1 text-[10px] font-medium ${
                      isSelected ? 'text-emerald-300' : 'text-emerald-500'
                    }`}
                  >
                    <Circle size={6} fill="currentColor" />
                    Loaded
                  </span>
                )}
                {model.status === 'loading' && (
                  <span
                    className={`flex items-center gap-1 text-[10px] font-medium ${
                      isSelected ? 'text-amber-300' : 'text-amber-500'
                    }`}
                  >
                    <Loader2 size={10} className="animate-spin" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </>
  )
}
