import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import type {
  SessionSummary,
  SystemStats,
} from '../src/renderer/src/types'
import type { SidebarState } from '../src/shared/sidebar'

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

function renderSidebar(sessions: SessionSummary[]): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      sessions,
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
      systemStats,
      models: [],
    }),
  )
}

describe('Sidebar session tags', () => {
  it('does not render legacy conversation tag icons in the sidebar', () => {
    const tags = [
      { id: 'tag-1', emoji: '⭐', name: 'favorite' },
      { id: 'tag-2', emoji: '🧪', name: 'Regression checks' },
    ]

    const markup = renderSidebar([makeSession({ sessionTags: tags })])

    expect(markup).not.toContain('favorite')
    expect(markup).not.toContain('Regression checks')
    expect(markup).not.toContain('aria-label="Remove tag')
  })

  it('omits the tag chip row when the session has no tags', () => {
    const markup = renderSidebar([makeSession({ sessionTags: [] })])

    expect(markup).not.toContain('aria-label="Remove tag')
  })

  it('does not expose legacy tag filtering when sessions carry tags', () => {
    const markup = renderSidebar([
      makeSession({
        id: 'session-a',
        sessionTags: [{ id: 'tag-1', emoji: '⭐', name: 'favorite' }],
      }),
      makeSession({
        id: 'session-b',
        sessionTags: [
          { id: 'tag-2', emoji: '🧪', name: 'tests' },
          { id: 'tag-3', emoji: '⭐', name: 'favorite' },
        ],
      }),
    ])

    expect(markup).not.toContain('aria-label="Filter by tag"')
  })

  it('hides the tag filter trigger when no open session has tags', () => {
    const markup = renderSidebar([makeSession({ sessionTags: [] })])

    expect(markup).not.toContain('aria-label="Filter by tag"')
    expect(markup).not.toContain('aria-label="Clear tag filter"')
  })
})
