export interface AppNotificationSettings {
  enabled: boolean
  automationFinished: boolean
  actionRequired: boolean
  sessionCompleted: boolean
}

export type NotificationPermissionStatus =
  | 'default'
  | 'granted'
  | 'denied'
  | 'unsupported'

export interface NotificationPermissionState {
  status: NotificationPermissionStatus
  promptPending: boolean
}

export interface NotificationAttentionContext {
  currentView: 'chat' | 'automations'
  activeSessionId: string | null
}

export type NotificationActivationTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'automation'; automationId: string }

export function getDefaultNotificationSettings(): AppNotificationSettings {
  return {
    enabled: true,
    automationFinished: true,
    actionRequired: true,
    sessionCompleted: true,
  }
}

export function normalizeNotificationSettings(
  value: unknown,
  fallback: AppNotificationSettings = getDefaultNotificationSettings(),
): AppNotificationSettings {
  const input =
    value && typeof value === 'object'
      ? value as Partial<AppNotificationSettings>
      : {}

  return {
    enabled:
      typeof input.enabled === 'boolean'
        ? input.enabled
        : fallback.enabled,
    automationFinished:
      typeof input.automationFinished === 'boolean'
        ? input.automationFinished
        : fallback.automationFinished,
    actionRequired:
      typeof input.actionRequired === 'boolean'
        ? input.actionRequired
        : fallback.actionRequired,
    sessionCompleted:
      typeof input.sessionCompleted === 'boolean'
        ? input.sessionCompleted
        : fallback.sessionCompleted,
  }
}

export function normalizeNotificationPermissionStatus(
  value: unknown,
  options?: { supported?: boolean },
): NotificationPermissionStatus {
  if (options?.supported === false) {
    return 'unsupported'
  }

  switch (value) {
    case 'default':
    case 'granted':
    case 'denied':
    case 'unsupported':
      return value
    default:
      return 'default'
  }
}
