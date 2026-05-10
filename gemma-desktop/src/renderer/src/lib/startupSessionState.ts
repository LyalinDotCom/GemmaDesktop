type StartupSessionFlag = 'startupOverlayDismissed' | 'startupRiskAccepted'

type StartupSessionStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

const STARTUP_SESSION_STORAGE_KEYS: Record<StartupSessionFlag, string> = {
  startupOverlayDismissed: 'gemma-desktop:startup-overlay-dismissed:v1',
  startupRiskAccepted: 'gemma-desktop:startup-risk-accepted:v1',
}

function getStartupSessionStorage(): StartupSessionStorage | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readStartupSessionFlag(
  flag: StartupSessionFlag,
  storage: StartupSessionStorage | null = getStartupSessionStorage(),
): boolean {
  if (!storage) {
    return false
  }

  try {
    return storage.getItem(STARTUP_SESSION_STORAGE_KEYS[flag]) === '1'
  } catch {
    return false
  }
}

export function writeStartupSessionFlag(
  flag: StartupSessionFlag,
  enabled: boolean,
  storage: StartupSessionStorage | null = getStartupSessionStorage(),
): void {
  if (!storage) {
    return
  }

  try {
    if (enabled) {
      storage.setItem(STARTUP_SESSION_STORAGE_KEYS[flag], '1')
    } else {
      storage.removeItem(STARTUP_SESSION_STORAGE_KEYS[flag])
    }
  } catch {
    // Startup acknowledgements are a UX convenience; storage failures should
    // never block app startup.
  }
}
