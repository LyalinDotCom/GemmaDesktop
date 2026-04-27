import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HELPER_GEMMA_TAG,
  getDefaultHelperGemmaCatalogEntry,
} from '../src/shared/gemmaCatalog'

describe('gemma catalog defaults', () => {
  it('keeps helper routing on the smallest low tier by default', () => {
    const entry = getDefaultHelperGemmaCatalogEntry()

    expect(entry.tag).toBe(DEFAULT_HELPER_GEMMA_TAG)
    expect(entry.tier).toBe('low')
  })
})
