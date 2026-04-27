import { createContext } from 'react'

/**
 * Metadata passed alongside a sentence toggle so the caller (useAppState) can
 * build a fully-formed PinnedQuote without needing a second lookup.
 */
export interface SentenceToggleIndices {
  contentBlockIndex: number
  blockIndex: number
  sentenceIndex: number
}

/**
 * Shared state for sentence-level selection within an assistant message.
 *
 * A single instance lives on an assistant `<Message>` while it is either
 * "in selection mode" or has any pinned sentences. `MarkdownContent` reads it
 * via context so the deeply-nested `SelectableSentence` span wrappers can
 * highlight / click-toggle without prop drilling.
 *
 * The context is null when the surrounding message isn't selectable at all
 * (user messages, streaming placeholders, etc.) — in that case the sentence
 * span wrappers render plain spans.
 */
export interface SelectionBlockContextValue {
  /**
   * When true, sentence spans are clickable (cursor + hover affordance).
   * When false, already-pinned sentences still render with their highlight,
   * but non-pinned sentences are inert.
   */
  selectionActive: boolean
  /**
   * Stable sentence keys that are currently pinned on the active session.
   * Keys are namespaced by `sourceMessageId` so this set is a superset of
   * everything pinned on the current message.
   */
  pinnedSentenceKeys: Set<string>
  /**
   * Fires when the user clicks a sentence while `selectionActive` is true.
   * The caller is expected to dispatch a `TOGGLE_PINNED_QUOTE` reducer action.
   */
  onToggleSentence: (
    sentenceKey: string,
    sentenceText: string,
    indices: SentenceToggleIndices,
  ) => void
  /**
   * The assistant message id these spans belong to. Used as the namespace
   * portion of each sentence key.
   */
  sourceMessageId: string
}

export const SelectionBlockContext = createContext<SelectionBlockContextValue | null>(null)
