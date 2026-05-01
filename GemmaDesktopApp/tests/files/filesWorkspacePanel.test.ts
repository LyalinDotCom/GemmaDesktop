/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilesWorkspacePanel } from '../../src/renderer/src/components/FilesWorkspacePanel'
import type { WorkspaceFileTreeEntry, WorkspaceInspection } from '../../src/shared/workspace'

const hookMocks = vi.hoisted(() => ({
  useSessionFileChanges: vi.fn(),
  useSessionTouchedFiles: vi.fn(),
  useWorkspaceInspection: vi.fn(),
}))

vi.mock('@/hooks/useWorkspaceInspection', () => ({
  useWorkspaceInspection: hookMocks.useWorkspaceInspection,
}))

vi.mock('@/hooks/useSessionTouchedFiles', () => ({
  useSessionTouchedFiles: hookMocks.useSessionTouchedFiles,
}))

vi.mock('@/hooks/useSessionFileChanges', () => ({
  useSessionFileChanges: hookMocks.useSessionFileChanges,
}))

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

function createInspection(entries: WorkspaceFileTreeEntry[]): WorkspaceInspection {
  return {
    rootPath: '/tmp/workspace',
    exists: true,
    git: {
      available: false,
      repoRoot: null,
      branch: null,
      dirty: false,
      entries: [],
      error: null,
    },
    files: {
      truncated: false,
      scannedEntryCount: entries.length,
      entries,
      error: null,
    },
    inspectedAt: '2026-04-28T00:00:00.000Z',
  }
}

describe('FilesWorkspacePanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    hookMocks.useWorkspaceInspection.mockReturnValue({
      inspection: createInspection([
        createEntry('src', { kind: 'directory', depth: 0 }),
        createEntry('src/App.tsx', { depth: 1 }),
        createEntry('.env'),
        createEntry('.config', { kind: 'directory', depth: 0 }),
        createEntry('.config/settings.json', { depth: 1 }),
      ]),
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    hookMocks.useSessionTouchedFiles.mockReturnValue({
      byPath: new Map(),
      changedCount: 0,
      readCount: 0,
    })
    hookMocks.useSessionFileChanges.mockReturnValue({
      ghostEntries: new Map(),
      rebornPaths: new Set(),
    })

    vi.stubGlobal('gemmaDesktopBridge', {
      folders: {
        openPath: vi.fn(),
      },
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it('keeps hidden files off by default and reveals them when checked', async () => {
    await act(async () => {
      root.render(createElement(FilesWorkspacePanel, {
        workingDirectory: '/tmp/workspace',
        session: null,
      }))
    })

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Show hidden files"]',
    )
    expect(checkbox).not.toBeNull()
    expect(checkbox?.checked).toBe(false)
    expect(container.textContent).toContain('Show hidden files')
    expect(container.textContent).not.toContain('.env')
    expect(container.textContent).not.toContain('.config')

    await act(async () => {
      checkbox?.click()
    })

    expect(checkbox?.checked).toBe(true)
    expect(container.textContent).toContain('.env')
    expect(container.textContent).toContain('.config')
  })
})
