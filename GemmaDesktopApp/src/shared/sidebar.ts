export interface SidebarState {
  pinnedSessionIds: string[]
  followUpSessionIds: string[]
  closedProjectPaths: string[]
  projectPaths: string[]
  sessionOrderOverrides: Record<string, number>
  projectOrderOverrides: Record<string, number>
}

export interface SidebarSessionReference {
  id: string
  workingDirectory: string
}

export const EMPTY_SIDEBAR_STATE: SidebarState = {
  pinnedSessionIds: [],
  followUpSessionIds: [],
  closedProjectPaths: [],
  projectPaths: [],
  sessionOrderOverrides: {},
  projectOrderOverrides: {},
}

export function normalizeSidebarProjectPath(targetPath: string): string {
  const trimmed = targetPath.trim()
  if (!trimmed) {
    return ''
  }

  const stripped = trimmed.replace(/[\\/]+$/, '')
  return stripped.length > 0 ? stripped : trimmed
}

export function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const nextValues: string[] = []

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }

    seen.add(value)
    nextValues.push(value)
  }

  return nextValues
}

export function cloneSidebarState(state: SidebarState): SidebarState {
  return {
    pinnedSessionIds: [...state.pinnedSessionIds],
    followUpSessionIds: [...state.followUpSessionIds],
    closedProjectPaths: [...state.closedProjectPaths],
    projectPaths: [...state.projectPaths],
    sessionOrderOverrides: { ...state.sessionOrderOverrides },
    projectOrderOverrides: { ...state.projectOrderOverrides },
  }
}

function sanitizeOrderRecord(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object') {
    return {}
  }

  const record = input as Record<string, unknown>
  const next: Record<string, number> = {}

  for (const [rawKey, rawValue] of Object.entries(record)) {
    if (typeof rawKey !== 'string') {
      continue
    }
    const key = rawKey.trim()
    if (!key) {
      continue
    }

    const numericValue = typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string'
        ? Number(rawValue)
        : Number.NaN

    if (!Number.isFinite(numericValue)) {
      continue
    }

    const normalized = Math.max(0, Math.floor(numericValue))
    next[key] = normalized
  }

  return next
}

export function sanitizeSidebarState(input: unknown): SidebarState {
  const record =
    input && typeof input === 'object'
      ? input as Record<string, unknown>
      : null

  const pinnedSessionIds = Array.isArray(record?.['pinnedSessionIds'])
    ? record['pinnedSessionIds'].filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []

  const followUpSessionIds = Array.isArray(record?.['followUpSessionIds'])
    ? record['followUpSessionIds'].filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []

  const closedProjectPaths = Array.isArray(record?.['closedProjectPaths'])
    ? record['closedProjectPaths'].filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []

  const projectPaths = Array.isArray(record?.['projectPaths'])
    ? record['projectPaths'].filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []

  const sessionOrderOverrides = sanitizeOrderRecord(
    record?.['sessionOrderOverrides'],
  )

  const rawProjectOrders = sanitizeOrderRecord(
    record?.['projectOrderOverrides'],
  )
  const projectOrderOverrides: Record<string, number> = {}
  for (const [key, value] of Object.entries(rawProjectOrders)) {
    const normalizedKey = normalizeSidebarProjectPath(key)
    if (!normalizedKey) {
      continue
    }
    projectOrderOverrides[normalizedKey] = value
  }

  return {
    pinnedSessionIds: dedupePreserveOrder(pinnedSessionIds),
    followUpSessionIds: dedupePreserveOrder(followUpSessionIds),
    closedProjectPaths: dedupePreserveOrder(
      closedProjectPaths.map((entry) => normalizeSidebarProjectPath(entry)),
    ),
    projectPaths: dedupePreserveOrder(
      projectPaths.map((entry) => normalizeSidebarProjectPath(entry)),
    ),
    sessionOrderOverrides,
    projectOrderOverrides,
  }
}

/**
 * Apply per-item override indices to a naturally-ordered list. Items with an
 * override are anchored at (or near) their stored index; remaining items keep
 * their natural-order positions among the leftover slots.
 *
 * Override semantics: dragging a single conversation or project pins just that
 * one to a position. Other items continue to flow by their natural rule
 * (updatedAt desc), filling around the anchors.
 */
export function applyOrderOverrides<T>(
  naturalOrder: readonly T[],
  getKey: (item: T) => string,
  overrides: Readonly<Record<string, number>> | undefined,
): T[] {
  if (naturalOrder.length === 0) {
    return []
  }

  const safeOverrides = overrides ?? {}
  const anchored: { item: T; target: number; naturalIndex: number }[] = []
  const unanchored: { item: T; naturalIndex: number }[] = []

  naturalOrder.forEach((item, index) => {
    const key = getKey(item)
    const override = key in safeOverrides ? safeOverrides[key] : undefined
    if (typeof override === 'number' && Number.isFinite(override)) {
      const target = Math.max(0, Math.min(naturalOrder.length - 1, Math.floor(override)))
      anchored.push({ item, target, naturalIndex: index })
    } else {
      unanchored.push({ item, naturalIndex: index })
    }
  })

  if (anchored.length === 0) {
    return [...naturalOrder]
  }

  anchored.sort((left, right) => {
    if (left.target !== right.target) {
      return left.target - right.target
    }
    return left.naturalIndex - right.naturalIndex
  })

  const result: (T | undefined)[] = Array.from(
    { length: naturalOrder.length },
    () => undefined,
  )

  for (const { item, target } of anchored) {
    let slot = target
    while (slot < result.length && result[slot] !== undefined) {
      slot += 1
    }
    if (slot >= result.length) {
      slot = result.length - 1
      while (slot >= 0 && result[slot] !== undefined) {
        slot -= 1
      }
      if (slot < 0) {
        continue
      }
    }
    result[slot] = item
  }

  let unanchoredCursor = 0
  for (let i = 0; i < result.length; i += 1) {
    if (result[i] === undefined) {
      const next = unanchored[unanchoredCursor]
      unanchoredCursor += 1
      if (next) {
        result[i] = next.item
      }
    }
  }

  return result.filter((entry): entry is T => entry !== undefined)
}
