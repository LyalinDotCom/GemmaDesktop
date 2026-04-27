import { describe, expect, it } from 'vitest'
import { buildVisibleWorkspaceFilesSnapshot, filterVisibleWorkspaceEntries } from '../src/renderer/src/lib/workspaceFileVisibility'
import type { WorkspaceFileTreeEntry } from '../src/shared/workspace'

function createEntry(
  relativePath: string,
  overrides: Partial<WorkspaceFileTreeEntry> = {},
): WorkspaceFileTreeEntry {
  const segments = relativePath.split('/')
  const name = segments.at(-1) ?? relativePath
  return {
    path: `/tmp/workspace/${relativePath}`,
    relativePath,
    name,
    depth: Math.max(0, segments.length - 1),
    kind: 'file',
    changed: false,
    gitStatus: null,
    ...overrides,
  }
}

describe('workspaceFileVisibility', () => {
  it('drops hidden paths from visible workspace entries', () => {
    const visibleEntries = filterVisibleWorkspaceEntries([
      createEntry('src/App.tsx'),
      createEntry('.env'),
      createEntry('src/.cache/state.json'),
      createEntry('.vscode/settings.json'),
    ])

    expect(visibleEntries.map((entry) => entry.relativePath)).toEqual(['src/App.tsx'])
  })

  it('keeps file badge snapshots stable when only hidden files change', () => {
    const previous = buildVisibleWorkspaceFilesSnapshot([
      createEntry('src/App.tsx', { changed: true, gitStatus: 'modified' }),
      createEntry('.env', { changed: true, gitStatus: 'modified' }),
    ])
    const next = buildVisibleWorkspaceFilesSnapshot([
      createEntry('src/App.tsx', { changed: true, gitStatus: 'modified' }),
      createEntry('.env', { changed: false, gitStatus: null }),
      createEntry('.vscode/settings.json', { changed: true, gitStatus: 'modified' }),
    ])

    expect(Array.from(next.entries())).toEqual(Array.from(previous.entries()))
  })
})
