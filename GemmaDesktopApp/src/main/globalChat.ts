import {
  buildFallbackGlobalChatState,
  type GlobalChatState,
} from '../shared/globalChat'

export class GlobalChatController {
  private assignedSessionId: string | null = null

  getState(fallbackSessionId?: string): GlobalChatState {
    if (!this.assignedSessionId) {
      return buildFallbackGlobalChatState(fallbackSessionId)
    }

    return {
      assignedSessionId: this.assignedSessionId,
      target: {
        kind: 'assigned',
        sessionId: this.assignedSessionId,
      },
    }
  }

  assignSession(sessionId: string): boolean {
    if (!sessionId || this.assignedSessionId === sessionId) {
      return false
    }

    this.assignedSessionId = sessionId
    return true
  }

  clearAssignment(): boolean {
    if (this.assignedSessionId === null) {
      return false
    }

    this.assignedSessionId = null
    return true
  }

  clearIfAssignedSession(sessionId: string): boolean {
    if (!sessionId || this.assignedSessionId !== sessionId) {
      return false
    }

    this.assignedSessionId = null
    return true
  }

  clearIfAssignedProject(
    projectPath: string | null,
    assignedProjectPath: string | null,
  ): boolean {
    if (
      this.assignedSessionId === null
      || !projectPath
      || !assignedProjectPath
      || projectPath !== assignedProjectPath
    ) {
      return false
    }

    this.assignedSessionId = null
    return true
  }

  reset(): void {
    this.assignedSessionId = null
  }
}

export const globalChatController = new GlobalChatController()
