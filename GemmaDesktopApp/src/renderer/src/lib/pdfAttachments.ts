import type { PdfPageRange } from '@/types'

export const PDF_MAX_WORKER_BATCH_BYTES = 48 * 1024 * 1024
export const PDF_MAX_WORKER_BATCHES = 12

export function defaultPdfPageRange(pageCount: number): PdfPageRange {
  const normalizedPageCount = Math.max(1, Math.floor(pageCount))
  return {
    startPage: 1,
    endPage: normalizedPageCount,
  }
}

export function clampPdfPageRange(
  range: PdfPageRange,
  pageCount: number,
): PdfPageRange {
  const normalizedPageCount = Math.max(1, Math.floor(pageCount))
  const startPage = Math.min(
    normalizedPageCount,
    Math.max(1, Math.floor(range.startPage || 1)),
  )
  const endPage = Math.min(
    normalizedPageCount,
    Math.max(startPage, Math.floor(range.endPage || startPage)),
  )

  return {
    startPage,
    endPage,
  }
}

export function countPdfPages(range: PdfPageRange): number {
  return Math.max(0, range.endPage - range.startPage + 1)
}

export function validatePdfPageRange(
  range: PdfPageRange,
  pageCount: number,
): string | null {
  if (!Number.isInteger(range.startPage) || !Number.isInteger(range.endPage)) {
    return 'Page selections must be whole numbers.'
  }

  if (pageCount < 1) {
    return 'This PDF does not report any pages.'
  }

  if (range.startPage < 1 || range.endPage < 1) {
    return 'Page selections must start at page 1 or later.'
  }

  if (range.startPage > range.endPage) {
    return 'The start page must be before the end page.'
  }

  if (range.endPage > pageCount) {
    return `This PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`
  }

  return null
}
