export type WorkspaceGitStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'updated_unmerged'
  | 'untracked'
  | 'ignored'

export interface WorkspaceGitEntry {
  path: string
  statusCode: string
  status: WorkspaceGitStatus
  staged: boolean
  unstaged: boolean
}

export interface WorkspaceGitInspection {
  available: boolean
  repoRoot: string | null
  branch: string | null
  dirty: boolean
  entries: WorkspaceGitEntry[]
  error: string | null
}

export interface WorkspaceFileTreeEntry {
  path: string
  relativePath: string
  name: string
  depth: number
  kind: 'directory' | 'file'
  changed: boolean
  gitStatus: WorkspaceGitStatus | null
}

export interface WorkspaceFilesInspection {
  truncated: boolean
  scannedEntryCount: number
  entries: WorkspaceFileTreeEntry[]
  error: string | null
}

export interface WorkspaceInspection {
  rootPath: string
  exists: boolean
  git: WorkspaceGitInspection
  files: WorkspaceFilesInspection
  inspectedAt: string
}
