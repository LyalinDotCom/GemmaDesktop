import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '@gemma-desktop/sdk-core'
import { restoreMissingUserHistoryFromAppMessages } from '../../src/main/sessionHistoryRepair'
import type { SessionDetailMessage } from '../../src/main/sessionMessages'

function buildSnapshot(
  history: SessionSnapshot['history'] = [],
): SessionSnapshot {
  return {
    schemaVersion: 2,
    sessionId: 'session_test',
    runtimeId: 'runtime_test',
    modelId: 'model_test',
    mode: 'build',
    workingDirectory: '/tmp/gemma-desktop',
    maxSteps: 8,
    history,
    started: history.length > 0,
    savedAt: '2026-04-23T10:00:00.000Z',
  }
}

function buildUserMessage(
  id: string,
  timestamp: number,
  content: Array<Record<string, unknown>>,
): SessionDetailMessage {
  return {
    id,
    role: 'user',
    timestamp,
    content,
  }
}

describe('session history repair', () => {
  it('restores a missing app-side user turn into SDK history with media attachments', () => {
    const snapshot = buildSnapshot([
      {
        id: 'message_sdk_1',
        role: 'user',
        createdAt: '2026-04-23T10:00:01.000Z',
        content: [
          {
            type: 'text',
            text: 'First prompt',
          },
        ],
      },
    ])

    const restored = restoreMissingUserHistoryFromAppMessages(snapshot, [
      buildUserMessage('user_app_2', Date.parse('2026-04-23T10:00:05.000Z'), [
        {
          type: 'text',
          text: '  Retry with the artifacts.  ',
        },
        {
          type: 'pdf',
          url: 'file:///tmp/gemma-desktop/spec.pdf',
          mediaType: 'application/pdf',
        },
        {
          type: 'video',
          url: 'file:///tmp/gemma-desktop/demo.mp4',
          mediaType: 'video/mp4',
        },
      ]),
    ])

    expect(restored.history).toEqual([
      {
        id: 'message_sdk_1',
        role: 'user',
        createdAt: '2026-04-23T10:00:01.000Z',
        content: [
          {
            type: 'text',
            text: 'First prompt',
          },
        ],
      },
      {
        id: 'user_app_2',
        role: 'user',
        createdAt: '2026-04-23T10:00:05.000Z',
        content: [
          {
            type: 'text',
            text: 'Retry with the artifacts.',
          },
          {
            type: 'pdf_url',
            url: 'file:///tmp/gemma-desktop/spec.pdf',
            mediaType: 'application/pdf',
          },
          {
            type: 'video_url',
            url: 'file:///tmp/gemma-desktop/demo.mp4',
            mediaType: 'video/mp4',
          },
        ],
      },
    ])
  })

  it('leaves the snapshot untouched when the SDK history already captured the user turn', () => {
    const snapshot = buildSnapshot([
      {
        id: 'message_sdk_1',
        role: 'user',
        createdAt: '2026-04-23T10:00:08.000Z',
        content: [
          {
            type: 'text',
            text: 'Ship the fix after compaction finishes.',
          },
        ],
      },
    ])

    const restored = restoreMissingUserHistoryFromAppMessages(snapshot, [
      buildUserMessage('user_app_1', Date.parse('2026-04-23T10:00:01.000Z'), [
        {
          type: 'text',
          text: 'Ship the fix after compaction finishes.',
        },
      ]),
    ])

    expect(restored).toBe(snapshot)
  })
})
