const RAW_CHANNEL_PAIR_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>\s*(?:thought|assistant|analysis|commentary|final)?\s*<channel\|[^>\r\n]*>/gi
const RAW_CHANNEL_MARKER_PATTERN =
  /<\|channel(?:\|[^>\r\n]*)?>|<channel\|[^>\r\n]*>/g
const CHANNEL_LABEL_ONLY_PATTERN =
  /^\s*(?:thought|assistant|analysis|commentary|final)\s*$/i
const LEADING_CHANNEL_LABEL_PATTERN =
  /^\s*(?:thought|assistant|analysis|commentary|final)\s*(?:\r?\n)+/i
const CHANNEL_LABELS = ['thought', 'assistant', 'analysis', 'commentary', 'final'] as const
const CHANNEL_LABEL_PREFIXES = new Set(
  CHANNEL_LABELS.flatMap((label) =>
    Array.from({ length: label.length }, (_value, index) => label.slice(0, index + 1).toLowerCase()),
  ),
)

function isInlineCodeWrapped(source: string, offset: number, length: number): boolean {
  const previous = offset > 0 ? source[offset - 1] : ''
  const next = offset + length < source.length
    ? source[offset + length]
    : ''

  return previous === '`' && next === '`'
}

export function stripAssistantTransportArtifacts(text: string): string {
  if (text.length === 0) {
    return text
  }

  const withoutWrappedArtifacts = text.replace(
    RAW_CHANNEL_PAIR_PATTERN,
    (match, offset: number, source: string) =>
      isInlineCodeWrapped(source, offset, match.length) ? match : '',
  )
  const sawOpenMarker = /<\|channel(?:\|[^>\r\n]*)?>/i.test(withoutWrappedArtifacts)
  const withoutMarkers = withoutWrappedArtifacts.replace(
    RAW_CHANNEL_MARKER_PATTERN,
    (match, offset: number, source: string) =>
      isInlineCodeWrapped(source, offset, match.length) ? match : '',
  )
  const withoutLeadingLabel = withoutMarkers.replace(LEADING_CHANNEL_LABEL_PATTERN, '')
  const trimmed = withoutLeadingLabel.trim()

  if (CHANNEL_LABEL_ONLY_PATTERN.test(trimmed)) {
    return ''
  }

  if (sawOpenMarker) {
    const leadingWhitespace = withoutLeadingLabel.match(/^\s*/)?.[0] ?? ''
    const visible = withoutLeadingLabel.slice(leadingWhitespace.length)
    const firstLine = visible.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? ''

    if (
      firstLine.length > 0
      && CHANNEL_LABEL_PREFIXES.has(firstLine)
      && !firstLine.includes(' ')
    ) {
      return leadingWhitespace
    }
  }

  return withoutLeadingLabel
}

export function sanitizeRenderableContentBlocks<T extends Array<Record<string, unknown>>>(
  blocks: T,
): T {
  let changed = false

  const nextBlocks = blocks.map((block) => {
    const type = block.type
    const text = typeof block.text === 'string' ? block.text : null

    if ((type !== 'text' && type !== 'thinking') || text == null) {
      return block
    }

    const sanitizedText = stripAssistantTransportArtifacts(text)
    if (sanitizedText === text) {
      return block
    }

    changed = true
    return {
      ...block,
      text: sanitizedText,
    }
  })

  return (changed ? nextBlocks : blocks) as T
}
