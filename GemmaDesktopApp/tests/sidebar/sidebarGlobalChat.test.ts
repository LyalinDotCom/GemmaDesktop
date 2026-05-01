import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/renderer/src/components/Sidebar'
import { GLOBAL_CHAT_FALLBACK_SESSION_ID } from '../../src/shared/globalChat'
import type { SessionSummary, SystemStats } from '../../src/renderer/src/types'
import type { SidebarState } from '../../src/shared/sidebar'

function makeSession(
  id: string,
  title: string,
  workingDirectory: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    title,
    titleSource: 'user',
    modelId: 'gemma3:4b',
    runtimeId: 'ollama-native',
    usesTemporaryModelOverride: false,
    conversationKind: 'normal',
    workMode: 'explore',
    planMode: false,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    workingDirectory,
    lastMessage: '',
    createdAt: updatedAt,
    updatedAt,
    isGenerating: false,
    isCompacting: false,
    ...overrides,
  }
}

const SYSTEM_STATS: SystemStats = {
  memoryUsedGB: 8,
  memoryTotalGB: 16,
  gpuUsagePercent: 12,
  cpuUsagePercent: 18,
}

function renderSidebar(
  sessions: SessionSummary[],
  sidebarState: SidebarState,
  activeSessionId: string | null = null,
): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      sessions,
      sidebarState,
      activeSessionId,
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
      systemStats: SYSTEM_STATS,
      models: [],
      preferredTerminalId: null,
    }),
  )
}

describe('Sidebar chat actions', () => {
  it('does not render a Global Chat row above pinned chats', () => {
    const sessions = [
      makeSession('alpha-chat', 'Alpha Chat', '/tmp/alpha', 200),
    ]
    const sidebarState: SidebarState = {
      pinnedSessionIds: ['alpha-chat'],
      followUpSessionIds: [],
      closedProjectPaths: [],
      projectPaths: ['/tmp/alpha'],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    }

    const markup = renderSidebar(sessions, sidebarState)

    expect(markup).toContain('PINNED')
    expect(markup).not.toContain('>Global Chat<')
  })

  it('keeps pinned chat controls available after removing the Global Chat row', () => {
    const sessions = [
      makeSession('alpha-chat', 'Alpha Chat', '/tmp/alpha', 200),
    ]
    const sidebarState: SidebarState = {
      pinnedSessionIds: ['alpha-chat'],
      followUpSessionIds: [],
      closedProjectPaths: [],
      projectPaths: ['/tmp/alpha'],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    }

    const markup = renderSidebar(sessions, sidebarState)

    expect(markup).toContain('PINNED')
    expect(markup).toContain('aria-label="Reorder pinned chat Alpha Chat"')
    expect(markup).toContain('aria-label="Unpin Alpha Chat"')
  })

  it('shows the pinned header without empty pinned rows', () => {
    const sidebarState: SidebarState = {
      pinnedSessionIds: [],
      followUpSessionIds: [],
      closedProjectPaths: [],
      projectPaths: [],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    }

    const markup = renderSidebar([], sidebarState)

    expect(markup).toContain('PINNED')
    expect(markup).not.toContain('>Empty<')
  })

  it('renders the restored pin icon action on regular conversations', () => {
    const sessions = [
      makeSession('alpha-chat', 'Alpha Chat', '/tmp/alpha', 200),
    ]
    const sidebarState: SidebarState = {
      pinnedSessionIds: [],
      followUpSessionIds: [],
      closedProjectPaths: [],
      projectPaths: ['/tmp/alpha'],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    }

    const markup = renderSidebar(sessions, sidebarState, 'alpha-chat')

    expect(markup).toContain('aria-label="Pin Alpha Chat"')
  })

  it('does not render a leaked built-in Assistant Chat fallback session', () => {
    const sessions = [
      makeSession(
        GLOBAL_CHAT_FALLBACK_SESSION_ID,
        'assistant',
        '/tmp/gemma-user-data/global-session-state/talk/workspace',
        300,
      ),
      makeSession('alpha-chat', 'Alpha Chat', '/tmp/alpha', 200),
    ]
    const sidebarState: SidebarState = {
      pinnedSessionIds: [GLOBAL_CHAT_FALLBACK_SESSION_ID],
      followUpSessionIds: [],
      closedProjectPaths: [],
      projectPaths: [
        '/tmp/gemma-user-data/global-session-state/talk/workspace',
        '/tmp/alpha',
      ],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    }

    const markup = renderSidebar(sessions, sidebarState)

    expect(markup).not.toContain('>workspace<')
    expect(markup).not.toContain('>assistant<')
    expect(markup).toContain('Alpha Chat')
  })
})
