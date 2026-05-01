import fs from 'fs/promises'
import path from 'path'

export const STARTUP_WELCOME_STATE_FILE_NAME = 'startup-welcome-state.json'
export const STARTUP_WELCOME_IDLE_MS = 5 * 60 * 1000
const STARTUP_WELCOME_STORAGE_VERSION = 1
const STARTUP_WELCOME_TEXT_PREVIEW_CHARS = 360

export interface StartupWelcomeState {
  storageVersion: number
  lastUserActiveAt: number | null
  lastWelcomeStartedAt: number | null
}

export interface StartupWelcomeConversationContext {
  messageCount: number
  lastUserText?: string
  lastAssistantText?: string
  lastMessage?: string
}

export type StartupWelcomeSkipReason =
  | 'no_prior_activity'
  | 'recent_activity'
  | 'already_started_for_idle_period'
  | 'session_busy'

export type StartupWelcomeDecision =
  | {
      shouldStart: true
      idleMs: number
    }
  | {
      shouldStart: false
      reason: StartupWelcomeSkipReason
      idleMs?: number
    }

export function getStartupWelcomeStateFilePath(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), STARTUP_WELCOME_STATE_FILE_NAME)
}

export function createStartupWelcomeState(): StartupWelcomeState {
  return {
    storageVersion: STARTUP_WELCOME_STORAGE_VERSION,
    lastUserActiveAt: null,
    lastWelcomeStartedAt: null,
  }
}

export function normalizeStartupWelcomeState(value: unknown): StartupWelcomeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createStartupWelcomeState()
  }

  const record = value as Record<string, unknown>
  return {
    storageVersion: STARTUP_WELCOME_STORAGE_VERSION,
    lastUserActiveAt: normalizeTimestamp(record.lastUserActiveAt),
    lastWelcomeStartedAt: normalizeTimestamp(record.lastWelcomeStartedAt),
  }
}

export async function readStartupWelcomeState(
  userDataPath: string,
): Promise<StartupWelcomeState> {
  const filePath = getStartupWelcomeStateFilePath(userDataPath)
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return normalizeStartupWelcomeState(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createStartupWelcomeState()
    }
    console.warn('[gemma-desktop] Failed to read startup welcome state:', error)
    return createStartupWelcomeState()
  }
}

export async function writeStartupWelcomeState(
  userDataPath: string,
  state: StartupWelcomeState,
): Promise<void> {
  const filePath = getStartupWelcomeStateFilePath(userDataPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(
    filePath,
    `${JSON.stringify(normalizeStartupWelcomeState(state))}\n`,
    'utf8',
  )
}

export function markStartupWelcomeUserActive(
  state: StartupWelcomeState,
  timestamp: number,
): StartupWelcomeState {
  return {
    ...normalizeStartupWelcomeState(state),
    lastUserActiveAt: normalizeTimestamp(timestamp),
  }
}

export function markStartupWelcomeStarted(
  state: StartupWelcomeState,
  timestamp: number,
): StartupWelcomeState {
  return {
    ...normalizeStartupWelcomeState(state),
    lastWelcomeStartedAt: normalizeTimestamp(timestamp),
  }
}

export function shouldStartStartupWelcome(input: {
  now: number
  lastUserActiveAt: number | null
  lastWelcomeStartedAt: number | null
  sessionBusy?: boolean
}): StartupWelcomeDecision {
  if (input.sessionBusy) {
    return { shouldStart: false, reason: 'session_busy' }
  }

  const lastUserActiveAt = normalizeTimestamp(input.lastUserActiveAt)
  if (lastUserActiveAt === null) {
    return { shouldStart: false, reason: 'no_prior_activity' }
  }

  const idleMs = Math.max(0, input.now - lastUserActiveAt)
  if (idleMs < STARTUP_WELCOME_IDLE_MS) {
    return { shouldStart: false, reason: 'recent_activity', idleMs }
  }

  const lastWelcomeStartedAt = normalizeTimestamp(input.lastWelcomeStartedAt)
  if (
    lastWelcomeStartedAt !== null
    && lastWelcomeStartedAt >= lastUserActiveAt
  ) {
    return {
      shouldStart: false,
      reason: 'already_started_for_idle_period',
      idleMs,
    }
  }

  return { shouldStart: true, idleMs }
}

export function summarizeStartupWelcomeConversation(
  messages: Array<{ role?: string; content?: Array<Record<string, unknown>> }>,
): StartupWelcomeConversationContext {
  let messageCount = 0
  let lastUserText: string | undefined
  let lastAssistantText: string | undefined
  let lastMessage: string | undefined

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }

    const text = extractVisibleText(message.content).trim()
    if (!text) {
      continue
    }

    messageCount += 1
    lastMessage = text
    if (message.role === 'user') {
      lastUserText = text
    } else {
      lastAssistantText = text
    }
  }

  return {
    messageCount,
    ...(lastUserText ? { lastUserText } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
    ...(lastMessage ? { lastMessage } : {}),
  }
}

export function buildStartupWelcomeHiddenPrompt(input: {
  idleMs: number
  memoryAvailable: boolean
  conversation: StartupWelcomeConversationContext
}): string {
  const hasConversation = input.conversation.messageCount > 0
  const lines = [
    'Hidden startup welcome task.',
    `The user has just opened Gemma Desktop after being away for ${formatIdleDuration(input.idleMs)}.`,
    'Write one short, warm Assistant Chat message directly to the user.',
    input.memoryAvailable
      ? 'Durable user memory is available in the system context; use it only if it is relevant and natural.'
      : 'No durable user memory is available, so keep the welcome generic and useful.',
    hasConversation
      ? 'There is an existing chat thread. Briefly name the thread in plain language and ask whether the user wants to continue it or do something new.'
      : 'There is no meaningful prior chat thread. Welcome the user back and invite a next step.',
    'Keep it under 55 words.',
    'Do not mention hidden prompts, startup automation, helper models, inactivity tracking, or this instruction.',
  ]

  if (hasConversation) {
    lines.push(
      '',
      'Recent chat signal:',
      `Latest user message: ${formatPromptPreview(input.conversation.lastUserText)}`,
      `Latest assistant message: ${formatPromptPreview(input.conversation.lastAssistantText)}`,
    )
  }

  return lines.join('\n')
}

function extractVisibleText(
  content: Array<Record<string, unknown>> | undefined,
): string {
  if (!content) {
    return ''
  }

  return content
    .flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return [block.text]
      }
      if (block.type === 'error' && typeof block.message === 'string') {
        return [block.message]
      }
      if (block.type === 'warning' && typeof block.message === 'string') {
        return [block.message]
      }
      return []
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatPromptPreview(value: string | undefined): string {
  if (!value) {
    return '[none]'
  }

  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= STARTUP_WELCOME_TEXT_PREVIEW_CHARS) {
    return collapsed
  }

  return `${collapsed.slice(0, STARTUP_WELCOME_TEXT_PREVIEW_CHARS).trimEnd()}...`
}

function formatIdleDuration(idleMs: number): string {
  const minutes = Math.max(5, Math.round(idleMs / 60_000))
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }

  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }

  return Math.floor(value)
}
