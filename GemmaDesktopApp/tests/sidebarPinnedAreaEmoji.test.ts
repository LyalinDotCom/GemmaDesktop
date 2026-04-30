/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import type { SystemStats } from '../src/renderer/src/types'
import { EMPTY_SIDEBAR_STATE } from '../src/shared/sidebar'

const SYSTEM_STATS: SystemStats = {
  memoryUsedGB: 8,
  memoryTotalGB: 16,
  gpuUsagePercent: 12,
  cpuUsagePercent: 18,
}

const openEmojiPanel = vi.fn(async () => ({ ok: true }))

function renderSidebar(container: HTMLElement): Root {
  const root = createRoot(container)
  act(() => {
    root.render(createElement(Sidebar, {
      sessions: [],
      sidebarState: EMPTY_SIDEBAR_STATE,
      activeSessionId: null,
      onSelectSession: () => {},
      onCreateProject: () => {},
      onCreateSessionInProject: () => {},
      onOpenProject: () => {},
      onCloseProject: () => {},
      onDeleteSession: () => {},
      onRenameSession: () => {},
      onCloseProcess: () => {},
      onPinSession: () => {},
      onUnpinSession: () => {},
      onCreatePinnedArea: () => {},
      onDeletePinnedArea: () => {},
      onUpdatePinnedAreaIcon: () => {},
      onSetPinnedAreaCollapsed: () => {},
      onMovePinnedArea: () => {},
      onFlagFollowUp: () => {},
      onUnflagFollowUp: () => {},
      onMovePinnedSession: () => {},
      onMoveProjectSession: () => {},
      onClearSessionOrder: () => {},
      onMoveProject: () => {},
      onClearProjectOrder: () => {},
      automations: [],
      activeAutomationId: null,
      onSelectAutomation: () => {},
      onNewAutomation: () => {},
      currentView: 'chat',
      onOpenSettings: () => {},
      onOpenDoctor: () => {},
      onOpenSkills: () => {},
      selectedSkillCount: 0,
      systemStats: SYSTEM_STATS,
      models: [],
      preferredTerminalId: null,
    }))
  })
  return root
}

describe('Sidebar pinned area emoji picker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    openEmojiPanel.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('gemmaDesktopBridge', {
      sessions: {
        search: vi.fn(async () => []),
      },
      system: {
        openEmojiPanel,
      },
      terminals: {
        listInstalled: vi.fn(() => new Promise(() => {})),
        openDirectory: vi.fn(async () => ({ ok: true })),
      },
    })
    root = renderSidebar(container)
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

  it('opens the macOS emoji panel when creating a pinned area', async () => {
    const createButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Create pinned area"]',
    )
    expect(createButton).not.toBeNull()

    await act(async () => {
      createButton?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('All macOS emoji')
    expect(container.querySelector<HTMLInputElement>('#pinned-area-icon-search')?.placeholder)
      .toBe('Filter suggestions')
    expect(openEmojiPanel).toHaveBeenCalledTimes(1)
  })
})
