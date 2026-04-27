import {
  DEFAULT_HELPER_GEMMA_TAG,
} from './gemmaCatalog'

export type SessionPrimaryMode = 'explore' | 'build'
export type SessionPrimaryConversationKind = 'normal' | 'research'

export interface SessionPrimaryModelTarget {
  modelId: string
  runtimeId: string
}

export interface AppModelSelectionSettings {
  mainModel: SessionPrimaryModelTarget
  helperModel: SessionPrimaryModelTarget
}

export const DEFAULT_PRIMARY_RUNTIME_ID = 'ollama-native'
export const LOW_MEMORY_DEFAULT_PRIMARY_MODEL_ID = 'gemma4:26b'
export const HIGH_MEMORY_DEFAULT_PRIMARY_MODEL_ID = 'gemma4:31b'
export const DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES = 32 * 1024 ** 3
export const DEFAULT_PRIMARY_MODEL_ID = LOW_MEMORY_DEFAULT_PRIMARY_MODEL_ID
export const DEFAULT_HELPER_MODEL_ID = DEFAULT_HELPER_GEMMA_TAG

export function resolveDefaultPrimaryModelIdForMemory(
  totalMemoryBytes: number,
): string {
  if (
    !Number.isFinite(totalMemoryBytes)
    || totalMemoryBytes <= DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES
  ) {
    return LOW_MEMORY_DEFAULT_PRIMARY_MODEL_ID
  }

  return HIGH_MEMORY_DEFAULT_PRIMARY_MODEL_ID
}

export function createDefaultModelSelectionSettings(
  totalMemoryBytes: number,
): AppModelSelectionSettings {
  return {
    mainModel: {
      modelId: resolveDefaultPrimaryModelIdForMemory(totalMemoryBytes),
      runtimeId: DEFAULT_PRIMARY_RUNTIME_ID,
    },
    helperModel: {
      modelId: DEFAULT_HELPER_MODEL_ID,
      runtimeId: DEFAULT_PRIMARY_RUNTIME_ID,
    },
  }
}

export const DEFAULT_MODEL_SELECTION_SETTINGS: AppModelSelectionSettings =
  createDefaultModelSelectionSettings(0)

export function normalizeSessionPrimaryModelTarget(
  value: unknown,
): SessionPrimaryModelTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const modelId =
    typeof record.modelId === 'string' ? record.modelId.trim() : ''
  const runtimeId =
    typeof record.runtimeId === 'string' ? record.runtimeId.trim() : ''

  if (!modelId || !runtimeId) {
    return null
  }

  return {
    modelId,
    runtimeId,
  }
}

export function normalizeAppModelSelectionSettings(
  value: unknown,
  fallback: AppModelSelectionSettings = DEFAULT_MODEL_SELECTION_SETTINGS,
): AppModelSelectionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      mainModel: { ...fallback.mainModel },
      helperModel: { ...fallback.helperModel },
    }
  }

  const record = value as Record<string, unknown>
  const mainModel =
    normalizeSessionPrimaryModelTarget(record.mainModel)
    ?? fallback.mainModel
  const helperModel =
    normalizeSessionPrimaryModelTarget(record.helperModel)
    ?? fallback.helperModel

  return {
    mainModel: { ...mainModel },
    helperModel: { ...helperModel },
  }
}

export function resolveConfiguredSessionPrimaryTarget(
  _input: {
    conversationKind: SessionPrimaryConversationKind
    baseMode: SessionPrimaryMode
  },
  modelSelection?: Partial<AppModelSelectionSettings> | null,
): SessionPrimaryModelTarget {
  const normalized = normalizeAppModelSelectionSettings(modelSelection)
  return { ...normalized.mainModel }
}

export function resolveSavedDefaultSessionPrimaryTarget(
  modelSelection?: Partial<AppModelSelectionSettings> | null,
): SessionPrimaryModelTarget {
  return resolveConfiguredSessionPrimaryTarget(
    {
      conversationKind: 'normal',
      baseMode: 'explore',
    },
    modelSelection,
  )
}

export function resolveConfiguredHelperModelTarget(
  modelSelection?: Partial<AppModelSelectionSettings> | null,
): SessionPrimaryModelTarget {
  const normalized = normalizeAppModelSelectionSettings(modelSelection)
  return { ...normalized.helperModel }
}
