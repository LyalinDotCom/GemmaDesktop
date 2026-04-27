import type { Element, ElementContent, Root, Text } from 'hast'
import { SKIP, visit } from 'unist-util-visit'

/**
 * Rehype plugin: wraps each sentence inside block-level elements (p, h1-h6,
 * li, blockquote) in a `<span data-sentence-key data-sentence-text>` so the
 * renderer can make individual sentences selectable / pinnable.
 *
 * v1 simplification — segmentation operates per text-node. If a sentence spans
 * multiple text nodes because of inline `<strong>` / `<em>` / `<a>`, each
 * text-node fragment becomes its own sentence span with a unique key. Clicking
 * any fragment pins that fragment's text. A follow-up can flatten the block to
 * unify cross-fragment sentences.
 *
 * The plugin is keyed on `sourceMessageId` + `contentBlockIndex` so sentence
 * keys are globally unique across multi-content-block messages.
 */
export interface RehypeSentenceSpansOptions {
  sourceMessageId: string
  contentBlockIndex: number
}

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
])

// Elements we never descend into for sentence wrapping — code and
// pre-formatted content should stay as-is.
const SKIP_TAGS = new Set([
  'code',
  'pre',
  'script',
  'style',
  'table',
])

// Cached segmenter — constructing is non-trivial and we reuse it per render.
let cachedSegmenter: Intl.Segmenter | null = null
function getSegmenter(): Intl.Segmenter {
  if (cachedSegmenter) return cachedSegmenter
  cachedSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  return cachedSegmenter
}

interface SentenceSlice {
  text: string
  // Offset within the original text-node value (after a leading-space trim
  // that Intl.Segmenter applies).
  trimmedText: string
}

function splitSentences(value: string): SentenceSlice[] {
  if (!value) return []

  // Intl.Segmenter may not be available in some older test environments.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    const trimmed = value.trim()
    return trimmed ? [{ text: value, trimmedText: trimmed }] : []
  }

  const segmenter = getSegmenter()
  const out: SentenceSlice[] = []
  for (const segment of segmenter.segment(value)) {
    const raw = segment.segment
    if (!raw) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    out.push({ text: raw, trimmedText: trimmed })
  }
  return out
}

function makeSentenceSpan(
  slice: SentenceSlice,
  sentenceKey: string,
): Element {
  const textNode: Text = {
    type: 'text',
    value: slice.text,
  }
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-sentence-key': sentenceKey,
      'data-sentence-text': slice.trimmedText,
    },
    children: [textNode],
  }
}

function wrapBlockChildren(
  block: Element,
  sourceMessageId: string,
  contentBlockIndex: number,
  blockIndex: number,
): void {
  let sentenceCounter = 0
  const nextKey = () =>
    `${sourceMessageId}:${contentBlockIndex}:${blockIndex}:${sentenceCounter++}`

  const walk = (children: ElementContent[]): ElementContent[] => {
    const out: ElementContent[] = []
    for (const child of children) {
      if (child.type === 'text') {
        const slices = splitSentences(child.value)
        if (slices.length === 0) {
          // Pure whitespace — keep as-is to preserve layout.
          out.push(child)
          continue
        }
        for (const slice of slices) {
          out.push(makeSentenceSpan(slice, nextKey()))
        }
        continue
      }

      if (child.type === 'element') {
        if (SKIP_TAGS.has(child.tagName)) {
          out.push(child)
          continue
        }
        // Recurse into inline children (strong, em, a, etc).
        child.children = walk(child.children)
        out.push(child)
        continue
      }

      out.push(child)
    }
    return out
  }

  block.children = walk(block.children)
}

/**
 * Flatten descendant text for use as `data-sentence-text` when we wrap a
 * whole block (or a `<pre>`) as a single sentence. We deliberately join with
 * a space so pinned code snippets don't render as one glued-together token.
 */
function extractPlainText(nodes: ElementContent[]): string {
  const parts: string[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      parts.push(node.value)
    } else if (node.type === 'element') {
      parts.push(extractPlainText(node.children))
    }
  }
  return parts.join('')
}

function hasCodeDescendant(nodes: ElementContent[]): boolean {
  for (const node of nodes) {
    if (node.type !== 'element') continue
    if (node.tagName === 'code' || node.tagName === 'pre') return true
    if (hasCodeDescendant(node.children)) return true
  }
  return false
}

/**
 * Wrap the block's entire contents in a single sentence span. Used when the
 * block contains code (inline or fenced) — splitting around code tags would
 * fragment a sentence mid-snippet and leave the snippet itself unclickable.
 */
function wrapBlockAsSingleSentence(block: Element, sentenceKey: string): void {
  const trimmed = extractPlainText(block.children).trim()
  if (!trimmed) return
  const wrapper: Element = {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-sentence-key': sentenceKey,
      'data-sentence-text': trimmed,
    },
    children: block.children,
  }
  block.children = [wrapper]
}

export function rehypeSentenceSpans(options: RehypeSentenceSpansOptions) {
  const { sourceMessageId, contentBlockIndex } = options

  return (tree: Root) => {
    let blockCounter = 0
    const keyFor = (blockIndex: number) =>
      `${sourceMessageId}:${contentBlockIndex}:${blockIndex}:0`

    visit(tree, 'element', (node: Element) => {
      // Fenced code block — wrap the whole <pre> as a single selectable unit
      // and don't descend (avoids sentence-wrapping the <code> inside).
      if (node.tagName === 'pre') {
        const blockIndex = blockCounter++
        wrapBlockAsSingleSentence(node, keyFor(blockIndex))
        return SKIP
      }

      if (!BLOCK_TAGS.has(node.tagName)) {
        return
      }

      const blockIndex = blockCounter++

      // If this block contains any code (inline `<code>` or fenced), treat
      // the whole block as one sentence. Segmenting around the code tag
      // would (a) fragment the surrounding sentence at code boundaries and
      // (b) leave the code itself unselectable. One unit is what the user
      // wants here.
      if (hasCodeDescendant(node.children)) {
        wrapBlockAsSingleSentence(node, keyFor(blockIndex))
        return SKIP
      }

      wrapBlockChildren(node, sourceMessageId, contentBlockIndex, blockIndex)
      return undefined
    })
  }
}
