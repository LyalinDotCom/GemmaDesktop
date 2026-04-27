import type { SessionInput, StructuredOutputSpec } from '@gemma-desktop/sdk-core'

export interface ThinkingSummaryTaskInput {
  thinkingText: string
  userText?: string
  conversationTitle?: string
  turnContext?: string
}

export interface ThinkingSummaryTask {
  systemInstructions: string
  sessionInput: SessionInput
}

export const THINKING_SUMMARY_RESPONSE_FORMAT: StructuredOutputSpec = {
  name: 'thinking_summary',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        minLength: 1,
      },
    },
    required: ['summary'],
  },
}

export const MIN_THINKING_LENGTH_FOR_SUMMARY = 80

const MAX_THINKING_PROMPT_CHARS = 64000
const MAX_USER_PROMPT_CHARS = 2000
const MAX_TITLE_PROMPT_CHARS = 200
const MAX_TURN_CONTEXT_PROMPT_CHARS = 4000
const MAX_SUMMARY_OUTPUT_CHARS = 80

function clipForPrompt(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function clipFromBothEnds(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  const half = Math.floor((maxLength - 5) / 2)
  return `${normalized.slice(0, half).trimEnd()}\n…\n${normalized.slice(-half).trimStart()}`
}

export function shouldSummarizeThinking(thinkingText: string): boolean {
  const trimmed = thinkingText.trim()
  if (trimmed.length === 0) return false
  return trimmed.length >= MIN_THINKING_LENGTH_FOR_SUMMARY || trimmed.includes('\n')
}

function tryExtractSummaryFromJsonString(value: string): string | null {
  const trimmed = value.trim()
  const candidates: string[] = [trimmed]

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim())
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0]) {
    candidates.push(objectMatch[0])
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const summary = (parsed as { summary?: unknown }).summary
        if (typeof summary === 'string' && summary.trim()) {
          return summary
        }
      }
    } catch {
      // try next candidate
    }
  }

  return null
}

export function normalizeThinkingSummary(value: unknown): string | null {
  let raw: unknown =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { summary?: unknown }).summary
        : null

  if (typeof raw === 'string') {
    const fromJson = tryExtractSummaryFromJsonString(raw)
    if (fromJson) {
      raw = fromJson
    }
  }

  if (typeof raw !== 'string') {
    return null
  }

  const firstLine =
    raw
      .split(/[\n\r]/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  if (!firstLine) {
    return null
  }

  const stripped = firstLine
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/^[-•·]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？]+\s*$/, '')
    .trim()

  if (!stripped) {
    return null
  }

  return stripped.slice(0, MAX_SUMMARY_OUTPUT_CHARS).trim() || null
}

export function buildThinkingSummaryTask(
  input: ThinkingSummaryTaskInput,
): ThinkingSummaryTask {
  const thinking = clipFromBothEnds(input.thinkingText, MAX_THINKING_PROMPT_CHARS)
  const userText = clipForPrompt(input.userText ?? '', MAX_USER_PROMPT_CHARS)
  const title = clipForPrompt(input.conversationTitle ?? '', MAX_TITLE_PROMPT_CHARS)
  const turnContext = clipForPrompt(input.turnContext ?? '', MAX_TURN_CONTEXT_PROMPT_CHARS)

  return {
    systemInstructions: [
      'You write a one-line preview of what an AI assistant was thinking through internally.',
      "Read the assistant's hidden chain-of-thought and produce a short status line that names what the assistant was working on or weighing.",
      'Use the user request and completed-turn context as grounding. If they conflict with the hidden text, prefer the completed-turn context.',
      'Style: present-participle phrase, 4 to 10 words, that reads like a status indicator.',
      'Examples:',
      '- Tracing the rename across files',
      '- Weighing two refactor options',
      '- Mapping out the test coverage',
      '- Locating the bug in the parser',
      '- Reconciling the schema with the migration',
      'Rules:',
      '- Name the line of inquiry, not the conclusion or the final answer.',
      '- Be concrete about the subject; reference the actual topic when it is clear.',
      '- Prefer real files, tools, commands, queries, errors, or results from the completed-turn context over generic wording.',
      "- Do not start with words like 'Thinking', 'The assistant', 'I am', or 'Considering whether'.",
      '- No markdown, quotes, emojis, trailing punctuation, or stage directions.',
      '- One line, single phrase, capitalize only the first word.',
      'Return JSON with a single "summary" field.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          title ? `Conversation title: ${title}` : '',
          userText ? `User request: ${userText}` : '',
          turnContext ? `Completed-turn context:\n${turnContext}` : '',
          'Assistant chain-of-thought (verbatim, possibly truncated in the middle):',
          '"""',
          thinking,
          '"""',
          'Write the one-line status preview now.',
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      },
    ],
  }
}
