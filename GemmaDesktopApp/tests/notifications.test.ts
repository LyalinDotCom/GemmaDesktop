import { describe, expect, it, vi } from 'vitest'
import {
  AppNotificationManager,
  isTrustedGemmaDesktopNotificationOrigin,
} from '../src/main/notifications'
import {
  getDefaultNotificationSettings,
  normalizeNotificationSettings,
} from '../src/shared/notifications'

class FakeNotification {
  clickListener: (() => void) | null = null
  show = vi.fn()

  constructor(
    readonly options: { title: string; body: string },
  ) {}

  on(event: 'click', listener: () => void): this {
    if (event === 'click') {
      this.clickListener = listener
    }
    return this
  }

  click(): void {
    this.clickListener?.()
  }
}

function createManager(input?: {
  settings?: Partial<ReturnType<typeof getDefaultNotificationSettings>>
  supported?: boolean
  notificationSupported?: boolean
}) {
  const settings = {
    ...getDefaultNotificationSettings(),
    ...(input?.settings ?? {}),
  }
  const created: FakeNotification[] = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const focusApp = vi.fn()

  const manager = new AppNotificationManager({
    supported: input?.supported ?? true,
    getSettings: () => settings,
    notificationFactory: {
      create: (options) => {
        const notification = new FakeNotification(options)
        created.push(notification)
        return notification
      },
      isSupported: () => input?.notificationSupported ?? true,
    },
    emitRendererEvent: (channel, payload) => {
      emitted.push({ channel, payload })
    },
    focusApp,
  })

  return {
    manager,
    settings,
    created,
    emitted,
    focusApp,
  }
}

describe('notification settings helpers', () => {
  it('provides stable notification defaults', () => {
    expect(getDefaultNotificationSettings()).toEqual({
      enabled: true,
      automationFinished: true,
      actionRequired: true,
      sessionCompleted: true,
    })
  })

  it('normalizes partial notification settings against defaults', () => {
    expect(
      normalizeNotificationSettings({
        enabled: false,
        sessionCompleted: false,
      }),
    ).toEqual({
      enabled: false,
      automationFinished: true,
      actionRequired: true,
      sessionCompleted: false,
    })
  })
})

describe('notification manager', () => {
  it('queues a permission prompt instead of showing a background notification when permission is default', () => {
    const { manager, created, emitted } = createManager()

    manager.setWindowFocused(false)
    expect(
      manager.notifyAutomationFinished({
        automationId: 'automation-1',
        runId: 'run-1',
        name: 'Nightly docs',
        status: 'success',
      }),
    ).toBe(false)
    expect(created).toHaveLength(0)
    expect(manager.getPermissionState()).toEqual({
      status: 'default',
      promptPending: true,
    })
    expect(emitted).toHaveLength(0)

    manager.setWindowFocused(true)
    expect(emitted).toEqual([
      {
        channel: 'notifications:permission-prompt',
        payload: { promptPending: true },
      },
    ])
  })

  it('only notifies for action-required states when the window is not focused', () => {
    const { manager, created } = createManager()
    manager.setPermissionStatus('granted')

    manager.setWindowFocused(true)
    expect(
      manager.notifyActionRequired({
        sessionId: 'session-1',
        dedupeId: 'approval-1',
        kind: 'tool_approval',
        toolName: 'exec_command',
      }),
    ).toBe(false)
    expect(created).toHaveLength(0)

    manager.setWindowFocused(false)
    expect(
      manager.notifyActionRequired({
        sessionId: 'session-1',
        dedupeId: 'approval-2',
        kind: 'tool_approval',
        toolName: 'exec_command',
      }),
    ).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('only notifies for session completion when the finished session is not visible', () => {
    const { manager, created } = createManager()
    manager.setPermissionStatus('granted')
    manager.setWindowFocused(true)
    manager.updateAttentionContext({
      currentView: 'chat',
      activeSessionId: 'session-1',
    })

    expect(
      manager.notifySessionCompleted({
        sessionId: 'session-1',
        turnId: 'turn-1',
        sessionTitle: 'Alpha',
      }),
    ).toBe(false)
    expect(created).toHaveLength(0)

    manager.updateAttentionContext({
      currentView: 'chat',
      activeSessionId: 'session-2',
    })
    expect(
      manager.notifySessionCompleted({
        sessionId: 'session-1',
        turnId: 'turn-2',
        sessionTitle: 'Alpha',
      }),
    ).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('suppresses all automatic notifications when the master toggle is off', () => {
    const { manager, created } = createManager({
      settings: {
        enabled: false,
      },
    })
    manager.setPermissionStatus('granted')
    manager.setWindowFocused(false)

    expect(
      manager.notifyAutomationFinished({
        automationId: 'automation-1',
        runId: 'run-1',
        name: 'Nightly docs',
        status: 'success',
      }),
    ).toBe(false)
    expect(created).toHaveLength(0)
  })

  it('dedupes repeated notifications for the same event', () => {
    const { manager, created } = createManager()
    manager.setPermissionStatus('granted')
    manager.setWindowFocused(false)

    expect(
      manager.notifyAutomationFinished({
        automationId: 'automation-1',
        runId: 'run-1',
        name: 'Nightly docs',
        status: 'success',
      }),
    ).toBe(true)
    expect(
      manager.notifyAutomationFinished({
        automationId: 'automation-1',
        runId: 'run-1',
        name: 'Nightly docs',
        status: 'success',
      }),
    ).toBe(false)
    expect(created).toHaveLength(1)
  })

  it('focuses the app and routes activation targets when a notification is clicked', () => {
    const { manager, created, emitted, focusApp } = createManager()
    manager.setPermissionStatus('granted')
    manager.setWindowFocused(false)

    manager.notifyAutomationFinished({
      automationId: 'automation-1',
      runId: 'run-1',
      name: 'Nightly docs',
      status: 'success',
    })

    expect(created).toHaveLength(1)
    created[0]?.click()

    expect(focusApp).toHaveBeenCalledTimes(1)
    expect(emitted).toContainEqual({
      channel: 'notifications:activate-target',
      payload: {
        kind: 'automation',
        automationId: 'automation-1',
      },
    })
  })
})

describe('notification origin trust', () => {
  it('allows packaged files and localhost renderer origins only', () => {
    expect(
      isTrustedGemmaDesktopNotificationOrigin('file:///Applications/Gemma Desktop.app/Contents/index.html'),
    ).toBe(true)
    expect(isTrustedGemmaDesktopNotificationOrigin('http://localhost:5173')).toBe(true)
    expect(isTrustedGemmaDesktopNotificationOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isTrustedGemmaDesktopNotificationOrigin('https://example.com')).toBe(false)
    expect(isTrustedGemmaDesktopNotificationOrigin('not a url')).toBe(false)
  })
})
