import type { ModelSummary, SessionMode } from '@/types'

export interface SelectableModel {
  key: string
  id: string
  name: string
  family: string
  runtimeLabel: string
  preferredRuntimeId: string
  status: ModelSummary['status']
  parameterCount?: string
  quantization?: string
  contextLength?: number
  optimizationTags?: string[]
}

const RUNTIME_PREFERENCE: Record<string, string[]> = {
  lmstudio: ['lmstudio-openai', 'lmstudio-native'],
  ollama: ['ollama-native', 'ollama-openai'],
  llamacpp: ['llamacpp-server'],
  omlx: ['omlx-openai'],
}

function statusRank(status: ModelSummary['status']): number {
  switch (status) {
    case 'loaded':
      return 3
    case 'loading':
      return 2
    case 'available':
      return 1
  }
}

function metadataRank(model: ModelSummary): number {
  let score = 0
  if (model.parameterCount) score += 2
  if (model.quantization) score += 2
  if (model.contextLength) score += 1
  return score
}

export function runtimeFamilyFromId(runtimeId: string): string {
  if (runtimeId.startsWith('lmstudio')) return 'lmstudio'
  if (runtimeId.startsWith('ollama')) return 'ollama'
  if (runtimeId.startsWith('llamacpp')) return 'llamacpp'
  if (runtimeId.startsWith('omlx')) return 'omlx'
  return runtimeId
}

function runtimeLabelForFamily(family: string, fallback: string): string {
  switch (family) {
    case 'lmstudio':
      return 'LM Studio'
    case 'ollama':
      return 'Ollama'
    case 'llamacpp':
      return 'llama.cpp'
    case 'omlx':
      return 'oMLX'
    default:
      return fallback
  }
}

function runtimePreferenceIndex(model: ModelSummary): number {
  const family = runtimeFamilyFromId(model.runtimeId)
  const order = RUNTIME_PREFERENCE[family] ?? [model.runtimeId]
  const index = order.indexOf(model.runtimeId)
  return index === -1 ? order.length : index
}

function sessionRuntimeRank(model: ModelSummary, mode: SessionMode): number {
  const family = runtimeFamilyFromId(model.runtimeId)
  let score = 100 - runtimePreferenceIndex(model) * 10

  if (family === 'lmstudio' && model.runtimeId === 'lmstudio-openai') {
    score += mode === 'build' ? 42 : 40
  }

  if (family === 'lmstudio' && model.runtimeId === 'lmstudio-native') {
    score -= 20
  }

  if (family !== 'lmstudio') {
    score += statusRank(model.status)
  }

  return score
}

function displayRank(model: ModelSummary): number {
  let score = statusRank(model.status) * 100
  score += metadataRank(model) * 10
  score += 10 - runtimePreferenceIndex(model)
  return score
}

function mergeStatus(models: ModelSummary[]): ModelSummary['status'] {
  if (models.some((model) => model.status === 'loaded')) return 'loaded'
  if (models.some((model) => model.status === 'loading')) return 'loading'
  return 'available'
}

function pickMetadata(
  models: ModelSummary[],
  selector: (model: ModelSummary) => string | number | undefined,
): string | number | undefined {
  const ranked = [...models].sort((left, right) => displayRank(right) - displayRank(left))
  for (const model of ranked) {
    const value = selector(model)
    if (value != null && value !== '') {
      return value
    }
  }
  return undefined
}

function mergeOptimizationTags(models: ModelSummary[]): string[] | undefined {
  const tags = new Set<string>()
  const ranked = [...models].sort((left, right) => displayRank(right) - displayRank(left))

  for (const model of ranked) {
    for (const tag of model.optimizationTags ?? []) {
      const normalized = tag.trim()
      if (normalized) {
        tags.add(normalized)
      }
    }
  }

  return tags.size > 0 ? [...tags] : undefined
}

function modelContextLength(model: ModelSummary | undefined): number | undefined {
  if (!model) {
    return undefined
  }

  return model.contextLength
    ?? model.runtimeConfig?.loadedContextLength
    ?? model.runtimeConfig?.nominalContextLength
    ?? model.runtimeConfig?.requestedOptions?.num_ctx
    ?? model.runtimeConfig?.requestedOptions?.context_length
}

export function resolveSessionModelContextLength(
  models: ModelSummary[],
  target: { modelId?: string | null; runtimeId?: string | null },
  fallback = 32_768,
): number {
  const modelId = target.modelId ?? ''
  const runtimeId = target.runtimeId ?? ''
  if (!modelId) {
    return fallback
  }

  const exact = models.find(
    (model) => model.id === modelId && model.runtimeId === runtimeId,
  )
  const exactContextLength = modelContextLength(exact)
  if (exactContextLength) {
    return exactContextLength
  }

  const targetFamily = runtimeId ? runtimeFamilyFromId(runtimeId) : undefined
  const familyMatch = models.find(
    (model) =>
      model.id === modelId
      && (!targetFamily || runtimeFamilyFromId(model.runtimeId) === targetFamily)
      && modelContextLength(model),
  )
  const familyContextLength = modelContextLength(familyMatch)
  if (familyContextLength) {
    return familyContextLength
  }

  const sameModel = models.find(
    (model) => model.id === modelId && modelContextLength(model),
  )
  return modelContextLength(sameModel) ?? fallback
}

export function buildSelectableModels(
  models: ModelSummary[],
  mode: SessionMode,
): SelectableModel[] {
  const groups = new Map<string, ModelSummary[]>()

  for (const model of models) {
    const family = runtimeFamilyFromId(model.runtimeId)
    const key = `${family}::${model.id}`
    const group = groups.get(key) ?? []
    group.push(model)
    groups.set(key, group)
  }

  return [...groups.entries()]
    .flatMap(([key, candidates]) => {
      const firstCandidate = candidates[0]
      if (!firstCandidate) {
        return []
      }

      const family = runtimeFamilyFromId(firstCandidate.runtimeId)
      const displayModel = [...candidates].sort(
        (left, right) => displayRank(right) - displayRank(left),
      )[0]
      const preferredRuntime = [...candidates].sort(
        (left, right) =>
          sessionRuntimeRank(right, mode) - sessionRuntimeRank(left, mode),
      )[0]
      if (!displayModel || !preferredRuntime) {
        return []
      }

      return [{
        key,
        id: displayModel.id,
        name: displayModel.name,
        family,
        runtimeLabel: runtimeLabelForFamily(family, displayModel.runtimeName),
        preferredRuntimeId: preferredRuntime.runtimeId,
        status: mergeStatus(candidates),
        parameterCount: pickMetadata(
          candidates,
          (model) => model.parameterCount,
        ) as string | undefined,
        quantization: pickMetadata(
          candidates,
          (model) => model.quantization,
        ) as string | undefined,
        contextLength: pickMetadata(
          candidates,
          (model) => model.contextLength,
        ) as number | undefined,
        optimizationTags: mergeOptimizationTags(candidates),
      }]
    })
    .sort((left, right) => {
      const statusDelta = statusRank(right.status) - statusRank(left.status)
      if (statusDelta !== 0) return statusDelta

      const runtimeDelta = left.runtimeLabel.localeCompare(right.runtimeLabel)
      if (runtimeDelta !== 0) return runtimeDelta

      return left.name.localeCompare(right.name)
    })
}

export function resolveSelectableModel(
  models: ModelSummary[],
  mode: SessionMode,
  target: { modelId: string; runtimeId?: string },
): SelectableModel | undefined {
  const selectableModels = buildSelectableModels(models, mode)
  const targetFamily = target.runtimeId
    ? runtimeFamilyFromId(target.runtimeId)
    : undefined

  return selectableModels.find(
    (model) =>
      model.id === target.modelId
      && (!targetFamily || model.family === targetFamily),
  ) ?? selectableModels.find((model) => model.id === target.modelId)
}

export function resolvePreferredSessionModel(
  models: ModelSummary[],
  target: { modelId: string; runtimeId?: string },
  mode: SessionMode,
): ModelSummary | undefined {
  const targetFamily = target.runtimeId
    ? runtimeFamilyFromId(target.runtimeId)
    : undefined
  const candidates = models.filter(
    (model) =>
      model.id === target.modelId
      && (!targetFamily || runtimeFamilyFromId(model.runtimeId) === targetFamily),
  )

  if (candidates.length === 0) {
    return undefined
  }

  return [...candidates].sort(
    (left, right) =>
      sessionRuntimeRank(right, mode) - sessionRuntimeRank(left, mode),
  )[0]
}

export function resolveDefaultSessionModel(
  models: ModelSummary[],
  mode: SessionMode,
  defaultModelId?: string,
): ModelSummary | undefined {
  if (defaultModelId) {
    const preferredDefault = resolvePreferredSessionModel(
      models,
      { modelId: defaultModelId },
      mode,
    )
    if (preferredDefault) {
      return preferredDefault
    }
  }

  const selectable = buildSelectableModels(models, mode)
  const first = selectable[0]
  if (!first) {
    return undefined
  }

  return resolvePreferredSessionModel(
    models,
    { modelId: first.id, runtimeId: first.preferredRuntimeId },
    mode,
  )
}
