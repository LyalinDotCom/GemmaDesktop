import type { SidebarState } from '@shared/sidebar'
import type { BootstrapState, SessionSummary } from '@/types'

export const FIRST_RUN_MODEL_SETUP_DISMISSED_KEY =
  'gemma-desktop:first-run-model-setup-dismissed'

function hasExistingWorkspaceState(
  sidebar: Pick<SidebarState, 'lastActiveSessionId' | 'projectPaths'>,
  sessions: Pick<SessionSummary, 'id'>[],
): boolean {
  return (
    sessions.length > 0
    || sidebar.projectPaths.length > 0
    || Boolean(sidebar.lastActiveSessionId)
  )
}

export function shouldShowFirstRunModelSetup({
  startupRiskAccepted,
  dismissed,
  bootstrapState,
  sidebar,
  sessions,
}: {
  startupRiskAccepted: boolean
  dismissed: boolean
  bootstrapState: Pick<BootstrapState, 'status'>
  sidebar: Pick<SidebarState, 'lastActiveSessionId' | 'projectPaths'>
  sessions: Pick<SessionSummary, 'id'>[]
}): boolean {
  return (
    startupRiskAccepted
    && !dismissed
    && bootstrapState.status === 'idle'
    && !hasExistingWorkspaceState(sidebar, sessions)
  )
}
