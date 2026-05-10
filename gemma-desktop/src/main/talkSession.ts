import path from 'path'
import fs from 'fs/promises'
import {
  GLOBAL_CHAT_FALLBACK_SESSION_ID,
  GLOBAL_CHAT_LABEL,
} from '../shared/globalChat'

export const TALK_SESSION_ID = GLOBAL_CHAT_FALLBACK_SESSION_ID
export const TALK_SESSION_TITLE = GLOBAL_CHAT_LABEL
export const TALK_SESSION_RUNTIME_ID = 'ollama-native'
export const GLOBAL_SESSION_STATE_DIRECTORY_NAME = 'global-session-state'
export const TALK_SESSION_DIRECTORY_NAME = 'talk'
export const TALK_SESSION_CONVERSATIONS_DIRECTORY_NAME = 'conversations'
export const TALK_SESSION_INDEX_FILE_NAME = 'index.json'
export const TALK_SESSION_FILE_NAME = 'session.json'
export const TALK_WORKSPACE_DIRECTORY_NAME = 'workspace'

export type AppSessionSurface = 'default' | 'talk'
export type AppSessionVisibility = 'visible' | 'hidden'
export type AppSessionStorageScope = 'project' | 'global'

export function normalizeAppSessionSurface(value: unknown): AppSessionSurface {
  return value === 'talk' ? 'talk' : 'default'
}

export function normalizeAppSessionVisibility(value: unknown): AppSessionVisibility {
  return value === 'hidden' ? 'hidden' : 'visible'
}

export function normalizeAppSessionStorageScope(value: unknown): AppSessionStorageScope {
  return value === 'global' ? 'global' : 'project'
}

export function isTalkSessionSurface(value: unknown): boolean {
  return normalizeAppSessionSurface(value) === 'talk'
}

export function isTalkSessionId(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }

  const normalized = value.trim()
  return normalized === TALK_SESSION_ID
    || /^talk-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(normalized)
}

export function isHiddenSessionVisibility(value: unknown): boolean {
  return normalizeAppSessionVisibility(value) === 'hidden'
}

export function isGlobalSessionStorageScope(value: unknown): boolean {
  return normalizeAppSessionStorageScope(value) === 'global'
}

export function getGlobalSessionStateDirectory(userDataPath: string): string {
  return path.join(
    path.resolve(userDataPath),
    GLOBAL_SESSION_STATE_DIRECTORY_NAME,
  )
}

export function getTalkSessionStorageDirectory(userDataPath: string): string {
  return path.join(
    getGlobalSessionStateDirectory(userDataPath),
    TALK_SESSION_DIRECTORY_NAME,
  )
}

export function getTalkSessionIndexFilePath(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_SESSION_INDEX_FILE_NAME,
  )
}

export function getTalkSessionConversationsDirectory(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_SESSION_CONVERSATIONS_DIRECTORY_NAME,
  )
}

export function getTalkSessionConversationStorageDirectory(
  userDataPath: string,
  sessionId: string,
): string {
  return path.join(
    getTalkSessionConversationsDirectory(userDataPath),
    sessionId,
  )
}

export function getTalkSessionFilePath(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_SESSION_FILE_NAME,
  )
}

export function getTalkSessionConversationFilePath(
  userDataPath: string,
  sessionId: string,
): string {
  return path.join(
    getTalkSessionConversationStorageDirectory(userDataPath, sessionId),
    TALK_SESSION_FILE_NAME,
  )
}

export function getTalkSessionWorkspaceDirectory(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_WORKSPACE_DIRECTORY_NAME,
  )
}

export function getTalkSessionConversationWorkspaceDirectory(
  userDataPath: string,
  sessionId: string,
): string {
  return path.join(
    getTalkSessionConversationStorageDirectory(userDataPath, sessionId),
    TALK_WORKSPACE_DIRECTORY_NAME,
  )
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath)
    return true
  } catch {
    return false
  }
}

export async function listTalkSessionConversationFilePaths(
  userDataPath: string,
): Promise<string[]> {
  const conversationsDirectory = getTalkSessionConversationsDirectory(userDataPath)

  let entries
  try {
    entries = await fs.readdir(conversationsDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const sessionFilePaths: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isTalkSessionId(entry.name)) {
      continue
    }

    const sessionFilePath = getTalkSessionConversationFilePath(
      userDataPath,
      entry.name,
    )
    if (await pathExists(sessionFilePath)) {
      sessionFilePaths.push(sessionFilePath)
    }
  }

  return sessionFilePaths.sort()
}
