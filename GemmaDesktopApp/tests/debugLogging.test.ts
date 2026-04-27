import { describe, expect, it } from 'vitest'
import {
  shouldPersistDebugLog,
  summarizeSdkEventForDebug,
} from '../src/main/debugLogging'

describe('debug logging hardening', () => {
  it('drops high-frequency renderer debug events from persistence', () => {
    expect(shouldPersistDebugLog({
      event: 'content.delta',
      data: {
        payload: {
          channel: 'reasoning',
          delta: 'hello',
        },
      },
    })).toBe(false)

    expect(shouldPersistDebugLog({
      event: 'session.event.content_delta_append',
      data: {
        blockType: 'thinking',
        delta: 'hello',
      },
    })).toBe(false)

    expect(shouldPersistDebugLog({
      event: 'session.event.live_activity',
      data: {
        activity: {
          state: 'streaming',
        },
      },
    })).toBe(false)
  })

  it('drops delegated child token streams while keeping more useful child events', () => {
    expect(shouldPersistDebugLog({
      event: 'tool.subsession.event',
      data: {
        childEventType: 'content.delta',
      },
    })).toBe(false)

    expect(shouldPersistDebugLog({
      event: 'tool.subsession.event',
      data: {
        childEventType: 'tool.result',
      },
    })).toBe(true)
  })

  it('summarizes delegated tool results without carrying full child traces', () => {
    const summary = summarizeSdkEventForDebug({
      type: 'tool.result',
      payload: {
        step: 3,
        callId: 'call_123',
        toolName: 'web_research_agent',
        output: 'short summary',
        metadata: {
          childSessionId: 'session_child',
          childTurnId: 'turn_child',
          childTrace: 'x'.repeat(500),
          sources: ['https://example.com'],
        },
      },
    }) as Record<string, unknown>

    expect(summary).toEqual({
      step: 3,
      callId: 'call_123',
      toolName: 'web_research_agent',
      outputLength: 13,
      outputPreview: 'short summary',
      errored: false,
      metadata: {
        childSessionId: 'session_child',
        childTurnId: 'turn_child',
        childTraceLength: 500,
        sourceCount: 1,
      },
    })
  })

  it('summarizes delegated child deltas without embedding raw child events', () => {
    const summary = summarizeSdkEventForDebug({
      type: 'tool.subsession.event',
      payload: {
        toolName: 'web_research_agent',
        childSessionId: 'session_child',
        childTurnId: 'turn_child',
        childEventType: 'content.delta',
        childPayload: {
          step: 4,
          channel: 'reasoning',
          delta: 'planet textures',
        },
      },
    }) as Record<string, unknown>

    expect(summary).toEqual({
      toolName: 'web_research_agent',
      childSessionId: 'session_child',
      childTurnId: 'turn_child',
      childEventType: 'content.delta',
      childPayload: {
        step: 4,
        channel: 'reasoning',
        length: 15,
        preview: 'planet textures',
      },
    })
  })
})
