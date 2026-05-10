import type { SessionSearchResult } from '../shared/sessionSearch'

export interface SessionSearchTerm {
  value: string
  exact: boolean
}

export interface SearchableSessionMessage {
  content: Array<Record<string, unknown>>
}

export interface SearchableSessionRecord {
  sessionId: string
  title: string
  workingDirectory: string
  conversationKind: 'normal' | 'research'
  updatedAt: number
  messages: SearchableSessionMessage[]
}

function normalizeSearchableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stringifySearchValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  if (value == null || typeof value === 'boolean') {
    return ''
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifySearchValue(entry))
      .filter((entry) => entry.length > 0)
      .join('\n')
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractTextLines(block: Record<string, unknown>): string[] {
  switch (block.type) {
    case 'text':
      return [stringifySearchValue(block.text)]
    case 'code':
      return [
        stringifySearchValue(block.filename),
        stringifySearchValue(block.code),
      ]
    case 'diff':
      return [
        stringifySearchValue(block.filename),
        stringifySearchValue(block.diff),
      ]
    case 'file_edit':
      return [
        stringifySearchValue(block.path),
        stringifySearchValue(block.changeType),
        stringifySearchValue(block.diff),
      ]
    case 'file_excerpt':
      return [
        stringifySearchValue(block.filename),
        stringifySearchValue(block.content),
      ]
    case 'shell_session':
      return [stringifySearchValue(block.transcript)]
    case 'warning':
      return [stringifySearchValue(block.message)]
    case 'error':
      return [
        stringifySearchValue(block.message),
        stringifySearchValue(block.details),
      ]
    case 'tool_call': {
      const worker =
        block.worker && typeof block.worker === 'object'
          ? block.worker as Record<string, unknown>
          : null

      return [
        stringifySearchValue(block.summary),
        stringifySearchValue(block.output),
        stringifySearchValue(worker?.goal),
        stringifySearchValue(worker?.resultSummary),
      ]
    }
    default:
      return []
  }
}

export function flattenSearchableContentBlocks(
  blocks: Array<Record<string, unknown>>,
): string {
  const sections = blocks
    .flatMap((block) => extractTextLines(block))
    .map((entry) => normalizeSearchableText(entry))
    .filter((entry) => entry.length > 0)

  return sections.join('\n\n')
}

export function buildSearchableTranscript(
  messages: SearchableSessionMessage[],
): string {
  const sections = messages
    .map((message) => flattenSearchableContentBlocks(message.content))
    .filter((entry) => entry.length > 0)

  return normalizeSearchableText(sections.join('\n\n'))
}

export function parseSessionSearchQuery(query: string): SessionSearchTerm[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return []
  }

  const terms: SessionSearchTerm[] = []
  let cursor = 0

  while (cursor < trimmed.length) {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor] ?? '')) {
      cursor += 1
    }

    if (cursor >= trimmed.length) {
      break
    }

    const startChar = trimmed[cursor]
    if (startChar === '"' || startChar === '\'') {
      const quote = startChar
      cursor += 1
      const start = cursor

      while (cursor < trimmed.length && trimmed[cursor] !== quote) {
        cursor += 1
      }

      const value = normalizeSearchableText(trimmed.slice(start, cursor))
      if (value.length > 0) {
        terms.push({ value, exact: true })
      }

      if (trimmed[cursor] === quote) {
        cursor += 1
      }

      continue
    }

    const start = cursor
    while (cursor < trimmed.length && !/\s/.test(trimmed[cursor] ?? '')) {
      cursor += 1
    }

    const value = normalizeSearchableText(trimmed.slice(start, cursor))
    if (value.length > 0) {
      terms.push({ value, exact: false })
    }
  }

  return terms
}

function findFirstMatchIndex(
  normalizedText: string,
  normalizedTerms: SessionSearchTerm[],
): number {
  const searchText = normalizedText.toLowerCase()
  let bestIndex = Number.POSITIVE_INFINITY

  for (const term of normalizedTerms) {
    const nextIndex = searchText.indexOf(term.value.toLowerCase())
    if (nextIndex >= 0 && nextIndex < bestIndex) {
      bestIndex = nextIndex
    }
  }

  return Number.isFinite(bestIndex) ? bestIndex : -1
}

function matchesAllTerms(
  normalizedText: string,
  normalizedTerms: SessionSearchTerm[],
): boolean {
  const searchText = normalizedText.toLowerCase()

  return normalizedTerms.every((term) =>
    searchText.includes(term.value.toLowerCase()),
  )
}

export function buildSessionSearchSnippet(
  normalizedText: string,
  normalizedTerms: SessionSearchTerm[],
): string {
  if (normalizedText.length === 0 || normalizedTerms.length === 0) {
    return ''
  }

  const firstMatchIndex = findFirstMatchIndex(normalizedText, normalizedTerms)
  if (firstMatchIndex < 0) {
    return ''
  }

  const longestTermLength = Math.max(
    ...normalizedTerms.map((term) => term.value.length),
  )
  const start = Math.max(0, firstMatchIndex - 56)
  const end = Math.min(
    normalizedText.length,
    firstMatchIndex + longestTermLength + 96,
  )
  const snippet = normalizedText.slice(start, end).trim()

  if (snippet.length === 0) {
    return ''
  }

  return `${start > 0 ? '…' : ''}${snippet}${end < normalizedText.length ? '…' : ''}`
}

export function searchSessionRecords(
  records: SearchableSessionRecord[],
  query: string,
): SessionSearchResult[] {
  const normalizedTerms = parseSessionSearchQuery(query)
  if (normalizedTerms.length === 0) {
    return []
  }

  return records
    .map((record) => {
      const transcript = buildSearchableTranscript(record.messages)
      if (!matchesAllTerms(transcript, normalizedTerms)) {
        return null
      }

      return {
        sessionId: record.sessionId,
        title: record.title,
        workingDirectory: record.workingDirectory,
        conversationKind: record.conversationKind,
        updatedAt: record.updatedAt,
        snippet:
          buildSessionSearchSnippet(transcript, normalizedTerms)
          || record.title,
      } satisfies SessionSearchResult
    })
    .filter((record): record is SessionSearchResult => record !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}
