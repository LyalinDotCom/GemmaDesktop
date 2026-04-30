import {
  parseGemmaContextBadge,
  resolveGemmaCatalogEntryForModel,
  type GemmaSizeId,
} from './gemmaCatalog'

export interface OmlxManagedModelProfile {
  max_context_window?: number
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  repetition_penalty?: number
  presence_penalty?: number
  frequency_penalty?: number
  xtc_probability?: number
  xtc_threshold?: number
  seed?: number
  thinking_budget?: number
}

export interface AppOmlxSettings {
  modelProfiles: Record<string, OmlxManagedModelProfile>
}

export const OMLX_CONTEXT_PRESET_VALUES = [
  4_096,
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
  262_144,
] as const

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
): OmlxManagedModelProfile {
  return {
    max_context_window: pickDefaultGemmaContextBySize(sizeId, totalMemoryBytes),
    max_tokens: 32_768,
    temperature: 1,
    top_p: 0.95,
    top_k: 64,
  }
}

export function getDefaultOmlxSettings(
  totalMemoryBytes = 32 * 1024 ** 3,
): AppOmlxSettings {
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

export function normalizeOmlxManagedModelProfile(
  value: unknown,
  fallback: OmlxManagedModelProfile = {},
): OmlxManagedModelProfile {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  return {
    max_context_window: normalizeOptionalNumber(record.max_context_window, fallback.max_context_window, {
      integer: true,
      min: OMLX_CONTEXT_PRESET_VALUES[0],
      max: OMLX_CONTEXT_PRESET_VALUES[OMLX_CONTEXT_PRESET_VALUES.length - 1],
    }),
    max_tokens: normalizeOptionalNumber(record.max_tokens, fallback.max_tokens, {
      integer: true,
      min: 1,
      max: 65_536,
    }),
    temperature: normalizeOptionalNumber(record.temperature, fallback.temperature, {
      min: 0,
      max: 2,
    }),
    top_p: normalizeOptionalNumber(record.top_p, fallback.top_p, {
      min: 0,
      max: 1,
    }),
    top_k: normalizeOptionalNumber(record.top_k, fallback.top_k, {
      integer: true,
      min: 0,
      max: 512,
    }),
    min_p: normalizeOptionalNumber(record.min_p, fallback.min_p, {
      min: 0,
      max: 1,
    }),
    repetition_penalty: normalizeOptionalNumber(record.repetition_penalty, fallback.repetition_penalty, {
      min: 0,
      max: 2,
    }),
    presence_penalty: normalizeOptionalNumber(record.presence_penalty, fallback.presence_penalty, {
      min: -2,
      max: 2,
    }),
    frequency_penalty: normalizeOptionalNumber(record.frequency_penalty, fallback.frequency_penalty, {
      min: -2,
      max: 2,
    }),
    xtc_probability: normalizeOptionalNumber(record.xtc_probability, fallback.xtc_probability, {
      min: 0,
      max: 1,
    }),
    xtc_threshold: normalizeOptionalNumber(record.xtc_threshold, fallback.xtc_threshold, {
      min: 0,
      max: 1,
    }),
    seed: normalizeOptionalNumber(record.seed, fallback.seed, {
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    thinking_budget: normalizeOptionalNumber(record.thinking_budget, fallback.thinking_budget, {
      integer: true,
      min: 0,
      max: 65_536,
    }),
  }
}

export function normalizeOmlxSettings(
  value: unknown,
  fallback: AppOmlxSettings = getDefaultOmlxSettings(),
): AppOmlxSettings {
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
      const normalized = normalizeOmlxManagedModelProfile(
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
              max_context_window: Math.max(
                normalized.max_context_window ?? catalogMaxContext,
                catalogMaxContext,
              ),
            },
      ]
    }),
  )

  return {
    modelProfiles,
  }
}

function getManagedGemmaMaxContext(
  modelId: string,
  fallback: AppOmlxSettings,
): number | undefined {
  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId)
  return catalogEntry
    ? parseGemmaContextBadge(catalogEntry.contextBadge)
      ?? fallback.modelProfiles[modelId]?.max_context_window
    : undefined
}

export function resolveManagedOmlxProfile(
  settings: AppOmlxSettings | undefined,
  modelId: string,
  runtimeId: string,
  displayName?: string,
  totalMemoryBytes = 32 * 1024 ** 3,
): OmlxManagedModelProfile | undefined {
  if (runtimeId !== 'omlx-openai') {
    return undefined
  }

  const profile = settings?.modelProfiles[modelId]
  if (profile) {
    return profile
  }

  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId, displayName)
  return catalogEntry ? buildDefaultGemmaProfile(catalogEntry.sizeId, totalMemoryBytes) : undefined
}

function buildNumericOptionsRecord(
  profile: OmlxManagedModelProfile | undefined,
  keys: Array<keyof OmlxManagedModelProfile>,
): Record<string, number> | undefined {
  if (!profile) {
    return undefined
  }

  const entries = keys.flatMap((key) => {
    const value = profile[key]
    return typeof value === 'number' && Number.isFinite(value)
      ? [[key, value] as const]
      : []
  })

  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined
}

export function buildOmlxRequestOptionsRecord(
  profile: OmlxManagedModelProfile | undefined,
): Record<string, number> | undefined {
  return buildNumericOptionsRecord(profile, [
    'temperature',
    'top_p',
    'min_p',
    'presence_penalty',
    'frequency_penalty',
    'xtc_probability',
    'xtc_threshold',
    'max_tokens',
    'seed',
    'thinking_budget',
  ])
}

export function buildOmlxModelSettingsRecord(
  profile: OmlxManagedModelProfile | undefined,
): Record<string, number> | undefined {
  return buildNumericOptionsRecord(profile, [
    'max_context_window',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'repetition_penalty',
    'presence_penalty',
  ])
}

export function buildOmlxDisplayOptionsRecord(
  profile: OmlxManagedModelProfile | undefined,
): Record<string, number> | undefined {
  return buildNumericOptionsRecord(profile, [
    'max_context_window',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'repetition_penalty',
    'presence_penalty',
    'frequency_penalty',
    'xtc_probability',
    'xtc_threshold',
    'seed',
    'thinking_budget',
  ])
}
