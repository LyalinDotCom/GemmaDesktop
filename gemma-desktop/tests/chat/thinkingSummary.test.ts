import { describe, expect, it } from 'vitest'
import {
  buildThinkingSummaryTask,
  normalizeThinkingSummary,
  shouldSummarizeThinking,
  THINKING_SUMMARY_RESPONSE_FORMAT,
  MIN_THINKING_LENGTH_FOR_SUMMARY,
} from '../../src/shared/thinkingSummary'

function extractFirstText(
  input: ReturnType<typeof buildThinkingSummaryTask>['sessionInput'],
): string {
  if (!Array.isArray(input)) {
    return typeof input === 'string' ? input : ''
  }
  const first = input[0]
  return first?.type === 'text' ? first.text : ''
}

describe('thinking summary helper prompt', () => {
  it('asks for a short present-participle status line and returns JSON', () => {
    const task = buildThinkingSummaryTask({
      thinkingText:
        'The user wants me to rename the function getCwd to getCurrentWorkingDirectory across the project. I should grep for all usages first, then update each call site, then run tests.',
      userText: 'Rename getCwd to getCurrentWorkingDirectory',
      conversationTitle: 'Refactor pass',
      turnContext: [
        'Tool: search_text success | pattern getCwd',
        'Files changed: src/fs.ts, tests/fs.test.ts',
      ].join('\n'),
    })

    expect(task.systemInstructions).toContain('one-line preview')
    expect(task.systemInstructions).toContain('present-participle phrase')
    expect(task.systemInstructions).toContain('4 to 10 words')
    expect(task.systemInstructions).toContain('Name the line of inquiry')
    expect(task.systemInstructions).toContain('completed-turn context')
    expect(task.systemInstructions).toContain('No markdown')
    expect(task.systemInstructions).toContain('"summary" field')

    const text = extractFirstText(task.sessionInput)
    expect(text).toContain('Conversation title: Refactor pass')
    expect(text).toContain('User request: Rename getCwd to getCurrentWorkingDirectory')
    expect(text).toContain('Completed-turn context:')
    expect(text).toContain('Files changed: src/fs.ts, tests/fs.test.ts')
    expect(text).toContain('Assistant chain-of-thought')
    expect(text).toContain('Write the one-line status preview now.')
  })

  it('omits empty optional fields from the prompt body', () => {
    const task = buildThinkingSummaryTask({
      thinkingText: 'Working through whether to use a recursive solution.',
    })

    const text = extractFirstText(task.sessionInput)
    expect(text).not.toContain('Conversation title:')
    expect(text).not.toContain('User request:')
    expect(text).toContain('Assistant chain-of-thought')
  })

  it('clips very long thinking from both ends so the prompt stays bounded', () => {
    const longThinking = `START_MARKER ${'a'.repeat(80000)} END_MARKER`
    const task = buildThinkingSummaryTask({ thinkingText: longThinking })
    const text = extractFirstText(task.sessionInput)

    expect(text).toContain('START_MARKER')
    expect(text).toContain('END_MARKER')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(longThinking.length)
  })

  it('passes moderate-length thinking through without clipping (helper has plenty of context)', () => {
    const moderateThinking = `BEGIN ${'a'.repeat(20000)} END`
    const task = buildThinkingSummaryTask({ thinkingText: moderateThinking })
    const text = extractFirstText(task.sessionInput)

    expect(text).toContain('BEGIN')
    expect(text).toContain('END')
    expect(text).not.toContain('…')
  })

  it('declares the structured response format with a single summary string', () => {
    expect(THINKING_SUMMARY_RESPONSE_FORMAT.name).toBe('thinking_summary')
    const schema = THINKING_SUMMARY_RESPONSE_FORMAT.schema as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.properties).toHaveProperty('summary')
    expect(schema.required).toEqual(['summary'])
  })
})

describe('normalizeThinkingSummary', () => {
  it('extracts summary from structured output and strips wrapping quotes', () => {
    expect(normalizeThinkingSummary({ summary: '"Tracing the rename across files"' }))
      .toBe('Tracing the rename across files')
  })

  it('accepts a plain string and trims trailing punctuation', () => {
    expect(normalizeThinkingSummary('Weighing two refactor options.'))
      .toBe('Weighing two refactor options')
  })

  it('strips markdown emphasis, leading bullets, and collapses whitespace', () => {
    expect(normalizeThinkingSummary('- **Mapping** the   test  coverage'))
      .toBe('Mapping the test coverage')
  })

  it('keeps only the first line if the model returns multiple lines', () => {
    expect(normalizeThinkingSummary('Locating the bug in the parser\nNext step: write a fix'))
      .toBe('Locating the bug in the parser')
  })

  it('caps at 80 characters', () => {
    const long = 'Reconciling '.repeat(20).trim()
    const result = normalizeThinkingSummary(long)
    expect(result?.length ?? 0).toBeLessThanOrEqual(80)
  })

  it('returns null for empty, non-string, or whitespace-only inputs', () => {
    expect(normalizeThinkingSummary('')).toBeNull()
    expect(normalizeThinkingSummary('   ')).toBeNull()
    expect(normalizeThinkingSummary(null)).toBeNull()
    expect(normalizeThinkingSummary(undefined)).toBeNull()
    expect(normalizeThinkingSummary(42)).toBeNull()
    expect(normalizeThinkingSummary({ other: 'thing' })).toBeNull()
  })
})

describe('shouldSummarizeThinking', () => {
  it('skips short single-line thinking that the inline preview can already show in full', () => {
    expect(shouldSummarizeThinking('quick thought')).toBe(false)
    expect(shouldSummarizeThinking('  ')).toBe(false)
    expect(shouldSummarizeThinking('')).toBe(false)
  })

  it('summarizes once the single-line thinking crosses the threshold', () => {
    const justUnder = 'a'.repeat(MIN_THINKING_LENGTH_FOR_SUMMARY - 1)
    const exactly = 'a'.repeat(MIN_THINKING_LENGTH_FOR_SUMMARY)
    expect(shouldSummarizeThinking(justUnder)).toBe(false)
    expect(shouldSummarizeThinking(exactly)).toBe(true)
  })

  it('summarizes any multi-line thinking even when each line is short', () => {
    expect(shouldSummarizeThinking('Step one.\nStep two.')).toBe(true)
    expect(shouldSummarizeThinking('Quick\nthought')).toBe(true)
  })
})

describe('normalizeThinkingSummary JSON-as-text fallback', () => {
  it('extracts summary from a JSON object emitted as a string', () => {
    expect(normalizeThinkingSummary('{"summary": "Tracing the rename across files"}'))
      .toBe('Tracing the rename across files')
  })

  it('extracts summary from a fenced JSON code block', () => {
    expect(normalizeThinkingSummary('```json\n{"summary": "Mapping out the test coverage"}\n```'))
      .toBe('Mapping out the test coverage')
  })

  it('falls back to first-line behavior for plain prose', () => {
    expect(normalizeThinkingSummary('Locating the bug in the parser'))
      .toBe('Locating the bug in the parser')
  })

  it('extracts summary when JSON is embedded in prose', () => {
    expect(normalizeThinkingSummary('Sure: {"summary": "Reconciling the schema"}'))
      .toBe('Reconciling the schema')
  })
})
