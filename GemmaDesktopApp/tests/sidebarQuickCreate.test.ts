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

function renderSidebar(input: {
  sessions?: SessionSummary[]
  sidebarState?: SidebarState
  activeSessionId?: string | null
}) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      sessions: input.sessions ?? [makeSession()],
      sidebarState: input.sidebarState ?? {
        pinnedSessionIds: [],
        followUpSessionIds: [],
        closedProjectPaths: [],
        projectPaths: ['/tmp/project-alpha'],
        sessionOrderOverrides: {},
        projectOrderOverrides: {},
        lastActiveSessionId: null,
      },
      activeSessionId: input.activeSessionId ?? 'session-1',
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

describe('Sidebar quick create menu', () => {
  it('shows both quick-create actions for the active project', () => {
    const markup = renderSidebar({})

    expect(markup).toContain('Quick create')
    expect(markup).toContain('Add conversation')
    expect(markup).toContain('project-alpha')
    expect(markup).toContain('Open project')
    expect(markup).toContain('Pick a folder and open its latest or first conversation')
  })

  it('prompts for a selected project before enabling conversation creation', () => {
    const markup = renderSidebar({
      sessions: [makeSession({ workingDirectory: '' })],
    })

    expect(markup).toContain('Open a project before adding a conversation')
    expect(markup).toContain('No project selected')
  })
})
