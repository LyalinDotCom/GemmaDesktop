import { describe, expect, it } from 'vitest'
import {
  deriveAttachmentSupport,
  isAttachmentKindSupported,
  summarizeAttachmentSupport,
} from '../../src/shared/attachmentSupport'

describe('attachment support helpers', () => {
  it('does not claim PDF support from model capabilities alone', () => {
    const support = deriveAttachmentSupport([
      {
        id: 'model.input.image',
        scope: 'model',
        status: 'supported',
        source: 'test',
      },
      {
        id: 'model.input.audio',
        scope: 'model',
        status: 'unsupported',
        source: 'test',
      },
    ])

    expect(support).toEqual({
      image: true,
      audio: false,
      video: true,
      pdf: false,
    })
    expect(isAttachmentKindSupported(support, 'video')).toBe(true)
    expect(summarizeAttachmentSupport(support)).toEqual([
      'image',
      'video',
    ])
  })
})
