import { useMemo, useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import { GEMMA_CATALOG } from '@shared/gemmaCatalog'
import type { GemmaInstallState, ModelSummary, RuntimeSummary } from '@/types'

type ModelTarget = {
  modelId: string
  runtimeId: string
}

type RuntimeChoice = {
  id: string
  label: string
  description: string
  status: RuntimeSummary['status'] | 'unknown'
}

const DEFAULT_RUNTIME_CHOICES: RuntimeChoice[] = [
  {
    id: 'ollama-native',
    label: 'Ollama',
    description: 'Use locally installed Ollama models, or explicitly download a guided Gemma model.',
    status: 'unknown',
  },
  {
    id: 'omlx-openai',
    label: 'oMLX',
    description: 'Use a running oMLX OpenAI-compatible endpoint.',
    status: 'unknown',
  },
  {
    id: 'lmstudio-openai',
    label: 'LM Studio',
    description: 'Use models already loaded or visible through LM Studio.',
    status: 'unknown',
  },
]

function runtimeLabel(runtimeId: string, runtimeName?: string): string {
  if (runtimeId.startsWith('ollama')) return 'Ollama'
  if (runtimeId.startsWith('omlx')) return 'oMLX'
  if (runtimeId.startsWith('lmstudio')) return 'LM Studio'
  if (runtimeId.startsWith('llamacpp')) return 'llama.cpp'
  return runtimeName?.trim() || runtimeId
}

function runtimeDescription(runtimeId: string): string {
  if (runtimeId.startsWith('ollama')) {
    return 'Use locally installed Ollama models, or explicitly download a guided Gemma model.'
  }
  if (runtimeId.startsWith('omlx')) {
    return 'Use a running oMLX OpenAI-compatible endpoint.'
  }
  if (runtimeId.startsWith('lmstudio')) {
    return 'Use models already loaded or visible through LM Studio.'
  }
  if (runtimeId.startsWith('llamacpp')) {
    return 'Use a running llama.cpp server model.'
  }
  return 'Use a model from this detected local runtime.'
}

function buildRuntimeChoices(
  runtimes: RuntimeSummary[],
  models: ModelSummary[],
): RuntimeChoice[] {
  const byId = new Map<string, RuntimeChoice>()
  for (const choice of DEFAULT_RUNTIME_CHOICES) {
    byId.set(choice.id, choice)
  }
  for (const runtime of runtimes) {
    byId.set(runtime.id, {
      id: runtime.id,
      label: runtimeLabel(runtime.id, runtime.name),
      description: runtimeDescription(runtime.id),
      status: runtime.status,
    })
  }
  for (const model of models) {
    if (!byId.has(model.runtimeId)) {
      byId.set(model.runtimeId, {
        id: model.runtimeId,
        label: runtimeLabel(model.runtimeId, model.runtimeName),
        description: runtimeDescription(model.runtimeId),
        status: 'running',
      })
    }
  }

  return [...byId.values()].sort((left, right) => {
    const order = ['ollama-native', 'omlx-openai', 'lmstudio-openai']
    const leftOrder = order.indexOf(left.id)
    const rightOrder = order.indexOf(right.id)
    if (leftOrder !== -1 || rightOrder !== -1) {
      return (leftOrder === -1 ? 99 : leftOrder) - (rightOrder === -1 ? 99 : rightOrder)
    }
    return left.label.localeCompare(right.label)
  })
}

function runtimeStatusLabel(status: RuntimeChoice['status']): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'stopped':
      return 'Offline'
    case 'not_installed':
      return 'Not detected'
    case 'unknown':
      return 'Optional'
  }
}

function installLabel(state: GemmaInstallState | undefined): string {
  if (!state) return 'Download'
  if (state.status === 'running') return state.progressText ?? 'Downloading...'
  if (state.status === 'completed') return 'Downloaded'
  return 'Retry Download'
}

function failedEnsureResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null
  }
  const record = result as Record<string, unknown>
  if (record.ok !== false && record.cancelled !== true) {
    return null
  }
  if (record.cancelled === true) {
    return 'Download cancelled.'
  }
  return typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : 'Download failed.'
}

export function FirstRunModelSetup({
  runtimes,
  models,
  gemmaInstallStates,
  onChoose,
  onDismiss,
  onEnsureGemmaModel,
}: {
  runtimes: RuntimeSummary[]
  models: ModelSummary[]
  gemmaInstallStates: GemmaInstallState[]
  onChoose: (target: ModelTarget) => void | Promise<void>
  onDismiss: () => void
  onEnsureGemmaModel: (tag: string) => Promise<unknown>
}) {
  const runtimeChoices = useMemo(
    () => buildRuntimeChoices(runtimes, models),
    [models, runtimes],
  )
  const [runtimeId, setRuntimeId] = useState(runtimeChoices[0]?.id ?? 'ollama-native')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [manualModelId, setManualModelId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedRuntime = runtimeChoices.find((runtime) => runtime.id === runtimeId)
    ?? runtimeChoices[0]
  const runtimeModels = models
    .filter((model) => model.runtimeId === runtimeId)
    .sort((left, right) => left.name.localeCompare(right.name))
  const targetModelId = (selectedModelId || manualModelId).trim()
  const canContinue = targetModelId.length > 0 && !busy

  const chooseTarget = async (modelId: string) => {
    const normalized = modelId.trim()
    if (!normalized) {
      setError('Choose an installed model or enter a model id first.')
      return
    }

    setBusy(`choose:${normalized}`)
    setError(null)
    try {
      await onChoose({ runtimeId, modelId: normalized })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the model choice.')
    } finally {
      setBusy(null)
    }
  }

  const downloadGemma = async (tag: string) => {
    setRuntimeId('ollama-native')
    setBusy(`download:${tag}`)
    setError(null)
    try {
      const result = await onEnsureGemmaModel(tag)
      const failure = failedEnsureResult(result)
      if (failure) {
        setError(failure)
        return
      }
      await onChoose({ runtimeId: 'ollama-native', modelId: tag })
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not download ${tag}.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="absolute inset-0 z-[145] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-model-title"
        className="no-drag flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="border-b border-zinc-200 px-6 py-5 dark:border-zinc-800">
          <h2
            id="first-run-model-title"
            className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
          >
            Choose how Gemma Desktop should run models
          </h2>
          <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            Nothing will be downloaded until you ask for it. Pick an inference provider and choose
            an existing model, or skip setup and decide later in Settings.
          </p>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            {runtimeChoices.map((runtime) => {
              const active = runtime.id === runtimeId
              return (
                <button
                  key={runtime.id}
                  type="button"
                  onClick={() => {
                    setRuntimeId(runtime.id)
                    setSelectedModelId('')
                    setManualModelId('')
                    setError(null)
                  }}
                  className={`min-h-32 rounded-xl border px-4 py-3 text-left transition-colors ${
                    active
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-950 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-100'
                      : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{runtime.label}</span>
                    {active ? <Check size={15} /> : null}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    {runtime.description}
                  </p>
                  <span className="mt-3 inline-flex rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {runtimeStatusLabel(runtime.status)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-5 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {selectedRuntime?.label ?? runtimeId} model
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Choose one of the models already visible to this runtime.
                </p>
              </div>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                {runtimeModels.length} found
              </span>
            </div>

            {runtimeModels.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {runtimeModels.map((model) => (
                  <button
                    key={`${model.runtimeId}:${model.id}`}
                    type="button"
                    onClick={() => {
                      setSelectedModelId(model.id)
                      setManualModelId('')
                      setError(null)
                    }}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      selectedModelId === model.id
                        ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/40'
                        : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
                    }`}
                  >
                    <span className="block truncate font-medium text-zinc-800 dark:text-zinc-100">
                      {model.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {model.id}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                No installed models are visible for this runtime yet.
              </p>
            )}

            <label className="mt-4 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Or enter a model id
            </label>
            <input
              value={manualModelId}
              onChange={(event) => {
                setManualModelId(event.target.value)
                setSelectedModelId('')
                setError(null)
              }}
              placeholder={runtimeId.startsWith('ollama') ? 'gemma4:26b' : 'model id'}
              className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-700"
            />
          </div>

          {runtimeId === 'ollama-native' && (
            <div className="mt-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Optional guided Gemma downloads
              </h3>
              <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                These run `ollama pull` only when clicked.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {GEMMA_CATALOG.map((entry) => {
                  const state = gemmaInstallStates.find((item) => item.tag === entry.tag)
                  const installing = busy === `download:${entry.tag}` || state?.status === 'running'
                  return (
                    <button
                      key={entry.tag}
                      type="button"
                      onClick={() => { void downloadGemma(entry.tag) }}
                      disabled={Boolean(busy) || installing}
                      className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-left transition-colors hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:hover:border-zinc-700"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                          {entry.label}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                          {entry.tierLabel} · {entry.contextBadge} · {entry.architectureBadge}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                        {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        {installLabel(state)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error ? (
            <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Decide Later
          </button>
          <button
            type="button"
            onClick={() => { void chooseTarget(targetModelId) }}
            disabled={!canContinue}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy?.startsWith('choose:') ? <Loader2 size={14} className="animate-spin" /> : null}
            Use Selected Model
          </button>
        </div>
      </div>
    </div>
  )
}
