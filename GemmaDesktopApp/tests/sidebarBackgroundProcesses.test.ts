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

describe('Sidebar background processes', () => {
  it('renders running process rows beneath the conversation', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        sessions: [
          makeSession({
            runningProcesses: [
              {
                terminalId: 'terminal-1',
                command: 'npm start',
                workingDirectory: '/tmp/project',
                startedAt: 3_000,
                previewText: 'App listening at http://localhost:3000',
              },
            ],
          }),
        ],
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
      }),
    )

    expect(markup).toContain('Conversation 1')
    expect(markup).toContain('npm start')
    expect(markup).toContain('Terminate process')
    expect(markup).toContain('App listening at http://localhost:3000')
  })

  it('does not add animated background classes to running conversations', () => {
    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        sessions: [
          makeSession({
            isGenerating: true,
          }),
        ],
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
      }),
    )

    expect(markup).toContain('Conversation 1')
    expect(markup).not.toContain('project-session-row')
    expect(markup).not.toContain('project-session-row-running')
  })
})
