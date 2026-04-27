import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceInspection } from '@/hooks/useWorkspaceInspection'
import { buildVisibleWorkspaceFilesSnapshot } from '@/lib/workspaceFileVisibility'
import type { WorkspaceInspection } from '@/types'
import type { RightDockView } from '@/components/RightDockRail'

type SnapshotMap = Map<string, string>

function buildGitSnapshot(inspection: WorkspaceInspection): SnapshotMap {
  const snapshot = new Map<string, string>()
  for (const entry of inspection.git.entries) {
    snapshot.set(entry.path, entry.statusCode)
  }
  return snapshot
}

function buildFilesSnapshot(inspection: WorkspaceInspection): SnapshotMap {
  return buildVisibleWorkspaceFilesSnapshot(inspection.files.entries)
}

function countSnapshotChanges(previous: SnapshotMap, current: SnapshotMap): number {
  const keys = new Set([...previous.keys(), ...current.keys()])
  let changes = 0
  for (const key of keys) {
    if (previous.get(key) !== current.get(key)) {
      changes += 1
    }
  }
  return changes
}

export function useWorkspaceDockBadges(
  workingDirectory: string | null,
  activeView: RightDockView | null,
  enabled = true,
) {
  const { inspection } = useWorkspaceInspection(workingDirectory, enabled)
  const [countsByRoot, setCountsByRoot] = useState<{
    git: Record<string, number>
    files: Record<string, number>
  }>({
    git: {},
    files: {},
  })
  const previousGitSnapshotsRef = useRef<Map<string, SnapshotMap>>(new Map())
  const previousFileSnapshotsRef = useRef<Map<string, SnapshotMap>>(new Map())

  useEffect(() => {
    if (!inspection?.exists) {
      return
    }

    const rootPath = inspection.rootPath
    const currentGit = buildGitSnapshot(inspection)
    const currentFiles = buildFilesSnapshot(inspection)
    const previousGit = previousGitSnapshotsRef.current.get(rootPath)
    const previousFiles = previousFileSnapshotsRef.current.get(rootPath)

    if (previousGit && activeView !== 'git') {
      const nextGitChanges = countSnapshotChanges(previousGit, currentGit)
      if (nextGitChanges > 0) {
        setCountsByRoot((current) => ({
          ...current,
          git: {
            ...current.git,
            [rootPath]: (current.git[rootPath] ?? 0) + nextGitChanges,
          },
        }))
      }
    }

    if (previousFiles && activeView !== 'files') {
      const nextFileChanges = countSnapshotChanges(previousFiles, currentFiles)
      if (nextFileChanges > 0) {
        setCountsByRoot((current) => ({
          ...current,
          files: {
            ...current.files,
            [rootPath]: (current.files[rootPath] ?? 0) + nextFileChanges,
          },
        }))
      }
    }

    previousGitSnapshotsRef.current.set(rootPath, currentGit)
    previousFileSnapshotsRef.current.set(rootPath, currentFiles)
  }, [activeView, inspection])

  useEffect(() => {
    const rootPath = inspection?.rootPath ?? workingDirectory?.trim() ?? ''
    if (!rootPath) {
      return
    }
    if (activeView !== 'git' && activeView !== 'files') {
      return
    }

    setCountsByRoot((current) => {
      const nextForView = current[activeView]
      if ((nextForView[rootPath] ?? 0) === 0) {
        return current
      }
      return {
        ...current,
        [activeView]: {
          ...nextForView,
          [rootPath]: 0,
        },
      }
    })
  }, [activeView, inspection?.rootPath, workingDirectory])

  const rootPath = inspection?.rootPath ?? workingDirectory?.trim() ?? ''
  const badges = useMemo<Partial<Record<RightDockView, number>>>(() => ({
    git: rootPath ? countsByRoot.git[rootPath] ?? 0 : 0,
    files: rootPath ? countsByRoot.files[rootPath] ?? 0 : 0,
  }), [countsByRoot.files, countsByRoot.git, rootPath])

  return {
    badges,
    gitAvailable: inspection?.git.available ?? false,
  }
}
