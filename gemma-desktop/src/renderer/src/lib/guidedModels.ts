import {
  DEFAULT_GEMMA_TAG,
  GEMMA_CATALOG,
  resolveGemmaCatalogEntryForModel,
  type GemmaCatalogEntry,
} from '@shared/gemmaCatalog'
import {
  normalizeProviderRuntimeId,
  resolveConfiguredSessionPrimaryTarget,
  type AppModelSelectionSettings,
} from '@shared/sessionModelDefaults'
import type {
  GemmaInstallState,
  GuidedModelFamily,
  ModelSummary,
  SessionMode,
} from '@/types'
import {
  buildSelectableModels,
  resolveSelectableModel,
  runtimeFamilyFromId,
  type SelectableModel,
} from '@/lib/sessionModels'

export type GuidedGemmaAvailability =
  | 'missing'
  | 'installing'
  | 'available'
  | 'loading'
  | 'loaded'

export interface GuidedGemmaModel extends GemmaCatalogEntry {
  availability: GuidedGemmaAvailability
  progressText?: string
  model?: ModelSummary
}

export interface GuidedModelSelectionState {
  family: GuidedModelFamily
  familyLabel: string
  gemma?: GuidedGemmaModel
  otherModel?: SelectableModel
}

function gemmaCandidateModels(
  models: ModelSummary[],
  entry: GemmaCatalogEntry,
): ModelSummary[] {
  return models.filter(
    (model) =>
      runtimeFamilyFromId(model.runtimeId) === 'ollama'
      && resolveGemmaCatalogEntryForModel(model.id, model.name)?.sizeId === entry.sizeId,
  )
}

function resolveLatestInstallState(
  installs: GemmaInstallState[],
  tag: string,
): GemmaInstallState | undefined {
  return [...installs]
    .filter((state) => state.tag === tag)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

export function buildGuidedGemmaModels(
  models: ModelSummary[],
  installs: GemmaInstallState[] = [],
): GuidedGemmaModel[] {
  return GEMMA_CATALOG.map((entry) => {
    const candidates = gemmaCandidateModels(models, entry)
    const latestInstall = resolveLatestInstallState(installs, entry.tag)
    const loadedModel = candidates.find((model) => model.status === 'loaded')
    const loadingModel = candidates.find((model) => model.status === 'loading')
    const availableModel = candidates.find((model) => model.status === 'available')
    const model = loadedModel ?? loadingModel ?? availableModel

    let availability: GuidedGemmaAvailability = 'missing'
    if (latestInstall?.status === 'running') {
      availability = 'installing'
    } else if (loadedModel) {
      availability = 'loaded'
    } else if (loadingModel) {
      availability = 'loading'
    } else if (availableModel) {
      availability = 'available'
    }

    return {
      ...entry,
      availability,
      progressText: latestInstall?.progressText,
      model,
    }
  })
}

export function sortGuidedGemmaModelsHighestFirst(
  models: GuidedGemmaModel[],
): GuidedGemmaModel[] {
  return [...models].sort((left, right) => right.order - left.order)
}

export function findGuidedGemmaModel(
  models: ModelSummary[],
  modelId: string,
  installs: GemmaInstallState[] = [],
): GuidedGemmaModel | undefined {
  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId)
  return buildGuidedGemmaModels(models, installs).find((entry) =>
    catalogEntry
      ? entry.sizeId === catalogEntry.sizeId
      : entry.tag === modelId,
  )
}

export function isGuidedGemmaTarget(
  target: { modelId?: string; runtimeId?: string },
): boolean {
  return Boolean(
    target.modelId
    && target.runtimeId
    && runtimeFamilyFromId(target.runtimeId) === 'ollama'
    && resolveGemmaCatalogEntryForModel(target.modelId),
  )
}

export function resolveGuidedGemmaModelTarget(
  entry: GuidedGemmaModel,
): { modelId: string; runtimeId: string } {
  return {
    modelId: entry.model?.id ?? entry.tag,
    runtimeId: entry.model
      ? normalizeProviderRuntimeId(entry.model.runtimeId)
      : entry.runtimeId,
  }
}

export function resolveDefaultGemmaTarget(
  models: ModelSummary[],
  installs: GemmaInstallState[] = [],
): GuidedGemmaModel {
  const guidedGemma = buildGuidedGemmaModels(models, installs)
  const defaultEntry = guidedGemma.find((entry) => entry.tag === DEFAULT_GEMMA_TAG)
  if (defaultEntry && defaultEntry.availability !== 'missing') {
    return defaultEntry
  }

  const installedFallback = guidedGemma
    .filter((entry) => entry.availability !== 'missing')
    .sort((left, right) => right.order - left.order)[0]

  return installedFallback ?? defaultEntry ?? buildGuidedGemmaModels(models, installs)[0]!
}

export function resolveDefaultSessionModelTarget(
  _models: ModelSummary[],
  mode: SessionMode,
  _installs: GemmaInstallState[] = [],
  modelSelection?: AppModelSelectionSettings,
): { modelId: string; runtimeId: string } {
  return resolveConfiguredSessionPrimaryTarget(
    {
      conversationKind: 'normal',
      baseMode: mode,
    },
    modelSelection,
  )
}

export function resolveDefaultResearchModelTarget(
  _models: ModelSummary[],
  _installs: GemmaInstallState[] = [],
  modelSelection?: AppModelSelectionSettings,
): { modelId: string; runtimeId: string } {
  return resolveConfiguredSessionPrimaryTarget(
    {
      conversationKind: 'research',
      baseMode: 'explore',
    },
    modelSelection,
  )
}

export function resolveDefaultInteractiveSessionTarget(
  models: ModelSummary[],
  mode: SessionMode,
  installs: GemmaInstallState[] = [],
  modelSelection?: AppModelSelectionSettings,
): { modelId: string; runtimeId: string } {
  return resolveDefaultSessionModelTarget(models, mode, installs, modelSelection)
}

export function resolveGuidedModelSelectionState(
  models: ModelSummary[],
  mode: SessionMode,
  target: {
    modelId?: string
    runtimeId?: string
  },
  installs: GemmaInstallState[] = [],
): GuidedModelSelectionState {
  const modelId = target.modelId?.trim() ?? ''
  const runtimeId = target.runtimeId?.trim() ?? ''

  if (modelId && runtimeId && isGuidedGemmaTarget({ modelId, runtimeId })) {
    return {
      family: 'gemma',
      familyLabel: 'Gemma',
      gemma:
        findGuidedGemmaModel(models, modelId, installs)
        ?? buildGuidedGemmaModels(models, installs).find((entry) => entry.tag === modelId),
    }
  }

  if (modelId) {
    return {
      family: 'other',
      familyLabel: 'Other models',
      otherModel: resolveSelectableModel(
        models,
        mode,
        {
          modelId,
          runtimeId,
        },
      ),
    }
  }

  const fallbackTarget = resolveDefaultSessionModelTarget(models, mode, installs)
  return {
    family: 'gemma',
    familyLabel: 'Gemma',
    gemma:
      findGuidedGemmaModel(models, fallbackTarget.modelId, installs)
      ?? resolveDefaultGemmaTarget(models, installs),
  }
}

export function isGuidedGemmaMissing(
  models: ModelSummary[],
  tag: string,
  installs: GemmaInstallState[] = [],
): boolean {
  const gemma = findGuidedGemmaModel(models, tag, installs)
  return !gemma || gemma.availability === 'missing'
}

export function resolveGuidedModelSummary(
  models: ModelSummary[],
  mode: SessionMode,
  target: {
    modelId?: string
    runtimeId?: string
  },
  installs: GemmaInstallState[] = [],
): SelectableModel | GuidedGemmaModel | undefined {
  const selection = resolveGuidedModelSelectionState(models, mode, target, installs)
  return selection.family === 'gemma' ? selection.gemma : selection.otherModel
}

export function guidedFamilyFromModelId(
  modelId?: string,
): GuidedModelFamily {
  return modelId && resolveGemmaCatalogEntryForModel(modelId) ? 'gemma' : 'other'
}

export function buildOtherSelectableModels(
  models: ModelSummary[],
  mode: SessionMode,
): SelectableModel[] {
  return buildSelectableModels(models, mode).filter(
    (model) =>
      model.family !== 'ollama'
      || !resolveGemmaCatalogEntryForModel(model.id, model.name),
  )
}

function formatContextBadge(contextLength?: number): string | null {
  if (!contextLength || !Number.isFinite(contextLength)) {
    return null
  }

  return `${Math.round(contextLength / 1024)}K ctx`
}

export function describeRuntimeModelMeta(
  model: ModelSummary | undefined,
  fallback?: GemmaCatalogEntry,
): string {
  if (!model) {
    return fallback
      ? [fallback.tierLabel, fallback.contextBadge].join(' · ')
      : ''
  }

  return [
    model.runtimeName,
    model.parameterCount,
    model.quantization,
    formatContextBadge(model.contextLength),
    model.attachmentSupport?.image ? 'image input' : null,
    model.attachmentSupport?.audio ? 'audio input' : null,
    ...(model.optimizationTags ?? []).map((tag) => `${tag} optimized`),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function resolveGuidedGemmaDisplayName(entry: GuidedGemmaModel): string {
  return entry.model?.name ?? entry.label
}

export function resolveGuidedGemmaCapabilityBadges(entry: GuidedGemmaModel): string[] {
  if (!entry.model) {
    return []
  }

  return [
    entry.model.attachmentSupport?.image ? 'Vision' : null,
    entry.model.attachmentSupport?.audio ? 'Audio' : null,
  ].filter((badge): badge is string => Boolean(badge))
}
