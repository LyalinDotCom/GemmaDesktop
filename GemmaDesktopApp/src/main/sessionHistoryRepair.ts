import type {
  ContentPart,
  SessionMessage,
  SessionSnapshot,
} from '@gemma-desktop/sdk-core'
import {
  findMissingAppUserMessages,
  type SessionDetailMessage,
} from './sessionMessages'

function buildSdkUserDetailMessages(
  snapshot: SessionSnapshot,
): SessionDetailMessage[] {
  return snapshot.history
    .filter((message) => message.role === 'user')
    .map((message) => ({
      id: message.id,
      role: message.role,
      timestamp: new Date(message.createdAt).getTime(),
      content: message.content.map((part) => {
        if (part.type === 'text') {
          return {
            type: 'text',
            text: part.text,
          }
        }

        return {
          type: part.type,
          url: part.url,
          mediaType: part.mediaType,
        }
      }),
    }))
}

function buildRecoveredUserContentParts(
  message: SessionDetailMessage,
): ContentPart[] {
  const parts: ContentPart[] = []

  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text.length > 0) {
        parts.push({
          type: 'text',
          text,
        })
      }
      continue
    }

    if (
      (block.type === 'image' || block.type === 'image_url')
      && typeof block.url === 'string'
    ) {
      parts.push({
        type: 'image_url',
        url: block.url,
        mediaType:
          typeof block.mediaType === 'string' ? block.mediaType : undefined,
      })
      continue
    }

    if (
      (block.type === 'audio' || block.type === 'audio_url')
      && typeof block.url === 'string'
    ) {
      parts.push({
        type: 'audio_url',
        url: block.url,
        mediaType:
          typeof block.mediaType === 'string' ? block.mediaType : undefined,
      })
      continue
    }

    if (
      (block.type === 'video' || block.type === 'video_url')
      && typeof block.url === 'string'
    ) {
      parts.push({
        type: 'video_url',
        url: block.url,
        mediaType:
          typeof block.mediaType === 'string' ? block.mediaType : undefined,
      })
      continue
    }

    if (
      (block.type === 'pdf' || block.type === 'pdf_url')
      && typeof block.url === 'string'
    ) {
      parts.push({
        type: 'pdf_url',
        url: block.url,
        mediaType:
          typeof block.mediaType === 'string' ? block.mediaType : undefined,
      })
    }
  }

  return parts
}

export function restoreMissingUserHistoryFromAppMessages(
  snapshot: SessionSnapshot,
  appMessages: SessionDetailMessage[] = [],
): SessionSnapshot {
  if (appMessages.length === 0) {
    return snapshot
  }

  const missingUserMessages = findMissingAppUserMessages(
    buildSdkUserDetailMessages(snapshot),
    appMessages,
  )
  if (missingUserMessages.length === 0) {
    return snapshot
  }

  const recoveredMessages: SessionMessage[] = []
  for (const message of missingUserMessages) {
    const content = buildRecoveredUserContentParts(message)
    if (content.length === 0) {
      continue
    }

    recoveredMessages.push({
      id: message.id,
      role: 'user',
      content,
      createdAt: new Date(message.timestamp).toISOString(),
    })
  }

  if (recoveredMessages.length === 0) {
    return snapshot
  }

  return {
    ...snapshot,
    history: [...snapshot.history, ...recoveredMessages].sort(
      (left, right) =>
        new Date(left.createdAt).getTime()
        - new Date(right.createdAt).getTime(),
    ),
    savedAt: new Date().toISOString(),
  }
}
