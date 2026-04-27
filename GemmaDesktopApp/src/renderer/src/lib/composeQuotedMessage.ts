/**
 * Shape of a pinned sentence quote that will be carried into the next user
 * message. Defined here (instead of imported from useAppState) so both the
 * reducer and any call sites that compose outgoing text can share the type
 * without creating an import cycle.
 */
export interface PinnedQuote {
  /** Stable unique id, typically `${sourceMessageId}:${contentBlockIndex}:${blockIndex}:${sentenceIndex}` */
  id: string
  /** Assistant message the sentence was pinned from. */
  sourceMessageId: string
  /** `message.timestamp` of the source message — used to chronologically order groups in the composed prefix. */
  sourceTurnTimestamp: number
  /** Which `message.content[]` entry the sentence is in (for messages with multiple text blocks). */
  contentBlockIndex: number
  /** Which top-level markdown block within that content block. */
  blockIndex: number
  /** 0-based sentence index within the block. */
  sentenceIndex: number
  /** Extracted plain text of the sentence. */
  text: string
  /** For composer-preview ordering by pin time. */
  createdAt: number
}

const QUOTE_HEADER = '> **Referencing earlier replies:**'

/**
 * Build the outgoing text for a user turn, prepending any pinned sentence
 * quotes as a markdown blockquote block above the user's typed text.
 *
 * - Quotes are grouped by source message id (so sentences from the same
 *   assistant reply cluster together in the committed turn).
 * - Groups are ordered chronologically by the source message's timestamp.
 * - Inside a group, quotes are rendered in the order they were pinned.
 * - If there are no quotes, the user text is returned unchanged (no header,
 *   no extra blank lines).
 *
 * The returned string renders naturally in chat history via the existing
 * `MarkdownContent` path (Tailwind prose gives blockquotes italic + left
 * border), and the agent sees the quotes as normal user-turn text so no
 * main-process plumbing is required.
 */
export function buildComposedMessageText(
  quotes: PinnedQuote[],
  userText: string,
): string {
  if (quotes.length === 0) {
    return userText
  }

  const byMessage = new Map<string, PinnedQuote[]>()
  for (const quote of quotes) {
    const bucket = byMessage.get(quote.sourceMessageId) ?? []
    bucket.push(quote)
    byMessage.set(quote.sourceMessageId, bucket)
  }

  const sortedGroups = Array.from(byMessage.values()).sort((a, b) => {
    const left = a[0]?.sourceTurnTimestamp ?? 0
    const right = b[0]?.sourceTurnTimestamp ?? 0
    return left - right
  })

  const lines: string[] = [QUOTE_HEADER, '>']
  for (const group of sortedGroups) {
    // Preserve pin order within a group.
    const ordered = [...group].sort((a, b) => a.createdAt - b.createdAt)
    for (const quote of ordered) {
      const pieces = quote.text.split('\n')
      for (const piece of pieces) {
        // Empty piece inside a sentence would produce a quote-break, which
        // we don't want mid-sentence — replace with an empty quoted line.
        lines.push(piece.length > 0 ? `> ${piece}` : '>')
      }
      // Visual separator between sentences within the same group.
      lines.push('>')
    }
  }

  // Strip trailing empty quote markers so the blockquote ends cleanly.
  while (lines.length > 0 && lines[lines.length - 1] === '>') {
    lines.pop()
  }

  const trimmedUser = userText.trim()
  if (trimmedUser.length === 0) {
    return lines.join('\n')
  }

  return `${lines.join('\n')}\n\n${userText}`
}
