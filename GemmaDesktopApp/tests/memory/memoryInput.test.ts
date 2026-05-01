import { describe, expect, it } from 'vitest'
import {
  extractMemoryPayload,
  isMemoryInput,
} from '../../src/renderer/src/lib/memoryInput'

describe('extractMemoryPayload', () => {
  it('returns the body when the trimmed text starts with #', () => {
    expect(extractMemoryPayload('# my name is Dmitry Lyalin')).toBe('my name is Dmitry Lyalin')
    expect(extractMemoryPayload('  #   remember that I love coffee  ')).toBe(
      'remember that I love coffee',
    )
  })

  it('returns null for non-memory inputs', () => {
    expect(extractMemoryPayload('hello')).toBeNull()
    expect(extractMemoryPayload('/help')).toBeNull()
    expect(extractMemoryPayload('')).toBeNull()
    expect(extractMemoryPayload('   ')).toBeNull()
  })

  it('returns null when # has no payload', () => {
    expect(extractMemoryPayload('#')).toBeNull()
    expect(extractMemoryPayload('#   ')).toBeNull()
  })

  it('returns null when the user typed a markdown heading (##) rather than a single #', () => {
    expect(extractMemoryPayload('## heading in chat')).toBeNull()
    expect(extractMemoryPayload('### still a heading')).toBeNull()
  })
})

describe('isMemoryInput', () => {
  it('matches extractMemoryPayload presence', () => {
    expect(isMemoryInput('# note me')).toBe(true)
    expect(isMemoryInput('note me')).toBe(false)
    expect(isMemoryInput('##')).toBe(false)
  })
})
