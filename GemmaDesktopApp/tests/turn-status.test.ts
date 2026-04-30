import { describe, expect, it } from 'vitest'
import {
  applyLatestAssistantPrimaryModelFallback,
  serializeChatMessage,
} from '../src/renderer/src/lib/chatCopy'
import {
  buildTurnDurationLabel,
  formatElapsedClock,
} from '../src/renderer/src/lib/turnStatus'

describe('turn status helpers', () => {
  it('formats elapsed durations as a clock', () => {
    expect(formatElapsedClock(8_000)).toBe('00:08')
    expect(formatElapsedClock(65_000)).toBe('01:05')
    expect(formatElapsedClock(3_726_000)).toBe('1:02:06')
  })

  it('builds success, stop, and failure labels from assistant turns', () => {
    expect(
      buildTurnDurationLabel([{ type: 'text', text: 'Done.' }], 12_000),
    ).toBe('12s')

    expect(
      buildTurnDurationLabel([
        { type: 'warning', message: 'Generation stopped before completion.' },
      ], 9_000),
    ).toBe('Stopped · 9s')

    expect(
      buildTurnDurationLabel([
        { type: 'error', message: 'Tool failed.' },
      ], 5_000),
    ).toBe('Failed · 5s')
  })

  it('can include the completed turn model label before the duration', () => {
    expect(
      buildTurnDurationLabel(
        [{ type: 'text', text: 'Done.' }],
        12_000,
        'gemma4:26b',
      ),
    ).toBe('gemma4:26b in 12s')

    expect(
      buildTurnDurationLabel([
        { type: 'warning', message: 'Generation stopped before completion.' },
      ], 9_000, 'gemma4:26b'),
    ).toBe('Stopped · gemma4:26b in 9s')
  })

  it('includes the turn duration label when serializing assistant messages', () => {
    const serialized = serializeChatMessage({
      id: 'assistant-1',
      role: 'assistant',
      timestamp: Date.UTC(2026, 3, 6, 23, 28, 29),
      durationMs: 317_000,
      primaryModelId: 'gemma4:26b',
      primaryRuntimeId: 'ollama-native',
      content: [{ type: 'text', text: 'Created the simulation.' }],
    })

    expect(serialized).toContain('Created the simulation.')
    expect(serialized).toContain('gemma4:26b in 5m 17s')
  })

  it('can add a primary model fallback only to the latest assistant message', () => {
    const messages = applyLatestAssistantPrimaryModelFallback([
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 1_000,
        durationMs: 2_000,
        content: [{ type: 'text', text: 'Earlier.' }],
      },
      {
        id: 'user-1',
        role: 'user',
        timestamp: 2_000,
        content: [{ type: 'text', text: 'Again.' }],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        timestamp: 3_000,
        durationMs: 4_000,
        content: [{ type: 'text', text: 'Latest.' }],
      },
    ], 'gemma4:26b')

    expect(messages[0]?.primaryModelId).toBeUndefined()
    expect(messages[2]?.primaryModelId).toBe('gemma4:26b')
  })
})
