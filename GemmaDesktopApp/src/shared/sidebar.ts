export interface SidebarState {
  pinnedSessionIds: string[]
  followUpSessionIds: string[]
  closedProjectPaths: string[]
  projectPaths: string[]
  sessionOrderOverrides: Record<string, number>
  projectOrderOverrides: Record<string, number>
  lastActiveSessionId: string | null
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
  lastActiveSessionId: null,
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
    lastActiveSessionId: state.lastActiveSessionId,
  }
}

function sanitizeSessionIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return []
  }

  return dedupePreserveOrder(
    input.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    ),
  )
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

  const followUpSessionIds = sanitizeSessionIds(record?.['followUpSessionIds'])

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
    pinnedSessionIds: sanitizeSessionIds(record?.['pinnedSessionIds']),
    followUpSessionIds,
    closedProjectPaths: dedupePreserveOrder(
      closedProjectPaths.map((entry) => normalizeSidebarProjectPath(entry)),
    ),
    projectPaths: dedupePreserveOrder(
      projectPaths.map((entry) => normalizeSidebarProjectPath(entry)),
    ),
    sessionOrderOverrides,
    projectOrderOverrides,
    lastActiveSessionId:
      typeof record?.['lastActiveSessionId'] === 'string'
      && record['lastActiveSessionId'].trim().length > 0
        ? record['lastActiveSessionId']
        : null,
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
    const override = safeOverrides[key]
    if (override === undefined || !Number.isFinite(override)) {
      unanchored.push({ item, naturalIndex: index })
      return
    }

    anchored.push({
      item,
      target: Math.max(0, Math.min(naturalOrder.length - 1, Math.floor(override))),
      naturalIndex: index,
    })
  })

  if (anchored.length === 0) {
    return [...naturalOrder]
  }

  const slots = new Array<T | null>(naturalOrder.length).fill(null)
  anchored
    .sort((left, right) => left.target - right.target || left.naturalIndex - right.naturalIndex)
    .forEach((entry) => {
      let index = entry.target
      while (index < slots.length && slots[index] !== null) {
        index += 1
      }
      if (index >= slots.length) {
        index = entry.target
        while (index >= 0 && slots[index] !== null) {
          index -= 1
        }
      }
      if (index >= 0) {
        slots[index] = entry.item
      }
    })

  let unanchoredIndex = 0
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index] !== null) {
      continue
    }

    slots[index] = unanchored[unanchoredIndex]?.item ?? null
    unanchoredIndex += 1
  }

  return slots.filter((item): item is T => item !== null)
}
