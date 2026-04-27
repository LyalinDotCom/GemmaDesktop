import type {
  LiveActivitySnapshot,
  MessageContent,
  PendingCompaction,
  PendingToolApproval,
} from '@/types'

export type ConversationUiControlLockReason =
  | 'generation'
  | 'compaction'
  | 'tool_approval'
  | 'live_activity'
  | 'streaming_content'
  | 'submitting'

export interface ConversationUiControlLock {
  locked: boolean
  reason: ConversationUiControlLockReason | null
  label: string
}

interface ConversationUiControlLockInput {
  isGenerating?: boolean
  isCompacting?: boolean
  submitting?: boolean
  pendingCompaction?: PendingCompaction | null
  pendingToolApproval?: PendingToolApproval | null
  liveActivity?: LiveActivitySnapshot | null
  streamingContent?: MessageContent[] | null
}

export const UNLOCKED_CONVERSATION_UI_CONTROLS: ConversationUiControlLock = {
  locked: false,
  reason: null,
  label: 'Ready',
}

export function buildConversationUiControlLock(
  input: ConversationUiControlLockInput,
): ConversationUiControlLock {
  if (input.isCompacting || input.pendingCompaction?.status === 'running') {
    return {
      locked: true,
      reason: 'compaction',
      label: 'Compacting',
    }
  }

  if (input.isGenerating) {
    return {
      locked: true,
      reason: 'generation',
      label: 'Agent is working',
    }
  }

  if (input.pendingToolApproval) {
    return {
      locked: true,
      reason: 'tool_approval',
      label: 'Waiting for tool approval',
    }
  }

  if (input.liveActivity) {
    return {
      locked: true,
      reason: 'live_activity',
      label: 'Agent is working',
    }
  }

  if ((input.streamingContent?.length ?? 0) > 0) {
    return {
      locked: true,
      reason: 'streaming_content',
      label: 'Agent is working',
    }
  }

  if (input.submitting) {
    return {
      locked: true,
      reason: 'submitting',
      label: 'Sending message',
    }
  }

  return UNLOCKED_CONVERSATION_UI_CONTROLS
}

export function getConversationUiActionLockedTitle(
  lock: ConversationUiControlLock,
  action: 'copy' | 'read_aloud' | 'selection',
): string {
  const runLabel = describeConversationUiLockProgress(lock)

  switch (action) {
    case 'copy':
      return `Wait for the ${runLabel} to finish before copying this turn.`
    case 'read_aloud':
      return `Wait for the ${runLabel} to finish before using read aloud.`
    case 'selection':
      return `Wait for the ${runLabel} to finish before selecting sentences.`
  }
}

function describeConversationUiLockProgress(
  lock: ConversationUiControlLock,
): string {
  switch (lock.reason) {
    case 'compaction':
      return 'compaction'
    case 'tool_approval':
      return 'tool approval'
    case 'submitting':
      return 'message send'
    case 'generation':
    case 'live_activity':
    case 'streaming_content':
    case null:
      return 'session run'
  }
}
