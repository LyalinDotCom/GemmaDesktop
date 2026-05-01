import { describe, expect, it } from 'vitest'
import {
  compareSessionMessagesForTimeline,
  findMissingAppUserMessages,
  mergeSessionMessages,
  type SessionDetailMessage,
} from '../../src/main/sessionMessages'

function buildUserMessage(
  id: string,
  timestamp: number,
  text: string,
): SessionDetailMessage {
  return {
    id,
    role: 'user',
    timestamp,
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

describe('session message merging', () => {
  it('drops app-side user duplicates when the SDK snapshot already has the same turn', () => {
    const merged = mergeSessionMessages(
      [
        buildUserMessage(
          'message_sdk',
          1_000,
          'Which runtime should we target?\n\nUse the local one.',
        ),
      ],
      [
        buildUserMessage(
          'user_app',
          780,
          '  Which runtime should we target?\n\nUse the local one.  ',
        ),
      ],
    )

    expect(merged).toEqual([
      buildUserMessage(
        'message_sdk',
        1_000,
        'Which runtime should we target?\n\nUse the local one.',
      ),
    ])
  })

  it('keeps a live app-side user message when the SDK history has not caught up yet', () => {
    const merged = mergeSessionMessages(
      [],
      [
        buildUserMessage('user_app', 780, 'Still only in app state'),
      ],
    )

    expect(merged).toEqual([
      buildUserMessage('user_app', 780, 'Still only in app state'),
    ])
  })

  it('identifies the app-side user turns that still need restoring into SDK history', () => {
    const missing = findMissingAppUserMessages(
      [
        buildUserMessage('message_sdk', 1_000, 'First prompt'),
      ],
      [
        buildUserMessage('user_app_duplicate', 820, 'First prompt'),
        buildUserMessage('user_app_missing', 4_500, 'Second prompt'),
        {
          id: 'assistant_app_only',
          role: 'assistant',
          timestamp: 4_700,
          content: [{ type: 'text', text: 'Partial answer' }],
        },
      ],
    )

    expect(missing).toEqual([
      buildUserMessage('user_app_missing', 4_500, 'Second prompt'),
    ])
  })

  it('keeps repeated identical prompts when they represent separate turns', () => {
    const merged = mergeSessionMessages(
      [
        buildUserMessage('message_sdk_1', 1_000, 'Run it again'),
        buildUserMessage('message_sdk_2', 4_500, 'Run it again'),
      ],
      [
        buildUserMessage('user_app_1', 820, 'Run it again'),
        buildUserMessage('user_app_2', 4_220, 'Run it again'),
      ],
    )

    expect(merged).toEqual([
      buildUserMessage('message_sdk_1', 1_000, 'Run it again'),
      buildUserMessage('message_sdk_2', 4_500, 'Run it again'),
    ])
  })

  it('drops app-side duplicates even when SDK records the user turn after a long preflight delay', () => {
    const merged = mergeSessionMessages(
      [
        buildUserMessage(
          'message_sdk',
          8_000,
          'Ship the fix after compaction finishes.',
        ),
      ],
      [
        buildUserMessage(
          'user_app',
          1_000,
          'Ship the fix after compaction finishes.',
        ),
      ],
    )

    expect(merged).toEqual([
      buildUserMessage(
        'message_sdk',
        8_000,
        'Ship the fix after compaction finishes.',
      ),
    ])
  })

  it('keeps a newly queued repeated prompt when only an earlier identical SDK turn exists', () => {
    const merged = mergeSessionMessages(
      [
        buildUserMessage('message_sdk_1', 1_000, 'Run it again'),
      ],
      [
        buildUserMessage('user_app_2', 4_500, 'Run it again'),
      ],
    )

    expect(merged).toEqual([
      buildUserMessage('message_sdk_1', 1_000, 'Run it again'),
      buildUserMessage('user_app_2', 4_500, 'Run it again'),
    ])
  })

  it('matches PDF app messages against the rendered image pages stored in SDK history', () => {
    const merged = mergeSessionMessages(
      [
        {
          id: 'message_sdk',
          role: 'user',
          timestamp: 2_000,
          content: [
            {
              type: 'image_url',
              url: '/tmp/session/page-1.png',
            },
            {
              type: 'image_url',
              url: '/tmp/session/page-2.png',
            },
          ],
        },
      ],
      [
        {
          id: 'user_app',
          role: 'user',
          timestamp: 1_780,
          content: [
            {
              type: 'pdf',
              url: 'file:///tmp/session/original.pdf',
              previewThumbnails: [
                'file:///tmp/session/page-1.png',
                'file:///tmp/session/page-2.png',
              ],
            },
          ],
        },
      ],
    )

    expect(merged).toEqual([
      {
        id: 'message_sdk',
        role: 'user',
        timestamp: 2_000,
        content: [
          {
            type: 'image_url',
            url: '/tmp/session/page-1.png',
          },
          {
            type: 'image_url',
            url: '/tmp/session/page-2.png',
          },
        ],
      },
    ])
  })

  it('keeps user turns ahead of assistant turns at the same timestamp', () => {
    const userAtT = buildUserMessage('user_app', 5_000, 'follow-up question')
    const assistantAtT: SessionDetailMessage = {
      id: 'process_notice',
      role: 'assistant',
      timestamp: 5_000,
      content: [
        {
          type: 'shell_session',
          terminalId: 'terminal-1',
          command: 'npm run dev',
          workingDirectory: '/tmp/project',
          status: 'running',
          startedAt: 5_000,
          transcript: '',
          collapsed: false,
          displayMode: 'sidebar',
        },
      ],
    }

    expect(compareSessionMessagesForTimeline(userAtT, assistantAtT)).toBeLessThan(0)
    expect(compareSessionMessagesForTimeline(assistantAtT, userAtT)).toBeGreaterThan(0)
  })

  it('orders equal-timestamp same-role messages deterministically by id', () => {
    const a: SessionDetailMessage = {
      id: 'process_a',
      role: 'assistant',
      timestamp: 5_000,
      content: [{ type: 'text', text: 'a' }],
    }
    const b: SessionDetailMessage = {
      id: 'process_b',
      role: 'assistant',
      timestamp: 5_000,
      content: [{ type: 'text', text: 'b' }],
    }

    expect(compareSessionMessagesForTimeline(a, b)).toBeLessThan(0)
    expect(compareSessionMessagesForTimeline(b, a)).toBeGreaterThan(0)
    expect(compareSessionMessagesForTimeline(a, a)).toBe(0)
  })

  it('matches attachment app messages against SDK turns that only retain the file manifest text', () => {
    const merged = mergeSessionMessages(
      [
        {
          id: 'message_sdk',
          role: 'user',
          timestamp: 2_000,
          content: [
            {
              type: 'text',
              text: [
                'Review this attachment.',
                '',
                'Attached local files for this turn are available on disk.',
                '',
                'Attached files:',
                '',
                '1. PDF: report.pdf',
                'Path: /tmp/session/report.pdf',
              ].join('\n'),
            },
          ],
        },
      ],
      [
        {
          id: 'user_app',
          role: 'user',
          timestamp: 1_780,
          content: [
            {
              type: 'text',
              text: 'Review this attachment.',
            },
            {
              type: 'pdf',
              url: 'file:///tmp/session/report.pdf',
            },
          ],
        },
      ],
    )

    expect(merged).toEqual([
      {
        id: 'message_sdk',
        role: 'user',
        timestamp: 2_000,
        content: [
          {
            type: 'text',
            text: [
              'Review this attachment.',
              '',
              'Attached local files for this turn are available on disk.',
              '',
              'Attached files:',
              '',
              '1. PDF: report.pdf',
              'Path: /tmp/session/report.pdf',
            ].join('\n'),
          },
        ],
      },
    ])
  })
})
