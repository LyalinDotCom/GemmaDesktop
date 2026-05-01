/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import type { SessionSummary, SystemStats } from '../../src/renderer/src/types'
import { EMPTY_SIDEBAR_STATE, type SidebarState } from '../../src/shared/sidebar'

const SYSTEM_STATS: SystemStats = {
  memoryUsedGB: 8,
  memoryTotalGB: 16,
  gpuUsagePercent: 12,
  cpuUsagePercent: 18,
}

function makeSession(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: 'session-1',
    title: 'Conversation 1',
    titleSource: 'user',
    modelId: 'gemma4:26b',
    runtimeId: 'ollama-native',
    usesTemporaryModelOverride: false,
    conversationKind: 'normal',
    workMode: 'explore',
    planMode: false,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    workingDirectory: '/tmp/project',
    lastMessage: '',
    createdAt: 1_000,
    updatedAt: 2_000,
    isGenerating: false,
    isCompacting: false,
    conversationIcon: null,
    ...overrides,
  }
}

function sidebarProps(input?: {
  sessions?: SessionSummary[]
  sidebarState?: SidebarState
  activeSessionId?: string | null
  onRenameSession?: (id: string, title: string, icon: string | null) => void
}) {
  return {
    sessions: input?.sessions ?? [makeSession()],
    sidebarState: input?.sidebarState ?? {
      ...EMPTY_SIDEBAR_STATE,
      projectPaths: ['/tmp/project'],
    },
    activeSessionId: input?.activeSessionId ?? 'session-1',
    onSelectSession: () => {},
    onCreateProject: () => {},
    onCreateSessionInProject: () => {},
    onOpenProject: () => {},
    onCloseProject: () => {},
    onDeleteSession: () => {},
    onRenameSession: input?.onRenameSession ?? (() => {}),
    onCloseProcess: () => {},
    onPinSession: () => {},
    onUnpinSession: () => {},
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
    currentView: 'chat' as const,
    onOpenSettings: () => {},
    onOpenDoctor: () => {},
    onOpenSkills: () => {},
    selectedSkillCount: 0,
    systemStats: SYSTEM_STATS,
    models: [],
    preferredTerminalId: null,
  }
}

function renderSidebarMarkup(sessions: SessionSummary[]): string {
  return renderToStaticMarkup(
    createElement(Sidebar, sidebarProps({ sessions })),
  )
}

function renderSidebar(container: HTMLElement, props = sidebarProps()): Root {
  const root = createRoot(container)
  act(() => {
    root.render(createElement(Sidebar, props))
  })
  return root
}

function getSessionRow(container: HTMLElement, title: string): HTMLElement {
  const titleNode = container.querySelector<HTMLElement>(`span[title="${title}"]`)
  const row = titleNode?.closest<HTMLElement>('[role="button"]')
  if (!row) {
    throw new Error(`Could not find row for ${title}`)
  }
  return row
}

function getButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.getAttribute('aria-label') === label) ?? null
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )
  valueDescriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Sidebar conversation icons', () => {
  let container: HTMLDivElement
  let root: Root | null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('gemmaDesktopBridge', {
      sessions: {
        search: vi.fn(async () => []),
      },
      system: {
        openEmojiPanel: vi.fn(async () => ({ ok: true })),
      },
      terminals: {
        listInstalled: vi.fn(async () => []),
        openDirectory: vi.fn(async () => ({ ok: true })),
      },
    })
    root = null
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it('does not render a default icon for conversations without one', () => {
    const markup = renderSidebarMarkup([makeSession({ conversationIcon: null })])

    expect(markup).not.toContain('aria-label="Conversation icon')
    expect(markup).not.toContain('aria-label="Show ⭐ conversations"')
  })

  it('renders icon filters and allows one expanded group at a time', async () => {
    root = renderSidebar(container, sidebarProps({
      sessions: [
        makeSession({ id: 'tests', title: 'Regression Chat', conversationIcon: '🧪' }),
        makeSession({
          id: 'ship',
          title: 'Launch Chat',
          conversationIcon: '🚀',
          updatedAt: 3_000,
        }),
      ],
      sidebarState: {
        ...EMPTY_SIDEBAR_STATE,
        projectPaths: ['/tmp/project'],
      },
      activeSessionId: 'tests',
    }))
    await act(async () => {})

    const testsButton = getButtonByLabel(container, 'Show 🧪 conversations')
    const launchButton = getButtonByLabel(container, 'Show 🚀 conversations')

    expect(testsButton).not.toBeNull()
    expect(launchButton).not.toBeNull()

    await act(async () => {
      testsButton?.click()
    })
    expect(testsButton?.getAttribute('aria-pressed')).toBe('true')
    expect(launchButton?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      launchButton?.click()
    })
    expect(testsButton?.getAttribute('aria-pressed')).toBe('false')
    expect(launchButton?.getAttribute('aria-pressed')).toBe('true')
  })

  it('renames a conversation with a selected icon', async () => {
    const onRenameSession = vi.fn()
    root = renderSidebar(container, sidebarProps({ onRenameSession }))

    await act(async () => {
      getSessionRow(container, 'Conversation 1').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      )
    })

    const titleInput = container.querySelector<HTMLInputElement>('#conversation-title-value')
    const iconInput = container.querySelector<HTMLInputElement>('#conversation-icon-value')
    expect(titleInput?.value).toBe('Conversation 1')
    expect(iconInput?.value).toBe('')

    await act(async () => {
      setInputValue(titleInput!, 'Renamed conversation')
      getButtonByLabel(container, 'Use 🧪')?.click()
    })

    expect(iconInput?.value).toBe('🧪')

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    })

    expect(onRenameSession).toHaveBeenCalledWith(
      'session-1',
      'Renamed conversation',
      '🧪',
    )
  })

  it('does not save plain text as a conversation icon', async () => {
    const onRenameSession = vi.fn()
    root = renderSidebar(container, sidebarProps({ onRenameSession }))

    await act(async () => {
      getSessionRow(container, 'Conversation 1').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      )
    })

    const titleInput = container.querySelector<HTMLInputElement>('#conversation-title-value')
    const iconInput = container.querySelector<HTMLInputElement>('#conversation-icon-value')
    expect(titleInput).toBeTruthy()
    expect(iconInput).toBeTruthy()

    await act(async () => {
      setInputValue(titleInput!, 'Text Icon Attempt')
      setInputValue(iconInput!, 'not-an-emoji')
    })

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    })

    expect(onRenameSession).toHaveBeenCalledWith('session-1', 'Text Icon Attempt', null)
  })

  it('can clear an existing icon while renaming', async () => {
    const onRenameSession = vi.fn()
    root = renderSidebar(container, sidebarProps({
      sessions: [makeSession({ conversationIcon: '🚀' })],
      onRenameSession,
    }))

    await act(async () => {
      getSessionRow(container, 'Conversation 1').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      )
    })

    await act(async () => {
      getButtonByLabel(container, 'Clear conversation icon')?.click()
    })

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    })

    expect(onRenameSession).toHaveBeenCalledWith('session-1', 'Conversation 1', null)
  })
})
