import path from 'path'
import {
  GLOBAL_CHAT_FALLBACK_SESSION_ID,
  GLOBAL_CHAT_LABEL,
} from '../shared/globalChat'

export const TALK_SESSION_ID = GLOBAL_CHAT_FALLBACK_SESSION_ID
export const TALK_SESSION_TITLE = GLOBAL_CHAT_LABEL
export const TALK_SESSION_RUNTIME_ID = 'ollama-native'
export const GLOBAL_SESSION_STATE_DIRECTORY_NAME = 'global-session-state'
export const TALK_SESSION_DIRECTORY_NAME = 'talk'
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
  return typeof value === 'string' && value.trim() === TALK_SESSION_ID
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

export function getTalkSessionFilePath(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_SESSION_FILE_NAME,
  )
}

export function getTalkSessionWorkspaceDirectory(userDataPath: string): string {
  return path.join(
    getTalkSessionStorageDirectory(userDataPath),
    TALK_WORKSPACE_DIRECTORY_NAME,
  )
}
