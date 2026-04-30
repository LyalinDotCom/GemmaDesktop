import { describe, expect, it } from 'vitest'
import { buildQueuedUserMessage } from '../src/renderer/src/lib/queuedUserMessage'

describe('queued user messages', () => {
  it('builds the same preview content for queued image, audio, video, and PDF attachments', () => {
    const message = buildQueuedUserMessage({
      text: 'Review these files',
      coBrowse: true,
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          size: 12,
          dataUrl: 'data:image/png;base64,a',
          mediaType: 'image/png',
        },
        {
          kind: 'audio',
          name: 'clip.wav',
          size: 34,
          path: '/tmp/clip.wav',
          mediaType: 'audio/wav',
          normalizedMediaType: 'audio/wav',
          durationMs: 1200,
        },
        {
          kind: 'video',
          name: 'demo.mp4',
          size: 56,
          path: '/tmp/demo.mp4',
          mediaType: 'video/mp4',
          durationMs: 2400,
          sampledFrames: [
            {
              kind: 'image',
              name: 'frame.png',
              size: 1,
              dataUrl: 'data:image/png;base64,b',
              timestampMs: 100,
            },
          ],
        },
        {
          kind: 'pdf',
          name: 'brief.pdf',
          size: 78,
          path: '/tmp/brief.pdf',
          mediaType: 'application/pdf',
          pageCount: 5,
          processedRange: { startPage: 2, endPage: 4 },
        },
      ],
    })

    expect(message).toMatchObject({
      text: 'Review these files',
      coBrowse: true,
      status: 'queued',
    })
    expect(message.content.map((block) => block.type)).toEqual([
      'text',
      'image',
      'audio',
      'video',
      'pdf',
    ])
    expect(message.content.at(-1)).toMatchObject({
      type: 'pdf',
      pageCount: 5,
      processedRange: { startPage: 2, endPage: 4 },
    })
  })
})
