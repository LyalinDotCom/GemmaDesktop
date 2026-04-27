import { useMemo } from 'react'
import type { ChatMessage, MessageContent, SessionDetail } from '@/types'

/**
 * Timestamp at which this app run started. Captured at module load so it
 * resets every time the app restarts. Session touch tracking only considers
 * tool calls with message timestamps >= this cutoff so old tool calls that
 * happened in previous runs (before the app was relaunched) don't polluate
 * the Files panel. This matches the product spec: "changes during the
 * session, until the conversation is closed or until the app restarts."
 */
const APP_STARTED_AT = Date.now()

export type SessionTouchAction = 'created' | 'modified' | 'read'

export interface SessionTouchEntry {
  relativePath: string
  action: SessionTouchAction
  lastAt: number
  count: number
}

export interface SessionTouchMap {
  byPath: Map<string, SessionTouchEntry>
  changedCount: number
  readCount: number
}

const WRITE_TOOLS = new Set(['Write'])
const MODIFY_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read'])

const FILE_PATH_INPUT_KEYS = ['file_path', 'notebook_path', 'filePath', 'path']

function pickStringField(
  input: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function toRelativePath(absoluteOrRelative: string, rootPath: string): string | null {
  const trimmed = absoluteOrRelative.trim()
  if (trimmed.length === 0) {
    return null
  }

  const normalizedRoot = rootPath.replace(/\/+$/, '')
  if (!normalizedRoot) {
    return trimmed.replace(/^\.\/+/, '')
  }

  if (trimmed === normalizedRoot) {
    return ''
  }

  const prefix = `${normalizedRoot}/`
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length)
  }

  // Already relative
  if (!trimmed.startsWith('/')) {
    return trimmed.replace(/^\.\/+/, '')
  }

  // Absolute path outside the root — ignore
  return null
}

function recordTouch(
  map: Map<string, SessionTouchEntry>,
  relativePath: string,
  action: SessionTouchAction,
  timestamp: number,
) {
  if (!relativePath) {
    return
  }

  const existing = map.get(relativePath)
  if (!existing) {
    map.set(relativePath, {
      relativePath,
      action,
      lastAt: timestamp,
      count: 1,
    })
    return
  }

  existing.count += 1
  existing.lastAt = Math.max(existing.lastAt, timestamp)

  // Upgrade action: read < modified < created. Once "created" or "modified", we don't downgrade.
  if (existing.action === 'read' && action !== 'read') {
    existing.action = action
  } else if (action === 'created' && existing.action === 'modified') {
    existing.action = 'created'
  }
}

function visitToolCallBlock(
  block: Extract<MessageContent, { type: 'tool_call' }>,
  rootPath: string,
  timestamp: number,
  map: Map<string, SessionTouchEntry>,
) {
  const { toolName, input, worker, status } = block
  if (status === 'error') {
    return
  }

  const rawPath = pickStringField(
    input ?? {},
    FILE_PATH_INPUT_KEYS,
  )
  if (rawPath) {
    const rel = toRelativePath(rawPath, rootPath)
    if (rel !== null && rel.length > 0) {
      if (WRITE_TOOLS.has(toolName)) {
        recordTouch(map, rel, 'created', timestamp)
      } else if (MODIFY_TOOLS.has(toolName)) {
        recordTouch(map, rel, 'modified', timestamp)
      } else if (READ_TOOLS.has(toolName)) {
        recordTouch(map, rel, 'read', timestamp)
      }
    }
  }

  const filesChanged = worker?.resultData?.filesChanged
  if (Array.isArray(filesChanged)) {
    for (const entry of filesChanged) {
      if (typeof entry !== 'string') continue
      const rel = toRelativePath(entry, rootPath)
      if (rel !== null && rel.length > 0) {
        recordTouch(map, rel, 'modified', timestamp)
      }
    }
  }
}

function visitFileEditBlock(
  block: Extract<MessageContent, { type: 'file_edit' }>,
  rootPath: string,
  timestamp: number,
  map: Map<string, SessionTouchEntry>,
) {
  const rel = toRelativePath(block.path, rootPath)
  if (rel === null || rel.length === 0) {
    return
  }

  recordTouch(
    map,
    rel,
    block.changeType === 'created' ? 'created' : 'modified',
    timestamp,
  )
}

function visitMessage(
  message: ChatMessage,
  rootPath: string,
  map: Map<string, SessionTouchEntry>,
) {
  // Skip messages from before this app run so restored conversation history
  // doesn't count as "this session". Small tolerance window in case the
  // message timestamp is slightly earlier due to clock skew / batched writes.
  if (message.timestamp < APP_STARTED_AT - 1000) {
    return
  }
  for (const block of message.content) {
    if (block.type === 'tool_call') {
      visitToolCallBlock(block, rootPath, message.timestamp, map)
    } else if (block.type === 'file_edit') {
      visitFileEditBlock(block, rootPath, message.timestamp, map)
    }
  }
}

export function useSessionTouchedFiles(
  session: SessionDetail | null,
  rootPath: string | null,
): SessionTouchMap {
  return useMemo(() => {
    const map = new Map<string, SessionTouchEntry>()
    const normalizedRoot = (rootPath ?? session?.workingDirectory ?? '').trim()

    if (!session || !normalizedRoot) {
      return { byPath: map, changedCount: 0, readCount: 0 }
    }

    for (const message of session.messages) {
      visitMessage(message, normalizedRoot, map)
    }

    // Also scan streaming tool_call blocks if present
    const streaming = session.streamingContent
    if (Array.isArray(streaming)) {
      const now = Date.now()
      for (const block of streaming) {
        if (block.type === 'tool_call') {
          visitToolCallBlock(block, normalizedRoot, now, map)
        } else if (block.type === 'file_edit') {
          visitFileEditBlock(block, normalizedRoot, now, map)
        }
      }
    }

    let changedCount = 0
    let readCount = 0
    for (const entry of map.values()) {
      if (entry.action === 'read') {
        readCount += 1
      } else {
        changedCount += 1
      }
    }

    return { byPath: map, changedCount, readCount }
  }, [session, rootPath])
}
