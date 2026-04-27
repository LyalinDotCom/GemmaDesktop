export type ShellSessionStatus =
  | 'running'
  | 'exited'
  | 'killed'
  | 'error'
  | 'interrupted'

export type ShellSessionDisplayMode = 'chat' | 'sidebar'

export interface ShellSessionContentBlock {
  type: 'shell_session'
  terminalId: string
  command: string
  workingDirectory: string
  status: ShellSessionStatus
  exitCode?: number | null
  startedAt: number
  completedAt?: number
  transcript: string
  collapsed: boolean
  displayMode?: ShellSessionDisplayMode
}

export const MAX_SHELL_TRANSCRIPT_CHARS = 120_000
export const DEFAULT_SHELL_PEEK_CHARS = 4_000
export const MAX_SHELL_PEEK_CHARS = 12_000
const SHELL_TRANSCRIPT_TRUNCATION_MARKER = '[older shell output truncated]\n'

export interface ShellTranscriptPeek {
  text: string
  maxChars: number
  totalChars: number
  returnedChars: number
  peekTruncated: boolean
  storageTruncated: boolean
}

export function isShellSessionContentBlock(
  value: unknown,
): value is ShellSessionContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return (value as { type?: unknown }).type === 'shell_session'
}

export function appendShellTranscript(
  currentTranscript: string,
  nextChunk: string,
  maxChars = MAX_SHELL_TRANSCRIPT_CHARS,
): string {
  if (!nextChunk) {
    return currentTranscript
  }

  const combined = `${currentTranscript}${nextChunk}`
  if (combined.length <= maxChars) {
    return combined
  }

  const retainedChars = Math.max(
    maxChars - SHELL_TRANSCRIPT_TRUNCATION_MARKER.length,
    0,
  )
  return `${SHELL_TRANSCRIPT_TRUNCATION_MARKER}${combined.slice(-retainedChars)}`
}

export function peekShellTranscript(
  transcript: string,
  maxChars = DEFAULT_SHELL_PEEK_CHARS,
): ShellTranscriptPeek {
  const normalizedMaxChars = normalizeShellPeekChars(maxChars)
  const storageTruncated = transcript.startsWith(SHELL_TRANSCRIPT_TRUNCATION_MARKER)
  const content = storageTruncated
    ? transcript.slice(SHELL_TRANSCRIPT_TRUNCATION_MARKER.length)
    : transcript
  const peekTruncated = content.length > normalizedMaxChars
  const text = peekTruncated
    ? content.slice(-normalizedMaxChars)
    : content

  return {
    text,
    maxChars: normalizedMaxChars,
    totalChars: content.length,
    returnedChars: text.length,
    peekTruncated,
    storageTruncated,
  }
}

export function formatShellCommandForChat(command: string): string {
  return `!${command}`
}

export function normalizePersistedShellBlock(
  block: ShellSessionContentBlock,
  timestamp = Date.now(),
): ShellSessionContentBlock {
  if (block.status !== 'running') {
    return block
  }

  return {
    ...block,
    status: 'interrupted',
    collapsed: true,
    completedAt: block.completedAt ?? timestamp,
  }
}

export function summarizeShellTranscript(
  transcript: string,
  maxLines = 4,
): string {
  const lines = transcript
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return ''
  }

  return lines.slice(-maxLines).join('\n')
}

function normalizeShellPeekChars(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SHELL_PEEK_CHARS
  }

  return Math.min(
    MAX_SHELL_PEEK_CHARS,
    Math.max(256, Math.floor(value)),
  )
}
