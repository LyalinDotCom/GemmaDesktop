import {
  applyOrderOverrides,
  normalizeSidebarProjectPath,
  type PinnedArea,
  type SidebarState,
} from '@shared/sidebar'
import { GLOBAL_CHAT_FALLBACK_SESSION_ID } from '@shared/globalChat'
import type { SessionSummary } from '@/types'

export interface SessionProjectGroup {
  key: string
  name: string
  path: string
  updatedAt: number
  sessions: SessionSummary[]
}

export interface SidebarModel {
  pinnedAreas: Array<PinnedArea & { sessions: SessionSummary[] }>
  pinnedSessions: SessionSummary[]
  projectGroups: SessionProjectGroup[]
  visibleSessionIds: string[]
}

export interface SidebarActiveProject {
  path: string
  name: string
}

export function basenameFromPath(targetPath: string): string {
  const normalized = normalizeSidebarProjectPath(targetPath)
  if (!normalized) {
    return 'Untitled Project'
  }

  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

function sortProjectSessions(left: SessionSummary, right: SessionSummary): number {
  const leftRunning = left.isGenerating || left.isCompacting
  const rightRunning = right.isGenerating || right.isCompacting

  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1
  }

  return right.updatedAt - left.updatedAt
}

function isSidebarVisibleSession(session: SessionSummary): boolean {
  return session.id !== GLOBAL_CHAT_FALLBACK_SESSION_ID
}

function buildProjectGroups(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>()
  const closedProjectPaths = new Set(sidebarState.closedProjectPaths)

  for (const session of sessions) {
    const projectPath = normalizeSidebarProjectPath(session.workingDirectory)
    if (projectPath && closedProjectPaths.has(projectPath)) {
      continue
    }

    const key = projectPath || '__no_project__'
    const current = groups.get(key)

    if (!current) {
      groups.set(key, {
        key,
        name: basenameFromPath(projectPath),
        path: projectPath,
        updatedAt: session.updatedAt,
        sessions: [session],
      })
      continue
    }

    current.updatedAt = Math.max(current.updatedAt, session.updatedAt)
    current.sessions.push(session)
  }

  const naturalGroups = [...groups.values()]
    .map((group) => {
      const naturalOrder = [...group.sessions].sort(sortProjectSessions)
      const orderedSessions = applyOrderOverrides(
        naturalOrder,
        (session) => session.id,
        sidebarState.sessionOrderOverrides,
      )
      return {
        ...group,
        sessions: orderedSessions,
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return applyOrderOverrides(
    naturalGroups,
    (group) => group.path,
    sidebarState.projectOrderOverrides,
  )
}

function buildPinnedAreas(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
): Array<PinnedArea & { sessions: SessionSummary[] }> {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))

  return (sidebarState.pinnedAreas ?? []).map((area) => {
    const areaSessions = area.sessionIds
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is SessionSummary => Boolean(session))

    return {
      ...area,
      sessions: areaSessions,
    }
  })
}

export function buildSidebarModel(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
): SidebarModel {
  const visibleSessions = sessions.filter(isSidebarVisibleSession)
  const pinnedAreas = buildPinnedAreas(visibleSessions, sidebarState)
  const pinnedSessions = pinnedAreas.flatMap((area) => area.sessions)
  const projectGroups = buildProjectGroups(visibleSessions, sidebarState)
  const visibleSessionIds: string[] = []
  const seen = new Set<string>()

  for (const session of pinnedSessions) {
    if (!seen.has(session.id)) {
      seen.add(session.id)
      visibleSessionIds.push(session.id)
    }
  }

  for (const group of projectGroups) {
    for (const session of group.sessions) {
      if (!seen.has(session.id)) {
        seen.add(session.id)
        visibleSessionIds.push(session.id)
      }
    }
  }

  return {
    pinnedAreas,
    pinnedSessions,
    projectGroups,
    visibleSessionIds,
  }
}

export function findInitialVisibleSessionId(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
): string | null {
  const visibleSessionIds = buildSidebarModel(sessions, sidebarState).visibleSessionIds
  if (
    sidebarState.lastActiveSessionId
    && visibleSessionIds.includes(sidebarState.lastActiveSessionId)
  ) {
    return sidebarState.lastActiveSessionId
  }

  return visibleSessionIds[0] ?? null
}

export function findReplacementSessionAfterDelete(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
  deletedSessionId: string,
): string | null {
  const visibleSessionIds = buildSidebarModel(sessions, sidebarState).visibleSessionIds
  const deletedIndex = visibleSessionIds.indexOf(deletedSessionId)

  if (deletedIndex === -1) {
    return visibleSessionIds.find((sessionId) => sessionId !== deletedSessionId) ?? null
  }

  return visibleSessionIds[deletedIndex - 1]
    ?? visibleSessionIds[deletedIndex + 1]
    ?? null
}

export function findMostRecentSessionInProject(
  sessions: SessionSummary[],
  projectPath: string,
): SessionSummary | null {
  const normalizedPath = normalizeSidebarProjectPath(projectPath)
  if (!normalizedPath) {
    return null
  }

  const matches = sessions
    .filter(isSidebarVisibleSession)
    .filter(
      (session) =>
        normalizeSidebarProjectPath(session.workingDirectory) === normalizedPath,
    )
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt
      }

      return right.createdAt - left.createdAt
    })

  return matches[0] ?? null
}

export function findActiveProjectForSession(
  sessions: SessionSummary[],
  activeSessionId: string | null,
): SidebarActiveProject | null {
  if (!activeSessionId) {
    return null
  }

  const activeSession = sessions
    .filter(isSidebarVisibleSession)
    .find((session) => session.id === activeSessionId)
  if (!activeSession) {
    return null
  }

  const projectPath = normalizeSidebarProjectPath(activeSession.workingDirectory)
  if (!projectPath) {
    return null
  }

  return {
    path: projectPath,
    name: basenameFromPath(projectPath),
  }
}

export function findReopenSessionForProject(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
  projectPath: string,
): SessionSummary | null {
  const normalizedPath = normalizeSidebarProjectPath(projectPath)
  if (!normalizedPath || !sidebarState.closedProjectPaths.includes(normalizedPath)) {
    return null
  }

  return findMostRecentSessionInProject(sessions, normalizedPath)
}
