import { describe, expect, it } from 'vitest'
import {
  buildComposedMessageText,
  type PinnedQuote,
} from '../src/renderer/src/lib/composeQuotedMessage'

function makeQuote(overrides: Partial<PinnedQuote> = {}): PinnedQuote {
  return {
    id: 'msg-a:0:0:0',
    sourceMessageId: 'msg-a',
    sourceTurnTimestamp: 1_000,
    contentBlockIndex: 0,
    blockIndex: 0,
    sentenceIndex: 0,
    text: 'The sky is blue.',
    createdAt: 1_000,
    ...overrides,
  }
}

describe('buildComposedMessageText', () => {
  it('returns the user text unchanged when no quotes are pinned', () => {
    expect(buildComposedMessageText([], 'hello world')).toBe('hello world')
  })

  it('prepends a single quote as a blockquote with the reference header', () => {
    const result = buildComposedMessageText(
      [makeQuote({ text: 'First story headline.' })],
      'Go look this up',
    )

    expect(result).toContain('> **Referencing earlier replies:**')
    expect(result).toContain('> First story headline.')
    expect(result.endsWith('Go look this up')).toBe(true)
    // A blank line separates the blockquote from the user text.
    expect(result).toContain('\n\nGo look this up')
  })

  it('groups quotes by source message ordered chronologically', () => {
    const earlier = makeQuote({
      id: 'msg-a:0:0:0',
      sourceMessageId: 'msg-a',
      sourceTurnTimestamp: 1_000,
      text: 'Story from earlier reply.',
      createdAt: 5_000, // pinned later, but source is older — source timestamp wins
    })
    const later = makeQuote({
      id: 'msg-b:0:0:0',
      sourceMessageId: 'msg-b',
      sourceTurnTimestamp: 2_000,
      text: 'Story from later reply.',
      createdAt: 4_000,
    })

    const result = buildComposedMessageText([later, earlier], 'More detail please')
    const earlierIndex = result.indexOf('Story from earlier reply.')
    const laterIndex = result.indexOf('Story from later reply.')
    expect(earlierIndex).toBeGreaterThan(-1)
    expect(laterIndex).toBeGreaterThan(-1)
    expect(earlierIndex).toBeLessThan(laterIndex)
  })

  it('preserves pin order within the same source message', () => {
    const first = makeQuote({
      id: 'msg-a:0:0:0',
      sentenceIndex: 0,
      text: 'Alpha sentence.',
      createdAt: 1_000,
    })
    const second = makeQuote({
      id: 'msg-a:0:0:1',
      sentenceIndex: 1,
      text: 'Beta sentence.',
      createdAt: 2_000,
    })

    const result = buildComposedMessageText([second, first], 'Elaborate')
    const alphaIdx = result.indexOf('Alpha sentence.')
    const betaIdx = result.indexOf('Beta sentence.')
    expect(alphaIdx).toBeLessThan(betaIdx)
  })

  it('multi-line quote text gets split across multiple quoted lines', () => {
    const result = buildComposedMessageText(
      [makeQuote({ text: 'line one\nline two' })],
      'ok',
    )
    expect(result).toContain('> line one')
    expect(result).toContain('> line two')
  })

  it('returns only the blockquote when user text is empty', () => {
    const result = buildComposedMessageText(
      [makeQuote({ text: 'Just the quote.' })],
      '',
    )
    expect(result).toContain('> Just the quote.')
    expect(result).not.toContain('\n\n')
  })

  it('does not leave a trailing empty quote marker', () => {
    const result = buildComposedMessageText(
      [makeQuote({ text: 'A sentence.' })],
      'followup',
    )
    // No occurrence of `>\n\n` at the boundary means the tail marker was stripped.
    expect(result.endsWith('> A sentence.\n\nfollowup')).toBe(true)
  })
})
