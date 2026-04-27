import path from 'node:path'
import type { FileEditArtifact } from '@gemma-desktop/sdk-core'
import type { FileEditContentBlock } from '../shared/fileEdits'

const MUTATION_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'workspace_editor_agent',
])

function toUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toDisplayPath(rawPath: string, workingDirectory: string): string {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) {
    return trimmed
  }

  const normalizedRoot = workingDirectory.replace(/\/+$/, '')
  if (normalizedRoot.length > 0) {
    if (trimmed === normalizedRoot) {
      return path.basename(trimmed)
    }

    const prefix = `${normalizedRoot}/`
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length)
    }
  }

  return trimmed.replace(/^\.\/+/, '')
}

function normalizeFileEditArtifact(
  value: unknown,
  workingDirectory: string,
): FileEditContentBlock | null {
  const record = toUnknownRecord(value) as Partial<FileEditArtifact>
  if (
    typeof record.path !== 'string'
    || (record.changeType !== 'created' && record.changeType !== 'edited')
    || typeof record.addedLines !== 'number'
    || typeof record.removedLines !== 'number'
    || typeof record.diff !== 'string'
  ) {
    return null
  }

  return {
    type: 'file_edit',
    path: toDisplayPath(record.path, workingDirectory),
    changeType: record.changeType,
    addedLines: record.addedLines,
    removedLines: record.removedLines,
    diff: record.diff,
    ...(record.truncated === true ? { truncated: true } : {}),
  }
}

export function extractFileEditBlocksFromToolResult(input: {
  toolName?: string
  structuredOutput?: unknown
  workingDirectory: string
}): FileEditContentBlock[] {
  if (!input.toolName || !MUTATION_TOOL_NAMES.has(input.toolName)) {
    return []
  }

  const structured = toUnknownRecord(input.structuredOutput)
  if (input.toolName === 'workspace_editor_agent') {
    const appliedWrites = Array.isArray(structured.appliedWrites)
      ? structured.appliedWrites
      : []

    return appliedWrites
      .map((entry) => normalizeFileEditArtifact(toUnknownRecord(entry).edit, input.workingDirectory))
      .filter((entry): entry is FileEditContentBlock => Boolean(entry))
  }

  const directEdit = normalizeFileEditArtifact(structured.edit, input.workingDirectory)
  return directEdit ? [directEdit] : []
}
