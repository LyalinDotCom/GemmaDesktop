export type GuidedModelFamily = 'gemma' | 'other'

export type GemmaSizeId = 'e2b' | 'e4b' | '26b' | '31b'

export type GemmaCapabilityTier = 'low' | 'medium' | 'high' | 'extra-high'

export interface GemmaCatalogEntry {
  family: 'gemma'
  sizeId: GemmaSizeId
  tag: string
  runtimeId: 'ollama-native'
  runtimeName: 'Ollama'
  label: string
  shortLabel: string
  order: number
  defaultRank: number
  tier: GemmaCapabilityTier
  tierLabel: string
  capabilityBadges: string[]
  architectureBadge: string
  contextBadge: string
}

export interface GemmaInstallState {
  tag: string
  status: 'running' | 'completed' | 'failed'
  progressText?: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  error?: string
}

export const GEMMA_CATALOG: readonly GemmaCatalogEntry[] = [
  {
    family: 'gemma',
    sizeId: 'e2b',
    tag: 'gemma4:e2b',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    label: 'Gemma 4 E2B',
    shortLabel: 'E2B',
    order: 10,
    defaultRank: 30,
    tier: 'low',
    tierLabel: 'Low',
    capabilityBadges: ['Text', 'Vision', 'Audio', 'Thinking', 'Tools', '128K'],
    architectureBadge: 'Edge',
    contextBadge: '128K',
  },
  {
    family: 'gemma',
    sizeId: 'e4b',
    tag: 'gemma4:e4b',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    label: 'Gemma 4 E4B',
    shortLabel: 'E4B',
    order: 20,
    defaultRank: 100,
    tier: 'medium',
    tierLabel: 'Medium',
    capabilityBadges: ['Text', 'Vision', 'Audio', 'Thinking', 'Tools', '128K'],
    architectureBadge: 'Edge',
    contextBadge: '128K',
  },
  {
    family: 'gemma',
    sizeId: '26b',
    tag: 'gemma4:26b',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    label: 'Gemma 4 26B',
    shortLabel: '26B',
    order: 30,
    defaultRank: 20,
    tier: 'high',
    tierLabel: 'High',
    capabilityBadges: ['Text', 'Vision', 'Thinking', 'Tools', '256K', 'MoE'],
    architectureBadge: 'MoE',
    contextBadge: '256K',
  },
  {
    family: 'gemma',
    sizeId: '31b',
    tag: 'gemma4:31b',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    label: 'Gemma 4 31B',
    shortLabel: '31B',
    order: 40,
    defaultRank: 10,
    tier: 'extra-high',
    tierLabel: 'Extra High',
    capabilityBadges: ['Text', 'Vision', 'Thinking', 'Tools', '256K', 'Dense'],
    architectureBadge: 'Dense',
    contextBadge: '256K',
  },
] as const

const GEMMA_CATALOG_BY_TAG = new Map(
  GEMMA_CATALOG.map((entry) => [entry.tag, entry]),
)
const GEMMA_CATALOG_BY_SIZE_ID = new Map(
  GEMMA_CATALOG.map((entry) => [entry.sizeId, entry]),
)

export const DEFAULT_GEMMA_TAG = 'gemma4:26b'
export const DEFAULT_HELPER_GEMMA_TAG = 'gemma4:e2b'

export function findGemmaCatalogEntryByTag(
  modelId: string,
): GemmaCatalogEntry | undefined {
  return GEMMA_CATALOG_BY_TAG.get(modelId)
}

export function findGemmaCatalogEntryBySizeId(
  sizeId: GemmaSizeId,
): GemmaCatalogEntry | undefined {
  return GEMMA_CATALOG_BY_SIZE_ID.get(sizeId)
}

export function inferGemmaSizeFromModelText(
  modelId: string,
  displayName?: string,
): GemmaSizeId | undefined {
  if (isGemmaCloudTag(modelId)) {
    return undefined
  }

  const explicitCatalogEntry = findGemmaCatalogEntryByTag(modelId)
  if (explicitCatalogEntry) {
    return explicitCatalogEntry.sizeId
  }

  const signature = [modelId, displayName]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

  if (!signature.includes('gemma')) {
    return undefined
  }

  if (signature.includes('31b')) return '31b'
  if (signature.includes('27b') || signature.includes('26b')) return '26b'
  if (signature.includes('4b') || signature.includes('e4b')) return 'e4b'
  if (signature.includes('2b') || signature.includes('e2b')) return 'e2b'

  return undefined
}

export function resolveGemmaCatalogEntryForModel(
  modelId: string,
  displayName?: string,
): GemmaCatalogEntry | undefined {
  const exact = findGemmaCatalogEntryByTag(modelId)
  if (exact) {
    return exact
  }

  const sizeId = inferGemmaSizeFromModelText(modelId, displayName)
  return sizeId ? findGemmaCatalogEntryBySizeId(sizeId) : undefined
}

export function isGuidedGemmaTag(modelId: string): boolean {
  return Boolean(resolveGemmaCatalogEntryForModel(modelId))
}

export function isGemmaCloudTag(modelId: string): boolean {
  return modelId === 'gemma4:31b-cloud'
}

export function getDefaultGemmaCatalogEntry(): GemmaCatalogEntry {
  return GEMMA_CATALOG.find((entry) => entry.tag === DEFAULT_GEMMA_TAG) ?? GEMMA_CATALOG[GEMMA_CATALOG.length - 1]!
}

export function getDefaultHelperGemmaCatalogEntry(): GemmaCatalogEntry {
  return GEMMA_CATALOG.find((entry) => entry.tag === DEFAULT_HELPER_GEMMA_TAG)
    ?? GEMMA_CATALOG.find((entry) => entry.tier === 'medium')
    ?? GEMMA_CATALOG[0]!
}

export function parseGemmaContextBadge(contextBadge: string): number | undefined {
  const match = contextBadge.trim().match(/^(\d+)\s*K$/i)
  if (!match) {
    return undefined
  }

  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value * 1024 : undefined
}

export function getExpectedGemmaContextLength(
  modelId: string,
): number | undefined {
  const entry = resolveGemmaCatalogEntryForModel(modelId)
  return entry ? parseGemmaContextBadge(entry.contextBadge) : undefined
}
