import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SidebarStateStore,
  normalizeStoredSidebarProjectPath,
} from '../src/main/sidebarState'
import {
  DEFAULT_PINNED_AREA_ICON,
  DEFAULT_PINNED_AREA_ID,
  getPinnedAreaDestinations,
  type SidebarSessionReference,
} from '../src/shared/sidebar'

describe('sidebar state store', () => {
  let tempDir = ''
  let sidebarStatePath = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-sidebar-state-'))
    sidebarStatePath = path.join(tempDir, 'sidebar-state.json')
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  function buildSessionRefs(): {
    projectAlpha: string
    projectBeta: string
    refs: SidebarSessionReference[]
  } {
    const projectAlpha = path.join(tempDir, 'alpha')
    const projectBeta = path.join(tempDir, 'beta')

    return {
      projectAlpha,
      projectBeta,
      refs: [
        { id: 'session-a', workingDirectory: projectAlpha },
        { id: 'session-b', workingDirectory: `${projectAlpha}/` },
        { id: 'session-c', workingDirectory: projectBeta },
      ],
    }
  }

  it('creates pinned areas and persists pinned sessions in their areas', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const created = await store.createPinnedArea('🚀', 'session-a', refs)
    const areaId = created.state.pinnedAreas?.[0]?.id ?? ''
    const result = await store.pinSession('session-c', areaId, refs)

    expect(result.state.pinnedSessionIds).toEqual([])
    expect(result.state.pinnedAreas?.map((area) => ({
      icon: area.icon,
      sessionIds: area.sessionIds,
      collapsed: area.collapsed,
    }))).toEqual([
      { icon: '🚀', sessionIds: ['session-a', 'session-c'], collapsed: false },
    ])
    expect(result.state.projectPaths).toEqual([
      normalizeStoredSidebarProjectPath(refs[0]!.workingDirectory),
      normalizeStoredSidebarProjectPath(refs[2]!.workingDirectory),
    ])

    const reloaded = new SidebarStateStore(sidebarStatePath)
    const reloadedState = await reloaded.init(refs)
    expect(reloadedState.state.pinnedAreas?.map((area) => area.sessionIds)).toEqual([
      ['session-a', 'session-c'],
    ])
    expect(reloadedState.state.projectPaths).toEqual([
      normalizeStoredSidebarProjectPath(refs[0]!.workingDirectory),
      normalizeStoredSidebarProjectPath(refs[2]!.workingDirectory),
    ])
  })

  it('pins directly into the generic default area when requested', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const result = await store.pinSession('session-a', DEFAULT_PINNED_AREA_ID, refs)

    expect(result.state.pinnedAreas?.map((area) => ({
      id: area.id,
      icon: area.icon,
      sessionIds: area.sessionIds,
    }))).toEqual([
      {
        id: DEFAULT_PINNED_AREA_ID,
        icon: DEFAULT_PINNED_AREA_ICON,
        sessionIds: ['session-a'],
      },
    ])
  })

  it('uses a synthetic generic destination until the default area is persisted', () => {
    expect(getPinnedAreaDestinations([]).map((area) => area.id)).toEqual([
      DEFAULT_PINNED_AREA_ID,
    ])
    expect(getPinnedAreaDestinations([
      {
        id: 'custom-area',
        icon: '🚀',
        collapsed: false,
        sessionIds: [],
      },
    ]).map((area) => area.id)).toEqual([
      DEFAULT_PINNED_AREA_ID,
      'custom-area',
    ])
  })

  it('keeps the generic default area stable', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    await store.pinSession('session-a', DEFAULT_PINNED_AREA_ID, refs)
    const updated = await store.updatePinnedAreaIcon(DEFAULT_PINNED_AREA_ID, '🔥', refs)
    const deleted = await store.deletePinnedArea(DEFAULT_PINNED_AREA_ID, refs)

    expect(updated.state.pinnedAreas?.[0]?.icon).toBe(DEFAULT_PINNED_AREA_ICON)
    expect(deleted.state.pinnedAreas?.[0]?.id).toBe(DEFAULT_PINNED_AREA_ID)
  })

  it('persists reordered pinned areas and icon changes across store reloads', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const first = await store.createPinnedArea('⭐', 'session-a', refs)
    const firstAreaId = first.state.pinnedAreas?.[0]?.id ?? ''
    const second = await store.createPinnedArea('🧪', 'session-c', refs)
    const secondAreaId = second.state.pinnedAreas?.[1]?.id ?? ''
    await store.updatePinnedAreaIcon(firstAreaId, '🔥', refs)
    const moved = await store.movePinnedArea(secondAreaId, 'up', refs)

    expect(moved.state.pinnedAreas?.map((area) => ({
      icon: area.icon,
      sessionIds: area.sessionIds,
    }))).toEqual([
      { icon: '🧪', sessionIds: ['session-c'] },
      { icon: '🔥', sessionIds: ['session-a'] },
    ])

    const reloaded = new SidebarStateStore(sidebarStatePath)
    const reloadedState = await reloaded.init(refs)
    expect(reloadedState.state.pinnedAreas?.map((area) => area.icon)).toEqual(['🧪', '🔥'])
  })

  it('preserves compound emoji graphemes for pinned area icons', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const created = await store.createPinnedArea('👩🏽‍💻 research', 'session-a', refs)
    const areaId = created.state.pinnedAreas?.[0]?.id ?? ''
    expect(created.state.pinnedAreas?.[0]?.icon).toBe('👩🏽‍💻')

    const updated = await store.updatePinnedAreaIcon(areaId, '🏳️‍🌈 release', refs)
    expect(updated.state.pinnedAreas?.[0]?.icon).toBe('🏳️‍🌈')

    const reloaded = new SidebarStateStore(sidebarStatePath)
    const reloadedState = await reloaded.init(refs)
    expect(reloadedState.state.pinnedAreas?.[0]?.icon).toBe('🏳️‍🌈')
  })

  it('prunes deleted pinned sessions from pinned areas after session cleanup', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const created = await store.createPinnedArea('⭐', 'session-a', refs)
    const areaId = created.state.pinnedAreas?.[0]?.id ?? ''
    await store.pinSession('session-c', areaId, refs)

    const pruned = await store.prune(refs.filter((session) => session.id !== 'session-a'))
    expect(pruned.state.pinnedAreas?.map((area) => area.sessionIds)).toEqual([['session-c']])
  })

  it('persists the last active session and prunes it after deletion', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const remembered = await store.rememberActiveSession('session-b', refs)
    expect(remembered.state.lastActiveSessionId).toBe('session-b')

    const reloaded = new SidebarStateStore(sidebarStatePath)
    const reloadedState = await reloaded.init(refs)
    expect(reloadedState.state.lastActiveSessionId).toBe('session-b')

    const pruned = await reloaded.prune(
      refs.filter((session) => session.id !== 'session-b'),
    )
    expect(pruned.state.lastActiveSessionId).toBeNull()
  })

  it('closing a project removes its pinned chats and tracks the closed folder', async () => {
    const { refs, projectAlpha } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const created = await store.createPinnedArea('⭐', 'session-a', refs)
    const areaId = created.state.pinnedAreas?.[0]?.id ?? ''
    await store.pinSession('session-c', areaId, refs)

    const closed = await store.closeProject(projectAlpha, refs)

    expect(closed.state.pinnedAreas?.map((area) => area.sessionIds)).toEqual([['session-c']])
    expect(closed.state.closedProjectPaths).toEqual([
      normalizeStoredSidebarProjectPath(projectAlpha),
    ])
    expect(closed.state.projectPaths).toEqual([
      normalizeStoredSidebarProjectPath(projectAlpha),
      normalizeStoredSidebarProjectPath(refs[2]!.workingDirectory),
    ])
  })

  it('reopening a project restores visibility without restoring old pins', async () => {
    const { refs, projectAlpha } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)

    await store.init(refs)
    const created = await store.createPinnedArea('⭐', 'session-a', refs)
    const areaId = created.state.pinnedAreas?.[0]?.id ?? ''
    await store.pinSession('session-c', areaId, refs)
    await store.closeProject(projectAlpha, refs)

    const reopened = await store.reopenProject(projectAlpha, refs)

    expect(reopened.state.closedProjectPaths).toEqual([])
    expect(reopened.state.pinnedAreas?.map((area) => area.sessionIds)).toEqual([['session-c']])
    expect(reopened.state.projectPaths).toEqual([
      normalizeStoredSidebarProjectPath(projectAlpha),
      normalizeStoredSidebarProjectPath(refs[2]!.workingDirectory),
    ])
  })

  it('ignores legacy pinned ids and prunes stale pinned area ids on initialization', async () => {
    const { refs, projectAlpha } = buildSessionRefs()

    await fs.writeFile(
      sidebarStatePath,
      JSON.stringify({
        pinnedSessionIds: ['session-a', 'missing-session', 'session-a', ''],
        pinnedAreas: [
          {
            id: 'area-1',
            icon: '🔥',
            collapsed: true,
            sessionIds: ['session-a', 'missing-session', 'session-a', ''],
          },
        ],
        closedProjectPaths: [
          projectAlpha,
          `${projectAlpha}/`,
          path.join(tempDir, 'missing-project'),
          '',
        ],
        projectPaths: [
          projectAlpha,
          `${projectAlpha}/`,
          path.join(tempDir, 'missing-project'),
          '',
        ],
      }),
      'utf-8',
    )

    const store = new SidebarStateStore(sidebarStatePath)
    const initialized = await store.init(refs)

    expect(initialized.state).toEqual({
      pinnedSessionIds: [],
      pinnedAreas: [
        {
          id: 'area-1',
          icon: '🔥',
          collapsed: true,
          sessionIds: ['session-a'],
        },
      ],
      followUpSessionIds: [],
      closedProjectPaths: [normalizeStoredSidebarProjectPath(projectAlpha)],
      projectPaths: [
        normalizeStoredSidebarProjectPath(projectAlpha),
        normalizeStoredSidebarProjectPath(refs[2]!.workingDirectory),
      ],
      sessionOrderOverrides: {},
      projectOrderOverrides: {},
      lastActiveSessionId: null,
    })
  })

  it('persists per-session order overrides and clears them individually', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)
    await store.init(refs)

    const set = await store.setSessionOrder('session-a', 2, refs)
    expect(set.state.sessionOrderOverrides).toEqual({ 'session-a': 2 })

    const updated = await store.setSessionOrder('session-b', 0, refs)
    expect(updated.state.sessionOrderOverrides).toEqual({
      'session-a': 2,
      'session-b': 0,
    })

    const cleared = await store.clearSessionOrder('session-a', refs)
    expect(cleared.state.sessionOrderOverrides).toEqual({ 'session-b': 0 })

    // Persistence round-trip
    const reloaded = new SidebarStateStore(sidebarStatePath)
    const reloadedState = await reloaded.init(refs)
    expect(reloadedState.state.sessionOrderOverrides).toEqual({ 'session-b': 0 })
  })

  it('persists per-project order overrides keyed by normalized path', async () => {
    const { refs, projectAlpha, projectBeta } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)
    await store.init(refs)

    const set = await store.setProjectOrder(`${projectAlpha}/`, 1, refs)
    expect(set.state.projectOrderOverrides).toEqual({
      [normalizeStoredSidebarProjectPath(projectAlpha)]: 1,
    })

    const both = await store.setProjectOrder(projectBeta, 0, refs)
    expect(both.state.projectOrderOverrides).toEqual({
      [normalizeStoredSidebarProjectPath(projectAlpha)]: 1,
      [normalizeStoredSidebarProjectPath(projectBeta)]: 0,
    })

    const cleared = await store.clearProjectOrder(projectAlpha, refs)
    expect(cleared.state.projectOrderOverrides).toEqual({
      [normalizeStoredSidebarProjectPath(projectBeta)]: 0,
    })
  })

  it('drops session and project order overrides for items that are no longer present', async () => {
    const { refs, projectAlpha } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)
    await store.init(refs)
    await store.setSessionOrder('session-a', 1, refs)
    await store.setProjectOrder(projectAlpha, 0, refs)

    // Drop session-a and the entire alpha project (its sessions)
    const remainingRefs = refs.filter((entry) => entry.id === 'session-c')
    const pruned = await store.prune(remainingRefs)

    expect(pruned.state.sessionOrderOverrides).toEqual({})
    expect(pruned.state.projectOrderOverrides).toEqual({})
  })

  it('rejects session order overrides for unknown session ids', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)
    await store.init(refs)

    const result = await store.setSessionOrder('not-a-real-session', 5, refs)
    expect(result.state.sessionOrderOverrides).toEqual({})
  })

  it('clamps negative or non-finite session order overrides to a sane index', async () => {
    const { refs } = buildSessionRefs()
    const store = new SidebarStateStore(sidebarStatePath)
    await store.init(refs)

    const negative = await store.setSessionOrder('session-a', -3, refs)
    expect(negative.state.sessionOrderOverrides).toEqual({ 'session-a': 0 })

    const nan = await store.setSessionOrder('session-b', Number.NaN, refs)
    expect(nan.state.sessionOrderOverrides).toEqual({
      'session-a': 0,
      'session-b': 0,
    })
  })
})
