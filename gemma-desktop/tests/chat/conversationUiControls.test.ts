import { describe, expect, it } from 'vitest'
import {
  buildConversationUiControlLock,
  getConversationUiActionLockedTitle,
} from '../../src/renderer/src/lib/conversationUiControls'

describe('conversation UI controls', () => {
  it('locks controls for every active run signal in priority order', () => {
    expect(buildConversationUiControlLock({}).locked).toBe(false)

    expect(buildConversationUiControlLock({
      isGenerating: true,
    })).toMatchObject({
      locked: true,
      reason: 'generation',
    })

    expect(buildConversationUiControlLock({
      isGenerating: true,
      isCompacting: true,
    })).toMatchObject({
      locked: true,
      reason: 'compaction',
    })

    expect(buildConversationUiControlLock({
      pendingToolApproval: {
        id: 'approval-1',
        toolName: 'write_file',
        argumentsSummary: 'file edit',
        reason: 'Needs approval',
        requestedAt: 1000,
      },
    })).toMatchObject({
      locked: true,
      reason: 'tool_approval',
    })

    expect(buildConversationUiControlLock({
      streamingContent: [{ type: 'text', text: 'Partial response' }],
    })).toMatchObject({
      locked: true,
      reason: 'streaming_content',
    })
  })

  it('uses action-specific lock copy', () => {
    const lock = buildConversationUiControlLock({ isGenerating: true })

    expect(getConversationUiActionLockedTitle(lock, 'selection')).toBe(
      'Wait for the session run to finish before selecting sentences.',
    )
    expect(getConversationUiActionLockedTitle(lock, 'read_aloud')).toBe(
      'Wait for the session run to finish before using read aloud.',
    )
    expect(getConversationUiActionLockedTitle(lock, 'copy')).toBe(
      'Wait for the session run to finish before copying this turn.',
    )
  })
})
