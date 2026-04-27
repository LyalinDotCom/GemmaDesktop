import { useMemo, useState } from 'react'
import { ChevronRight, File, FileText, Folder, Loader2, Search, X } from 'lucide-react'
import { RightDockShell } from '@/components/RightDockShell'
import { useWorkspaceInspection } from '@/hooks/useWorkspaceInspection'
import { filterVisibleWorkspaceEntries } from '@/lib/workspaceFileVisibility'
import {
  useSessionTouchedFiles,
  type SessionTouchEntry,
  type SessionTouchMap,
} from '@/hooks/useSessionTouchedFiles'
import { useSessionFileChanges } from '@/hooks/useSessionFileChanges'
import type { SessionDetail } from '@/types'
import type { WorkspaceFileTreeEntry, WorkspaceGitStatus } from '@shared/workspace'

type RowState = 'untouched' | 'created' | 'modified' | 'deleted'

interface TreeNode {
  key: string
  kind: 'file' | 'directory'
  name: string
  path: string
  relativePath: string
  depth: number
  touch: SessionTouchEntry | null
  gitStatus: WorkspaceGitStatus | null
  state: RowState
  children: TreeNode[]
  hasTouchedDescendant: boolean
}

function deriveState(args: {
  touch: SessionTouchEntry | null
  isReborn: boolean
  gitStatus: WorkspaceGitStatus | null
}): RowState {
  const { touch, isReborn, gitStatus } = args
  if (touch) {
    if (touch.action === 'created') return 'created'
    if (touch.action === 'modified') return 'modified'
  }
  if (isReborn) return 'modified'
  // Fall back to git state so freshly-created-but-not-yet-touched files still
  // light up as new (green). Ignored/untouched files stay neutral.
  if (gitStatus === 'untracked' || gitStatus === 'added') return 'created'
  if (
    gitStatus === 'modified'
    || gitStatus === 'renamed'
    || gitStatus === 'copied'
    || gitStatus === 'type_changed'
    || gitStatus === 'updated_unmerged'
  ) {
    return 'modified'
  }
  return 'untouched'
}

function buildTree(
  entries: WorkspaceFileTreeEntry[],
  touches: SessionTouchMap,
  rebornPaths: Set<string>,
): TreeNode[] {
  const roots: TreeNode[] = []
  const stack: TreeNode[] = []

  // Drop dotfiles/dotdirs entirely — they are visual noise for most users.
  const visibleEntries = filterVisibleWorkspaceEntries(entries)

  for (const entry of visibleEntries) {
    const touch = touches.byPath.get(entry.relativePath) ?? null
    const node: TreeNode = {
      key: `${entry.kind}:${entry.relativePath}`,
      kind: entry.kind,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      depth: entry.depth,
      touch,
      gitStatus: entry.gitStatus,
      state: deriveState({
        touch,
        isReborn: rebornPaths.has(entry.relativePath),
        gitStatus: entry.gitStatus,
      }),
      children: [],
      hasTouchedDescendant:
        (touch !== null && touch.action !== 'read')
        || rebornPaths.has(entry.relativePath),
    }

    if (entry.depth === 0) {
      roots.push(node)
    } else {
      const parent = stack[entry.depth - 1]
      if (parent) {
        parent.children.push(node)
      } else {
        roots.push(node)
      }
    }

    stack[entry.depth] = node
    stack.length = entry.depth + 1
  }

  // Propagate session activity bit up so parent directories know if anything
  // below them was touched (used for auto-expand on first reveal).
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      walk(child)
      if (child.hasTouchedDescendant) node.hasTouchedDescendant = true
    }
  }
  for (const root of roots) walk(root)

  return roots
}

/**
 * Graft ghost (deleted) file nodes into the tree under their last-known
 * parent directory. If the parent directory itself is gone we skip the
 * ghost to avoid noisy dangling rows with no context.
 */
function attachGhosts(
  roots: TreeNode[],
  ghostEntries: Map<string, WorkspaceFileTreeEntry>,
): TreeNode[] {
  if (ghostEntries.size === 0) return roots

  const dirsByPath = new Map<string, TreeNode>()
  const indexDirs = (node: TreeNode) => {
    if (node.kind === 'directory') {
      dirsByPath.set(node.relativePath, node)
    }
    for (const child of node.children) indexDirs(child)
  }
  for (const root of roots) indexDirs(root)

  for (const ghost of ghostEntries.values()) {
    const lastSep = ghost.relativePath.lastIndexOf('/')
    const parentPath = lastSep === -1 ? '' : ghost.relativePath.slice(0, lastSep)

    const ghostNode: TreeNode = {
      key: `ghost:${ghost.relativePath}`,
      kind: 'file',
      name: ghost.name,
      path: ghost.path,
      relativePath: ghost.relativePath,
      depth: ghost.depth,
      touch: null,
      gitStatus: ghost.gitStatus,
      state: 'deleted',
      children: [],
      hasTouchedDescendant: false,
    }

    if (parentPath === '') {
      roots.push(ghostNode)
      continue
    }

    const parent = dirsByPath.get(parentPath)
    if (parent) {
      parent.children.push(ghostNode)
      parent.hasTouchedDescendant = true
      // Bubble the activity marker up to ancestors so auto-expand works.
      let segments = parentPath.split('/')
      while (segments.length > 0) {
        segments = segments.slice(0, -1)
        const ancestorKey = segments.join('/')
        const ancestor = dirsByPath.get(ancestorKey)
        if (ancestor) {
          ancestor.hasTouchedDescendant = true
        }
      }
    }
    // If the parent directory is also gone we quietly drop the ghost; the
    // parent directory's own deletion signal (if we later add it) covers it.
  }

  return roots
}

type NodeMatcher = (node: TreeNode) => boolean

// If the query contains glob metacharacters (`*`/`?`) we treat it as a full
// filename pattern; otherwise it's a plain case-insensitive substring match.
// Patterns that contain a `/` are matched against the node's relative path
// so users can scope to a subtree (e.g. `src/*.ts`); otherwise only the
// basename is considered so `*.md` doesn't get derailed by a path segment.
function buildMatcher(rawQuery: string): NodeMatcher {
  const query = rawQuery.toLowerCase()
  const hasGlob = /[*?]/.test(query)

  if (!hasGlob) {
    return (node) =>
      node.name.toLowerCase().includes(query)
      || node.relativePath.toLowerCase().includes(query)
  }

  const matchPath = query.includes('/')
  const regex = new RegExp(
    '^'
    + query
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    + '$',
  )

  return (node) => {
    const target = matchPath ? node.relativePath : node.name
    return regex.test(target.toLowerCase())
  }
}

function filterTree(nodes: TreeNode[], match: NodeMatcher): TreeNode[] {
  const keep = (node: TreeNode): TreeNode | null => {
    const selfMatch = match(node)
    if (node.kind === 'file') {
      return selfMatch ? node : null
    }
    const keptChildren: TreeNode[] = []
    for (const child of node.children) {
      const kept = keep(child)
      if (kept) keptChildren.push(kept)
    }
    if (selfMatch || keptChildren.length > 0) {
      return { ...node, children: keptChildren }
    }
    return null
  }
  const result: TreeNode[] = []
  for (const node of nodes) {
    const kept = keep(node)
    if (kept) result.push(kept)
  }
  return result
}

function countFileLeaves(nodes: TreeNode[]): number {
  let total = 0
  const walk = (node: TreeNode) => {
    if (node.kind === 'file') total += 1
    for (const child of node.children) walk(child)
  }
  for (const node of nodes) walk(node)
  return total
}

function formatRowTooltip(node: TreeNode): string {
  const base = node.relativePath
  switch (node.state) {
    case 'created':
      return `${base} · created this session`
    case 'modified':
      if (node.touch?.action === 'modified') {
        const count = node.touch.count
        return `${base} · modified ${count === 1 ? 'once' : `${count}×`} this session`
      }
      return `${base} · modified this session`
    case 'deleted':
      return `${base} · deleted this session`
    case 'untouched':
    default:
      return base
  }
}

function pickFileIcon(name: string): typeof File {
  if (/\.(md|mdx|txt|log)$/i.test(name)) return FileText
  return File
}

interface FileRowProps {
  node: TreeNode
  expanded: Set<string>
  onToggleExpanded: (key: string) => void
}

function FileRow({ node, expanded, onToggleExpanded }: FileRowProps) {
  const isDirectory = node.kind === 'directory'
  const isOpen = isDirectory && expanded.has(node.key)
  const isDeleted = node.state === 'deleted'

  const dotTone =
    node.state === 'created'
      ? 'bg-emerald-500 dark:bg-emerald-400'
      : node.state === 'modified'
        ? 'bg-sky-500 dark:bg-sky-400'
        : null

  const Icon = isDirectory ? Folder : pickFileIcon(node.name)

  const nameClass = [
    'truncate',
    node.state === 'created' || node.state === 'modified' ? 'font-medium' : '',
    node.state === 'created' && !isDeleted
      ? 'text-emerald-600 dark:text-emerald-400'
      : '',
    isDeleted ? 'text-red-500/90 line-through dark:text-red-400/85' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const rowClass = [
    'group/row flex h-6 items-center gap-1 rounded px-1 text-[13px] leading-none',
    isDeleted
      ? 'text-red-500/90 dark:text-red-400/85'
      : 'text-slate-800 hover:bg-slate-200/50 dark:text-slate-200 dark:hover:bg-slate-800/50',
  ].join(' ')

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={isDirectory ? isOpen : undefined}
        className={rowClass}
        style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => {
            if (isDeleted) return // no-op; file no longer exists
            if (isDirectory) {
              onToggleExpanded(node.key)
            } else {
              void window.gemmaDesktopBridge.folders.openPath(node.path)
            }
          }}
          onDoubleClick={(event) => {
            if (isDeleted) return
            if (isDirectory) {
              event.preventDefault()
              void window.gemmaDesktopBridge.folders.openPath(node.path)
            }
          }}
          disabled={isDeleted}
          className={`flex min-w-0 flex-1 items-center gap-1 text-left ${
            isDeleted ? 'cursor-default' : ''
          }`}
          title={formatRowTooltip(node)}
        >
          <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-slate-400 dark:text-slate-500">
            {isDirectory ? (
              <ChevronRight
                size={12}
                className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
              />
            ) : null}
          </span>
          <Icon
            size={13}
            className={`shrink-0 ${
              isDeleted
                ? 'text-red-400/80 dark:text-red-400/70'
                : isDirectory
                  ? 'text-sky-500 dark:text-sky-300'
                  : 'text-slate-400 dark:text-slate-500'
            }`}
          />
          <span className={nameClass}>{node.name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1 pr-1">
          {dotTone ? (
            <span
              aria-label={formatRowTooltip(node)}
              title={formatRowTooltip(node)}
              className={`h-1.5 w-1.5 rounded-full ${dotTone}`}
            />
          ) : null}
          {!isDeleted && node.gitStatus === 'untracked' ? (
            <span
              className="font-mono text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
              title="Untracked (new)"
            >
              U
            </span>
          ) : null}
          {isDeleted ? (
            <span
              className="font-mono text-[10px] font-semibold text-red-500 dark:text-red-400"
              title="Deleted this session"
            >
              D
            </span>
          ) : null}
        </div>
      </div>
      {isDirectory && isOpen
        ? node.children.map((child) => (
            <FileRow
              key={child.key}
              node={child}
              expanded={expanded}
              onToggleExpanded={onToggleExpanded}
            />
          ))
        : null}
    </>
  )
}

export function FilesWorkspacePanel({
  workingDirectory,
  session,
  onClose,
}: {
  workingDirectory: string
  session: SessionDetail | null
  onClose?: () => void
}) {
  const {
    inspection,
    loading,
    error,
    refresh,
  } = useWorkspaceInspection(workingDirectory, true)

  const rootPath = inspection?.rootPath ?? workingDirectory
  const touches = useSessionTouchedFiles(session, rootPath)
  const files = inspection?.files
  const visibleEntries = useMemo(
    () => filterVisibleWorkspaceEntries(files?.entries ?? []),
    [files?.entries],
  )
  const fileChanges = useSessionFileChanges(visibleEntries, rootPath)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim().toLowerCase()

  const tree = useMemo(() => {
    const base = visibleEntries.length > 0
      ? buildTree(visibleEntries, touches, fileChanges.rebornPaths)
      : []
    return attachGhosts(base, fileChanges.ghostEntries)
  }, [visibleEntries, touches, fileChanges.ghostEntries, fileChanges.rebornPaths])

  const filteredTree = useMemo(
    () => (trimmedQuery ? filterTree(tree, buildMatcher(trimmedQuery)) : tree),
    [tree, trimmedQuery],
  )

  // While filtering, force every surviving directory open so matches are
  // reachable without clicking. Clearing the query restores the user's
  // previous manual expansion state.
  const effectiveExpanded = useMemo(() => {
    if (!trimmedQuery) return expanded
    const next = new Set(expanded)
    const visit = (node: TreeNode) => {
      if (node.kind === 'directory') next.add(node.key)
      for (const child of node.children) visit(child)
    }
    for (const root of filteredTree) visit(root)
    return next
  }, [expanded, trimmedQuery, filteredTree])

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const touchedCount = touches.changedCount + fileChanges.rebornPaths.size
  const deletedCount = fileChanges.ghostEntries.size
  const matchCount = trimmedQuery ? countFileLeaves(filteredTree) : 0

  const metaParts: string[] = []
  if (files) {
    if (trimmedQuery) {
      metaParts.push(`${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`)
    } else {
      metaParts.push(`${visibleEntries.length} ${visibleEntries.length === 1 ? 'item' : 'items'}`)
    }
  }
  if (touchedCount > 0) {
    metaParts.push(`${touchedCount} touched`)
  }
  if (deletedCount > 0) {
    metaParts.push(`${deletedCount} deleted`)
  }
  if (files?.truncated) {
    metaParts.push('truncated')
  }
  const meta = metaParts.length > 0 ? metaParts.join(' · ') : null

  const toolbar = inspection?.exists && !files?.error ? (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
      <Search size={13} className="shrink-0 text-zinc-400" />
      <input
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter files (supports *.ts, *.md)"
        aria-label="Filter files"
        title="Substring match, or glob when pattern contains * or ?"
        className="min-w-0 flex-1 bg-transparent text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200 dark:placeholder:text-zinc-500"
      />
      {query.length > 0 ? (
        <button
          type="button"
          onClick={() => setQuery('')}
          className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
          title="Clear filter"
          aria-label="Clear filter"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  ) : undefined

  return (
    <RightDockShell
      title="Files"
      description="Workspace browser · session changes highlighted"
      meta={meta}
      toolbar={toolbar}
      rootPath={rootPath}
      refreshing={loading}
      onRefresh={refresh}
      onClose={onClose}
    >
      {error ? (
        <div className="mx-2 rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      ) : loading && !inspection ? (
        <div className="flex min-h-[180px] items-center justify-center text-xs text-slate-500 dark:text-slate-400">
          <Loader2 size={13} className="mr-2 animate-spin" />
          Scanning files…
        </div>
      ) : !inspection?.exists ? (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          Open a workspace-backed session to browse files here.
        </div>
      ) : files?.error ? (
        <div className="mx-2 rounded border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
          {files.error}
        </div>
      ) : tree.length === 0 ? (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          No files to show.
        </div>
      ) : filteredTree.length === 0 ? (
        <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
          No files match “{query.trim()}”.
        </div>
      ) : (
        <div role="tree" className="select-none">
          {filteredTree.map((node) => (
            <FileRow
              key={node.key}
              node={node}
              expanded={effectiveExpanded}
              onToggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </RightDockShell>
  )
}
