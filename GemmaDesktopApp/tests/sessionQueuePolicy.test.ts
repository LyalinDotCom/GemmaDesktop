import { describe, expect, it } from 'vitest'
import {
  canQueueMessageWhileBusy,
  getBusyQueueBlockedReason,
} from '../src/renderer/src/lib/sessionQueuePolicy'

describe('session queue policy', () => {
  it('allows busy-message queueing for normal work conversations', () => {
    expect(
      canQueueMessageWhileBusy({
        conversationKind: 'normal',
        planMode: false,
      }),
    ).toBe(true)
  })

  it('blocks busy-message queueing in plan mode', () => {
    expect(
      canQueueMessageWhileBusy({
        conversationKind: 'normal',
        planMode: true,
      }),
    ).toBe(false)
    expect(
      getBusyQueueBlockedReason({
        conversationKind: 'normal',
        planMode: true,
      }),
    ).toBe('Wait for plan mode to finish before sending another prompt.')
  })

  it('blocks busy-message queueing in research conversations', () => {
    expect(
      canQueueMessageWhileBusy({
        conversationKind: 'research',
        planMode: false,
      }),
    ).toBe(false)
    expect(
      getBusyQueueBlockedReason({
        conversationKind: 'research',
        planMode: false,
      }),
    ).toBe('Wait for deep research to finish before sending another prompt.')
  })
})
