import { clampToFirstGrapheme } from './emoji'

export interface PinnedArea {
  id: string
  icon: string
  collapsed: boolean
  sessionIds: string[]
}

export const DEFAULT_PINNED_AREA_ID = 'pinned-area-default'
export const DEFAULT_PINNED_AREA_ICON = '📌'

export interface SidebarState {
  pinnedSessionIds: string[]
  pinnedAreas?: PinnedArea[]
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
  pinnedAreas: [],
  followUpSessionIds: [],
  closedProjectPaths: [],
  projectPaths: [],
  sessionOrderOverrides: {},
  projectOrderOverrides: {},
  lastActiveSessionId: null,
}

export function isDefaultPinnedArea(areaId: string): boolean {
  return areaId === DEFAULT_PINNED_AREA_ID
}

export function createDefaultPinnedArea(
  sessionIds: readonly string[] = [],
): PinnedArea {
  return {
    id: DEFAULT_PINNED_AREA_ID,
    icon: DEFAULT_PINNED_AREA_ICON,
    collapsed: false,
    sessionIds: [...sessionIds],
  }
}

export function getPinnedAreaDestinations(
  pinnedAreas: readonly PinnedArea[],
): PinnedArea[] {
  if (pinnedAreas.length === 0) {
    return [createDefaultPinnedArea()]
  }

  if (pinnedAreas.some((area) => isDefaultPinnedArea(area.id))) {
    return [...pinnedAreas]
  }

  return [
    createDefaultPinnedArea(),
    ...pinnedAreas,
  ]
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
    pinnedAreas: (state.pinnedAreas ?? []).map((area) => ({
      id: area.id,
      icon: area.icon,
      collapsed: area.collapsed,
      sessionIds: [...area.sessionIds],
    })),
    followUpSessionIds: [...state.followUpSessionIds],
    closedProjectPaths: [...state.closedProjectPaths],
    projectPaths: [...state.projectPaths],
    sessionOrderOverrides: { ...state.sessionOrderOverrides },
    projectOrderOverrides: { ...state.projectOrderOverrides },
    lastActiveSessionId: state.lastActiveSessionId,
  }
}

function sanitizeEmojiIcon(input: unknown): string {
  return clampToFirstGrapheme(input)
}

function sanitizePinnedAreas(input: unknown): PinnedArea[] {
  if (!Array.isArray(input)) {
    return []
  }

  const seenAreaIds = new Set<string>()
  const areas: PinnedArea[] = []

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const record = entry as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    if (!id || seenAreaIds.has(id)) {
      continue
    }

    const rawSessionIds = Array.isArray(record['sessionIds'])
      ? record['sessionIds'].filter(
          (sessionId): sessionId is string =>
            typeof sessionId === 'string' && sessionId.trim().length > 0,
        )
      : []

    seenAreaIds.add(id)
    areas.push({
      id,
      icon: isDefaultPinnedArea(id)
        ? DEFAULT_PINNED_AREA_ICON
        : sanitizeEmojiIcon(record['icon']),
      collapsed: record['collapsed'] === true,
      sessionIds: dedupePreserveOrder(rawSessionIds),
    })
  }

  return areas
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
    pinnedSessionIds: [],
    pinnedAreas: sanitizePinnedAreas(record?.['pinnedAreas']),
    followUpSessionIds: dedupePreserveOrder(followUpSessionIds),
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
