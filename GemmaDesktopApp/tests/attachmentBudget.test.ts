import { describe, expect, it } from 'vitest'
import { assessAttachmentBudget } from '../src/shared/attachmentBudget'

describe('attachment budget assessment', () => {
  it('flags large PDF payloads against the current context window', () => {
    const result = assessAttachmentBudget({
      attachments: [
        {
          kind: 'pdf',
          name: 'book.pdf',
          size: 2_000_000,
          pageCount: 40,
          batchCount: 3,
          fitStatus: 'ready',
        },
      ],
      support: {
        image: true,
        audio: false,
        video: true,
        pdf: false,
      },
      contextLength: 32_768,
    })

    expect(result.issues.join(' ')).toContain('book.pdf')
  })

  it('flags PDFs already marked too large by the planner', () => {
    const result = assessAttachmentBudget({
      attachments: [
        {
          kind: 'pdf',
          name: 'archive.pdf',
          size: 10_000_000,
          fitStatus: 'too_large',
        },
      ],
      support: {
        image: true,
        audio: false,
        video: true,
        pdf: false,
      },
      contextLength: 32_768,
    })

    expect(result.issues).toContain(
      'archive.pdf is too large for the current PDF processing budget.',
    )
  })
})
