import { describe, expect, it } from 'vitest'
import {
  buildSidebarModel,
  findActiveProjectForSession,
  findInitialVisibleSessionId,
  findReplacementSessionAfterDelete,
  findReopenSessionForProject,
} from '../../src/renderer/src/lib/sidebarModel'
import { GLOBAL_CHAT_FALLBACK_SESSION_ID } from '../../src/shared/globalChat'
import type { SessionSummary } from '../../src/renderer/src/types'
import {
  EMPTY_SIDEBAR_STATE,
  type SidebarState,
} from '../../src/shared/sidebar'

function makeSidebarState(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    ...EMPTY_SIDEBAR_STATE,
    pinnedSessionIds: [],
    followUpSessionIds: [],
    closedProjectPaths: [],
    projectPaths: [],
    sessionOrderOverrides: {},
    projectOrderOverrides: {},
    ...overrides,
  }
}

function makeSession(
  id: string,
  workingDirectory: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    titleSource: 'user',
    modelId: 'gemma3:4b',
    runtimeId: 'ollama-native',
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

describe('sidebar model', () => {
  it('renders pinned chats before projects while keeping them in their project group', () => {
    const sessions = [
      makeSession('alpha-chat', '/tmp/alpha', 100),
      makeSession('beta-chat', '/tmp/beta', 200),
    ]
    const sidebarState = makeSidebarState({
      pinnedSessionIds: ['alpha-chat'],
      projectPaths: ['/tmp/alpha', '/tmp/beta'],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.pinnedSessions.map((session) => session.id)).toEqual(['alpha-chat'])
    expect(model.projectGroups.map((group) => group.path)).toEqual([
      '/tmp/beta',
      '/tmp/alpha',
    ])
    expect(
      model.projectGroups.find((group) => group.path === '/tmp/alpha')?.sessions.map(
        (session) => session.id,
      ),
    ).toEqual(['alpha-chat'])
    expect(model.visibleSessionIds).toEqual(['alpha-chat', 'beta-chat'])
  })

  it('never exposes the built-in Assistant Chat fallback in sidebar groups', () => {
    const sessions = [
      makeSession(GLOBAL_CHAT_FALLBACK_SESSION_ID, '/tmp/user-data/global-session-state/talk/workspace', 500, {
        title: 'assistant',
      }),
      makeSession('alpha-chat', '/tmp/alpha', 100),
    ]
    const sidebarState = makeSidebarState({
      pinnedSessionIds: [GLOBAL_CHAT_FALLBACK_SESSION_ID, 'alpha-chat'],
      projectPaths: [
        '/tmp/user-data/global-session-state/talk/workspace',
        '/tmp/alpha',
      ],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.pinnedSessions.map((session) => session.id)).toEqual(['alpha-chat'])
    expect(model.projectGroups.map((group) => group.path)).toEqual(['/tmp/alpha'])
    expect(model.visibleSessionIds).toEqual(['alpha-chat'])
  })

  it('derives icon groups from conversation icons ordered by latest matching chat', () => {
    const sessions = [
      makeSession('alpha-old', '/tmp/alpha', 100, { conversationIcon: '🧪' }),
      makeSession('alpha-new', '/tmp/alpha', 400, { conversationIcon: '🧪' }),
      makeSession('beta-chat', '/tmp/beta', 300, { conversationIcon: '🚀' }),
      makeSession('plain-chat', '/tmp/gamma', 500),
    ]
    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma'],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.iconGroups.map((group) => ({
      icon: group.icon,
      sessionIds: group.sessions.map((session) => session.id),
    }))).toEqual([
      { icon: '🧪', sessionIds: ['alpha-new', 'alpha-old'] },
      { icon: '🚀', sessionIds: ['beta-chat'] },
    ])
  })

  it('keeps icon-group conversations visible in normal project folders too', () => {
    const sessions = [
      makeSession('alpha-chat', '/tmp/alpha', 100, { conversationIcon: '🧪' }),
      makeSession('beta-chat', '/tmp/beta', 200),
    ]
    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha', '/tmp/beta'],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.iconGroups[0]?.sessions.map((session) => session.id)).toEqual([
      'alpha-chat',
    ])
    expect(
      model.projectGroups.find((group) => group.path === '/tmp/alpha')?.sessions.map(
        (session) => session.id,
      ),
    ).toEqual(['alpha-chat'])
  })

  it('hides closed projects from the visible project list', () => {
    const sessions = [
      makeSession('alpha-chat', '/tmp/alpha', 300),
      makeSession('beta-chat', '/tmp/beta', 200),
      makeSession('gamma-chat', '/tmp/gamma', 100),
    ]
    const sidebarState = makeSidebarState({
      pinnedSessionIds: ['gamma-chat'],
      closedProjectPaths: ['/tmp/alpha'],
      projectPaths: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma'],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.projectGroups.map((group) => group.path)).toEqual([
      '/tmp/beta',
      '/tmp/gamma',
    ])
    expect(model.visibleSessionIds).toEqual(['gamma-chat', 'beta-chat'])
  })

  it('exposes the next visible session order after a project is closed', () => {
    const sessions = [
      makeSession('active-alpha', '/tmp/alpha', 100),
      makeSession('pinned-delta', '/tmp/delta', 400),
      makeSession('beta-chat', '/tmp/beta', 300),
      makeSession('gamma-chat', '/tmp/gamma', 200),
    ]
    const sidebarState = makeSidebarState({
      pinnedSessionIds: ['pinned-delta'],
      closedProjectPaths: ['/tmp/alpha'],
      projectPaths: ['/tmp/alpha', '/tmp/delta', '/tmp/beta', '/tmp/gamma'],
    })

    const model = buildSidebarModel(sessions, sidebarState)

    expect(model.visibleSessionIds[0]).toBe('pinned-delta')
    expect(model.visibleSessionIds).toEqual([
      'pinned-delta',
      'beta-chat',
      'gamma-chat',
    ])
  })

  it('finds the most recently updated chat when reopening a closed project', () => {
    const sessions = [
      makeSession('alpha-older', '/tmp/alpha', 100),
      makeSession('alpha-newer', '/tmp/alpha', 250),
      makeSession('beta-chat', '/tmp/beta', 200),
    ]
    const closedSidebarState = makeSidebarState({
      closedProjectPaths: ['/tmp/alpha'],
      projectPaths: ['/tmp/alpha', '/tmp/beta'],
    })
    const openSidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha', '/tmp/beta'],
    })

    expect(
      findReopenSessionForProject(sessions, closedSidebarState, '/tmp/alpha/'),
    ).toMatchObject({ id: 'alpha-newer' })
    expect(
      findReopenSessionForProject(sessions, openSidebarState, '/tmp/alpha'),
    ).toBeNull()
  })

  it('derives the active project from the selected conversation path', () => {
    const sessions = [
      makeSession('alpha-chat', '/tmp/alpha/', 200),
      makeSession('beta-chat', '/tmp/beta', 100),
    ]

    expect(findActiveProjectForSession(sessions, 'alpha-chat')).toEqual({
      path: '/tmp/alpha',
      name: 'alpha',
    })
    expect(findActiveProjectForSession(sessions, 'missing')).toBeNull()
  })

  it('restores the last active visible conversation on startup', () => {
    const sessions = [
      makeSession('alpha-older', '/tmp/alpha', 100),
      makeSession('alpha-newer', '/tmp/alpha', 300),
      makeSession('beta-chat', '/tmp/beta', 200),
    ]
    const sidebarState = makeSidebarState({
      lastActiveSessionId: 'beta-chat',
      projectPaths: ['/tmp/alpha', '/tmp/beta'],
    })

    expect(findInitialVisibleSessionId(sessions, sidebarState)).toBe('beta-chat')
    expect(
      findInitialVisibleSessionId(
        sessions,
        makeSidebarState({
          lastActiveSessionId: 'missing-chat',
          projectPaths: ['/tmp/alpha', '/tmp/beta'],
        }),
      ),
    ).toBe('alpha-newer')
  })

  it('selects the conversation above the deleted active one when possible', () => {
    const sessions = [
      makeSession('alpha-newest', '/tmp/alpha', 300),
      makeSession('alpha-middle', '/tmp/alpha', 200),
      makeSession('alpha-oldest', '/tmp/alpha', 100),
    ]
    const sidebarState = makeSidebarState({ projectPaths: ['/tmp/alpha'] })

    expect(
      findReplacementSessionAfterDelete(sessions, sidebarState, 'alpha-middle'),
    ).toBe('alpha-newest')
    expect(
      findReplacementSessionAfterDelete(sessions, sidebarState, 'alpha-newest'),
    ).toBe('alpha-middle')
    expect(
      findReplacementSessionAfterDelete(
        [makeSession('only-chat', '/tmp/alpha', 100)],
        sidebarState,
        'only-chat',
      ),
    ).toBeNull()
  })

  it('anchors a moved conversation at its saved index inside its project group', () => {
    const sessions = [
      makeSession('alpha-1', '/tmp/alpha', 400),
      makeSession('alpha-2', '/tmp/alpha', 300),
      makeSession('alpha-3', '/tmp/alpha', 200),
      makeSession('alpha-4', '/tmp/alpha', 100),
    ]

    // Move alpha-1 (the most-recent) to position 2 — others fill around it.
    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha'],
      sessionOrderOverrides: { 'alpha-1': 2 },
    })

    const model = buildSidebarModel(sessions, sidebarState)
    const alphaGroup = model.projectGroups.find((group) => group.path === '/tmp/alpha')
    expect(alphaGroup?.sessions.map((session) => session.id)).toEqual([
      'alpha-2',
      'alpha-3',
      'alpha-1',
      'alpha-4',
    ])
  })

  it('falls back to natural updatedAt order for sessions without overrides', () => {
    const sessions = [
      makeSession('alpha-1', '/tmp/alpha', 400),
      makeSession('alpha-2', '/tmp/alpha', 300),
      makeSession('alpha-3', '/tmp/alpha', 200),
    ]

    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha'],
    })

    const model = buildSidebarModel(sessions, sidebarState)
    const alphaGroup = model.projectGroups.find((group) => group.path === '/tmp/alpha')
    expect(alphaGroup?.sessions.map((session) => session.id)).toEqual([
      'alpha-1',
      'alpha-2',
      'alpha-3',
    ])
  })

  it('respects project order overrides when reordering project groups', () => {
    const sessions = [
      makeSession('alpha-chat', '/tmp/alpha', 400),
      makeSession('beta-chat', '/tmp/beta', 300),
      makeSession('gamma-chat', '/tmp/gamma', 200),
    ]

    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha', '/tmp/beta', '/tmp/gamma'],
      // Pin gamma at position 0 — alpha and beta flow naturally around it.
      projectOrderOverrides: { '/tmp/gamma': 0 },
    })

    const model = buildSidebarModel(sessions, sidebarState)
    expect(model.projectGroups.map((group) => group.path)).toEqual([
      '/tmp/gamma',
      '/tmp/alpha',
      '/tmp/beta',
    ])
  })

  it('clamps overrides past the end of the list to the last available slot', () => {
    const sessions = [
      makeSession('alpha-1', '/tmp/alpha', 200),
      makeSession('alpha-2', '/tmp/alpha', 100),
    ]

    const sidebarState = makeSidebarState({
      projectPaths: ['/tmp/alpha'],
      sessionOrderOverrides: { 'alpha-1': 99 },
    })

    const model = buildSidebarModel(sessions, sidebarState)
    const alphaGroup = model.projectGroups.find((group) => group.path === '/tmp/alpha')
    // alpha-1 anchored to end (clamped from 99 → 1), alpha-2 fills slot 0.
    expect(alphaGroup?.sessions.map((session) => session.id)).toEqual([
      'alpha-2',
      'alpha-1',
    ])
  })
})
