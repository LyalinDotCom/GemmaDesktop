import {
  GEMMA_CATALOG,
  isGuidedGemmaTag,
  type GemmaCatalogEntry,
} from './gemmaCatalog'

export type ReasoningMode = 'auto' | 'on' | 'off'

export interface AppReasoningSettings {
  modelModes: Record<string, ReasoningMode>
}

export const REASONING_MODE_ORDER: readonly ReasoningMode[] = ['auto', 'off', 'on']

export function getDefaultReasoningSettings(): AppReasoningSettings {
  return {
    modelModes: {},
  }
}

export function normalizeReasoningMode(
  value: unknown,
  fallback: ReasoningMode = 'auto',
): ReasoningMode {
  return value === 'auto' || value === 'on' || value === 'off'
    ? value
    : fallback
}

export function normalizeReasoningSettings(
  value: unknown,
  fallback: AppReasoningSettings = getDefaultReasoningSettings(),
): AppReasoningSettings {
  const settingsRecord =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const rawModelModes = settingsRecord?.modelModes
  const modelModesValue =
    rawModelModes && typeof rawModelModes === 'object' && !Array.isArray(rawModelModes)
      ? (rawModelModes as Record<string, unknown>)
      : {}

  const modelModes = Object.fromEntries(
    Object.entries(modelModesValue)
      .map(([modelId, mode]) => [modelId.trim(), normalizeReasoningMode(mode, 'auto')] as const)
      .filter(
        ([modelId, mode]) =>
          modelId.length > 0
          && mode !== 'auto',
      ),
  )

  return {
    ...fallback,
    modelModes,
  }
}

export function resolveModelReasoningMode(
  settings: AppReasoningSettings | undefined,
  modelId: string,
): ReasoningMode {
  if (!settings || typeof modelId !== 'string' || modelId.trim().length === 0) {
    return 'auto'
  }

  return normalizeReasoningMode(settings.modelModes[modelId.trim()], 'auto')
}

export function supportsReasoningControlForModel(
  modelId: string,
  runtimeId: string,
): boolean {
  return runtimeId === 'ollama-native' && isGuidedGemmaTag(modelId)
}

export function listKnownReasoningControlModels(): readonly GemmaCatalogEntry[] {
  return GEMMA_CATALOG
}
