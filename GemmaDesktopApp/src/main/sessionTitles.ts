import type { SessionInput, StructuredOutputSpec } from '@gemma-desktop/sdk-core'
import type { ConversationKind } from './tooling'

export const SESSION_TITLE_RESPONSE_FORMAT: StructuredOutputSpec = {
  name: 'session_title',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {
        type: 'string',
        minLength: 1,
      },
    },
    required: ['title'],
  },
}

export interface AutoSessionTitleTask {
  systemInstructions: string
  sessionInput: SessionInput
  fallbackMaxWords: number
}

export interface AutoSessionTitleEligibilityInput {
  conversationKind: ConversationKind
  title: string
  titleSource: 'auto' | 'user'
  placeholderTitle: string
}

export function isAutoSessionTitleReplaceable(
  input: AutoSessionTitleEligibilityInput,
): boolean {
  if (input.titleSource === 'user') {
    return false
  }

  const normalizedTitle = input.title.trim()
  if (!normalizedTitle || normalizedTitle === input.placeholderTitle) {
    return true
  }

  if (input.conversationKind === 'research') {
    return /^Research(?:\s+\d+)?$/i.test(normalizedTitle)
  }

  return false
}

export function normalizeGeneratedSessionTitle(
  value: unknown,
  maxWords?: number,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const title = typeof (value as { title?: unknown }).title === 'string'
    ? (value as { title: string }).title.trim()
    : ''

  if (!title) {
    return null
  }

  const normalized = title
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const bounded = typeof maxWords === 'number' && maxWords > 0
    ? normalized.split(' ').filter(Boolean).slice(0, maxWords).join(' ')
    : normalized

  return bounded.slice(0, 80).trim() || null
}

export function buildFallbackSessionTitle(
  promptSeed: string,
  maxWords = 6,
): string | null {
  const normalized = promptSeed
    .replace(/\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return null
  }

  const words = normalized
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)

  if (words.length === 0) {
    return null
  }

  return words
    .map((word) =>
      word.length <= 3 || /\d/.test(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ')
    .slice(0, 80)
    .trim()
    || null
}

export function buildAutoSessionTitleTask(input: {
  conversationKind: ConversationKind
  promptSeed: string
}): AutoSessionTitleTask {
  if (input.conversationKind === 'research') {
    return {
      systemInstructions: [
        'Write a short title for a Gemma Desktop deep research session.',
        'Base it on the research request.',
        'Use 3 to 5 words.',
        'Do not use quotes or trailing punctuation.',
        'Prefer concrete nouns and named subjects over vague labels like "Research" or "Update".',
      ].join('\n'),
      fallbackMaxWords: 5,
      sessionInput: [
        { type: 'text', text: [
          'Generate a short 3-5 word session title for this research request.',
          input.promptSeed,
        ].join('\n\n') },
      ],
    }
  }

  return {
    systemInstructions: [
      'Write a short conversation title for a developer chat in Gemma Desktop.',
      'Use 2 to 6 words.',
      'Do not use quotes or trailing punctuation.',
      'Prefer concrete nouns over vague labels like "Help" or "Question".',
    ].join('\n'),
    fallbackMaxWords: 6,
    sessionInput: [
      { type: 'text', text: [
        'Generate a concise session title for this first user prompt.',
        input.promptSeed,
      ].join('\n\n') },
    ],
  }
}
