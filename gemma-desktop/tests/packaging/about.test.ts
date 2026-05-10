import { describe, expect, it } from 'vitest'
import {
  ABOUT_CREDIT_SECTIONS,
  flattenAboutCreditEntries,
} from '../../src/shared/about'

describe('about credits', () => {
  it('keeps section ids and entry ids unique', () => {
    const sectionIds = ABOUT_CREDIT_SECTIONS.map((section) => section.id)
    expect(new Set(sectionIds).size).toBe(sectionIds.length)

    const entryIds = flattenAboutCreditEntries().map((entry) => entry.id)
    expect(new Set(entryIds).size).toBe(entryIds.length)
  })

  it('includes the major user-visible runtime dependencies', () => {
    const ids = new Set(flattenAboutCreditEntries().map((entry) => entry.id))

    expect(ids.has('whisper-cpp')).toBe(true)
    expect(ids.has('openai-whisper-models')).toBe(true)
    expect(ids.has('silero-vad')).toBe(true)
    expect(ids.has('pdf-to-img')).toBe(true)
    expect(ids.has('pdfjs-dist')).toBe(true)
    expect(ids.has('chrome-devtools-mcp')).toBe(true)
    expect(ids.has('mozilla-readability')).toBe(true)
    expect(ids.has('got-scraping')).toBe(true)
    expect(ids.has('electron')).toBe(true)
  })

  it('uses absolute external links when a website is present', () => {
    for (const entry of flattenAboutCreditEntries()) {
      if (!entry.website) {
        continue
      }

      expect(entry.website.startsWith('https://')).toBe(true)
    }
  })
})
