export const START_BACKGROUND_PROCESS_TOOL = 'start_background_process'
export const PEEK_BACKGROUND_PROCESS_TOOL = 'peek_background_process'
export const TERMINATE_BACKGROUND_PROCESS_TOOL = 'terminate_background_process'

export interface RunningBackgroundProcessSummary {
  terminalId: string
  command: string
  workingDirectory: string
  startedAt: number
  previewText: string
  previewUrl?: string
}

export const BACKGROUND_PROCESS_TOOL_NAMES = [
  START_BACKGROUND_PROCESS_TOOL,
  PEEK_BACKGROUND_PROCESS_TOOL,
  TERMINATE_BACKGROUND_PROCESS_TOOL,
] as const

export type BackgroundProcessToolName =
  (typeof BACKGROUND_PROCESS_TOOL_NAMES)[number]

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi
const LOCAL_ADDRESS_PATTERN =
  /(?:^|[\s(])((?:localhost|(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)(?:[/?#][^\s<>"'`]*)?)/gi

function trimUrlCandidate(input: string): string {
  let trimmed = input.trim().replace(/^['"`<]+|['"`>]+$/g, '')
  while (/[.,;:]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1).trimEnd()
  }
  while (
    /[)\]}]+$/.test(trimmed)
    && (trimmed.match(/[)\]}]/g)?.length ?? 0) > (trimmed.match(/[([{]/g)?.length ?? 0)
  ) {
    trimmed = trimmed.slice(0, -1).trimEnd()
  }
  return trimmed
}

function isLocalPreviewHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || /^127\./.test(normalized)
}

function normalizePreviewUrlCandidate(
  input: string,
  hasProtocol: boolean,
): string | null {
  const trimmed = trimUrlCandidate(input)
  if (!trimmed) {
    return null
  }

  const candidate = hasProtocol ? trimmed : `http://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    if (!isLocalPreviewHostname(parsed.hostname)) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

export function extractBackgroundProcessPreviewUrl(output: string): string | null {
  const normalized = output.replace(ANSI_ESCAPE_PATTERN, ' ')

  for (const match of normalized.matchAll(HTTP_URL_PATTERN)) {
    const url = normalizePreviewUrlCandidate(match[0], true)
    if (url) {
      return url
    }
  }

  for (const match of normalized.matchAll(LOCAL_ADDRESS_PATTERN)) {
    const candidate = match[1]
    if (!candidate) {
      continue
    }
    const url = normalizePreviewUrlCandidate(candidate, false)
    if (url) {
      return url
    }
  }

  return null
}
