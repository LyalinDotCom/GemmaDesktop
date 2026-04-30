import {
  parseGemmaContextBadge,
  resolveGemmaCatalogEntryForModel,
  type GemmaSizeId,
} from './gemmaCatalog'

export interface OllamaManagedModelProfile {
  num_ctx?: number
  temperature?: number
  top_p?: number
  top_k?: number
  num_predict?: number
  repeat_penalty?: number
  seed?: number
}

export interface AppOllamaSettings {
  modelProfiles: Record<string, OllamaManagedModelProfile>
}

export const OLLAMA_CONTEXT_PRESET_VALUES = [
  4_096,
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
  262_144,
] as const

export function formatOllamaContextPreset(value: number): string {
  if (value >= 1024) {
    return `${Math.round(value / 1024)}K`
  }
  return `${value}`
}

function pickDefaultGemmaContextBySize(
  sizeId: GemmaSizeId,
  _totalMemoryBytes: number,
): number {
  switch (sizeId) {
    case 'e2b':
    case 'e4b':
      return 131_072
    case '26b':
    case '31b':
      return 262_144
  }
}

function buildDefaultGemmaProfile(
  sizeId: GemmaSizeId,
  totalMemoryBytes: number,
): OllamaManagedModelProfile {
  return {
    num_ctx: pickDefaultGemmaContextBySize(sizeId, totalMemoryBytes),
    temperature: 1,
    top_p: 0.95,
    top_k: 64,
  }
}

export function getDefaultOllamaSettings(
  totalMemoryBytes = 32 * 1024 ** 3,
): AppOllamaSettings {
  return {
    modelProfiles: {
      'gemma4:e2b': buildDefaultGemmaProfile('e2b', totalMemoryBytes),
      'gemma4:e4b': buildDefaultGemmaProfile('e4b', totalMemoryBytes),
      'gemma4:26b': buildDefaultGemmaProfile('26b', totalMemoryBytes),
      'gemma4:31b': buildDefaultGemmaProfile('31b', totalMemoryBytes),
    },
  }
}

function normalizeOptionalNumber(
  value: unknown,
  fallback: number | undefined,
  options: {
    integer?: boolean
    min?: number
    max?: number
  } = {},
): number | undefined {
  if (value == null || value === '') {
    return fallback
  }

  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) {
    return fallback
  }

  const bounded = Math.min(
    options.max ?? numeric,
    Math.max(options.min ?? numeric, numeric),
  )

  return options.integer ? Math.round(bounded) : bounded
}

export function normalizeOllamaManagedModelProfile(
  value: unknown,
  fallback: OllamaManagedModelProfile = {},
): OllamaManagedModelProfile {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  return {
    num_ctx: normalizeOptionalNumber(record.num_ctx, fallback.num_ctx, {
      integer: true,
      min: OLLAMA_CONTEXT_PRESET_VALUES[0],
      max: OLLAMA_CONTEXT_PRESET_VALUES[OLLAMA_CONTEXT_PRESET_VALUES.length - 1],
    }),
    temperature: normalizeOptionalNumber(record.temperature, fallback.temperature, {
      min: 0,
      max: 5,
    }),
    top_p: normalizeOptionalNumber(record.top_p, fallback.top_p, {
      min: 0,
      max: 1,
    }),
    top_k: normalizeOptionalNumber(record.top_k, fallback.top_k, {
      integer: true,
      min: 1,
      max: 512,
    }),
    num_predict: normalizeOptionalNumber(record.num_predict, fallback.num_predict, {
      integer: true,
      min: 1,
      max: 32_768,
    }),
    repeat_penalty: normalizeOptionalNumber(record.repeat_penalty, fallback.repeat_penalty, {
      min: 0,
      max: 2,
    }),
    seed: normalizeOptionalNumber(record.seed, fallback.seed, {
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
  }
}

export function normalizeOllamaSettings(
  value: unknown,
  fallback: AppOllamaSettings = getDefaultOllamaSettings(),
): AppOllamaSettings {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const rawModelProfiles =
    record.modelProfiles && typeof record.modelProfiles === 'object' && !Array.isArray(record.modelProfiles)
      ? (record.modelProfiles as Record<string, unknown>)
      : {}

  const modelProfiles = Object.fromEntries(
    Object.entries({
      ...fallback.modelProfiles,
      ...rawModelProfiles,
    }).map(([modelId, profile]) => {
      const normalized = normalizeOllamaManagedModelProfile(
        profile,
        fallback.modelProfiles[modelId] ?? {},
      )
      const catalogMaxContext = getManagedGemmaMaxContext(modelId, fallback)
      return [
        modelId,
        catalogMaxContext == null
          ? normalized
          : {
              ...normalized,
              num_ctx: Math.max(normalized.num_ctx ?? catalogMaxContext, catalogMaxContext),
            },
      ]
    }),
  )

  return {
    modelProfiles,
  }
}

export function resolveManagedOllamaProfile(
  settings: AppOllamaSettings | undefined,
  modelId: string,
  runtimeId: string,
): OllamaManagedModelProfile | undefined {
  if (runtimeId !== 'ollama-native' && runtimeId !== 'ollama-openai') {
    return undefined
  }

  const profile = settings?.modelProfiles[modelId]
  if (profile) {
    return profile
  }

  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId)
  return catalogEntry
    ? getDefaultOllamaSettings().modelProfiles[catalogEntry.tag]
    : undefined
}

export function buildOllamaOptionsRecord(
  profile: OllamaManagedModelProfile | undefined,
): Record<string, number> | undefined {
  if (!profile) {
    return undefined
  }

  const entries = Object.entries(profile).filter(([, value]) =>
    typeof value === 'number' && Number.isFinite(value),
  )
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined
}

function getManagedGemmaMaxContext(
  modelId: string,
  fallback: AppOllamaSettings,
): number | undefined {
  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId)
  return catalogEntry
    ? parseGemmaContextBadge(catalogEntry.contextBadge)
      ?? fallback.modelProfiles[modelId]?.num_ctx
    : undefined
}

function numericConfigValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function ollamaLoadedConfigMatchesManagedProfile(
  loadedConfig: Record<string, unknown>,
  profile: OllamaManagedModelProfile | undefined,
): boolean {
  const requestedContextLength = numericConfigValue(profile?.num_ctx)
  if (requestedContextLength == null) {
    return true
  }

  const loadedContextLength =
    numericConfigValue(loadedConfig.context_length)
    ?? numericConfigValue(loadedConfig.num_ctx)
  return loadedContextLength == null || loadedContextLength === requestedContextLength
}
