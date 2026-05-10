import type { ConversationKind } from '@/types'

interface SessionQueuePolicyInput {
  conversationKind: ConversationKind
  planMode: boolean
}

export function canQueueMessageWhileBusy(
  input: SessionQueuePolicyInput,
): boolean {
  return input.conversationKind !== 'research' && !input.planMode
}

export function getBusyQueueBlockedReason(
  input: SessionQueuePolicyInput,
): string {
  if (input.conversationKind === 'research') {
    return 'Wait for deep research to finish before sending another prompt.'
  }

  if (input.planMode) {
    return 'Wait for plan mode to finish before sending another prompt.'
  }

  return 'Queue the next message while this turn runs.'
}
