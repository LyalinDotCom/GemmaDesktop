import { sanitizeRenderableContentBlocks } from '../shared/assistantTextArtifacts'

export const CANCELLED_TURN_ID_SUFFIX = '-cancelled'
export const FAILED_TURN_ID_SUFFIX = '-failed'
export const INTERRUPTED_TURN_ID_SUFFIX = '-interrupted'
export const RECOVERED_TURN_ID_SUFFIX = '-recovered'
export const CANCELLED_TURN_WARNING = 'Generation stopped before completion.'
export const INTERRUPTED_TURN_WARNING =
  'Gemma Desktop closed before this turn finished. Partial thinking and output were preserved.'
export const RECOVERED_TURN_WARNING =
  'The primary turn stopped before it could write a final answer. Gemma Desktop recovered a summary from the available context.'

export interface InterruptedTurnMessage {
  id: string
  role: 'assistant'
  content: Array<Record<string, unknown>>
  timestamp: number
  durationMs?: number
}

interface BuildInterruptedAssistantMessageInput {
  turnId: string
  content: Array<Record<string, unknown>>
  timestamp?: number
  durationMs?: number
  idSuffix?: string
  warningMessage?: string
}

interface BuildFailedAssistantMessageInput {
  turnId: string
  content: Array<Record<string, unknown>>
  errorMessage: string
  timestamp?: number
  durationMs?: number
}

interface BuildRecoveredFailedAssistantMessageInput {
  turnId: string
  content: Array<Record<string, unknown>>
  recoveryMessage: string
  timestamp?: number
  durationMs?: number
  warningMessage?: string
}

interface ResolveInterruptedTurnTimestampInput {
  turnStartedAt: number
  history?: Array<{
    role?: string
    createdAt?: string
  }>
  appMessages?: Array<{
    role?: string
    timestamp?: number
  }>
}

function finalizeInterruptedBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  if (
    block.type === 'tool_call'
    && (block.status === 'running' || block.status === 'pending')
  ) {
    return {
      ...block,
      status: 'error',
    }
  }

  return block
}

function toFiniteTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export function resolveInterruptedTurnTimestamp(
  input: ResolveInterruptedTurnTimestampInput,
): number {
  // SDK user messages can be recorded after app-side send preflight. Anchor
  // recovered assistant content after that SDK turn so history stays readable.
  let timestamp = input.turnStartedAt + 1

  for (const message of input.history ?? []) {
    if (message.role !== 'user') {
      continue
    }

    const userTimestamp = toFiniteTimestamp(message.createdAt)
    if (userTimestamp != null) {
      timestamp = Math.max(timestamp, userTimestamp + 1)
    }
  }

  for (const message of input.appMessages ?? []) {
    if (message.role !== 'user') {
      continue
    }

    const userTimestamp = toFiniteTimestamp(message.timestamp)
    if (userTimestamp != null) {
      timestamp = Math.max(timestamp, userTimestamp + 1)
    }
  }

  return timestamp
}

export function buildInterruptedAssistantMessage(
  input: BuildInterruptedAssistantMessageInput,
): InterruptedTurnMessage | null {
  const content = sanitizeRenderableContentBlocks(
    input.content.map((block) => finalizeInterruptedBlock(block)),
  )

  if (content.length === 0) {
    return null
  }

  return {
    id: `${input.turnId}${input.idSuffix ?? INTERRUPTED_TURN_ID_SUFFIX}`,
    role: 'assistant',
    content: [
      ...content,
      {
        type: 'warning',
        message: input.warningMessage ?? INTERRUPTED_TURN_WARNING,
      },
    ],
    timestamp: input.timestamp ?? Date.now(),
    durationMs: input.durationMs,
  }
}

export function buildFailedAssistantMessage(
  input: BuildFailedAssistantMessageInput,
): InterruptedTurnMessage | null {
  const errorMessage = input.errorMessage.trim()
  const content = sanitizeRenderableContentBlocks([
    ...input.content.map((block) => finalizeInterruptedBlock(block)),
    ...(errorMessage ? [{ type: 'error', message: errorMessage }] : []),
  ])

  if (content.length === 0) {
    return null
  }

  return {
    id: `${input.turnId}${FAILED_TURN_ID_SUFFIX}`,
    role: 'assistant',
    content,
    timestamp: input.timestamp ?? Date.now(),
    durationMs: input.durationMs,
  }
}

export function buildRecoveredFailedAssistantMessage(
  input: BuildRecoveredFailedAssistantMessageInput,
): InterruptedTurnMessage | null {
  const recoveryMessage = input.recoveryMessage.trim()
  if (!recoveryMessage) {
    return null
  }

  const content = sanitizeRenderableContentBlocks([
    ...input.content.map((block) => finalizeInterruptedBlock(block)),
    {
      type: 'warning',
      message: input.warningMessage ?? RECOVERED_TURN_WARNING,
    },
    {
      type: 'text',
      text: recoveryMessage,
    },
  ])

  if (content.length === 0) {
    return null
  }

  return {
    id: `${input.turnId}${RECOVERED_TURN_ID_SUFFIX}`,
    role: 'assistant',
    content,
    timestamp: input.timestamp ?? Date.now(),
    durationMs: input.durationMs,
  }
}
