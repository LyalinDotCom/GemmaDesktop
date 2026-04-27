import { describe, expect, it } from 'vitest'
import { shouldOfferComposerHistoryNavigation } from '../src/renderer/src/lib/composerHistoryNavigation'

describe('composer history navigation', () => {
  it('leaves ArrowUp and ArrowDown for native textarea navigation in the floating welcome composer', () => {
    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'floating',
      key: 'ArrowUp',
      text: 'wrapped welcome prompt',
      selectionStart: 10,
      selectionEnd: 10,
    })).toBe(false)

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'floating',
      key: 'ArrowDown',
      text: 'wrapped welcome prompt',
      selectionStart: 10,
      selectionEnd: 10,
    })).toBe(false)
  })

  it('offers history navigation only when the caret sits at the very start or end of the draft', () => {
    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowUp',
      text: 'single line prompt',
      selectionStart: 0,
      selectionEnd: 0,
    })).toBe(true)

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowDown',
      text: 'single line prompt',
      selectionStart: 'single line prompt'.length,
      selectionEnd: 'single line prompt'.length,
    })).toBe(true)
  })

  it('does not hijack arrow keys when the caret sits inside the draft', () => {
    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowUp',
      text: 'single line prompt',
      selectionStart: 8,
      selectionEnd: 8,
    })).toBe(false)

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowDown',
      text: 'single line prompt',
      selectionStart: 8,
      selectionEnd: 8,
    })).toBe(false)
  })

  it('does not steal arrow keys when long unwrapped text visually wraps across rows', () => {
    const wrappedDraft =
      'this is a fairly long single-line draft that the textarea wraps across multiple visual rows even though it has no newline characters at all'

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowUp',
      text: wrappedDraft,
      selectionStart: 80,
      selectionEnd: 80,
    })).toBe(false)

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowDown',
      text: wrappedDraft,
      selectionStart: 40,
      selectionEnd: 40,
    })).toBe(false)
  })

  it('does not offer history navigation inside explicit multiline default text', () => {
    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowUp',
      text: 'first line\nsecond line',
      selectionStart: 13,
      selectionEnd: 13,
    })).toBe(false)

    expect(shouldOfferComposerHistoryNavigation({
      presentation: 'default',
      key: 'ArrowDown',
      text: 'first line\nsecond line',
      selectionStart: 4,
      selectionEnd: 4,
    })).toBe(false)
  })
})
