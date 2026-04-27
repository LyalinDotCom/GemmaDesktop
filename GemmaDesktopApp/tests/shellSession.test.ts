import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHELL_PEEK_CHARS,
  MAX_SHELL_TRANSCRIPT_CHARS,
  appendShellTranscript,
  normalizePersistedShellBlock,
  peekShellTranscript,
} from '../src/shared/shellSession'

describe('shell session helpers', () => {
  it('caps transcripts and keeps the newest output', () => {
    const oversized = 'a'.repeat(MAX_SHELL_TRANSCRIPT_CHARS)
    const next = appendShellTranscript(oversized, 'tail')

    expect(next.length).toBeLessThanOrEqual(MAX_SHELL_TRANSCRIPT_CHARS)
    expect(next.endsWith('tail')).toBe(true)
  })

  it('restores persisted running shells as interrupted summaries', () => {
    expect(normalizePersistedShellBlock({
      type: 'shell_session',
      terminalId: 'terminal-1',
      command: 'sleep 10',
      workingDirectory: '/tmp/project',
      status: 'running',
      startedAt: 1_000,
      transcript: '',
      collapsed: false,
    }, 2_000)).toEqual({
      type: 'shell_session',
      terminalId: 'terminal-1',
      command: 'sleep 10',
      workingDirectory: '/tmp/project',
      status: 'interrupted',
      startedAt: 1_000,
      completedAt: 2_000,
      transcript: '',
      collapsed: true,
    })
  })

  it('returns a bounded tail when peeking transcript output', () => {
    const peek = peekShellTranscript('a'.repeat(400), 300)

    expect(peek.text).toBe('a'.repeat(300))
    expect(peek.peekTruncated).toBe(true)
    expect(peek.storageTruncated).toBe(false)
    expect(peek.maxChars).toBe(300)
  })

  it('reports when retained transcript storage already dropped older output', () => {
    const transcript = appendShellTranscript(
      'a'.repeat(MAX_SHELL_TRANSCRIPT_CHARS),
      'tail',
    )
    const peek = peekShellTranscript(transcript, DEFAULT_SHELL_PEEK_CHARS)

    expect(peek.text.endsWith('tail')).toBe(true)
    expect(peek.storageTruncated).toBe(true)
  })
})
