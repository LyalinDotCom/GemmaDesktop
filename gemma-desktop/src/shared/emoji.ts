const DEFAULT_DISPLAY_EMOJI = '⭐'

interface GraphemeSegment {
  segment: string
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>
}

type GraphemeSegmenterConstructor = new (
  locale: string | undefined,
  options: { granularity: 'grapheme' },
) => GraphemeSegmenter

function getSegmenter(): GraphemeSegmenter | null {
  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: GraphemeSegmenterConstructor
  }
  const Segmenter = intlWithSegmenter.Segmenter
  return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null
}

function isRegionalIndicator(codePoint: number | undefined): boolean {
  return codePoint !== undefined
    && codePoint >= 0x1F1E6
    && codePoint <= 0x1F1FF
}

function shouldJoinEmojiCodePoint(codePoint: number | undefined): boolean {
  return codePoint === 0x20E3
    || codePoint === 0xFE0E
    || codePoint === 0xFE0F
    || (
      codePoint !== undefined
      && codePoint >= 0x1F3FB
      && codePoint <= 0x1F3FF
    )
}

export function extractFirstGrapheme(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const segmenter = getSegmenter()
  if (segmenter) {
    for (const { segment } of segmenter.segment(trimmed)) {
      return segment.trim() ? segment : null
    }
    return null
  }

  const codePoints = Array.from(trimmed)
  const first = codePoints[0]
  if (!first) {
    return null
  }

  let result = first
  const firstCodePoint = first.codePointAt(0)
  if (isRegionalIndicator(firstCodePoint)) {
    const next = codePoints[1]
    if (isRegionalIndicator(next?.codePointAt(0))) {
      return `${result}${next}`
    }
    return result
  }

  for (let index = 1; index < codePoints.length; index += 1) {
    const next = codePoints[index]
    if (!next) {
      break
    }

    const nextCodePoint = next.codePointAt(0)
    if (shouldJoinEmojiCodePoint(nextCodePoint)) {
      result += next
      continue
    }

    if (next === '\u200D') {
      const joined = codePoints[index + 1]
      if (!joined) {
        break
      }
      result += `${next}${joined}`
      index += 1
      continue
    }

    break
  }

  return result
}

export function clampToFirstGrapheme(
  input: unknown,
  fallback = DEFAULT_DISPLAY_EMOJI,
): string {
  if (typeof input !== 'string') {
    return fallback
  }

  return extractFirstGrapheme(input) ?? fallback
}
