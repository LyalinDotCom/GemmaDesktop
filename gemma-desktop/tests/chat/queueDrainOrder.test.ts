import { describe, expect, it } from 'vitest'
import { appStateReducer, initialState } from '../../src/renderer/src/hooks/appStateCore'
import { buildQueuedUserMessage } from '../../src/renderer/src/lib/queuedUserMessage'

describe('queued message ordering', () => {
  const sessionId = 'session-1'
  const m1 = buildQueuedUserMessage({ text: 'first' })
  const m2 = buildQueuedUserMessage({ text: 'second' })

  it('appends queued messages in arrival order by default', () => {
    let state = initialState
    state = appStateReducer(state, { type: 'QUEUE_MESSAGE', sessionId, message: m1 })
    state = appStateReducer(state, { type: 'QUEUE_MESSAGE', sessionId, message: m2 })
    expect(state.queuedMessagesBySession[sessionId]?.map((m) => m.text)).toEqual([
      'first',
      'second',
    ])
  })

  it('re-inserts a bounced message at the front so order is preserved', () => {
    let state = initialState
    // m1 and m2 queued; m1 was popped for draining, bounced (session busy), and
    // must go back to the front rather than behind m2.
    state = appStateReducer(state, { type: 'QUEUE_MESSAGE', sessionId, message: m2 })
    state = appStateReducer(state, {
      type: 'QUEUE_MESSAGE',
      sessionId,
      message: m1,
      front: true,
    })
    expect(state.queuedMessagesBySession[sessionId]?.map((m) => m.text)).toEqual([
      'first',
      'second',
    ])
  })
})
