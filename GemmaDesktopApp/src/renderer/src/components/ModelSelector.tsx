import { useState, useRef, useEffect } from 'react'
import { AudioLines, ChevronDown, Circle, Code, Download, Eye, Lightbulb, Loader2, Search, Type, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  GemmaInstallState,
  ModelSummary,
  SessionMode,
} from '@/types'
import { ModelPickerList } from '@/components/ModelPickerList'
import { ModelOptimizationBadges } from '@/components/ModelOptimizationBadges'
import {
  buildGuidedGemmaModels,
  describeRuntimeModelMeta,
  resolveGuidedGemmaModelTarget,
  resolveGuidedGemmaCapabilityBadges,
  resolveGuidedGemmaDisplayName,
  resolveGuidedModelSelectionState,
} from '@/lib/guidedModels'

interface ModelSelectorProps {
  models: ModelSummary[]
  gemmaInstallStates?: GemmaInstallState[]
  selectedModelId: string
  selectedRuntimeId: string
  mode: SessionMode
  onSelect?: (selection: {
    modelId: string
    runtimeId: string
  }) => void | Promise<void>
  hasMessages?: boolean
  disabled?: boolean
  layout?: 'compact' | 'expanded'
  buttonClassName?: string
  menuClassName?: string
  rootClassName?: string
  emptyState?: ReactNode
  menuPlacement?: 'top' | 'bottom'
}

const CAPABILITY_ICONS: Record<string, typeof Type> = {
  Text: Type,
  Vision: Eye,
  Audio: AudioLines,
  Thinking: Lightbulb,
  Tools: Wrench,
  'Code Execution': Code,
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

export function ModelSelector({
  models,
  gemmaInstallStates = [],
  selectedModelId,
  selectedRuntimeId,
  mode,
  onSelect,
  hasMessages,
  disabled,
  layout = 'compact',
  buttonClassName,
  menuClassName,
  rootClassName,
  emptyState,
  menuPlacement = 'top',
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [menuFamily, setMenuFamily] = useState<'gemma' | 'other'>('gemma')
  const [otherSearch, setOtherSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    if (!open) {
      setOtherSearch('')
    }
  }, [open])

  useEffect(() => {
    if (open && menuFamily === 'other') {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [open, menuFamily])

  const selection = resolveGuidedModelSelectionState(
    models,
    mode,
    {
      modelId: selectedModelId,
      runtimeId: selectedRuntimeId,
    },
    gemmaInstallStates,
  )
  const guidedGemma = buildGuidedGemmaModels(models, gemmaInstallStates)

  useEffect(() => {
    if (!open) {
      setMenuFamily(selection.family)
    }
  }, [open, selection.family])

  const compact = layout === 'compact'
  const shellClassName = buttonClassName ?? (
    compact
      ? 'inline-flex items-center gap-1 rounded-lg border border-zinc-200/70 bg-white/80 p-1 text-xs shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/80 dark:hover:border-zinc-700'
      : 'flex w-full items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 text-left text-sm transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800'
  )
  const triggerButtonClassName = compact
    ? 'inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-900'
    : 'flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-950'
  const renderedMenuClassName = menuClassName
    ?? `absolute left-0 z-50 max-h-[360px] min-w-[300px] max-w-[420px] overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${
      menuPlacement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
    }`

  return (
    <div ref={ref} className={rootClassName ?? 'relative'}>
      <div className={shellClassName}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setMenuFamily(selection.family)
            setOpen((current) => !current)
          }}
          className={triggerButtonClassName}
        >
          {selection.family === 'gemma' && selection.gemma ? (
            compact ? (
              <>
                <span className="font-medium text-zinc-500 dark:text-zinc-400">
                  {selection.familyLabel}
                </span>
                <span className="font-medium">
                  {selection.gemma.shortLabel}
                </span>
                <ChevronDown size={12} className="text-zinc-400" />
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {resolveGuidedGemmaDisplayName(selection.gemma)}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {describeRuntimeModelMeta(selection.gemma.model, selection.gemma)}
                  </div>
                </div>
                <ChevronDown size={14} className="text-zinc-400" />
              </>
            )
          ) : selection.otherModel ? (
            compact ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">
                    {selection.otherModel.name}
                  </span>
                  <ModelOptimizationBadges
                    tags={selection.otherModel.optimizationTags}
                    compact
                  />
                </span>
                <ChevronDown size={12} className="text-zinc-400" />
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                    <span className="truncate">
                      {selection.otherModel.name}
                    </span>
                    <ModelOptimizationBadges
                      tags={selection.otherModel.optimizationTags}
                      compact
                    />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {[selection.otherModel.runtimeLabel, selection.otherModel.quantization]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <ChevronDown size={14} className="text-zinc-400" />
              </>
            )
          ) : (
            <>
              <span className="text-zinc-500 dark:text-zinc-400">
                {selection.family === 'gemma'
                  ? 'Choose Gemma size'
                  : 'Choose model'}
              </span>
              <ChevronDown size={12} className="text-zinc-400" />
            </>
          )}
        </button>
      </div>

      {open && (
        <div className={renderedMenuClassName}>
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
                  selection.family === 'gemma'
                  && selection.gemma?.tag === entry.tag

                const capabilityIcons = resolveGuidedGemmaCapabilityBadges(entry)
                  .filter((badge) => badge in CAPABILITY_ICONS)

                return (
                  <button
                    key={entry.tag}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setOpen(false)
                      const target = resolveGuidedGemmaModelTarget(entry)
                      void onSelect?.({
                        modelId: target.modelId,
                        runtimeId: target.runtimeId,
                      })
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'bg-indigo-600 dark:bg-indigo-600'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    } ${index > 0 ? 'mt-0.5' : ''}`}
                  >
                    <span
                      className={`w-8 shrink-0 text-sm font-semibold ${
                        isSelected ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'
                      }`}
                    >
                      {entry.model?.parameterCount ?? entry.shortLabel}
                    </span>
                    <span
                      className={`w-[72px] shrink-0 text-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] ${
                        isSelected
                          ? 'bg-indigo-500/60 text-indigo-50'
                          : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200'
                      }`}
                    >
                      {entry.model?.quantization ?? entry.tierLabel}
                    </span>
                    <div
                      className={`flex items-center gap-1 ${
                        isSelected ? 'text-indigo-200' : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                      title={capabilityIcons.join(', ')}
                    >
                      {capabilityIcons.map((badge) => {
                        const Icon = CAPABILITY_ICONS[badge]!
                        return <Icon key={badge} size={12} />
                      })}
                    </div>
                    <span
                      className={`text-[10px] ${
                        isSelected ? 'text-indigo-200' : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                    >
                      {entry.model?.contextLength
                        ? `${Math.round(entry.model.contextLength / 1024)}K`
                        : entry.contextBadge}
                    </span>
                    <div className="flex-1" />
                    <div
                      className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${gemmaStatusTone(entry.availability)} ${
                        isSelected ? 'text-white' : ''
                      }`}
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
                    onChange={(e) => setOtherSearch(e.target.value)}
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
                emptyState={emptyState}
                searchQuery={otherSearch}
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
