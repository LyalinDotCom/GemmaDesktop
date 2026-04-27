import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileTreeEntry } from '@shared/workspace'

/**
 * Session-scoped tracking of file *disk* changes. Complements
 * useSessionTouchedFiles (which watches tool calls) by diffing successive
 * workspace inspection snapshots to surface files that were deleted during
 * the session, and files that reappeared after being deleted.
 *
 * Contracts:
 * - A file is a "ghost" if we've seen it in this session and it is no longer
 *   present in the current snapshot. Ghosts stay in the map for the lifetime
 *   of the session so the Files panel can render them as deleted placeholders.
 * - A path is in `rebornPaths` if it was in the ghost set at some prior
 *   point and is now back in the snapshot. The Files panel uses that as a
 *   signal to render the row as "modified" (even if no tool call fired).
 * - Switching workspace root resets the session state. Closing / reopening
 *   the app also resets because hook state lives in renderer memory only.
 */

export interface SessionFileChanges {
  /** Files seen earlier this session and absent from the current snapshot. */
  ghostEntries: Map<string, WorkspaceFileTreeEntry>
  /**
   * Paths that were ghosted at some point but are currently present again.
   * Typically rendered as "modified" overlays on their normal tree rows.
   */
  rebornPaths: Set<string>
}

const EMPTY_STATE: SessionFileChanges = {
  ghostEntries: new Map(),
  rebornPaths: new Set(),
}

export function useSessionFileChanges(
  entries: WorkspaceFileTreeEntry[] | undefined,
  rootPath: string | null,
): SessionFileChanges {
  // Snapshot of every file ever seen this session, keyed by relative path.
  // Value is the last snapshot of the entry so we can render ghosts with
  // their original name/depth/path even after they disappear.
  const seenFilesRef = useRef<Map<string, WorkspaceFileTreeEntry>>(new Map())
  // Paths that have ever been observed as missing during the session.
  // Sticky — we keep flagging a re-added file as "reborn" for the rest of
  // the session so the user keeps getting the modified visual cue.
  const everDeletedRef = useRef<Set<string>>(new Set())

  const [changes, setChanges] = useState<SessionFileChanges>(EMPTY_STATE)

  // Reset session tracking when the workspace root changes.
  useEffect(() => {
    seenFilesRef.current = new Map()
    everDeletedRef.current = new Set()
    setChanges(EMPTY_STATE)
  }, [rootPath])

  useEffect(() => {
    if (!entries) return

    const currentPaths = new Set<string>()
    for (const entry of entries) {
      if (entry.kind === 'file') {
        currentPaths.add(entry.relativePath)
        // Always store the latest snapshot. This keeps the ghost data fresh
        // if a file is repeatedly modified before being deleted.
        seenFilesRef.current.set(entry.relativePath, entry)
      }
    }

    // Compute ghosts: previously-seen files currently absent.
    const nextGhosts = new Map<string, WorkspaceFileTreeEntry>()
    for (const [filePath, snapshot] of seenFilesRef.current) {
      if (!currentPaths.has(filePath)) {
        nextGhosts.set(filePath, snapshot)
        everDeletedRef.current.add(filePath)
      }
    }

    // Reborn: files that were in the deleted set at some point and are back.
    const nextReborn = new Set<string>()
    for (const filePath of everDeletedRef.current) {
      if (currentPaths.has(filePath)) {
        nextReborn.add(filePath)
      }
    }

    setChanges({
      ghostEntries: nextGhosts,
      rebornPaths: nextReborn,
    })
  }, [entries])

  return changes
}
