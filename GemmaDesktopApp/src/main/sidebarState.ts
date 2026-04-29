import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import {
  cloneSidebarState,
  dedupePreserveOrder,
  EMPTY_SIDEBAR_STATE,
  normalizeSidebarProjectPath,
  sanitizeSidebarState,
  type SidebarSessionReference,
  type SidebarState,
} from '../shared/sidebar'

export interface SidebarStateUpdateResult {
  state: SidebarState
  changed: boolean
}

export function normalizeStoredSidebarProjectPath(targetPath: string): string {
  const trimmed = targetPath.trim()
  if (!trimmed) {
    return ''
  }

  return normalizeSidebarProjectPath(path.resolve(trimmed))
}

function normalizePinnedAreaIcon(icon: string): string {
  const trimmed = icon.trim()
  const [first] = Array.from(trimmed)
  return first ?? '⭐'
}

function orderRecordsEqual(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) {
    return false
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false
    }
  }
  return true
}

function sidebarStatesEqual(left: SidebarState, right: SidebarState): boolean {
  const leftPinnedAreas = left.pinnedAreas ?? []
  const rightPinnedAreas = right.pinnedAreas ?? []

  if (left.lastActiveSessionId !== right.lastActiveSessionId) {
    return false
  }

  if (left.pinnedSessionIds.length !== right.pinnedSessionIds.length) {
    return false
  }

  if (leftPinnedAreas.length !== rightPinnedAreas.length) {
    return false
  }

  if (left.followUpSessionIds.length !== right.followUpSessionIds.length) {
    return false
  }

  if (left.closedProjectPaths.length !== right.closedProjectPaths.length) {
    return false
  }

  if (left.projectPaths.length !== right.projectPaths.length) {
    return false
  }

  return left.pinnedSessionIds.every((entry, index) => entry === right.pinnedSessionIds[index])
    && leftPinnedAreas.every((area, index) => {
      const rightArea = rightPinnedAreas[index]
      return rightArea
        && area.id === rightArea.id
        && area.icon === rightArea.icon
        && area.collapsed === rightArea.collapsed
        && area.sessionIds.length === rightArea.sessionIds.length
        && area.sessionIds.every((entry, sessionIndex) => entry === rightArea.sessionIds[sessionIndex])
    })
    && left.followUpSessionIds.every((entry, index) => entry === right.followUpSessionIds[index])
    && left.closedProjectPaths.every((entry, index) => entry === right.closedProjectPaths[index])
    && left.projectPaths.every((entry, index) => entry === right.projectPaths[index])
    && orderRecordsEqual(left.sessionOrderOverrides, right.sessionOrderOverrides)
    && orderRecordsEqual(left.projectOrderOverrides, right.projectOrderOverrides)
}

export class SidebarStateStore {
  private state: SidebarState = cloneSidebarState(EMPTY_SIDEBAR_STATE)

  constructor(private readonly filePath: string) {}

  async init(sessionRefs: SidebarSessionReference[]): Promise<SidebarStateUpdateResult> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      this.state = sanitizeSidebarState(JSON.parse(raw))
    } catch {
      this.state = cloneSidebarState(EMPTY_SIDEBAR_STATE)
    }

    return await this.prune(sessionRefs)
  }

  getState(): SidebarState {
    return cloneSidebarState(this.state)
  }

  async pinSession(
    sessionId: string,
    areaId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const nextState = this.pruneState(this.state, sessionRefs)
    const pinnedAreas = nextState.pinnedAreas ?? []
    const targetArea = pinnedAreas.find((area) => area.id === areaId)

    if (!validSessionIds.has(sessionId) || !targetArea) {
      return await this.commit(nextState)
    }

    return await this.commit({
      ...nextState,
      pinnedAreas: pinnedAreas.map((area) =>
        area.id === areaId
          ? {
              ...area,
              sessionIds: dedupePreserveOrder([...area.sessionIds, sessionId]),
            }
          : {
              ...area,
              sessionIds: area.sessionIds.filter((entry) => entry !== sessionId),
            },
      ),
    })
  }

  async unpinSession(
    sessionId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    return await this.commit({
      ...nextState,
      pinnedSessionIds: nextState.pinnedSessionIds.filter((entry) => entry !== sessionId),
      pinnedAreas: (nextState.pinnedAreas ?? []).map((area) => ({
        ...area,
        sessionIds: area.sessionIds.filter((entry) => entry !== sessionId),
      })),
    })
  }

  async movePinnedSession(
    sessionId: string,
    toIndex: number,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    const pinnedAreas = nextState.pinnedAreas ?? []
    const flattened = pinnedAreas.flatMap((area) =>
      area.sessionIds.map((entry) => ({ areaId: area.id, sessionId: entry })),
    )
    const currentIndex = flattened.findIndex((entry) => entry.sessionId === sessionId)

    if (currentIndex === -1) {
      return await this.commit(nextState)
    }

    const reordered = [...flattened]
    reordered.splice(currentIndex, 1)

    const boundedIndex = Math.max(
      0,
      Math.min(
        reordered.length,
        Number.isFinite(toIndex) ? Math.floor(toIndex) : currentIndex,
      ),
    )

    const targetAreaId =
      reordered[boundedIndex]?.areaId
      ?? reordered[boundedIndex - 1]?.areaId
      ?? flattened[currentIndex]?.areaId
    if (!targetAreaId) {
      return await this.commit(nextState)
    }

    reordered.splice(boundedIndex, 0, {
      areaId: targetAreaId,
      sessionId,
    })

    const sessionIdsByArea = new Map<string, string[]>()
    for (const entry of reordered) {
      const entries = sessionIdsByArea.get(entry.areaId) ?? []
      entries.push(entry.sessionId)
      sessionIdsByArea.set(entry.areaId, entries)
    }

    return await this.commit({
      ...nextState,
      pinnedAreas: pinnedAreas.map((area) => ({
        ...area,
        sessionIds: sessionIdsByArea.get(area.id) ?? [],
      })),
    })
  }

  async createPinnedArea(
    icon: string,
    sessionId: string | null,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const areaId = `pinned-area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const sessionIds =
      sessionId && validSessionIds.has(sessionId) ? [sessionId] : []

    return await this.commit({
      ...nextState,
      pinnedAreas: [
        ...(nextState.pinnedAreas ?? []).map((area) => ({
          ...area,
          sessionIds: area.sessionIds.filter((entry) => !sessionIds.includes(entry)),
        })),
        {
          id: areaId,
          icon: normalizePinnedAreaIcon(icon),
          collapsed: false,
          sessionIds,
        },
      ],
    })
  }

  async deletePinnedArea(
    areaId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    return await this.commit({
      ...nextState,
      pinnedAreas: (nextState.pinnedAreas ?? []).filter((area) => area.id !== areaId),
    })
  }

  async updatePinnedAreaIcon(
    areaId: string,
    icon: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    return await this.commit({
      ...nextState,
      pinnedAreas: (nextState.pinnedAreas ?? []).map((area) =>
        area.id === areaId
          ? { ...area, icon: normalizePinnedAreaIcon(icon) }
          : area,
      ),
    })
  }

  async setPinnedAreaCollapsed(
    areaId: string,
    collapsed: boolean,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    return await this.commit({
      ...nextState,
      pinnedAreas: (nextState.pinnedAreas ?? []).map((area) =>
        area.id === areaId ? { ...area, collapsed } : area,
      ),
    })
  }

  async movePinnedArea(
    areaId: string,
    direction: 'up' | 'down',
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    const currentPinnedAreas = nextState.pinnedAreas ?? []
    const index = currentPinnedAreas.findIndex((area) => area.id === areaId)
    if (index === -1) {
      return await this.commit(nextState)
    }

    const toIndex = direction === 'up' ? index - 1 : index + 1
    if (toIndex < 0 || toIndex >= currentPinnedAreas.length) {
      return await this.commit(nextState)
    }

    const pinnedAreas = [...currentPinnedAreas]
    const [area] = pinnedAreas.splice(index, 1)
    if (!area) {
      return await this.commit(nextState)
    }
    pinnedAreas.splice(toIndex, 0, area)

    return await this.commit({
      ...nextState,
      pinnedAreas,
    })
  }

  async setSessionOrder(
    sessionId: string,
    orderIndex: number,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const nextState = this.pruneState(this.state, sessionRefs)

    if (!validSessionIds.has(sessionId)) {
      return await this.commit(nextState)
    }

    const normalized = Math.max(
      0,
      Number.isFinite(orderIndex) ? Math.floor(orderIndex) : 0,
    )

    return await this.commit({
      ...nextState,
      sessionOrderOverrides: {
        ...nextState.sessionOrderOverrides,
        [sessionId]: normalized,
      },
    })
  }

  async clearSessionOrder(
    sessionId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    if (!(sessionId in nextState.sessionOrderOverrides)) {
      return await this.commit(nextState)
    }
    const next = { ...nextState.sessionOrderOverrides }
    delete next[sessionId]
    return await this.commit({
      ...nextState,
      sessionOrderOverrides: next,
    })
  }

  async setProjectOrder(
    projectPath: string,
    orderIndex: number,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const normalizedPath = normalizeStoredSidebarProjectPath(projectPath)
    const nextState = this.pruneState(this.state, sessionRefs)

    if (!normalizedPath) {
      return await this.commit(nextState)
    }

    const normalizedIndex = Math.max(
      0,
      Number.isFinite(orderIndex) ? Math.floor(orderIndex) : 0,
    )

    return await this.commit({
      ...nextState,
      projectOrderOverrides: {
        ...nextState.projectOrderOverrides,
        [normalizedPath]: normalizedIndex,
      },
    })
  }

  async clearProjectOrder(
    projectPath: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const normalizedPath = normalizeStoredSidebarProjectPath(projectPath)
    const nextState = this.pruneState(this.state, sessionRefs)
    if (!normalizedPath || !(normalizedPath in nextState.projectOrderOverrides)) {
      return await this.commit(nextState)
    }
    const next = { ...nextState.projectOrderOverrides }
    delete next[normalizedPath]
    return await this.commit({
      ...nextState,
      projectOrderOverrides: next,
    })
  }

  async flagFollowUp(
    sessionId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const nextState = this.pruneState(this.state, sessionRefs)

    if (!validSessionIds.has(sessionId) || nextState.followUpSessionIds.includes(sessionId)) {
      return await this.commit(nextState)
    }

    return await this.commit({
      ...nextState,
      followUpSessionIds: [...nextState.followUpSessionIds, sessionId],
    })
  }

  async rememberActiveSession(
    sessionId: string | null,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const nextState = this.pruneState(this.state, sessionRefs)
    const nextSessionId =
      sessionId && validSessionIds.has(sessionId) ? sessionId : null

    return await this.commit({
      ...nextState,
      lastActiveSessionId: nextSessionId,
    })
  }

  async unflagFollowUp(
    sessionId: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const nextState = this.pruneState(this.state, sessionRefs)
    return await this.commit({
      ...nextState,
      followUpSessionIds: nextState.followUpSessionIds.filter((entry) => entry !== sessionId),
    })
  }

  async closeProject(
    projectPath: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const normalizedPath = normalizeStoredSidebarProjectPath(projectPath)
    const nextState = this.pruneState(this.state, sessionRefs)

    if (!normalizedPath) {
      return await this.commit(nextState)
    }

    const projectSessionIds = new Set(
      sessionRefs
        .filter(
          (session) =>
            normalizeStoredSidebarProjectPath(session.workingDirectory) === normalizedPath,
        )
        .map((session) => session.id),
    )

    if (projectSessionIds.size === 0 && !nextState.closedProjectPaths.includes(normalizedPath)) {
      return await this.commit(nextState)
    }

    return await this.commit({
      ...nextState,
      pinnedSessionIds: nextState.pinnedSessionIds.filter(
        (sessionId) => !projectSessionIds.has(sessionId),
      ),
      pinnedAreas: (nextState.pinnedAreas ?? []).map((area) => ({
        ...area,
        sessionIds: area.sessionIds.filter(
          (sessionId) => !projectSessionIds.has(sessionId),
        ),
      })),
      followUpSessionIds: nextState.followUpSessionIds.filter(
        (sessionId) => !projectSessionIds.has(sessionId),
      ),
      closedProjectPaths: dedupePreserveOrder([
        ...nextState.closedProjectPaths,
        normalizedPath,
      ]),
      projectPaths: dedupePreserveOrder([
        ...nextState.projectPaths,
        normalizedPath,
      ]),
    })
  }

  async reopenProject(
    projectPath: string,
    sessionRefs: SidebarSessionReference[],
  ): Promise<SidebarStateUpdateResult> {
    const normalizedPath = normalizeStoredSidebarProjectPath(projectPath)
    const nextState = this.pruneState(this.state, sessionRefs)

    if (!normalizedPath) {
      return await this.commit(nextState)
    }

    return await this.commit({
      ...nextState,
      closedProjectPaths: nextState.closedProjectPaths.filter(
        (entry) => entry !== normalizedPath,
      ),
    })
  }

  async prune(sessionRefs: SidebarSessionReference[]): Promise<SidebarStateUpdateResult> {
    return await this.commit(this.pruneState(this.state, sessionRefs))
  }

  private pruneState(
    currentState: SidebarState,
    sessionRefs: SidebarSessionReference[],
  ): SidebarState {
    const validSessionIds = new Set(sessionRefs.map((session) => session.id))
    const validProjectPaths = new Set(
      sessionRefs
        .map((session) => normalizeStoredSidebarProjectPath(session.workingDirectory))
        .filter((entry) => entry.length > 0),
    )

    const sessionOrderOverrides: Record<string, number> = {}
    for (const [sessionId, value] of Object.entries(currentState.sessionOrderOverrides)) {
      if (validSessionIds.has(sessionId)) {
        sessionOrderOverrides[sessionId] = value
      }
    }

    const projectOrderOverrides: Record<string, number> = {}
    for (const [projectPath, value] of Object.entries(currentState.projectOrderOverrides)) {
      if (validProjectPaths.has(projectPath)) {
        projectOrderOverrides[projectPath] = value
      }
    }

    return {
      pinnedSessionIds: dedupePreserveOrder(
        currentState.pinnedSessionIds.filter((entry) => validSessionIds.has(entry)),
      ),
      pinnedAreas: (currentState.pinnedAreas ?? []).map((area) => ({
        ...area,
        sessionIds: dedupePreserveOrder(
          area.sessionIds.filter((entry) => validSessionIds.has(entry)),
        ),
      })),
      followUpSessionIds: dedupePreserveOrder(
        currentState.followUpSessionIds.filter((entry) => validSessionIds.has(entry)),
      ),
      closedProjectPaths: dedupePreserveOrder(
        currentState.closedProjectPaths.filter((entry) => validProjectPaths.has(entry)),
      ),
      projectPaths: dedupePreserveOrder([
        ...currentState.projectPaths.filter((entry) => validProjectPaths.has(entry)),
        ...validProjectPaths,
      ]),
      sessionOrderOverrides,
      projectOrderOverrides,
      lastActiveSessionId:
        currentState.lastActiveSessionId
        && validSessionIds.has(currentState.lastActiveSessionId)
          ? currentState.lastActiveSessionId
          : null,
    }
  }

  private async commit(nextState: SidebarState): Promise<SidebarStateUpdateResult> {
    if (sidebarStatesEqual(this.state, nextState)) {
      return {
        state: this.getState(),
        changed: false,
      }
    }

    this.state = cloneSidebarState(nextState)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8')

    return {
      state: this.getState(),
      changed: true,
    }
  }
}

export async function readSidebarStateFile(filePath: string): Promise<SidebarState> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return sanitizeSidebarState(JSON.parse(raw))
  } catch {
    return cloneSidebarState(EMPTY_SIDEBAR_STATE)
  }
}

export function readSidebarStateFileSync(filePath: string): SidebarState {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8')
    return sanitizeSidebarState(JSON.parse(raw))
  } catch {
    return cloneSidebarState(EMPTY_SIDEBAR_STATE)
  }
}
