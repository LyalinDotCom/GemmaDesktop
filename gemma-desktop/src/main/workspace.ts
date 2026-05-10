import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  WorkspaceFileTreeEntry,
  WorkspaceGitEntry,
  WorkspaceGitInspection,
  WorkspaceGitStatus,
  WorkspaceInspection,
} from '../shared/workspace'

const execFileAsync = promisify(execFile)

const MAX_FILE_TREE_DEPTH = 8
const MAX_FILE_TREE_ENTRIES = 5000
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.packaging',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

function normalizeWorkspaceError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : 'Workspace inspection failed.'
}

function deriveGitStatus(code: string): WorkspaceGitStatus {
  if (code === '??') return 'untracked'
  if (code === '!!') return 'ignored'
  if (code.includes('U')) return 'updated_unmerged'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('T')) return 'type_changed'
  return 'modified'
}

function parseGitStatusOutput(stdout: string): {
  branch: string | null
  entries: WorkspaceGitEntry[]
} {
  const entries: WorkspaceGitEntry[] = []
  let branch: string | null = null

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) {
      continue
    }

    if (line.startsWith('## ')) {
      const branchSummary = line.slice(3).trim()
      if (branchSummary.startsWith('HEAD ')) {
        branch = 'Detached HEAD'
      } else {
        branch = branchSummary.split('...')[0]?.trim() ?? branchSummary
      }
      continue
    }

    if (line.length < 4) {
      continue
    }

    const statusCode = line.slice(0, 2)
    const rawPath = line.slice(3).trim()
    const normalizedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim() ?? rawPath
      : rawPath

    entries.push({
      path: normalizedPath,
      statusCode,
      status: deriveGitStatus(statusCode),
      staged: statusCode[0] !== ' ' && statusCode[0] !== '?' && statusCode[0] !== '!',
      unstaged: statusCode[1] !== ' ' && statusCode[1] !== '?' && statusCode[1] !== '!',
    })
  }

  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { branch, entries }
}

async function inspectGit(rootPath: string): Promise<WorkspaceGitInspection> {
  try {
    const [repoRootResult, statusResult] = await Promise.all([
      execFileAsync('git', ['-C', rootPath, 'rev-parse', '--show-toplevel'], {
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(
        'git',
        ['-C', rootPath, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'],
        { maxBuffer: 1024 * 1024 * 8 },
      ),
    ])

    const parsed = parseGitStatusOutput(statusResult.stdout)
    return {
      available: true,
      repoRoot: repoRootResult.stdout.trim() || rootPath,
      branch: parsed.branch,
      dirty: parsed.entries.some((entry) => entry.status !== 'ignored'),
      entries: parsed.entries,
      error: null,
    }
  } catch (error) {
    const message = normalizeWorkspaceError(error)
    if (
      /not a git repository/i.test(message)
      || /cannot change to/i.test(message)
      || /unknown option/i.test(message)
    ) {
      return {
        available: false,
        repoRoot: null,
        branch: null,
        dirty: false,
        entries: [],
        error: null,
      }
    }

    return {
      available: false,
      repoRoot: null,
      branch: null,
      dirty: false,
      entries: [],
      error: message,
    }
  }
}

async function inspectFiles(
  rootPath: string,
  changedPaths: Map<string, WorkspaceGitStatus>,
): Promise<WorkspaceInspection['files']> {
  let emittedCount = 0
  let truncated = false

  const walk = async (
    currentPath: string,
    depth: number,
  ): Promise<{ entries: WorkspaceFileTreeEntry[]; changed: boolean }> => {
    let dirEntries
    try {
      dirEntries = await fs.readdir(currentPath, {
        withFileTypes: true,
        encoding: 'utf8',
      })
    } catch (error) {
      throw new Error(normalizeWorkspaceError(error))
    }

    const visibleEntries = dirEntries
      .filter((entry) => !IGNORED_DIRECTORY_NAMES.has(entry.name))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })

    const collected: WorkspaceFileTreeEntry[] = []
    let subtreeChanged = false

    for (const dirEntry of visibleEntries) {
      if (emittedCount >= MAX_FILE_TREE_ENTRIES) {
        truncated = true
        break
      }

      const absolutePath = path.join(currentPath, dirEntry.name)
      const relativePath = path.relative(rootPath, absolutePath)
      if (relativePath.length === 0) {
        continue
      }

      if (dirEntry.isDirectory()) {
        const directoryEntry: WorkspaceFileTreeEntry = {
          path: absolutePath,
          relativePath,
          name: dirEntry.name,
          depth,
          kind: 'directory',
          changed: false,
          gitStatus: null,
        }
        emittedCount += 1
        collected.push(directoryEntry)

        if (depth < MAX_FILE_TREE_DEPTH) {
          const nested = await walk(absolutePath, depth + 1)
          directoryEntry.changed = nested.changed
          subtreeChanged = subtreeChanged || nested.changed
          collected.push(...nested.entries)
        }
        continue
      }

      if (!dirEntry.isFile()) {
        continue
      }

      const gitStatus = changedPaths.get(relativePath) ?? null
      const changed = gitStatus !== null
      if (changed) {
        subtreeChanged = true
      }

      collected.push({
        path: absolutePath,
        relativePath,
        name: dirEntry.name,
        depth,
        kind: 'file',
        changed,
        gitStatus,
      })
      emittedCount += 1
    }

    return {
      entries: collected,
      changed: subtreeChanged,
    }
  }

  try {
    const walked = await walk(rootPath, 0)
    return {
      truncated,
      scannedEntryCount: walked.entries.length,
      entries: walked.entries,
      error: null,
    }
  } catch (error) {
    return {
      truncated: false,
      scannedEntryCount: 0,
      entries: [],
      error: normalizeWorkspaceError(error),
    }
  }
}

export async function inspectWorkspace(
  workingDirectory: string,
): Promise<WorkspaceInspection> {
  const rootPath = path.resolve(workingDirectory)

  try {
    await fs.access(rootPath)
  } catch {
    return {
      rootPath,
      exists: false,
      git: {
        available: false,
        repoRoot: null,
        branch: null,
        dirty: false,
        entries: [],
        error: null,
      },
      files: {
        truncated: false,
        scannedEntryCount: 0,
        entries: [],
        error: null,
      },
      inspectedAt: new Date().toISOString(),
    }
  }

  const git = await inspectGit(rootPath)
  const changedPaths = new Map<string, WorkspaceGitStatus>()
  for (const entry of git.entries) {
    if (entry.status === 'ignored') {
      continue
    }
    changedPaths.set(entry.path, entry.status)
  }

  const files = await inspectFiles(rootPath, changedPaths)
  return {
    rootPath,
    exists: true,
    git,
    files,
    inspectedAt: new Date().toISOString(),
  }
}
