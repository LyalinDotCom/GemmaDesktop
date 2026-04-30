import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Circle, Download, Loader2, Search } from 'lucide-react'
import { ModelPickerList } from '@/components/ModelPickerList'
import { ModelOptimizationBadges } from '@/components/ModelOptimizationBadges'
import {
  buildGuidedGemmaModels,
  sortGuidedGemmaModelsHighestFirst,
} from '@/lib/guidedModels'
import type { GemmaInstallState, ModelSummary, SessionMode } from '@/types'
import { findGemmaCatalogEntryByTag } from '@shared/gemmaCatalog'

interface GemmaSizeSelectorProps {
  models: ModelSummary[]
  gemmaInstallStates?: GemmaInstallState[]
  selectedModelId: string
  selectedRuntimeId: string
  mode: SessionMode
  hasMessages?: boolean
  disabled?: boolean
  onSelect?: (selection: {
    modelId: string
    runtimeId: string
  }) => void | Promise<void>
}

function gemmaStatusTone(status: ReturnType<typeof buildGuidedGemmaModels>[number]['availability']): string {
  switch (status) {
    case 'loaded':
      return 'text-emerald-500'
    case 'loading':
      return 'text-amber-500'
    case 'installing':
      return 'text-sky-500'
    case 'available':
      return 'text-zinc-500'
    case 'missing':
      return 'text-zinc-400'
  }
}

function gemmaStatusLabel(status: ReturnType<typeof buildGuidedGemmaModels>[number]['availability']): string {
  switch (status) {
    case 'loaded':
      return 'Loaded'
    case 'loading':
      return 'Loading'
    case 'installing':
      return 'Downloading'
    case 'available':
      return 'Installed'
    case 'missing':
      return 'Download'
  }
}

function displayTierLabel(input: { tierLabel: string; tier: string }): string {
  return input.tier === 'extra-high' ? 'X-High' : input.tierLabel
}

export function GemmaSizeSelector({
  models,
  gemmaInstallStates = [],
  selectedModelId,
  selectedRuntimeId,
  mode,
  hasMessages = false,
  disabled = false,
  onSelect,
}: GemmaSizeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [menuFamily, setMenuFamily] = useState<'gemma' | 'other'>('gemma')
  const [otherSearch, setOtherSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const guidedGemma = useMemo(
    () => sortGuidedGemmaModelsHighestFirst(
      buildGuidedGemmaModels(models, gemmaInstallStates),
    ),
    [gemmaInstallStates, models],
  )

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])

  const selectedGemma =
    guidedGemma.find(
      (entry) =>
        entry.tag === selectedModelId
        && entry.runtimeId === selectedRuntimeId,
    )
    ?? (selectedRuntimeId === 'ollama-native'
      ? guidedGemma.find((entry) => entry.tag === selectedModelId)
      : undefined)
  const selectedCustomModel = !selectedGemma
    ? models.find(
      (model) =>
        model.id === selectedModelId
        && model.runtimeId === selectedRuntimeId,
    )
    : undefined
  const selectedFamily = selectedGemma ? 'gemma' : 'other'
  const buttonLabel = selectedGemma
    ? displayTierLabel(selectedGemma)
    : 'Custom'
  const selectedCustomOptimizationTags = selectedCustomModel?.optimizationTags ?? []
  const selectedCustomOptimizationLabel = selectedCustomOptimizationTags.length > 0
    ? ` · ${selectedCustomOptimizationTags.map((tag) => `${tag} optimized`).join(' · ')}`
    : ''
  const buttonTitle = selectedGemma
    ? `Session model size: ${displayTierLabel(selectedGemma)}`
    : `Session model: ${selectedCustomModel?.name ?? selectedModelId}${selectedCustomOptimizationLabel}`

  useEffect(() => {
    if (!open) {
      setMenuFamily(selectedFamily)
      setOtherSearch('')
    }
  }, [open, selectedFamily])

  useEffect(() => {
    if (open && menuFamily === 'other') {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [open, menuFamily])

  return (
    <div ref={ref} className="relative">
      <div className="inline-flex items-center rounded-full border border-zinc-200/80 bg-white/90 p-0.5 shadow-[0_10px_24px_-20px_rgba(24,24,27,0.8)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setMenuFamily(selectedFamily)
            setOpen((current) => !current)
          }}
          aria-label="Session model size"
          title={buttonTitle}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          <span>{buttonLabel}</span>
          <ModelOptimizationBadges
            tags={selectedCustomOptimizationTags}
            compact
          />
          <ChevronDown size={12} className="text-zinc-400" />
        </button>
      </div>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[360px] min-w-[320px] overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="sticky top-0 z-20 border-b border-zinc-100 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-700 dark:bg-zinc-950">
              {(['gemma', 'other'] as const).map((family) => (
                <button
                  key={family}
                  type="button"
                  onClick={() => setMenuFamily(family)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    menuFamily === family
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  }`}
                >
                  {family === 'gemma' ? 'Gemma' : 'Other models'}
                </button>
              ))}
            </div>
          </div>

          {menuFamily === 'gemma' ? (
            <div className="px-2 py-2">
              {guidedGemma.map((entry, index) => {
                const isSelected =
                  entry.tag === selectedModelId
                  && entry.runtimeId === selectedRuntimeId

                return (
                  <button
                    key={entry.tag}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setOpen(false)
                      void onSelect?.({
                        modelId: entry.tag,
                        runtimeId: entry.runtimeId,
                      })
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'bg-indigo-600 dark:bg-indigo-600'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    } ${index > 0 ? 'mt-0.5' : ''}`}
                  >
                    <span
                      className={`w-[58px] shrink-0 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        isSelected
                          ? 'bg-indigo-500/60 text-indigo-50'
                          : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      {displayTierLabel(entry)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate text-sm font-medium ${
                          isSelected ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'
                        }`}
                      >
                        {entry.label}
                      </div>
                      <div
                        className={`truncate text-[11px] ${
                          isSelected ? 'text-indigo-100' : 'text-zinc-500 dark:text-zinc-400'
                        }`}
                      >
                        {entry.contextBadge} · {entry.architectureBadge}
                      </div>
                    </div>
                    <div
                      className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${gemmaStatusTone(entry.availability)} ${
                        isSelected ? 'text-white' : ''
                      }`}
                      title={gemmaStatusLabel(entry.availability)}
                    >
                      {entry.availability === 'loaded' && (
                        <Circle size={7} fill="currentColor" />
                      )}
                      {(entry.availability === 'loading' || entry.availability === 'installing') && (
                        <Loader2 size={12} className="animate-spin" />
                      )}
                      {entry.availability === 'missing' && (
                        <Download size={12} />
                      )}
                      <span>{gemmaStatusLabel(entry.availability)}</span>
                    </div>
                  </button>
                )
              })}
              {selectedCustomModel && !findGemmaCatalogEntryByTag(selectedModelId) && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                  Current conversation is using a custom model. Picking a size here switches back to the pinned Gemma ladder.
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="sticky top-[53px] z-10 border-b border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                  <Search size={13} className="shrink-0 text-zinc-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={otherSearch}
                    onChange={(event) => setOtherSearch(event.target.value)}
                    placeholder="Filter models..."
                    className="min-w-0 flex-1 bg-transparent text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>
              <ModelPickerList
                models={models}
                selectedModelId={selectedModelId}
                selectedRuntimeId={selectedRuntimeId}
                mode={mode}
                hasMessages={hasMessages}
                searchQuery={otherSearch}
                pinSelectedModel
                onSelect={(modelId, runtimeId) => {
                  setOpen(false)
                  void onSelect?.({
                    modelId,
                    runtimeId,
                  })
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
