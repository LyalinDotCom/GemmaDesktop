export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export type GeminiApiProfileKey =
  | 'gemini3'
  | 'gemini25'
  | 'gemmaApi'
  | 'openModel'

export interface GeminiApiGenerationProfile {
  temperature: number
  topP: number
  topK: number
  maxOutputTokens: number | null
  contextTokens: number | null
  includeThoughts: boolean
  thinkingLevel: GeminiThinkingLevel
  thinkingBudget: number
}

export interface AppGeminiApiSettings {
  apiKey: string
  model: string
  profiles: Record<GeminiApiProfileKey, GeminiApiGenerationProfile>
}

export const DEFAULT_GEMINI_API_MODEL = 'gemini-3-flash-preview'
export const GEMINI_CLI_CHAT_TEMPERATURE = 1
export const GEMINI_CLI_CHAT_TOP_P = 0.95
export const GEMINI_CLI_CHAT_TOP_K = 64
export const GEMINI_CLI_CHAT_INCLUDE_THOUGHTS = true
export const GEMINI_CLI_GEMINI_3_THINKING_LEVEL: GeminiThinkingLevel = 'high'
export const GEMINI_CLI_GEMINI_25_THINKING_BUDGET = 8_192
export const GEMMA_DOCS_TEMPERATURE = 1
export const GEMMA_DOCS_TOP_P = 0.95
export const GEMMA_DOCS_TOP_K = 64

export const GEMINI_API_CONTEXT_PRESET_VALUES = [
  32_768,
  65_536,
  131_072,
  262_144,
  524_288,
  1_048_576,
] as const

export const GEMINI_THINKING_LEVEL_OPTIONS: readonly GeminiThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
] as const

export const GEMINI_API_PROFILE_ORDER: readonly GeminiApiProfileKey[] = [
  'gemini3',
  'gemmaApi',
  'gemini25',
  'openModel',
] as const

export const GEMINI_API_PROFILE_LABELS: Record<GeminiApiProfileKey, string> = {
  gemini3: 'Gemini 3.x',
  gemmaApi: 'Gemma on Gemini API',
  gemini25: 'Gemini 2.5',
  openModel: 'Other hosted/open models',
}

export const GEMINI_API_PROFILE_DESCRIPTIONS: Record<GeminiApiProfileKey, string> = {
  gemini3: 'Primary hosted Gemini profile. Uses Gemini CLI chat sampling and Gemini 3 thinking levels.',
  gemmaApi: 'Hosted Gemma profile. Keeps Gemma sampling aligned with the offline Gemma defaults and uses Gemini 3-style thinking levels.',
  gemini25: 'Legacy Gemini profile. Uses Gemini CLI chat sampling with the Gemini 2.5 thinking budget.',
  openModel: 'Fallback hosted model profile. Sampling is set, but thinking config is not sent unless the model family is known.',
}

export const GEMINI_API_SETTING_RANGES = {
  temperature: { min: 0, max: 2, step: 0.05 },
  topP: { min: 0, max: 1, step: 0.01 },
  topK: { min: 1, max: 1_000, step: 1 },
  maxOutputTokens: { min: 1, max: 1_000_000, step: 1 },
  contextTokens: { min: 1_024, max: 2_000_000, step: 1 },
  thinkingBudget: { min: 0, max: 32_768, step: 1 },
} as const

export function formatGeminiContextPreset(value: number): string {
  if (value >= 1_048_576) {
    return `${Math.round(value / 1_048_576)}M`
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)}K`
  }
  return `${value}`
}

function createBaseGeminiCliChatProfile(): GeminiApiGenerationProfile {
  return {
    temperature: GEMINI_CLI_CHAT_TEMPERATURE,
    topP: GEMINI_CLI_CHAT_TOP_P,
    topK: GEMINI_CLI_CHAT_TOP_K,
    maxOutputTokens: null,
    contextTokens: null,
    includeThoughts: GEMINI_CLI_CHAT_INCLUDE_THOUGHTS,
    thinkingLevel: GEMINI_CLI_GEMINI_3_THINKING_LEVEL,
    thinkingBudget: GEMINI_CLI_GEMINI_25_THINKING_BUDGET,
  }
}

export function getDefaultGeminiApiProfiles(): Record<GeminiApiProfileKey, GeminiApiGenerationProfile> {
  return {
    gemini3: createBaseGeminiCliChatProfile(),
    gemmaApi: {
      ...createBaseGeminiCliChatProfile(),
      temperature: GEMMA_DOCS_TEMPERATURE,
      topP: GEMMA_DOCS_TOP_P,
      topK: GEMMA_DOCS_TOP_K,
    },
    gemini25: createBaseGeminiCliChatProfile(),
    openModel: {
      ...createBaseGeminiCliChatProfile(),
      includeThoughts: false,
      thinkingBudget: 0,
    },
  }
}

export function getDefaultGeminiApiSettings(): AppGeminiApiSettings {
  return {
    apiKey: '',
    model: DEFAULT_GEMINI_API_MODEL,
    profiles: getDefaultGeminiApiProfiles(),
  }
}

function normalizeOptionalNumber(
  value: unknown,
  fallback: number | null,
  options: {
    integer?: boolean
    min?: number
    max?: number
  } = {},
): number | null {
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

  let next = options.integer ? Math.round(numeric) : numeric
  if (typeof options.min === 'number') {
    next = Math.max(options.min, next)
  }
  if (typeof options.max === 'number') {
    next = Math.min(options.max, next)
  }
  return next
}

function normalizeRequiredNumber(
  value: unknown,
  fallback: number,
  options: {
    integer?: boolean
    min?: number
    max?: number
  } = {},
): number {
  return normalizeOptionalNumber(value, fallback, options) ?? fallback
}

function normalizeThinkingLevel(
  value: unknown,
  fallback: GeminiThinkingLevel,
): GeminiThinkingLevel {
  return GEMINI_THINKING_LEVEL_OPTIONS.includes(value as GeminiThinkingLevel)
    ? value as GeminiThinkingLevel
    : fallback
}

function normalizeProfile(
  value: unknown,
  fallback: GeminiApiGenerationProfile,
): GeminiApiGenerationProfile {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Partial<GeminiApiGenerationProfile>
      : {}

  return {
    temperature: normalizeRequiredNumber(record.temperature, fallback.temperature, {
      min: GEMINI_API_SETTING_RANGES.temperature.min,
      max: GEMINI_API_SETTING_RANGES.temperature.max,
    }),
    topP: normalizeRequiredNumber(record.topP, fallback.topP, {
      min: GEMINI_API_SETTING_RANGES.topP.min,
      max: GEMINI_API_SETTING_RANGES.topP.max,
    }),
    topK: normalizeRequiredNumber(record.topK, fallback.topK, {
      integer: true,
      min: GEMINI_API_SETTING_RANGES.topK.min,
      max: GEMINI_API_SETTING_RANGES.topK.max,
    }),
    maxOutputTokens: normalizeOptionalNumber(record.maxOutputTokens, fallback.maxOutputTokens, {
      integer: true,
      min: GEMINI_API_SETTING_RANGES.maxOutputTokens.min,
      max: GEMINI_API_SETTING_RANGES.maxOutputTokens.max,
    }),
    contextTokens: normalizeOptionalNumber(record.contextTokens, fallback.contextTokens, {
      integer: true,
      min: GEMINI_API_SETTING_RANGES.contextTokens.min,
      max: GEMINI_API_SETTING_RANGES.contextTokens.max,
    }),
    includeThoughts:
      typeof record.includeThoughts === 'boolean'
        ? record.includeThoughts
        : fallback.includeThoughts,
    thinkingLevel: normalizeThinkingLevel(record.thinkingLevel, fallback.thinkingLevel),
    thinkingBudget: normalizeRequiredNumber(record.thinkingBudget, fallback.thinkingBudget, {
      integer: true,
      min: GEMINI_API_SETTING_RANGES.thinkingBudget.min,
      max: GEMINI_API_SETTING_RANGES.thinkingBudget.max,
    }),
  }
}

function normalizeLegacyFlatProfile(
  record: Record<string, unknown>,
  fallback: GeminiApiGenerationProfile,
): GeminiApiGenerationProfile {
  return normalizeProfile({
    temperature: record.temperature,
    topP: record.topP,
    topK: record.topK,
    maxOutputTokens: record.maxOutputTokens,
    contextTokens: record.contextTokens,
    includeThoughts: record.includeThoughts,
    thinkingLevel: record.thinkingLevel,
    thinkingBudget: record.thinkingBudget,
  }, fallback)
}

export function normalizeGeminiApiSettings(
  value: unknown,
  fallback: AppGeminiApiSettings = getDefaultGeminiApiSettings(),
): AppGeminiApiSettings {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  const model =
    typeof record.model === 'string' && record.model.trim().length > 0
      ? record.model.trim()
      : fallback.model
  const rawProfiles =
    record.profiles && typeof record.profiles === 'object' && !Array.isArray(record.profiles)
      ? record.profiles as Partial<Record<GeminiApiProfileKey, unknown>>
      : undefined
  const legacyProfile = normalizeLegacyFlatProfile(record, fallback.profiles.gemini3)

  return {
    apiKey:
      typeof record.apiKey === 'string'
        ? record.apiKey
        : fallback.apiKey,
    model,
    profiles: {
      gemini3: normalizeProfile(rawProfiles?.gemini3 ?? legacyProfile, fallback.profiles.gemini3),
      gemmaApi: normalizeProfile(rawProfiles?.gemmaApi ?? fallback.profiles.gemmaApi, fallback.profiles.gemmaApi),
      gemini25: normalizeProfile(rawProfiles?.gemini25 ?? fallback.profiles.gemini25, fallback.profiles.gemini25),
      openModel: normalizeProfile(rawProfiles?.openModel ?? fallback.profiles.openModel, fallback.profiles.openModel),
    },
  }
}

export function isGemini3ModelId(modelId: string): boolean {
  return /^gemini-3(?:[.-]|$)/i.test(modelId)
}

export function isGemini25ModelId(modelId: string): boolean {
  return /^gemini-2\.5(?:[.-]|$)/i.test(modelId)
}

export function isGemmaApiModelId(modelId: string): boolean {
  return /^(?:models\/)?gemma-?4(?:[.:-]|$)/i.test(modelId)
}

export function resolveGeminiApiProfileKey(modelId: string): GeminiApiProfileKey {
  if (isGemmaApiModelId(modelId)) {
    return 'gemmaApi'
  }
  if (isGemini3ModelId(modelId)) {
    return 'gemini3'
  }
  if (isGemini25ModelId(modelId)) {
    return 'gemini25'
  }
  return 'openModel'
}

export function resolveGeminiApiProfile(
  settings: AppGeminiApiSettings | undefined,
  modelId: string,
): GeminiApiGenerationProfile | undefined {
  if (!settings) {
    return undefined
  }
  return settings.profiles[resolveGeminiApiProfileKey(modelId)]
}

export function buildGeminiGenerationOptions(
  settings: AppGeminiApiSettings | undefined,
  modelId: string,
): Record<string, unknown> | undefined {
  const profile = resolveGeminiApiProfile(settings, modelId)
  if (!profile) {
    return undefined
  }

  const options: Record<string, unknown> = {
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
  }
  if (profile.maxOutputTokens != null) {
    options.maxOutputTokens = profile.maxOutputTokens
  }

  const profileKey = resolveGeminiApiProfileKey(modelId)
  if (profileKey === 'gemini3' || profileKey === 'gemmaApi') {
    options.thinkingConfig = {
      includeThoughts: profile.includeThoughts,
      thinkingLevel: profile.thinkingLevel,
    }
  } else if (profileKey === 'gemini25') {
    options.thinkingConfig = {
      includeThoughts: profile.includeThoughts,
      thinkingBudget: profile.thinkingBudget,
    }
  }

  return options
}

export function buildGeminiDisplayOptionsRecord(
  settings: AppGeminiApiSettings | undefined,
  modelId: string,
): Record<string, number> | undefined {
  const profile = resolveGeminiApiProfile(settings, modelId)
  if (!profile) {
    return undefined
  }
  const profileKey = resolveGeminiApiProfileKey(modelId)

  return {
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    ...(profile.maxOutputTokens != null ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    ...(profile.contextTokens != null ? { contextTokens: profile.contextTokens } : {}),
    ...(profileKey === 'gemini25' ? { thinkingBudget: profile.thinkingBudget } : {}),
  }
}

export function resolveGeminiContextTokens(
  settings: AppGeminiApiSettings | undefined,
  modelId: string,
): number | undefined {
  return resolveGeminiApiProfile(settings, modelId)?.contextTokens ?? undefined
}
