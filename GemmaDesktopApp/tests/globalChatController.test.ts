import { describe, expect, it } from 'vitest'
import { GlobalChatController } from '../src/main/globalChat'
import { buildFallbackGlobalChatState } from '../src/shared/globalChat'

describe('GlobalChatController', () => {
  it('starts on the built-in fallback target', () => {
    const controller = new GlobalChatController()

    expect(controller.getState()).toEqual(buildFallbackGlobalChatState())
    expect(controller.getState('talk-00000000-0000-4000-8000-000000000000'))
      .toEqual(buildFallbackGlobalChatState(
        'talk-00000000-0000-4000-8000-000000000000',
      ))
  })

  it('assigns and clears a normal conversation target', () => {
    const controller = new GlobalChatController()

    expect(controller.assignSession('session-alpha')).toBe(true)
    expect(controller.getState()).toEqual({
      assignedSessionId: 'session-alpha',
      target: {
        kind: 'assigned',
        sessionId: 'session-alpha',
      },
    })

    expect(controller.clearAssignment()).toBe(true)
    expect(controller.getState()).toEqual(buildFallbackGlobalChatState())
  })

  it('clears automatically when the assigned conversation is deleted', () => {
    const controller = new GlobalChatController()

    controller.assignSession('session-alpha')

    expect(controller.clearIfAssignedSession('session-beta')).toBe(false)
    expect(controller.clearIfAssignedSession('session-alpha')).toBe(true)
    expect(controller.getState()).toEqual(buildFallbackGlobalChatState())
  })

  it('clears automatically when the assigned project is closed', () => {
    const controller = new GlobalChatController()

    controller.assignSession('session-alpha')

    expect(controller.clearIfAssignedProject('/tmp/alpha', '/tmp/beta')).toBe(false)
    expect(controller.clearIfAssignedProject('/tmp/alpha', '/tmp/alpha')).toBe(true)
    expect(controller.getState()).toEqual(buildFallbackGlobalChatState())
  })

  it('resets the in-memory assignment across app restarts', () => {
    const controller = new GlobalChatController()

    controller.assignSession('session-alpha')
    controller.reset()

    expect(controller.getState()).toEqual(buildFallbackGlobalChatState())
  })
})
