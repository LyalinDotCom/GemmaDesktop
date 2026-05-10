import type { MessageContent } from '@/types'

const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const INLINE_CODE_PATTERN = /`([^`]+)`/g
const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g
const LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g
const AUTOLINK_PATTERN = /<((?:https?:\/\/|mailto:)[^>]+)>/g
const BARE_URL_PATTERN = /\bhttps?:\/\/\S+/gi
const HTML_TAG_PATTERN = /<\/?[^>]+>/g
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+/gm
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s?/gm
const LIST_MARKER_PATTERN = /^\s*[-*+]\s+/gm
const ORDERED_LIST_PATTERN = /^\s*\d+\.\s+/gm
const TABLE_RULE_PATTERN = /^\s*\|?[\s:-]+\|[\s|:-]*$/gm
const EMPHASIS_PATTERN = /(\*\*|__|\*|_)(.*?)\1/g

function collapseWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function stripMarkdownForReadAloud(value: string): string {
  return collapseWhitespace(
    value
      .replace(FENCED_CODE_BLOCK_PATTERN, ' ')
      .replace(IMAGE_PATTERN, '$1')
      .replace(LINK_PATTERN, '$1')
      .replace(AUTOLINK_PATTERN, '$1')
      .replace(BARE_URL_PATTERN, ' ')
      .replace(INLINE_CODE_PATTERN, '$1')
      .replace(HTML_TAG_PATTERN, ' ')
      .replace(HEADING_PATTERN, '')
      .replace(BLOCKQUOTE_PATTERN, '')
      .replace(LIST_MARKER_PATTERN, '')
      .replace(ORDERED_LIST_PATTERN, '')
      .replace(TABLE_RULE_PATTERN, '')
      .replace(EMPHASIS_PATTERN, '$2')
      .replace(/[|]/g, ' ')
      .replace(/\[[ xX]\]\s+/g, '')
      .replace(/[ \t]+\./g, '.')
      .replace(/[ \t]+,/g, ',')
      .replace(/[ \t]+:/g, ':')
      .replace(/[ \t]+;/g, ';')
      .replace(/[ \t]+!/g, '!')
      .replace(/[ \t]+\?/g, '?'),
  )
}

export function normalizeSelectedReadAloudText(value: string): string {
  return collapseWhitespace(
    value
      .replace(/\u00a0/g, ' ')
      .replace(/\n[ \t]+/g, '\n'),
  )
}

export function buildReadAloudSelectionPlaybackId(value: string): string {
  const normalized = normalizeSelectedReadAloudText(value)
  if (normalized.length === 0) {
    return 'selection:empty'
  }

  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `selection:${normalized.length}:${(hash >>> 0).toString(16)}`
}

export function extractSpeakableTextFromContent(
  content: MessageContent[],
): string {
  const primarySections = content
    .flatMap((block) => {
      if (block.type === 'text') {
        const text = stripMarkdownForReadAloud(block.text)
        return text.length > 0 ? [text] : []
      }
      return []
    })

  if (primarySections.length > 0) {
    return primarySections.join('\n\n')
  }

  const fallbackSections = content.flatMap((block) => {
    if (block.type === 'warning') {
      const text = stripMarkdownForReadAloud(block.message)
      return text.length > 0 ? [text] : []
    }

    if (block.type === 'error') {
      const details =
        typeof block.details === 'string' && block.details.trim().length > 0
          ? block.details.trim()
          : null
      const message = block.message.trim()
      const text = stripMarkdownForReadAloud(
        details
          ? `${message}${/[.!?]$/.test(message) ? ' ' : '. '}${details}`
          : message,
      )
      return text.length > 0 ? [text] : []
    }

    return []
  })

  return fallbackSections.join('\n\n')
}
