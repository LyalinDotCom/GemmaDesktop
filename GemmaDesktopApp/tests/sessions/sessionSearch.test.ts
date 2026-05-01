import { describe, expect, it } from 'vitest'
import {
  buildSearchableTranscript,
  parseSessionSearchQuery,
  searchSessionRecords,
  flattenSearchableContentBlocks,
  type SearchableSessionRecord,
} from '../../src/main/sessionSearch'

function makeRecord(
  sessionId: string,
  updatedAt: number,
  content: Array<Record<string, unknown>>,
  overrides: Partial<SearchableSessionRecord> = {},
): SearchableSessionRecord {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    workingDirectory: `/tmp/project-${sessionId}`,
    conversationKind: 'normal',
    updatedAt,
    messages: [
      {
        content,
      },
    ],
    ...overrides,
  }
}

describe('session search query parsing', () => {
  it('parses unquoted words as partial-match terms', () => {
    expect(parseSessionSearchQuery('hello world')).toEqual([
      { value: 'hello', exact: false },
      { value: 'world', exact: false },
    ])
  })

  it('parses both double-quoted and single-quoted phrases as exact terms', () => {
    expect(parseSessionSearchQuery('"npm run dev"')).toEqual([
      { value: 'npm run dev', exact: true },
    ])
    expect(parseSessionSearchQuery("'npm run dev'")).toEqual([
      { value: 'npm run dev', exact: true },
    ])
  })
})

describe('session search transcript flattening', () => {
  it('collects searchable text from supported content blocks and skips non-text blocks', () => {
    const flattened = flattenSearchableContentBlocks([
      { type: 'text', text: 'hello world' },
      { type: 'code', filename: 'dev.sh', code: 'npm run dev' },
      { type: 'file_edit', path: 'src/runtime.ts', changeType: 'edited', diff: '+ const ready = true', addedLines: 1, removedLines: 0 },
      { type: 'diff', filename: 'app.ts', diff: '+ console.log("ready")' },
      { type: 'file_excerpt', filename: 'README.md', content: 'quoted script block' },
      { type: 'shell_session', transcript: 'pnpm test\nvitest run' },
      { type: 'warning', message: 'Heads up' },
      { type: 'error', message: 'Boom', details: 'Stack trace here' },
      {
        type: 'tool_call',
        summary: 'Search completed',
        output: 'Found exact match in tool output',
        worker: { resultSummary: 'worker summary' },
      },
      { type: 'image', url: '/tmp/screenshot.png' },
    ])

    expect(flattened).toContain('hello world')
    expect(flattened).toContain('npm run dev')
    expect(flattened).toContain('src/runtime.ts')
    expect(flattened).toContain('const ready = true')
    expect(flattened).toContain('console.log("ready")')
    expect(flattened).toContain('quoted script block')
    expect(flattened).toContain('vitest run')
    expect(flattened).toContain('Heads up')
    expect(flattened).toContain('Stack trace here')
    expect(flattened).toContain('Found exact match in tool output')
    expect(flattened).not.toContain('/tmp/screenshot.png')
  })

  it('normalizes the merged transcript into a single searchable text surface', () => {
    const transcript = buildSearchableTranscript([
      {
        content: [
          { type: 'text', text: 'hello\n\nworld' },
          { type: 'shell_session', transcript: 'npm   run   dev' },
        ],
      },
    ])

    expect(transcript).toBe('hello world npm run dev')
  })
})

describe('session search matching', () => {
  it('requires all unquoted terms, matches quoted phrases, and is case-insensitive', () => {
    const records = [
      makeRecord('alpha', 100, [
        { type: 'text', text: 'Hello there general kenobi' },
        { type: 'code', code: 'npm run dev', filename: 'dev.sh' },
      ]),
      makeRecord('beta', 200, [
        { type: 'text', text: 'hello only' },
      ]),
    ]

    expect(searchSessionRecords(records, 'hello kenobi').map((record) => record.sessionId))
      .toEqual(['alpha'])
    expect(searchSessionRecords(records, '"NPM RUN DEV"').map((record) => record.sessionId))
      .toEqual(['alpha'])
    expect(searchSessionRecords(records, "'npm run dev'").map((record) => record.sessionId))
      .toEqual(['alpha'])
  })

  it('returns one result per matching session, sorted by newest update, with snippets', () => {
    const records = [
      makeRecord('older', 100, [
        { type: 'text', text: 'Find the release checklist in this conversation.' },
      ]),
      makeRecord('newer', 300, [
        { type: 'shell_session', transcript: 'echo release checklist && npm run dev' },
      ]),
      makeRecord('hidden', 999, [
        { type: 'text', text: 'release checklist' },
      ]),
    ]

    const results = searchSessionRecords(records.slice(0, 2), 'release checklist')

    expect(results.map((record) => record.sessionId)).toEqual(['newer', 'older'])
    expect(results[0]?.snippet).toContain('release checklist')
    expect(results.some((record) => record.sessionId === 'hidden')).toBe(false)
  })
})
