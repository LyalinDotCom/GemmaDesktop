import type { Element, ElementContent, Root } from 'hast'
import { SKIP, visit } from 'unist-util-visit'

/**
 * Rehype plugin: wraps each sentence inside block-level elements (p, h1-h6,
 * li, blockquote) in a `<span data-sentence-key data-sentence-text>` so the
 * renderer can make individual sentences selectable / pinnable.
 *
 * Segmentation is computed against the block's flattened readable text, then
 * applied back onto the original HAST children. That keeps markdown formatting
 * intact while making one visual sentence one selectable unit, even when it
 * crosses inline `<strong>` / `<em>` / `<a>` boundaries.
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

// Cached segmenter — constructing is non-trivial and we reuse it per render.
let cachedSegmenter: Intl.Segmenter | null = null
function getSegmenter(): Intl.Segmenter {
  if (cachedSegmenter) return cachedSegmenter
  cachedSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  return cachedSegmenter
}

interface SentenceSlice {
  start: number
  end: number
  // Plain quote text for the selected range. Whitespace is collapsed because
  // markdown line breaks are visual layout, not meaningful sentence content.
  trimmedText: string
}

const NUMBERED_PREFIX_PATTERN = /^\(?\d+[.)]\s*$/
const SENTENCE_TERMINATOR_PATTERN = /[.!?…][)"'\]\u2019\u201d]*$/

function normalizeSentenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function makeSentenceSlice(value: string, start: number, end: number): SentenceSlice | null {
  const text = value.slice(start, end)
  const trimmedText = normalizeSentenceText(text)
  if (!trimmedText) return null
  return {
    start,
    end,
    trimmedText,
  }
}

function shouldMergeWithNext(slice: SentenceSlice): boolean {
  if (NUMBERED_PREFIX_PATTERN.test(slice.trimmedText)) {
    return true
  }

  return !SENTENCE_TERMINATOR_PATTERN.test(slice.trimmedText)
}

function mergeSentenceFragments(value: string, slices: SentenceSlice[]): SentenceSlice[] {
  const merged: SentenceSlice[] = []
  let pending: SentenceSlice | null = null

  for (const slice of slices) {
    if (!pending) {
      pending = slice
      continue
    }

    if (shouldMergeWithNext(pending)) {
      pending = makeSentenceSlice(value, pending.start, slice.end)
      continue
    }

    merged.push(pending)
    pending = slice
  }

  if (pending) {
    merged.push(pending)
  }

  return merged
}

function splitSentences(value: string): SentenceSlice[] {
  if (!value) return []

  // Intl.Segmenter may not be available in some older test environments.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    const slice = makeSentenceSlice(value, 0, value.length)
    return slice ? [slice] : []
  }

  const segmenter = getSegmenter()
  const out: SentenceSlice[] = []
  for (const segment of segmenter.segment(value)) {
    const raw = segment.segment
    if (!raw) continue
    const slice = makeSentenceSlice(
      value,
      segment.index,
      segment.index + raw.length,
    )
    if (slice) {
      out.push(slice)
    }
  }
  return mergeSentenceFragments(value, out)
}

function makeSentenceSpan(
  slice: SentenceSlice,
  sentenceKey: string,
  children: ElementContent[],
): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-sentence-key': sentenceKey,
      'data-sentence-text': slice.trimmedText,
    },
    children,
  }
}

function cloneElement(node: Element, children: ElementContent[]): Element {
  return {
    ...node,
    properties: {
      ...node.properties,
    },
    children,
  }
}

function getNodeSegmentText(node: ElementContent): string {
  if (node.type === 'text') {
    return node.value
  }

  if (node.type !== 'element') {
    return ''
  }

  if (node.tagName === 'br') {
    return '\n'
  }

  if (node.tagName === 'img') {
    const alt = node.properties?.alt
    return typeof alt === 'string' ? alt : ''
  }

  return node.children.map((child) => getNodeSegmentText(child)).join('')
}

function getNodesSegmentText(nodes: ElementContent[]): string {
  return nodes.map((node) => getNodeSegmentText(node)).join('')
}

function sliceNodeByTextRange(
  node: ElementContent,
  rangeStart: number,
  rangeEnd: number,
  nodeStart: number,
): ElementContent | null {
  const nodeText = getNodeSegmentText(node)
  const nodeEnd = nodeStart + nodeText.length
  if (rangeEnd <= nodeStart || nodeEnd <= rangeStart) {
    return null
  }

  if (node.type === 'text') {
    const start = Math.max(0, rangeStart - nodeStart)
    const end = Math.min(node.value.length, rangeEnd - nodeStart)
    if (end <= start) return null
    return {
      ...node,
      value: node.value.slice(start, end),
    }
  }

  if (node.type !== 'element') {
    return null
  }

  if (node.tagName === 'br' || node.tagName === 'img') {
    return cloneElement(node, [...node.children])
  }

  const children: ElementContent[] = []
  let childStart = nodeStart
  for (const child of node.children) {
    const childLength = getNodeSegmentText(child).length
    const sliced = sliceNodeByTextRange(child, rangeStart, rangeEnd, childStart)
    if (sliced) {
      children.push(sliced)
    }
    childStart += childLength
  }

  if (children.length === 0) {
    return null
  }

  return cloneElement(node, children)
}

function sliceNodesByTextRange(
  nodes: ElementContent[],
  rangeStart: number,
  rangeEnd: number,
): ElementContent[] {
  const out: ElementContent[] = []
  let nodeStart = 0

  for (const node of nodes) {
    const nodeLength = getNodeSegmentText(node).length
    const sliced = sliceNodeByTextRange(node, rangeStart, rangeEnd, nodeStart)
    if (sliced) {
      out.push(sliced)
    }
    nodeStart += nodeLength
  }

  return out
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

  const blockText = getNodesSegmentText(block.children)
  const slices = splitSentences(blockText)
  if (slices.length === 0) {
    return
  }

  const wrappedChildren: ElementContent[] = []
  let previousEnd = 0
  for (const slice of slices) {
    if (slice.start > previousEnd) {
      wrappedChildren.push(
        ...sliceNodesByTextRange(block.children, previousEnd, slice.start),
      )
    }

    const sentenceChildren = sliceNodesByTextRange(
      block.children,
      slice.start,
      slice.end,
    )
    if (sentenceChildren.length > 0) {
      wrappedChildren.push(makeSentenceSpan(slice, nextKey(), sentenceChildren))
    }
    previousEnd = slice.end
  }

  if (previousEnd < blockText.length) {
    wrappedChildren.push(
      ...sliceNodesByTextRange(block.children, previousEnd, blockText.length),
    )
  }

  block.children = wrappedChildren
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

function hasDirectBlockChild(nodes: ElementContent[]): boolean {
  return nodes.some(
    (node) => node.type === 'element' && BLOCK_TAGS.has(node.tagName),
  )
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

      if (hasDirectBlockChild(node.children)) {
        return undefined
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
      return SKIP
    })
  }
}
