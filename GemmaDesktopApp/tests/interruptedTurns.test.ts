import { describe, expect, it } from 'vitest'
import {
  buildFailedAssistantMessage,
  buildInterruptedAssistantMessage,
  CANCELLED_TURN_ID_SUFFIX,
  CANCELLED_TURN_WARNING,
  FAILED_TURN_ID_SUFFIX,
  INTERRUPTED_TURN_ID_SUFFIX,
  INTERRUPTED_TURN_WARNING,
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
})
