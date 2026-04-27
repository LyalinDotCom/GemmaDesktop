export const GEMMA_DESKTOP_OLLAMA_KEEP_ALIVE = '24h'
export const OLLAMA_DEFAULT_KEEP_ALIVE = '5m'

export interface OllamaRuntimeServerSettings {
  numParallel: number
  maxLoadedModels: number
  keepAliveEnabled?: boolean
}

export interface OllamaServerConfigSnapshot {
  numParallel?: number
  maxLoadedModels?: number
  contextLength?: number
  keepAlive?: string
}

export interface OllamaServerConfigDrift {
  key: 'numParallel' | 'maxLoadedModels' | 'keepAlive'
  label: string
  expected: string
  actual: string
}

export function resolveOllamaRequestKeepAlive(
  settings: Pick<OllamaRuntimeServerSettings, 'keepAliveEnabled'>,
): string | undefined {
  return settings.keepAliveEnabled === false
    ? undefined
    : GEMMA_DESKTOP_OLLAMA_KEEP_ALIVE
}

export function resolveExpectedOllamaServerKeepAlive(
  settings: Pick<OllamaRuntimeServerSettings, 'keepAliveEnabled'>,
): string {
  return settings.keepAliveEnabled === false
    ? OLLAMA_DEFAULT_KEEP_ALIVE
    : GEMMA_DESKTOP_OLLAMA_KEEP_ALIVE
}

function parseGoDurationMs(value: string): number | undefined {
  const compact = value.trim().toLowerCase().replace(/\s+/g, '')
  if (compact.length === 0) {
    return undefined
  }
  if (compact === '0') {
    return 0
  }

  let totalMs = 0
  let consumed = 0
  const pattern = /(-?\d+(?:\.\d+)?)(ms|h|m|s)/g
  for (const match of compact.matchAll(pattern)) {
    if (match.index !== consumed) {
      return undefined
    }

    consumed += match[0].length
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) {
      return undefined
    }

    const unit = match[2]
    if (unit !== 'ms' && unit !== 'h' && unit !== 'm' && unit !== 's') {
      return undefined
    }

    switch (unit) {
      case 'h':
        totalMs += amount * 60 * 60 * 1000
        break
      case 'm':
        totalMs += amount * 60 * 1000
        break
      case 's':
        totalMs += amount * 1000
        break
      case 'ms':
        totalMs += amount
        break
      default:
        return undefined
    }
  }

  return consumed === compact.length ? totalMs : undefined
}

export function ollamaKeepAliveDurationsMatch(
  left: string,
  right: string,
): boolean {
  const leftMs = parseGoDurationMs(left)
  const rightMs = parseGoDurationMs(right)
  if (leftMs != null && rightMs != null) {
    return leftMs === rightMs
  }

  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export function describeOllamaServerConfigDrift(
  observed: OllamaServerConfigSnapshot | null | undefined,
  settings: OllamaRuntimeServerSettings,
): OllamaServerConfigDrift[] {
  if (!observed) {
    return []
  }

  const drift: OllamaServerConfigDrift[] = []
  if (
    typeof observed.numParallel === 'number'
    && observed.numParallel !== settings.numParallel
  ) {
    drift.push({
      key: 'numParallel',
      label: 'OLLAMA_NUM_PARALLEL',
      expected: `${settings.numParallel}`,
      actual: `${observed.numParallel}`,
    })
  }

  if (
    typeof observed.maxLoadedModels === 'number'
    && observed.maxLoadedModels !== settings.maxLoadedModels
  ) {
    drift.push({
      key: 'maxLoadedModels',
      label: 'OLLAMA_MAX_LOADED_MODELS',
      expected: `${settings.maxLoadedModels}`,
      actual: `${observed.maxLoadedModels}`,
    })
  }

  const expectedKeepAlive = resolveExpectedOllamaServerKeepAlive(settings)
  if (
    typeof observed.keepAlive === 'string'
    && !ollamaKeepAliveDurationsMatch(observed.keepAlive, expectedKeepAlive)
  ) {
    drift.push({
      key: 'keepAlive',
      label: 'OLLAMA_KEEP_ALIVE',
      expected: expectedKeepAlive,
      actual: observed.keepAlive,
    })
  }

  return drift
}

export function formatOllamaServerConfigDrift(
  drift: OllamaServerConfigDrift[],
): string {
  return drift
    .map((entry) => `${entry.label}=${entry.actual} (expected ${entry.expected})`)
    .join(', ')
}
