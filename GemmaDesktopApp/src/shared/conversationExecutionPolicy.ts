export type ConversationExecutionTask = 'generation' | 'compaction'

export interface ConversationExecutionRun {
  sessionId: string
  task: ConversationExecutionTask
  title?: string | null
}

export const CONVERSATION_EXECUTION_BLOCKED_ERROR_CODE =
  'CONVERSATION_EXECUTION_BLOCKED'

export function findBlockingConversationExecution(
  activeRuns: Iterable<ConversationExecutionRun>,
  sessionId?: string | null,
): ConversationExecutionRun | null {
  for (const run of activeRuns) {
    if (!sessionId || run.sessionId !== sessionId) {
      return run
    }
  }

  return null
}

export function buildConversationExecutionBlockedMessage(
  blocker: ConversationExecutionRun,
): string {
  return `${CONVERSATION_EXECUTION_BLOCKED_ERROR_CODE}: ${formatConversationExecutionBlockedReason(blocker)}`
}

export function formatConversationExecutionBlockedReason(
  blocker: ConversationExecutionRun,
): string {
  const title = blocker.title?.trim()
  const label = title ? `"${title}"` : 'another conversation'
  const action = blocker.task === 'compaction' ? 'compacting' : 'answering'

  return `Gemma Desktop is already ${action} in ${label}. Wait for that conversation to finish or stop it before starting another one.`
}

export function isConversationExecutionBlockedError(message: string): boolean {
  return message.includes(CONVERSATION_EXECUTION_BLOCKED_ERROR_CODE)
}

export function stripConversationExecutionBlockedErrorCode(message: string): string {
  return message.replace(`${CONVERSATION_EXECUTION_BLOCKED_ERROR_CODE}: `, '')
}
