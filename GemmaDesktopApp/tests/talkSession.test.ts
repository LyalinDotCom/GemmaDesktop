import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  TALK_SESSION_ID,
  getGlobalSessionStateDirectory,
  getTalkSessionConversationFilePath,
  getTalkSessionConversationStorageDirectory,
  getTalkSessionConversationWorkspaceDirectory,
  getTalkSessionConversationsDirectory,
  getTalkSessionFilePath,
  getTalkSessionIndexFilePath,
  getTalkSessionStorageDirectory,
  getTalkSessionWorkspaceDirectory,
  isGlobalSessionStorageScope,
  isHiddenSessionVisibility,
  isTalkSessionId,
  isTalkSessionSurface,
  normalizeAppSessionStorageScope,
  normalizeAppSessionSurface,
  normalizeAppSessionVisibility,
} from '../src/main/talkSession'

describe('talk session helpers', () => {
  it('builds app-global storage paths under userData', () => {
    const userDataPath = path.join(os.tmpdir(), 'gemma-desktop-talk-user-data')

    expect(getGlobalSessionStateDirectory(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state'),
    )
    expect(getTalkSessionStorageDirectory(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state', 'talk'),
    )
    expect(getTalkSessionIndexFilePath(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state', 'talk', 'index.json'),
    )
    expect(getTalkSessionFilePath(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state', 'talk', 'session.json'),
    )
    expect(getTalkSessionWorkspaceDirectory(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state', 'talk', 'workspace'),
    )
    expect(getTalkSessionConversationsDirectory(userDataPath)).toBe(
      path.join(userDataPath, 'global-session-state', 'talk', 'conversations'),
    )
    expect(getTalkSessionConversationStorageDirectory(
      userDataPath,
      'talk-00000000-0000-4000-8000-000000000000',
    )).toBe(
      path.join(
        userDataPath,
        'global-session-state',
        'talk',
        'conversations',
        'talk-00000000-0000-4000-8000-000000000000',
      ),
    )
    expect(getTalkSessionConversationFilePath(
      userDataPath,
      'talk-00000000-0000-4000-8000-000000000000',
    )).toBe(
      path.join(
        userDataPath,
        'global-session-state',
        'talk',
        'conversations',
        'talk-00000000-0000-4000-8000-000000000000',
        'session.json',
      ),
    )
    expect(getTalkSessionConversationWorkspaceDirectory(
      userDataPath,
      'talk-00000000-0000-4000-8000-000000000000',
    )).toBe(
      path.join(
        userDataPath,
        'global-session-state',
        'talk',
        'conversations',
        'talk-00000000-0000-4000-8000-000000000000',
        'workspace',
      ),
    )
  })

  it('normalizes talk session metadata flags safely', () => {
    expect(normalizeAppSessionSurface('talk')).toBe('talk')
    expect(normalizeAppSessionSurface('other')).toBe('default')
    expect(normalizeAppSessionVisibility('hidden')).toBe('hidden')
    expect(normalizeAppSessionVisibility('other')).toBe('visible')
    expect(normalizeAppSessionStorageScope('global')).toBe('global')
    expect(normalizeAppSessionStorageScope('other')).toBe('project')

    expect(isTalkSessionSurface('talk')).toBe(true)
    expect(isTalkSessionSurface('default')).toBe(false)
    expect(isTalkSessionId(TALK_SESSION_ID)).toBe(true)
    expect(isTalkSessionId('talk-00000000-0000-4000-8000-000000000000')).toBe(true)
    expect(isTalkSessionId('regular-session')).toBe(false)
    expect(isHiddenSessionVisibility('hidden')).toBe(true)
    expect(isHiddenSessionVisibility('visible')).toBe(false)
    expect(isGlobalSessionStorageScope('global')).toBe(true)
    expect(isGlobalSessionStorageScope('project')).toBe(false)
  })
})
