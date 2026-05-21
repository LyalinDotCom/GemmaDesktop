/**
 * @vitest-environment jsdom
 */
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import type { SessionSummary, SystemStats } from '../../src/renderer/src/types'
import type { SidebarState } from '../../src/shared/sidebar'

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'Conversation 1',
    titleSource: 'user',
    modelId: 'gemma3:4b',
    runtimeId: 'ollama-native',
    conversationKind: 'normal',
    workMode: 'build',
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
    ...overrides,
  }
}

const sidebarState: SidebarState = {
  pinnedSessionIds: [],
  followUpSessionIds: [],
  closedProjectPaths: [],
  projectPaths: ['/tmp/project'],
  sessionOrderOverrides: {},
  projectOrderOverrides: {},
  lastActiveSessionId: null,
}

const systemStats: SystemStats = {
  memoryUsedGB: 0,
  memoryTotalGB: 0,
  gpuUsagePercent: 0,
  cpuUsagePercent: 0,
}

type SidebarProps = ComponentProps<typeof Sidebar>

function makeSidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    sessions: [makeSession()],
    sidebarState,
    activeSessionId: 'session-1',
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
    systemStats,
    models: [],
    ...overrides,
  }
}

function makeRunningProcess(
  overrides: Partial<NonNullable<SessionSummary['runningProcesses']>[number]> = {},
) {
  return {
    terminalId: 'terminal-1',
    command: 'npm start',
    workingDirectory: '/tmp/project',
    startedAt: 3_000,
    previewText: 'App listening at http://localhost:3000',
    ...overrides,
  }
}

function getButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((entry) => entry.getAttribute('aria-label') === label)
  if (!button) {
    throw new Error(`Could not find button with label: ${label}`)
  }
  return button
}

describe('Sidebar background processes', () => {
  let container: HTMLDivElement
  let root: Root | null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = null
    vi.stubGlobal('gemmaDesktopBridge', {
      sessions: {
        search: vi.fn(async () => []),
      },
      system: {
        openEmojiPanel: vi.fn(async () => {}),
      },
      terminals: {
        listInstalled: vi.fn(async () => []),
        openDirectory: vi.fn(async () => ({ ok: true })),
      },
    })
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount()
      })
    }
    container.remove()
    vi.unstubAllGlobals()
  })

  it('renders running process rows beneath the conversation', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, makeSidebarProps({
        sessions: [
          makeSession({
            runningProcesses: [
              makeRunningProcess({}),
            ],
          }),
        ],
      })),
    )

    expect(markup).toContain('Conversation 1')
    expect(markup).toContain('npm start')
    expect(markup).toContain('Terminate process')
    expect(markup).toContain('App listening at http://localhost:3000')
  })

  it('renders a Project Browser reopen action when the process has a preview URL', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, makeSidebarProps({
        sessions: [
          makeSession({
            runningProcesses: [
              makeRunningProcess({ previewUrl: 'http://localhost:3000/' }),
            ],
          }),
        ],
        onOpenProcessPreview: () => {},
      })),
    )

    expect(markup).toContain('Open Project Browser for process npm start')
    expect(markup).toContain('Open Project Browser at http://localhost:3000/')
  })

  it('opens a process preview without selecting the conversation row', async () => {
    const onOpenProcessPreview = vi.fn()
    const onSelectSession = vi.fn()
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(Sidebar, makeSidebarProps({
        sessions: [
          makeSession({
            runningProcesses: [
              makeRunningProcess({ previewUrl: 'http://localhost:3000/' }),
            ],
          }),
        ],
        onOpenProcessPreview,
        onSelectSession,
      })))
    })

    const button = getButtonByLabel(container, 'Open Project Browser for process npm start')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenProcessPreview).toHaveBeenCalledWith('session-1', 'http://localhost:3000/')
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('does not add animated background classes to running conversations', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, makeSidebarProps({
        sessions: [
          makeSession({
            isGenerating: true,
          }),
        ],
      })),
    )

    expect(markup).toContain('Conversation 1')
    expect(markup).not.toContain('project-session-row')
    expect(markup).not.toContain('project-session-row-running')
  })
})
