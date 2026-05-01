import { describe, expect, it } from 'vitest'
import {
  buildConversationExecutionBlockedMessage,
  findBlockingConversationExecution,
  formatConversationExecutionBlockedReason,
  isConversationExecutionBlockedError,
  stripConversationExecutionBlockedErrorCode,
} from '../../src/shared/conversationExecutionPolicy'

describe('conversation execution policy', () => {
  it('finds only other running conversations as blockers', () => {
    const runs = [
      { sessionId: 'current', task: 'generation' as const, title: 'Current' },
      { sessionId: 'other', task: 'compaction' as const, title: 'Other' },
    ]

    expect(findBlockingConversationExecution(runs, 'current')).toEqual({
      sessionId: 'other',
      task: 'compaction',
      title: 'Other',
    })
    expect(findBlockingConversationExecution(runs.slice(0, 1), 'current')).toBeNull()
  })

  it('finds any running conversation when starting a new conversation', () => {
    const runs = [
      { sessionId: 'running', task: 'generation' as const, title: 'Research' },
    ]

    expect(findBlockingConversationExecution(runs)).toEqual({
      sessionId: 'running',
      task: 'generation',
      title: 'Research',
    })
  })

  it('builds detectable user-facing blocked messages', () => {
    const reason = formatConversationExecutionBlockedReason({
      sessionId: 'other',
      task: 'generation',
      title: 'Build notes',
    })
    const message = buildConversationExecutionBlockedMessage({
      sessionId: 'other',
      task: 'generation',
      title: 'Build notes',
    })

    expect(reason).toBe(
      'Gemma Desktop is already answering in "Build notes". Wait for that conversation to finish or stop it before starting another one.',
    )
    expect(isConversationExecutionBlockedError(message)).toBe(true)
    expect(stripConversationExecutionBlockedErrorCode(message)).toBe(reason)
  })

  it('describes active automations as execution blockers', () => {
    const reason = formatConversationExecutionBlockedReason({
      sessionId: 'automation:nightly',
      task: 'automation',
      title: 'Nightly build check',
    })

    expect(reason).toBe(
      'Gemma Desktop is already running an automation in "Nightly build check". Wait for that conversation to finish or stop it before starting another one.',
    )
  })
})
