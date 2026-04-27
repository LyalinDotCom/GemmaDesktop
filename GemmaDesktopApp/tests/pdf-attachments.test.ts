import { describe, expect, it } from 'vitest'
import {
  clampPdfPageRange,
  defaultPdfPageRange,
  validatePdfPageRange,
} from '../src/renderer/src/lib/pdfAttachments'

describe('pdf attachment helpers', () => {
  it('defaults to the full document', () => {
    expect(defaultPdfPageRange(3)).toEqual({
      startPage: 1,
      endPage: 3,
    })

    expect(defaultPdfPageRange(22)).toEqual({
      startPage: 1,
      endPage: 22,
    })
  })

  it('clamps and validates page ranges against document bounds', () => {
    expect(
      clampPdfPageRange(
        {
          startPage: 12,
          endPage: 99,
        },
        12,
      ),
    ).toEqual({
      startPage: 12,
      endPage: 12,
    })

    expect(
      validatePdfPageRange(
        {
          startPage: 2,
          endPage: 8,
        },
        12,
      ),
    ).toBeNull()

    expect(
      validatePdfPageRange(
        {
          startPage: 9,
          endPage: 8,
        },
        12,
      ),
    ).toContain('start page')

    expect(
      validatePdfPageRange(
        {
          startPage: 1,
          endPage: 13,
        },
        12,
      ),
    ).toContain('12')
  })
})
