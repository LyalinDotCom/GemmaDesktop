import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '@gemma-desktop/sdk-core'
import {
  applyAssistantCompletionMessage,
  buildAssistantHelperToolOutput,
  buildAssistantHelperToolSummary,
  normalizeAssistantHeartbeatDecision,
  stripHiddenAssistantHeartbeatMessages,
} from '../src/main/assistantHeartbeat'

describe('assistant heartbeat helpers', () => {
  it('keeps only valid assistant heartbeat actions', () => {
    expect(
      normalizeAssistantHeartbeatDecision({
        action: 'complete',
        completionMessage: '  FlightAware had no data yet, so I switched to JetBlue. ',
      }),
    ).toEqual({
      action: 'complete',
      completionMessage: 'FlightAware had no data yet, so I switched to JetBlue.',
    })

    expect(
      normalizeAssistantHeartbeatDecision({
        action: 'restart',
        restartInstruction: ' Continue from the JetBlue tracker and use the site UI directly. ',
      }),
    ).toEqual({
      action: 'restart',
      restartInstruction: 'Continue from the JetBlue tracker and use the site UI directly.',
    })

    expect(
      normalizeAssistantHeartbeatDecision({
        action: 'restart',
      }),
    ).toEqual({ action: 'noop' })
  })

  it('preserves markdown structure in helper completion messages', () => {
    expect(
      normalizeAssistantHeartbeatDecision({
        action: 'complete',
        completionMessage:
          '  Top Recent Stories:\r\n\r\n* DeepSeek v4 - 361 points\r\n* GPT-5.5 - 1219 points  ',
      }),
    ).toEqual({
      action: 'complete',
      completionMessage:
        'Top Recent Stories:\n\n* DeepSeek v4 - 361 points\n* GPT-5.5 - 1219 points',
    })
  })

  it('summarizes visible helper activity for the chat tool-call row', () => {
    expect(
      buildAssistantHelperToolSummary({
        consultedForTurnAudit: true,
      }),
    ).toBe('Checked the final answer')

    expect(
      buildAssistantHelperToolOutput({
        consultedForTurnAudit: true,
      }),
    ).toBe('Checked the finished turn and no restart was needed.')
  })

  it('replaces the last visible text block with a helper completion message', () => {
    expect(
      applyAssistantCompletionMessage(
        [
          { type: 'tool_call', toolName: 'browser', status: 'success' },
          { type: 'text', text: 'I will check the tracker now.' },
        ],
        'JetBlue has not published live status yet, but the route is FLL to LAS.',
      ),
    ).toEqual([
      { type: 'tool_call', toolName: 'browser', status: 'success' },
      {
        type: 'text',
        text: 'JetBlue has not published live status yet, but the route is FLL to LAS.',
      },
    ])
  })

  it('removes the hidden heartbeat nudge and superseded assistant stub from history', () => {
    const history: SessionMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: 'status?' }],
        createdAt: new Date(0).toISOString(),
      },
      {
        id: 'assistant-weak',
        role: 'assistant',
        content: [{ type: 'text', text: 'I will check that.' }],
        createdAt: new Date(1).toISOString(),
      },
      {
        id: 'user-hidden',
        role: 'user',
        content: [{ type: 'text', text: 'Continue from the tracker directly.' }],
        createdAt: new Date(2).toISOString(),
      },
      {
        id: 'assistant-final',
        role: 'assistant',
        content: [{ type: 'text', text: 'JetBlue does not show live status yet.' }],
        createdAt: new Date(3).toISOString(),
      },
    ]

    expect(
      stripHiddenAssistantHeartbeatMessages(history, {
        previousAssistantMessageId: 'assistant-weak',
        previousHistoryLength: 2,
      }).map((message) => message.id),
    ).toEqual(['user-1', 'assistant-final'])
  })
})
