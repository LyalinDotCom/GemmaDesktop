import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HELPER_GEMMA_TAG,
  getExpectedGemmaContextLength,
  getDefaultHelperGemmaCatalogEntry,
  resolveGemmaCatalogEntryForModel,
} from '../src/shared/gemmaCatalog'

describe('gemma catalog defaults', () => {
  it('keeps helper routing on the smallest low tier by default', () => {
    const entry = getDefaultHelperGemmaCatalogEntry()

    expect(entry.tag).toBe(DEFAULT_HELPER_GEMMA_TAG)
    expect(entry.tier).toBe('low')
  })

  it('maps Gemma variant tags back to their guided tiers', () => {
    expect(resolveGemmaCatalogEntryForModel('gemma4:31b-mlx-bf16')?.tier).toBe(
      'extra-high',
    )
    expect(
      resolveGemmaCatalogEntryForModel(
        'google/gemma-4-27b-it-qat',
        'Gemma 4 27B IT QAT',
      )?.tier,
    ).toBe('high')
    expect(getExpectedGemmaContextLength('gemma4:31b-mlx-bf16')).toBe(262_144)
  })
})
