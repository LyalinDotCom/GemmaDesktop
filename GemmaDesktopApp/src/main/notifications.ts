import type {
  AppNotificationSettings,
  NotificationActivationTarget,
  NotificationAttentionContext,
  NotificationPermissionState,
  NotificationPermissionStatus,
} from '../shared/notifications'
import { normalizeNotificationPermissionStatus } from '../shared/notifications'

interface NativeNotificationLike {
  on(event: 'click', listener: () => void): this
  show(): void
}

interface NativeNotificationFactoryLike {
  create(options: { title: string; body: string }): NativeNotificationLike
  isSupported(): boolean
}

interface AppNotificationManagerOptions {
  supported: boolean
  getSettings: () => AppNotificationSettings
  notificationFactory: NativeNotificationFactoryLike
  emitRendererEvent: (channel: string, payload: unknown) => void
  focusApp: () => void
}

type ActionRequiredKind = 'tool_approval' | 'plan_question' | 'plan_exit'

export interface AutomationFinishedNotificationInput {
  automationId: string
  runId: string
  name: string
  status: 'success' | 'error' | 'cancelled'
  summary?: string
}

export interface ActionRequiredNotificationInput {
  sessionId: string
  dedupeId: string
  sessionTitle?: string
  kind: ActionRequiredKind
  toolName?: string
}

export interface SessionCompletedNotificationInput {
  sessionId: string
  turnId: string
  sessionTitle?: string
  preview?: string
}

type DeliveryFailureReason =
  | 'unsupported'
  | 'permission_default'
  | 'permission_denied'

type DeliverySupport =
  | { ok: true }
  | { ok: false; reason: DeliveryFailureReason }

export class AppNotificationManager {
  private attentionContext: NotificationAttentionContext = {
    currentView: 'chat',
    activeSessionId: null,
  }

  private permissionStatus: NotificationPermissionStatus
  private promptPending = false
  private promptVisible = false
  private windowFocused = false
  private readonly sentKeys = new Set<string>()
  private readonly sentKeyOrder: string[] = []

  constructor(private readonly options: AppNotificationManagerOptions) {
    this.permissionStatus = normalizeNotificationPermissionStatus(undefined, {
      supported: options.supported,
    })
  }

  updateAttentionContext(context: NotificationAttentionContext): void {
    this.attentionContext = context
  }

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused
    if (focused) {
      this.emitPermissionPromptIfNeeded()
    }
  }

  setPermissionStatus(status: unknown): NotificationPermissionState {
    this.permissionStatus = normalizeNotificationPermissionStatus(status, {
      supported: this.options.supported,
    })

    if (this.permissionStatus !== 'default') {
      this.promptPending = false
      this.promptVisible = false
    }

    return this.getPermissionState()
  }

  getPermissionState(): NotificationPermissionState {
    return {
      status: this.permissionStatus,
      promptPending: this.promptPending,
    }
  }

  dismissPermissionPrompt(): NotificationPermissionState {
    this.promptPending = false
    this.promptVisible = false
    return this.getPermissionState()
  }

  sendTestNotification(): {
    ok: boolean
    delivered: boolean
    reason?: DeliveryFailureReason
  } {
    const support = this.getDeliverySupport()
    if (!support.ok) {
      if (support.reason === 'permission_default') {
        this.queuePermissionPrompt()
      }

      return {
        ok: false,
        delivered: false,
        reason: support.reason,
      }
    }

    this.showNativeNotification(
      'Gemma Desktop notifications are on',
      'Automation, action-required, and background session notifications are ready.',
      null,
    )

    return {
      ok: true,
      delivered: true,
    }
  }

  notifyAutomationFinished(
    input: AutomationFinishedNotificationInput,
  ): boolean {
    const settings = this.options.getSettings()
    if (!settings.enabled || !settings.automationFinished) {
      return false
    }

    const title =
      input.status === 'success'
        ? `${formatNotificationLabel(input.name)} finished`
        : input.status === 'cancelled'
          ? `${formatNotificationLabel(input.name)} stopped`
          : `${formatNotificationLabel(input.name)} needs attention`

    return this.deliver({
      dedupeKey: `automation:${input.automationId}:${input.runId}`,
      title,
      body:
        collapseNotificationText(input.summary)
        || (
          input.status === 'success'
            ? 'Automation completed successfully.'
            : input.status === 'cancelled'
              ? 'Automation run was cancelled.'
              : 'Automation run failed.'
        ),
      target: {
        kind: 'automation',
        automationId: input.automationId,
      },
    })
  }

  notifyActionRequired(input: ActionRequiredNotificationInput): boolean {
    const settings = this.options.getSettings()
    if (!settings.enabled || !settings.actionRequired || this.windowFocused) {
      return false
    }

    const sessionLabel = formatNotificationLabel(input.sessionTitle)
    let title = `${sessionLabel} needs attention`
    let body = 'Gemma Desktop is waiting for your input.'

    if (input.kind === 'tool_approval') {
      title = `${sessionLabel} needs approval`
      body = input.toolName
        ? `Gemma Desktop is waiting for approval to run ${input.toolName}.`
        : 'Gemma Desktop is waiting for tool approval.'
    } else if (input.kind === 'plan_question') {
      title = `${sessionLabel} needs your answer`
      body = 'Plan mode is waiting for an answer before it can continue.'
    } else if (input.kind === 'plan_exit') {
      title = `${sessionLabel} is ready to work`
      body = 'The plan is ready and this session can switch back to work mode.'
    }

    return this.deliver({
      dedupeKey: `action:${input.sessionId}:${input.dedupeId}`,
      title,
      body,
      target: {
        kind: 'session',
        sessionId: input.sessionId,
      },
    })
  }

  notifySessionCompleted(input: SessionCompletedNotificationInput): boolean {
    const settings = this.options.getSettings()
    const isVisible =
      this.windowFocused
      && this.attentionContext.currentView === 'chat'
      && this.attentionContext.activeSessionId === input.sessionId

    if (!settings.enabled || !settings.sessionCompleted || isVisible) {
      return false
    }

    const sessionLabel = formatNotificationLabel(input.sessionTitle)
    return this.deliver({
      dedupeKey: `session:${input.sessionId}:${input.turnId}`,
      title: `${sessionLabel} finished`,
      body:
        collapseNotificationText(input.preview)
        || 'A background conversation turn completed.',
      target: {
        kind: 'session',
        sessionId: input.sessionId,
      },
    })
  }

  private deliver(input: {
    dedupeKey: string
    title: string
    body: string
    target: NotificationActivationTarget | null
  }): boolean {
    if (this.sentKeys.has(input.dedupeKey)) {
      return false
    }

    this.rememberDedupeKey(input.dedupeKey)

    const support = this.getDeliverySupport()
    if (!support.ok) {
      if (support.reason === 'permission_default') {
        this.queuePermissionPrompt()
      }
      return false
    }

    this.showNativeNotification(input.title, input.body, input.target)
    return true
  }

  private getDeliverySupport(): DeliverySupport {
    if (
      !this.options.supported
      || !this.options.notificationFactory.isSupported()
    ) {
      return { ok: false, reason: 'unsupported' }
    }

    if (this.permissionStatus === 'granted') {
      return { ok: true }
    }

    if (this.permissionStatus === 'denied') {
      return { ok: false, reason: 'permission_denied' }
    }

    return { ok: false, reason: 'permission_default' }
  }

  private showNativeNotification(
    title: string,
    body: string,
    target: NotificationActivationTarget | null,
  ): void {
    const notification = this.options.notificationFactory.create({
      title,
      body,
    })

    if (target) {
      notification.on('click', () => {
        this.options.focusApp()
        this.options.emitRendererEvent('notifications:activate-target', target)
      })
    }

    notification.show()
  }

  private queuePermissionPrompt(): void {
    this.promptPending = true
    this.emitPermissionPromptIfNeeded()
  }

  private emitPermissionPromptIfNeeded(): void {
    if (
      !this.windowFocused
      || !this.promptPending
      || this.promptVisible
      || this.permissionStatus !== 'default'
    ) {
      return
    }

    this.promptVisible = true
    this.options.emitRendererEvent('notifications:permission-prompt', {
      promptPending: true,
    })
  }

  private rememberDedupeKey(dedupeKey: string): void {
    this.sentKeys.add(dedupeKey)
    this.sentKeyOrder.push(dedupeKey)

    while (this.sentKeyOrder.length > 1000) {
      const removed = this.sentKeyOrder.shift()
      if (removed) {
        this.sentKeys.delete(removed)
      }
    }
  }
}

export function isTrustedGemmaDesktopNotificationOrigin(
  value: string | null | undefined,
): boolean {
  if (!value) {
    return false
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'file:') {
      return true
    }

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

function collapseNotificationText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

function formatNotificationLabel(value: string | undefined): string {
  const normalized = collapseNotificationText(value)
  return normalized || 'Conversation'
}
