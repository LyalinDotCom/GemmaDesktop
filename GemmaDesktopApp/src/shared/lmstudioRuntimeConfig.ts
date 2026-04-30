import {
  parseGemmaContextBadge,
  resolveGemmaCatalogEntryForModel,
  type GemmaSizeId,
} from './gemmaCatalog'

export interface LmStudioManagedModelProfile {
  context_length?: number
  temperature?: number
  top_p?: number
  top_k?: number
  max_output_tokens?: number
  repeat_penalty?: number
  min_p?: number
  eval_batch_size?: number
  flash_attention?: boolean
  offload_kv_cache_to_gpu?: boolean
  num_experts?: number
}

export interface AppLmStudioSettings {
  modelProfiles: Record<string, LmStudioManagedModelProfile>
}

const LMSTUDIO_CONTEXT_PRESET_VALUES = [
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
): LmStudioManagedModelProfile {
  return {
    context_length: pickDefaultGemmaContextBySize(sizeId, totalMemoryBytes),
    temperature: 1,
    top_p: 0.95,
    top_k: 64,
    flash_attention: true,
    offload_kv_cache_to_gpu: true,
    ...(sizeId === '26b' ? { num_experts: 4 } : {}),
  }
}

export function getDefaultLmStudioSettings(
  totalMemoryBytes = 32 * 1024 ** 3,
): AppLmStudioSettings {
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

function normalizeOptionalBoolean(
  value: unknown,
  fallback: boolean | undefined,
): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return fallback
}

export function normalizeLmStudioManagedModelProfile(
  value: unknown,
  fallback: LmStudioManagedModelProfile = {},
): LmStudioManagedModelProfile {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  return {
    context_length: normalizeOptionalNumber(record.context_length, fallback.context_length, {
      integer: true,
      min: LMSTUDIO_CONTEXT_PRESET_VALUES[0],
      max: LMSTUDIO_CONTEXT_PRESET_VALUES[LMSTUDIO_CONTEXT_PRESET_VALUES.length - 1],
    }),
    temperature: normalizeOptionalNumber(record.temperature, fallback.temperature, {
      min: 0,
      max: 1,
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
    max_output_tokens: normalizeOptionalNumber(record.max_output_tokens, fallback.max_output_tokens, {
      integer: true,
      min: 1,
      max: 32_768,
    }),
    repeat_penalty: normalizeOptionalNumber(record.repeat_penalty, fallback.repeat_penalty, {
      min: 0,
      max: 2,
    }),
    min_p: normalizeOptionalNumber(record.min_p, fallback.min_p, {
      min: 0,
      max: 1,
    }),
    eval_batch_size: normalizeOptionalNumber(record.eval_batch_size, fallback.eval_batch_size, {
      integer: true,
      min: 1,
      max: 8_192,
    }),
    flash_attention: normalizeOptionalBoolean(record.flash_attention, fallback.flash_attention),
    offload_kv_cache_to_gpu: normalizeOptionalBoolean(
      record.offload_kv_cache_to_gpu,
      fallback.offload_kv_cache_to_gpu,
    ),
    num_experts: normalizeOptionalNumber(record.num_experts, fallback.num_experts, {
      integer: true,
      min: 1,
      max: 16,
    }),
  }
}

export function normalizeLmStudioSettings(
  value: unknown,
  fallback: AppLmStudioSettings = getDefaultLmStudioSettings(),
): AppLmStudioSettings {
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
      const normalized = normalizeLmStudioManagedModelProfile(
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
              context_length: Math.max(
                normalized.context_length ?? catalogMaxContext,
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
  fallback: AppLmStudioSettings,
): number | undefined {
  const catalogEntry = resolveGemmaCatalogEntryForModel(modelId)
  return catalogEntry
    ? parseGemmaContextBadge(catalogEntry.contextBadge)
      ?? fallback.modelProfiles[modelId]?.context_length
    : undefined
}

export function resolveManagedLmStudioProfile(
  settings: AppLmStudioSettings | undefined,
  modelId: string,
  runtimeId: string,
  displayName?: string,
  totalMemoryBytes = 32 * 1024 ** 3,
): LmStudioManagedModelProfile | undefined {
  if (runtimeId !== 'lmstudio-native' && runtimeId !== 'lmstudio-openai') {
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
  profile: LmStudioManagedModelProfile | undefined,
  keys: Array<keyof LmStudioManagedModelProfile>,
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

export function buildLmStudioRequestOptionsRecord(
  profile: LmStudioManagedModelProfile | undefined,
): Record<string, number> | undefined {
  return buildNumericOptionsRecord(profile, [
    'context_length',
    'temperature',
    'top_p',
    'top_k',
    'max_output_tokens',
    'repeat_penalty',
    'min_p',
  ])
}

export function buildLmStudioLoadOptionsRecord(
  profile: LmStudioManagedModelProfile | undefined,
): Record<string, number | boolean> | undefined {
  if (!profile) {
    return undefined
  }

  const numeric = buildNumericOptionsRecord(profile, [
    'context_length',
    'eval_batch_size',
    'num_experts',
  ])
  const booleanEntries = ([
    'flash_attention',
    'offload_kv_cache_to_gpu',
  ] as const).flatMap((key) =>
    typeof profile[key] === 'boolean'
      ? [[key, profile[key]] as const]
      : [],
  )

  const entries = [
    ...Object.entries(numeric ?? {}),
    ...booleanEntries,
  ]

  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number | boolean>
    : undefined
}
