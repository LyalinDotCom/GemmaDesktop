import { describe, expect, it } from 'vitest'
import {
  buildFailedAssistantMessage,
  buildInterruptedAssistantMessage,
  buildRecoveredFailedAssistantMessage,
  CANCELLED_TURN_ID_SUFFIX,
  CANCELLED_TURN_WARNING,
  FAILED_TURN_ID_SUFFIX,
  INTERRUPTED_TURN_ID_SUFFIX,
  INTERRUPTED_TURN_WARNING,
  RECOVERED_TURN_ID_SUFFIX,
  RECOVERED_TURN_WARNING,
  resolveInterruptedTurnTimestamp,
} from '../src/main/interruptedTurns'

describe('interrupted turn recovery', () => {
  it('preserves thinking blocks and downgrades unfinished tool calls', () => {
    const message = buildInterruptedAssistantMessage({
      turnId: 'turn_123',
      timestamp: 42,
      content: [
        {
          type: 'thinking',
          text: 'Trace parser state',
        },
        {
          type: 'tool_call',
          toolName: 'edit_file',
          input: { path: 'src/App.tsx' },
          status: 'running',
        },
      ],
    })

    expect(message).toEqual({
      id: `turn_123${INTERRUPTED_TURN_ID_SUFFIX}`,
      role: 'assistant',
      timestamp: 42,
      content: [
        {
          type: 'thinking',
          text: 'Trace parser state',
        },
        {
          type: 'tool_call',
          toolName: 'edit_file',
          input: { path: 'src/App.tsx' },
          status: 'error',
        },
        {
          type: 'warning',
          message: INTERRUPTED_TURN_WARNING,
        },
      ],
    })
  })

  it('supports cancelled turns with a distinct id suffix and warning', () => {
    const message = buildInterruptedAssistantMessage({
      turnId: 'turn_456',
      timestamp: 100,
      durationMs: 9_000,
      idSuffix: CANCELLED_TURN_ID_SUFFIX,
      warningMessage: CANCELLED_TURN_WARNING,
      content: [
        {
          type: 'text',
          text: 'Partial answer',
        },
      ],
    })

    expect(message).toEqual({
      id: `turn_456${CANCELLED_TURN_ID_SUFFIX}`,
      role: 'assistant',
      timestamp: 100,
      durationMs: 9_000,
      content: [
        {
          type: 'text',
          text: 'Partial answer',
        },
        {
          type: 'warning',
          message: CANCELLED_TURN_WARNING,
        },
      ],
    })
  })

  it('returns null when there is no recoverable content', () => {
    expect(buildInterruptedAssistantMessage({
      turnId: 'turn_empty',
      content: [],
    })).toBeNull()
  })

  it('places recovered app-startup turns after the SDK user turn they answered', () => {
    expect(resolveInterruptedTurnTimestamp({
      turnStartedAt: 1_000,
      history: [
        {
          role: 'user',
          createdAt: new Date(8_000).toISOString(),
        },
      ],
      appMessages: [
        {
          role: 'user',
          timestamp: 1_000,
        },
      ],
    })).toBe(8_001)
  })

  it('preserves visible turn content when a generation fails', () => {
    const message = buildFailedAssistantMessage({
      turnId: 'turn_failed',
      timestamp: 200,
      durationMs: 12_000,
      errorMessage: 'Turn reached the maximum step count immediately after tool use.',
      content: [
        {
          type: 'tool_call',
          toolName: 'write_file',
          input: { path: 'index.html' },
          output: 'Created index.html.',
          status: 'success',
        },
      ],
    })

    expect(message).toEqual({
      id: `turn_failed${FAILED_TURN_ID_SUFFIX}`,
      role: 'assistant',
      timestamp: 200,
      durationMs: 12_000,
      content: [
        {
          type: 'tool_call',
          toolName: 'write_file',
          input: { path: 'index.html' },
          output: 'Created index.html.',
          status: 'success',
        },
        {
          type: 'error',
          message: 'Turn reached the maximum step count immediately after tool use.',
        },
      ],
    })
  })

  it('still returns an error message when a failed turn has no visible content', () => {
    const message = buildFailedAssistantMessage({
      turnId: 'turn_error_only',
      timestamp: 300,
      errorMessage: 'Runtime stream ended without a final response.',
      content: [],
    })

    expect(message).toEqual({
      id: `turn_error_only${FAILED_TURN_ID_SUFFIX}`,
      role: 'assistant',
      timestamp: 300,
      content: [
        {
          type: 'error',
          message: 'Runtime stream ended without a final response.',
        },
      ],
    })
  })

  it('appends a recovered user-facing message without preserving the raw turn error as the final block', () => {
    const message = buildRecoveredFailedAssistantMessage({
      turnId: 'turn_recovered',
      timestamp: 400,
      durationMs: 24_000,
      recoveryMessage:
        'I confirmed the official search path was blocked and could not verify the White House schedule before the turn stopped.',
      content: [
        {
          type: 'tool_call',
          toolName: 'search_web',
          input: { query: 'White House today' },
          output: 'Gemini search capacity was exhausted.',
          status: 'error',
        },
      ],
    })

    expect(message).toEqual({
      id: `turn_recovered${RECOVERED_TURN_ID_SUFFIX}`,
      role: 'assistant',
      timestamp: 400,
      durationMs: 24_000,
      content: [
        {
          type: 'tool_call',
          toolName: 'search_web',
          input: { query: 'White House today' },
          output: 'Gemini search capacity was exhausted.',
          status: 'error',
        },
        {
          type: 'warning',
          message: RECOVERED_TURN_WARNING,
        },
        {
          type: 'text',
          text: 'I confirmed the official search path was blocked and could not verify the White House schedule before the turn stopped.',
        },
      ],
    })
  })
})
