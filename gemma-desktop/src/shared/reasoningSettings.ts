import {
  GEMMA_CATALOG,
  resolveGemmaCatalogEntryForModel,
  type GemmaCatalogEntry,
} from './gemmaCatalog'

export type ReasoningMode = 'on'

export interface AppReasoningSettings {
  modelModes: Record<string, ReasoningMode>
}

export function getDefaultReasoningSettings(): AppReasoningSettings {
  return {
    modelModes: {},
  }
}

export function normalizeReasoningMode(
  value: unknown,
  fallback: ReasoningMode = 'on',
): ReasoningMode {
  return value === 'on'
    ? value
    : fallback
}

export function normalizeReasoningSettings(
  _value: unknown,
  fallback: AppReasoningSettings = getDefaultReasoningSettings(),
): AppReasoningSettings {
  return {
    ...fallback,
    modelModes: {},
  }
}

export function resolveModelReasoningMode(
  _settings: AppReasoningSettings | undefined,
  _modelId: string,
): ReasoningMode {
  return 'on'
}

export function supportsReasoningControlForModel(
  modelId: string,
  runtimeId: string,
): boolean {
  if (runtimeId === 'gemini-api') {
    return /^gemini-(?:3\.5|3\.1|3|2\.5|2)/i.test(modelId)
  }

  return (
    (runtimeId === 'ollama-openai' || runtimeId === 'ollama-native')
    && Boolean(resolveGemmaCatalogEntryForModel(modelId))
  )
}

export function listKnownReasoningControlModels(): readonly GemmaCatalogEntry[] {
  return GEMMA_CATALOG
}
