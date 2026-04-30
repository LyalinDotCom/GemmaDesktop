import { useEffect, useMemo, useState } from 'react'
import { Check, Download, Loader2, RefreshCw } from 'lucide-react'
import { GEMMA_CATALOG } from '@shared/gemmaCatalog'
import type { AppSettings, GemmaInstallState, ModelSummary, RuntimeSummary } from '@/types'

type ModelTarget = {
  modelId: string
  runtimeId: string
}

type FirstRunModelSelection = {
  mainModel: ModelTarget
  helperModel: ModelTarget
  runtimeSettings?: Partial<AppSettings['runtimes']>
}

type RuntimeChoice = {
  id: string
  runtimeIds: string[]
  label: string
  description: string
  status: RuntimeSummary['status'] | 'unknown'
}

const DEFAULT_RUNTIME_CHOICES: RuntimeChoice[] = [
  {
    id: 'ollama-native',
    runtimeIds: ['ollama-native', 'ollama-openai'],
    label: 'Ollama',
    description: 'Use locally installed Ollama models, or explicitly download a guided Gemma model.',
    status: 'unknown',
  },
  {
    id: 'omlx-openai',
    runtimeIds: ['omlx-openai'],
    label: 'oMLX',
    description: 'Use a running oMLX OpenAI-compatible endpoint.',
    status: 'unknown',
  },
  {
    id: 'lmstudio-openai',
    runtimeIds: ['lmstudio-native', 'lmstudio-openai'],
    label: 'LM Studio',
    description: 'Use models already loaded or visible through LM Studio.',
    status: 'unknown',
  },
]

function runtimeProviderKey(runtimeId: string): string {
  if (runtimeId.startsWith('ollama')) return 'ollama'
  if (runtimeId.startsWith('omlx')) return 'omlx'
  if (runtimeId.startsWith('lmstudio')) return 'lmstudio'
  if (runtimeId.startsWith('llamacpp')) return 'llamacpp'
  return runtimeId
}

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

function strongerRuntimeStatus(
  left: RuntimeChoice['status'],
  right: RuntimeChoice['status'],
): RuntimeChoice['status'] {
  const score: Record<RuntimeChoice['status'], number> = {
    running: 4,
    stopped: 3,
    unknown: 2,
    not_installed: 1,
  }
  return score[right] > score[left] ? right : left
}

function mergeRuntimeChoice(
  byProvider: Map<string, RuntimeChoice>,
  runtimeId: string,
  input: Omit<RuntimeChoice, 'runtimeIds'> & { runtimeIds?: string[] },
) {
  const providerKey = runtimeProviderKey(runtimeId)
  const existing = byProvider.get(providerKey)
  const runtimeIds = input.runtimeIds ?? [runtimeId]
  if (!existing) {
    byProvider.set(providerKey, {
      ...input,
      runtimeIds: [...runtimeIds],
    })
    return
  }

  byProvider.set(providerKey, {
    ...existing,
    label: existing.label || input.label,
    description: existing.description || input.description,
    status: strongerRuntimeStatus(existing.status, input.status),
    runtimeIds: Array.from(new Set([...existing.runtimeIds, ...runtimeIds])),
  })
}

function buildRuntimeChoices(
  runtimes: RuntimeSummary[],
  models: ModelSummary[],
): RuntimeChoice[] {
  const byProvider = new Map<string, RuntimeChoice>()
  for (const choice of DEFAULT_RUNTIME_CHOICES) {
    mergeRuntimeChoice(byProvider, choice.id, choice)
  }
  for (const runtime of runtimes) {
    mergeRuntimeChoice(byProvider, runtime.id, {
      id: runtime.id,
      label: runtimeLabel(runtime.id, runtime.name),
      description: runtimeDescription(runtime.id),
      status: runtime.status,
    })
  }
  for (const model of models) {
    mergeRuntimeChoice(byProvider, model.runtimeId, {
      id: model.runtimeId,
      label: runtimeLabel(model.runtimeId, model.runtimeName),
      description: runtimeDescription(model.runtimeId),
      status: 'running',
    })
  }

  return [...byProvider.values()].sort((left, right) => {
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
  runtimeSettings,
  gemmaInstallStates,
  onChoose,
  onDismiss,
  onEnsureGemmaModel,
  onRefreshModels,
}: {
  runtimes: RuntimeSummary[]
  models: ModelSummary[]
  runtimeSettings: AppSettings['runtimes']
  gemmaInstallStates: GemmaInstallState[]
  onChoose: (selection: FirstRunModelSelection) => void | Promise<void>
  onDismiss: () => void
  onEnsureGemmaModel: (tag: string) => Promise<unknown>
  onRefreshModels: (runtimeSettings?: Partial<AppSettings['runtimes']>) => Promise<void>
}) {
  const runtimeChoices = useMemo(
    () => buildRuntimeChoices(runtimes, models),
    [models, runtimes],
  )
  const [runtimeId, setRuntimeId] = useState(runtimeChoices[0]?.id ?? 'ollama-native')
  const [selectedModel, setSelectedModel] = useState<ModelTarget | null>(null)
  const [manualModelId, setManualModelId] = useState('')
  const [helperMatchesMain, setHelperMatchesMain] = useState(false)
  const [selectedHelperModel, setSelectedHelperModel] = useState<ModelTarget | null>(null)
  const [manualHelperModelId, setManualHelperModelId] = useState('')
  const [omlxEndpoint, setOmlxEndpoint] = useState(runtimeSettings.omlx.endpoint)
  const [omlxApiKey, setOmlxApiKey] = useState(runtimeSettings.omlx.apiKey)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setOmlxEndpoint(runtimeSettings.omlx.endpoint)
    setOmlxApiKey(runtimeSettings.omlx.apiKey)
  }, [runtimeSettings.omlx.apiKey, runtimeSettings.omlx.endpoint])

  const selectedRuntime = runtimeChoices.find((runtime) => runtime.id === runtimeId)
    ?? runtimeChoices[0]
  const runtimeModels = Array.from(models
    .filter((model) =>
      selectedRuntime?.runtimeIds.includes(model.runtimeId) ?? model.runtimeId === runtimeId)
    .reduce((byModelId, model) => {
      const existing = byModelId.get(model.id)
      if (!existing || model.runtimeId === runtimeId) {
        byModelId.set(model.id, model)
      }
      return byModelId
    }, new Map<string, ModelSummary>())
    .values())
    .sort((left, right) => left.name.localeCompare(right.name))
  const manualTarget: ModelTarget = {
    runtimeId,
    modelId: manualModelId.trim(),
  }
  const target = selectedModel ?? (manualTarget.modelId ? manualTarget : null)
  const manualHelperTarget: ModelTarget = {
    runtimeId,
    modelId: manualHelperModelId.trim(),
  }
  const helperTarget = helperMatchesMain
    ? target
    : selectedHelperModel ?? (manualHelperTarget.modelId ? manualHelperTarget : null)
  const needsOmlxEndpoint = runtimeId === 'omlx-openai'
  const canContinue =
    Boolean(target)
    && Boolean(helperTarget)
    && !busy
    && (!needsOmlxEndpoint || Boolean(omlxEndpoint.trim()))
  const refreshRuntimeSettings = (): Partial<AppSettings['runtimes']> | undefined =>
    runtimeId === 'omlx-openai'
      ? {
          omlx: {
            ...runtimeSettings.omlx,
            endpoint: omlxEndpoint.trim(),
            apiKey: omlxApiKey.trim(),
          },
        }
      : undefined

  const chooseTarget = async () => {
    if (!target?.modelId.trim()) {
      setError('Choose an installed main model or enter a main model id first.')
      return
    }
    if (!helperTarget?.modelId.trim()) {
      setError('Choose a helper model or keep the same model for helper tasks.')
      return
    }
    const normalized = {
      mainModel: {
        runtimeId: target.runtimeId,
        modelId: target.modelId.trim(),
      },
      helperModel: {
        runtimeId: helperTarget.runtimeId,
        modelId: helperTarget.modelId.trim(),
      },
      runtimeSettings: refreshRuntimeSettings(),
    }

    setBusy(`choose:${normalized.mainModel.runtimeId}:${normalized.mainModel.modelId}`)
    setError(null)
    try {
      await onChoose(normalized)
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
      await onChoose({
        mainModel: { runtimeId: 'ollama-native', modelId: tag },
        helperModel: { runtimeId: 'ollama-native', modelId: tag },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not download ${tag}.`)
    } finally {
      setBusy(null)
    }
  }

  const refreshModels = async () => {
    setBusy('refresh-models')
    setError(null)
    try {
      await onRefreshModels(refreshRuntimeSettings())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh models.')
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
                    setSelectedModel(null)
                    setManualModelId('')
                    setSelectedHelperModel(null)
                    setManualHelperModelId('')
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
            <button
              type="button"
              onClick={() => { void refreshModels() }}
              disabled={Boolean(busy) || (runtimeId === 'omlx-openai' && !omlxEndpoint.trim())}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
            >
              {busy === 'refresh-models' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Refresh Models
            </button>

            {runtimeModels.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {runtimeModels.map((model) => (
                  <button
                    key={`${model.runtimeId}:${model.id}`}
                    type="button"
                    onClick={() => {
                      setSelectedModel({
                        runtimeId: model.runtimeId,
                        modelId: model.id,
                      })
                      setManualModelId('')
                      setError(null)
                    }}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      selectedModel?.runtimeId === model.runtimeId
                        && selectedModel.modelId === model.id
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
                setSelectedModel(null)
                setError(null)
              }}
              placeholder={runtimeId.startsWith('ollama') ? 'gemma4:26b' : 'model id'}
              className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-700"
            />
            <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    Helper model
                  </h4>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Pick a smaller helper for titles, summaries, narration, and background tasks.
                  </p>
                </div>
                <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => {
                      setHelperMatchesMain(false)
                      setSelectedHelperModel(null)
                      setManualHelperModelId('')
                      setError(null)
                    }}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      !helperMatchesMain
                        ? 'bg-white text-indigo-700 shadow-sm dark:bg-zinc-800 dark:text-indigo-300'
                        : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    Choose helper
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHelperMatchesMain(true)
                      setSelectedHelperModel(null)
                      setManualHelperModelId('')
                      setError(null)
                    }}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      helperMatchesMain
                        ? 'bg-white text-indigo-700 shadow-sm dark:bg-zinc-800 dark:text-indigo-300'
                        : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    Same as main
                  </button>
                </div>
              </div>

              {helperMatchesMain ? (
                <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  Helper tasks will use the selected main model.
                </p>
              ) : (
                <>
                  {runtimeModels.length > 0 ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {runtimeModels.map((model) => (
                        <button
                          key={`helper:${model.runtimeId}:${model.id}`}
                          type="button"
                          onClick={() => {
                            setSelectedHelperModel({
                              runtimeId: model.runtimeId,
                              modelId: model.id,
                            })
                            setManualHelperModelId('')
                            setError(null)
                          }}
                          className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                            selectedHelperModel?.runtimeId === model.runtimeId
                              && selectedHelperModel.modelId === model.id
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
                      No helper models are visible for this runtime yet.
                    </p>
                  )}

                  <label className="mt-3 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Or enter a helper model id
                  </label>
                  <input
                    value={manualHelperModelId}
                    onChange={(event) => {
                      setManualHelperModelId(event.target.value)
                      setSelectedHelperModel(null)
                      setError(null)
                    }}
                    placeholder={runtimeId.startsWith('ollama') ? 'gemma4:e2b' : 'helper model id'}
                    className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-700"
                  />
                </>
              )}
            </div>
            {runtimeId === 'omlx-openai' && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  oMLX endpoint
                  <input
                    value={omlxEndpoint}
                    onChange={(event) => {
                      setOmlxEndpoint(event.target.value)
                      setError(null)
                    }}
                    placeholder="http://127.0.0.1:8000"
                    className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-800 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-700"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  API key / PIN
                  <input
                    value={omlxApiKey}
                    onChange={(event) => {
                      setOmlxApiKey(event.target.value)
                      setError(null)
                    }}
                    placeholder="Optional bearer token"
                    type="password"
                    autoComplete="off"
                    className="mt-1.5 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-800 outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-300/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-700"
                  />
                </label>
              </div>
            )}
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
            onClick={() => { void chooseTarget() }}
            disabled={!canContinue}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy?.startsWith('choose:') ? <Loader2 size={14} className="animate-spin" /> : null}
            Use Selected Models
          </button>
        </div>
      </div>
    </div>
  )
}
