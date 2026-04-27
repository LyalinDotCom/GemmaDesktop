import {
  isValidElement,
  useContext,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { PluggableList } from 'unified'
import { CodeBlock } from '@/components/CodeBlock'
import { resolveAttachmentPreviewUrl } from '@/lib/inputAttachments'
import {
  SelectionBlockContext,
  type SelectionBlockContextValue,
} from '@/lib/selectionBlockContext'
import { rehypeSentenceSpans } from '@/lib/rehypeSentenceSpans'

interface MarkdownContentProps {
  text: string
  /**
   * When provided, sentences within block-level elements become individually
   * click-to-toggle via the {@link SelectionBlockContext}. Only pass this on
   * assistant messages that have a selection button visible (non-streaming).
   */
  selectionContext?: SelectionBlockContextValue | null
  /**
   * Namespace used to disambiguate sentence keys when an assistant message
   * has multiple text content blocks. Pass `content` array index.
   */
  contentBlockIndex?: number
}

const TABLE_ALIGNMENT_CELL_PATTERN = /^:?-{3,}:?$/

function splitPipeTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) {
    return null
  }

  let content = trimmed
  if (content.startsWith('|')) {
    content = content.slice(1)
  }
  if (content.endsWith('|')) {
    content = content.slice(0, -1)
  }

  const cells = content.split('|').map((cell) => cell.trim())
  return cells.length >= 2 ? cells : null
}

function normalizeAlignmentCell(cell: string): string | null {
  const stripped = cell.replace(/[^:\-\s]/g, '').replace(/\s+/g, '')
  if (!stripped || !stripped.includes('-')) {
    return null
  }

  const alignLeft = stripped.startsWith(':')
  const alignRight = stripped.endsWith(':')
  return `${alignLeft ? ':' : ''}---${alignRight ? ':' : ''}`
}

function normalizeMalformedPipeTables(text: string): string {
  const lines = text.split('\n')

  for (let index = 1; index < lines.length; index += 1) {
    const headerLine = lines[index - 1]
    const separatorLine = lines[index]
    if (headerLine == null || separatorLine == null) {
      continue
    }

    const headerCells = splitPipeTableRow(headerLine)
    if (!headerCells) {
      continue
    }

    const separatorCells = splitPipeTableRow(separatorLine)
    if (!separatorCells || separatorCells.length !== headerCells.length) {
      continue
    }

    if (separatorCells.every((cell) => TABLE_ALIGNMENT_CELL_PATTERN.test(cell))) {
      continue
    }

    const normalizedCells = separatorCells.map(normalizeAlignmentCell)
    if (normalizedCells.some((cell) => cell == null)) {
      continue
    }

    const repairedCells = normalizedCells.filter(
      (cell): cell is string => cell != null,
    )
    const indentation = separatorLine.match(/^\s*/)?.[0] ?? ''
    lines[index] = `${indentation}| ${repairedCells.join(' | ')} |`
  }

  return lines.join('\n')
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (node == null || typeof node === 'boolean') {
    return ''
  }

  if (Array.isArray(node)) {
    return (node as ReactNode[]).map((child) => extractNodeText(child)).join('')
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    const props = node.props as { children?: ReactNode }
    return extractNodeText(props.children)
  }

  return ''
}

interface SelectableSentenceProps {
  sentenceKey: string
  sentenceText: string
  children: ReactNode
}

function SelectableSentence({
  sentenceKey,
  sentenceText,
  children,
}: SelectableSentenceProps) {
  const ctx = useContext(SelectionBlockContext)
  if (!ctx) {
    return <span>{children}</span>
  }

  const isPinned = ctx.pinnedSentenceKeys.has(sentenceKey)
  const clickable = ctx.selectionActive

  const classes: string[] = ['transition-colors']
  if (isPinned) {
    classes.push(
      'rounded bg-indigo-100 px-0.5 -mx-0.5 dark:bg-indigo-900/40',
    )
  }
  if (clickable && !isPinned) {
    classes.push(
      'cursor-pointer rounded hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
    )
  }
  if (clickable && isPinned) {
    classes.push('cursor-pointer')
  }

  // Decode the indices from the sentence key:
  // `${sourceMessageId}:${contentBlockIndex}:${blockIndex}:${sentenceIndex}`
  // The sourceMessageId is unknown to us here (it may contain `:` itself), but
  // the last three segments are numeric and stable.
  const parts = sentenceKey.split(':')
  const sentenceIndex = Number(parts[parts.length - 1] ?? 0)
  const blockIndex = Number(parts[parts.length - 2] ?? 0)
  const contentBlockIndex = Number(parts[parts.length - 3] ?? 0)

  return (
    <span
      data-sentence-key={sentenceKey}
      className={classes.join(' ')}
      onClick={(event) => {
        if (!clickable) return
        const target = event.target as HTMLElement | null
        // Links and buttons stay interactive; code used to be excluded here
        // too, but now that sentence spans intentionally wrap whole blocks
        // that contain code, clicking the code counts as selecting the
        // surrounding sentence.
        if (target && target.closest('a, button')) {
          return
        }
        event.stopPropagation()
        ctx.onToggleSentence(sentenceKey, sentenceText, {
          contentBlockIndex,
          blockIndex,
          sentenceIndex,
        })
      }}
    >
      {children}
    </span>
  )
}

export function MarkdownContent({
  text,
  selectionContext,
  contentBlockIndex = 0,
}: MarkdownContentProps) {
  const normalizedText = normalizeMalformedPipeTables(text)

  const resolveMarkdownImageSrc = (src?: string): string | undefined => {
    if (!src) {
      return undefined
    }

    return resolveAttachmentPreviewUrl({ previewUrl: src }) ?? src
  }

  const handleLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    href?: string,
  ) => {
    if (!href) {
      return
    }

    event.preventDefault()
    void window.gemmaDesktopBridge.links.openTarget(href)
  }

  const rehypePlugins: PluggableList = useMemo(() => {
    const plugins: PluggableList = [rehypeHighlight, [rehypeKatex, { output: 'html' }]]
    if (selectionContext) {
      plugins.push([
        rehypeSentenceSpans,
        {
          sourceMessageId: selectionContext.sourceMessageId,
          contentBlockIndex,
        },
      ])
    }
    return plugins
  }, [selectionContext, contentBlockIndex])

  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={rehypePlugins}
      className="prose prose-sm prose-zinc dark:prose-invert max-w-none
        prose-p:my-2 prose-p:leading-relaxed
        prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold
        prose-h2:text-base prose-h3:text-sm
        prose-code:rounded prose-code:bg-zinc-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:font-normal prose-code:before:content-none prose-code:after:content-none
        dark:prose-code:bg-zinc-800
        prose-pre:my-3 prose-pre:p-0 prose-pre:bg-transparent
        prose-table:my-3 prose-table:w-full prose-table:border-collapse prose-table:overflow-hidden prose-table:rounded-xl prose-table:border prose-table:border-zinc-200 prose-table:text-[13px] dark:prose-table:border-zinc-800
        prose-thead:bg-zinc-50 dark:prose-thead:bg-zinc-900/60
        prose-th:border-b prose-th:border-zinc-200 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-[12px] prose-th:font-semibold prose-th:uppercase prose-th:tracking-wide prose-th:text-zinc-600 dark:prose-th:border-zinc-800 dark:prose-th:text-zinc-300
        prose-td:border-b prose-td:border-zinc-100 prose-td:px-3 prose-td:py-2 prose-td:align-top dark:prose-td:border-zinc-800/60
        prose-tr:even:bg-zinc-50/40 dark:prose-tr:even:bg-zinc-900/30
        prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline dark:prose-a:text-indigo-400
        prose-li:my-0.5
        prose-blockquote:border-l-2 prose-blockquote:border-zinc-200 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-zinc-600 dark:prose-blockquote:border-zinc-700 dark:prose-blockquote:text-zinc-400
        prose-strong:font-semibold prose-strong:text-zinc-800 dark:prose-strong:text-zinc-200"
      components={{
        a({ href, children, ...props }) {
          return (
            <a
              {...props}
              href={href}
              rel="noreferrer noopener"
              target="_blank"
              onClick={(event) => handleLinkClick(event, href)}
            >
              {children}
            </a>
          )
        },
        img({ src, alt, className, ...props }) {
          const resolvedSrc = resolveMarkdownImageSrc(src)
          if (!resolvedSrc) {
            return null
          }

          const mergedClassName = [
            'my-3 max-h-[28rem] max-w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-800',
            className,
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <img
              {...props}
              src={resolvedSrc}
              alt={alt ?? ''}
              loading="lazy"
              className={mergedClassName}
            />
          )
        },
        pre({ children }) {
          return <>{children}</>
        },
        table({ children }) {
          return (
            <div className="my-3 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="min-w-full border-collapse text-[13px]">
                {children}
              </table>
            </div>
          )
        },
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const code = extractNodeText(children).replace(/\n$/, '')
          const language = match?.[1]

          if (language) {
            return <CodeBlock code={code} language={language} />
          }

          return (
            <code className={className} {...props}>
              {children}
            </code>
          )
        },
        span({ children, ...props }) {
          // Sentence spans injected by rehypeSentenceSpans get wrapped with
          // click-to-toggle behaviour. All other spans (e.g. syntax highlighting
          // from rehype-highlight) fall through to the default renderer.
          const rawProps = props as Record<string, unknown>
          const sentenceKey = rawProps['data-sentence-key']
          const sentenceText = rawProps['data-sentence-text']
          if (
            typeof sentenceKey === 'string'
            && typeof sentenceText === 'string'
          ) {
            return (
              <SelectableSentence
                sentenceKey={sentenceKey}
                sentenceText={sentenceText}
              >
                {children}
              </SelectableSentence>
            )
          }
          return <span {...props}>{children}</span>
        },
      }}
    >
      {normalizedText}
    </ReactMarkdown>
  )

  if (selectionContext) {
    return (
      <SelectionBlockContext.Provider value={selectionContext}>
        {markdown}
      </SelectionBlockContext.Provider>
    )
  }

  return markdown
}
