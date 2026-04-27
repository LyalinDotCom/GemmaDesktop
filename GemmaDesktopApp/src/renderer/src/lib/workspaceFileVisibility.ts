import type { WorkspaceFileTreeEntry } from '@shared/workspace'

export function isHiddenWorkspacePath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.'))
}

export function filterVisibleWorkspaceEntries<T extends { relativePath: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => !isHiddenWorkspacePath(entry.relativePath))
}

export function buildVisibleWorkspaceFilesSnapshot(
  entries: readonly WorkspaceFileTreeEntry[],
): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const entry of filterVisibleWorkspaceEntries(entries)) {
    snapshot.set(
      entry.relativePath,
      `${entry.kind}:${entry.gitStatus ?? ''}:${entry.changed ? '1' : '0'}`,
    )
  }
  return snapshot
}
