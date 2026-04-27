import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import type { SessionSummary, SystemStats } from '../src/renderer/src/types'
import type { SidebarState } from '../src/shared/sidebar'

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'Conversation 1',
    titleSource: 'user',
    modelId: 'gemma3:4b',
    runtimeId: 'ollama-native',
    usesTemporaryModelOverride: false,
    conversationKind: 'normal',
    workMode: 'build',
    planMode: false,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    workingDirectory: '/tmp/project-alpha',
    lastMessage: '',
    createdAt: 1_000,
    updatedAt: 2_000,
    isGenerating: false,
    isCompacting: false,
    ...overrides,
  }
}

const systemStats: SystemStats = {
  memoryUsedGB: 0,
  memoryTotalGB: 0,
  gpuUsagePercent: 0,
  cpuUsagePercent: 0,
}

function renderSidebar(input?: {
  sessions?: SessionSummary[]
  sidebarState?: SidebarState
  initialSearchState?: {
    query: string
    status: 'idle' | 'searching' | 'ready' | 'error'
    results: Array<{
      sessionId: string
      title: string
      workingDirectory: string
      conversationKind: 'normal' | 'research'
      updatedAt: number
      snippet: string
    }>
    errorMessage?: string | null
  }
}) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      sessions: input?.sessions ?? [makeSession()],
      sidebarState: input?.sidebarState ?? {
        pinnedSessionIds: [],
        followUpSessionIds: [],
        closedProjectPaths: [],
        projectPaths: ['/tmp/project-alpha'],
        sessionOrderOverrides: {},
        projectOrderOverrides: {},
        lastActiveSessionId: null,
      },
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
      onSetSessionTags: () => {},
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
      initialSearchState: input?.initialSearchState,
    }),
  )
}

describe('Sidebar search rendering', () => {
  it('shows the normal pinned and project list when the query is empty', () => {
    const markup = renderSidebar({
      sidebarState: {
        pinnedSessionIds: ['session-1'],
        followUpSessionIds: [],
        closedProjectPaths: [],
        projectPaths: ['/tmp/project-alpha'],
        sessionOrderOverrides: {},
        projectOrderOverrides: {},
        lastActiveSessionId: null,
      },
    })

    expect(markup).toContain('placeholder="Search"')
    expect(markup).toContain('Pinned')
    expect(markup).toContain('project-alpha')
    expect(markup).toContain('Conversation 1')
    expect(markup).not.toContain('Search results')
  })

  it('shows the searching state for a non-empty query', () => {
    const markup = renderSidebar({
      initialSearchState: {
        query: 'npm run dev',
        status: 'searching',
        results: [],
      },
    })

    expect(markup).toContain('Searching open conversations…')
  })

  it('shows the no-results state for a non-empty query', () => {
    const markup = renderSidebar({
      initialSearchState: {
        query: 'missing phrase',
        status: 'ready',
        results: [],
      },
    })

    expect(markup).toContain('No open conversations matched')
    expect(markup).toContain('missing phrase')
  })

  it('shows flat search results for a non-empty query', () => {
    const markup = renderSidebar({
      initialSearchState: {
        query: 'release checklist',
        status: 'ready',
        results: [
          {
            sessionId: 'session-2',
            title: 'Release chat',
            workingDirectory: '/tmp/project-beta',
            conversationKind: 'normal',
            updatedAt: 3_000,
            snippet: 'release checklist and npm run dev',
          },
        ],
      },
    })

    expect(markup).toContain('Search results')
    expect(markup).toContain('Release chat')
    expect(markup).toContain('/tmp/project-beta')
    expect(markup).toContain('release checklist and npm run dev')
    expect(markup).not.toContain('Pinned')
  })
})
