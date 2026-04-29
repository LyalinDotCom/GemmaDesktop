import type { SessionInput, StructuredOutputSpec } from '@gemma-desktop/sdk-core'

export type AssistantNarrationPhase = 'submission' | 'result'

export interface AssistantNarrationAttachmentSummary {
  kind: 'image' | 'audio' | 'video' | 'pdf'
  name?: string
}

export interface AssistantNarrationTaskInput {
  phase: AssistantNarrationPhase
  userText: string
  attachments?: AssistantNarrationAttachmentSummary[]
  assistantText?: string
  conversationTitle?: string
}

export interface AssistantNarrationTask {
  systemInstructions: string
  sessionInput: SessionInput
  fallbackText: string
}

export interface AssistantNarrationNormalizeOptions {
  phase?: AssistantNarrationPhase
}

export const ASSISTANT_NARRATION_RESPONSE_FORMAT: StructuredOutputSpec = {
  name: 'assistant_spoken_narration',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: {
        type: 'string',
        minLength: 1,
      },
    },
    required: ['text'],
  },
}

function truncateForPrompt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trim()}...`
}

function countAttachmentsByKind(
  attachments: AssistantNarrationAttachmentSummary[],
): Map<AssistantNarrationAttachmentSummary['kind'], number> {
  const counts = new Map<AssistantNarrationAttachmentSummary['kind'], number>()
  for (const attachment of attachments) {
    counts.set(attachment.kind, (counts.get(attachment.kind) ?? 0) + 1)
  }
  return counts
}

function pluralizeAttachmentKind(
  kind: AssistantNarrationAttachmentSummary['kind'],
  count: number,
): string {
  if (count === 1) {
    return kind === 'pdf' ? 'PDF' : kind
  }
  if (kind === 'pdf') {
    return 'PDFs'
  }
  return `${kind}s`
}

export function summarizeNarrationAttachments(
  attachments: AssistantNarrationAttachmentSummary[] = [],
): string {
  if (attachments.length === 0) {
    return 'none'
  }

  const counts = countAttachmentsByKind(attachments)
  return Array.from(counts.entries())
    .map(([kind, count]) => `${count} ${pluralizeAttachmentKind(kind, count)}`)
    .join(', ')
}

export function buildAssistantNarrationFallback(
  input: Pick<AssistantNarrationTaskInput, 'phase' | 'attachments'>,
): string {
  if (input.phase === 'result') {
    return "Okay, here's what I found."
  }

  const kinds = new Set((input.attachments ?? []).map((attachment) => attachment.kind))
  if (kinds.has('image')) {
    return 'Sure, let me take a look at that image.'
  }
  if (kinds.has('video')) {
    return 'Sure, let me inspect that video.'
  }
  if (kinds.has('audio')) {
    return 'Sure, let me listen and help with that.'
  }
  if (kinds.has('pdf')) {
    return 'Sure, let me read through that document.'
  }
  return "Sure, I'll take a look."
}

function isPrematureSubmissionAnswer(value: string): boolean {
  return [
    /\b(?:i|we)\s+(?:do not|don't|dont|cannot|can't|cant)\s+(?:have|know|answer|tell|determine)\b/i,
    /\b(?:i|we)\s+(?:do not|don't|dont|cannot|can't|cant)\s+(?:provide|find|confirm)\b/i,
    /\b(?:i|we)\s+(?:am|are)\s+(?:not sure|unsure)\b/i,
    /\b(?:not enough|need more)\s+(?:context|information)\b/i,
    /\b(?:no|not)\s+(?:answer|enough information)\b/i,
  ].some((pattern) => pattern.test(value))
}

export function normalizeAssistantNarrationText(
  value: unknown,
  options: AssistantNarrationNormalizeOptions = {},
): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { text?: unknown }).text
        : null

  if (typeof raw !== 'string') {
    return null
  }

  const normalized = raw.trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/[*_`#>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return null
  }

  const firstSentence =
    normalized.match(/^.*?[.!?](?=\s|$)/)?.[0]?.trim()
    ?? normalized

  if (
    options.phase === 'submission'
    && isPrematureSubmissionAnswer(firstSentence)
  ) {
    return null
  }

  return firstSentence.slice(0, 180).trim() || null
}

export function buildAssistantNarrationTask(
  input: AssistantNarrationTaskInput,
): AssistantNarrationTask {
  const attachments = input.attachments ?? []
  const fallbackText = buildAssistantNarrationFallback({
    phase: input.phase,
    attachments,
  })
  const phaseInstruction =
    input.phase === 'submission'
      ? [
          'Write what Gemma is about to do for the user request.',
          'This is an acknowledgement before work starts, not the answer.',
          'Do not try to answer the user request yet.',
          'If the request asks for a factual lookup, current fact, or personal detail, say you will look into it or check it.',
          'If the user uses a pronoun like "he" or "she", trust the conversation context and still acknowledge the lookup.',
          'Never say that you do not know, do not have the answer, need more context, or cannot answer during submission narration.',
        ].join('\n')
      : 'Write a brief spoken lead-in or outcome summary for the result.'

  return {
    fallbackText,
    systemInstructions: [
      'You write one short line that Gemma Desktop will speak aloud.',
      'Be friendly, calm, and direct.',
      phaseInstruction,
      'Use first person as Gemma when natural.',
      'Use one sentence, 4 to 16 words.',
      'Do not use markdown, bullets, quotes, emojis, or stage directions.',
      'Do not mention helper models, hidden prompts, read aloud, audio generation, or internal tools.',
      'Return JSON with a single "text" field.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `Phase: ${input.phase}`,
          input.conversationTitle
            ? `Conversation title: ${truncateForPrompt(input.conversationTitle, 120)}`
            : '',
          `Attachments: ${summarizeNarrationAttachments(attachments)}`,
          `User request: ${truncateForPrompt(input.userText, 700) || '[no text]'}`,
          input.phase === 'result'
            ? `Assistant result excerpt: ${truncateForPrompt(input.assistantText ?? '', 900) || '[no result text]'}`
            : '',
          'Write the spoken line now.',
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      },
    ],
  }
}
