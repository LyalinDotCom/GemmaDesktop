export interface SessionTag {
  id: string
  emoji: string
  name: string
}

export const MAX_SESSION_TAGS_PER_SESSION = 12
export const MAX_SESSION_TAG_NAME_LENGTH = 48
export const MAX_SESSION_TAG_EMOJI_LENGTH = 12

const EMOJI_FALLBACK = '⭐'

function toDisplayEmoji(rawEmoji: unknown): string {
  if (typeof rawEmoji !== 'string') {
    return EMOJI_FALLBACK
  }

  const trimmed = rawEmoji.trim()
  if (!trimmed) {
    return EMOJI_FALLBACK
  }

  const clamped = Array.from(trimmed).slice(0, MAX_SESSION_TAG_EMOJI_LENGTH).join('')
  return clamped.length > 0 ? clamped : EMOJI_FALLBACK
}

function toTrimmedName(rawName: unknown, fallback: string): string {
  if (typeof rawName !== 'string') {
    return fallback
  }

  const trimmed = rawName.trim()
  if (!trimmed) {
    return fallback
  }

  return trimmed.length > MAX_SESSION_TAG_NAME_LENGTH
    ? trimmed.slice(0, MAX_SESSION_TAG_NAME_LENGTH)
    : trimmed
}

function toTagId(rawId: unknown): string {
  if (typeof rawId === 'string' && rawId.trim().length > 0) {
    return rawId.trim()
  }

  const randomSegment = Math.random().toString(36).slice(2, 10)
  const timeSegment = Date.now().toString(36)
  return `tag-${timeSegment}-${randomSegment}`
}

export function normalizeSessionTag(input: unknown): SessionTag | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const record = input as Record<string, unknown>
  const emoji = toDisplayEmoji(record.emoji)
  const name = toTrimmedName(record.name, emoji)
  const id = toTagId(record.id)

  return { id, emoji, name }
}

export function normalizeSessionTags(input: unknown): SessionTag[] {
  if (!Array.isArray(input)) {
    return []
  }

  const seenIds = new Set<string>()
  const tags: SessionTag[] = []

  for (const entry of input) {
    const tag = normalizeSessionTag(entry)
    if (!tag || seenIds.has(tag.id)) {
      continue
    }

    seenIds.add(tag.id)
    tags.push(tag)

    if (tags.length >= MAX_SESSION_TAGS_PER_SESSION) {
      break
    }
  }

  return tags
}

export function sessionTagsEqual(
  left: readonly SessionTag[] | null | undefined,
  right: readonly SessionTag[] | null | undefined,
): boolean {
  const a = left ?? []
  const b = right ?? []
  if (a.length !== b.length) {
    return false
  }

  for (let index = 0; index < a.length; index += 1) {
    const lhs = a[index]
    const rhs = b[index]
    if (!lhs || !rhs) {
      return false
    }
    if (
      lhs.id !== rhs.id
      || lhs.emoji !== rhs.emoji
      || lhs.name !== rhs.name
    ) {
      return false
    }
  }

  return true
}
