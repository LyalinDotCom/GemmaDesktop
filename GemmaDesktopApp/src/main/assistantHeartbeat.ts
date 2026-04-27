import type { SessionMessage } from '@gemma-desktop/sdk-core'

export type AssistantHeartbeatDecision = {
  action: 'noop' | 'complete' | 'restart'
  completionMessage?: string
  restartInstruction?: string
}

export interface AssistantHelperActivity {
  consultedForTurnAudit?: boolean
  completedTurnMessage?: boolean
  restartedTurn?: boolean
  recoveredFailedTurn?: boolean
  restartInstruction?: string | null
  completionMessage?: string | null
}

function normalizeTrimmedText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) {
    return undefined
  }

  return trimmed.slice(0, maxLength).trim() || undefined
}

function normalizeCompletionText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!normalized) {
    return undefined
  }

  return normalized.slice(0, maxLength).trim() || undefined
}

export function normalizeAssistantCompletionMessage(
  value: unknown,
  maxLength = 1_200,
): string | undefined {
  return normalizeCompletionText(value, maxLength)
}

export function normalizeAssistantHeartbeatDecision(
  value: unknown,
): AssistantHeartbeatDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { action: 'noop' }
  }

  const record = value as {
    action?: unknown
    completionMessage?: unknown
    restartInstruction?: unknown
  }
  const action =
    record.action === 'complete'
    || record.action === 'restart'
    || record.action === 'noop'
      ? record.action
      : 'noop'

  const completionMessage = normalizeCompletionText(record.completionMessage, 900)
  const restartInstruction = normalizeTrimmedText(record.restartInstruction, 700)

  if (action === 'complete' && completionMessage) {
    return {
      action,
      completionMessage,
    }
  }

  if (action === 'restart' && restartInstruction) {
    return {
      action,
      restartInstruction,
    }
  }

  return { action: 'noop' }
}

export function buildAssistantHelperToolSummary(
  activity: AssistantHelperActivity,
): string {
  if (activity.recoveredFailedTurn) {
    return 'Recovered the failed turn'
  }

  if (activity.restartedTurn) {
    return 'Restarted the turn once'
  }

  if (activity.completedTurnMessage) {
    return 'Finished the missing completion'
  }

  if (activity.consultedForTurnAudit) {
    return 'Checked the final answer'
  }

  return 'Consulted Gemma low in the background'
}

export function buildAssistantHelperToolOutput(
  activity: AssistantHelperActivity,
): string | undefined {
  const lines: string[] = []

  if (activity.recoveredFailedTurn) {
    lines.push('Recovered a final message after the primary turn failed.')
  } else if (activity.restartedTurn) {
    lines.push('Restarted the turn once with a hidden steer.')
  } else if (activity.completedTurnMessage) {
    lines.push('Added a missing final completion message.')
  } else if (activity.consultedForTurnAudit) {
    lines.push('Checked the finished turn and no restart was needed.')
  }

  return lines.length > 0 ? lines.join('\n') : undefined
}

export function applyAssistantCompletionMessage(
  content: Array<Record<string, unknown>>,
  completionMessage: string,
): Array<Record<string, unknown>> {
  const normalized = completionMessage.trim()
  if (!normalized) {
    return content
  }

  const next = content.map((block) => ({ ...block }))
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const block = next[index]
    if (block?.type !== 'text') {
      continue
    }

    next[index] = {
      ...block,
      text: normalized,
    }
    return next
  }

  next.push({
    type: 'text',
    text: normalized,
  })
  return next
}

export function stripHiddenAssistantHeartbeatMessages(
  history: SessionMessage[],
  input: {
    previousAssistantMessageId?: string
    previousHistoryLength: number
  },
): SessionMessage[] {
  const prefix = history.slice(0, input.previousHistoryLength)
  const suffix = history.slice(input.previousHistoryLength)

  const hiddenUserIndex = suffix.findIndex((message) => message.role === 'user')
  const filteredSuffix = suffix.filter((_, index) => index !== hiddenUserIndex)
  const filteredPrefix = input.previousAssistantMessageId
    ? prefix.filter((message) => message.id !== input.previousAssistantMessageId)
    : prefix

  return [...filteredPrefix, ...filteredSuffix]
}
