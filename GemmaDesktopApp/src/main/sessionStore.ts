import fs from 'fs/promises'
import path from 'path'
import type { SessionSnapshot } from '@gemma-desktop/sdk-core'
import type { AppSessionMode } from './tooling'
import { normalizeAppSessionStorageScope } from './talkSession'
import type { AppSessionStorageScope } from './talkSession'
import { isTalkSessionId } from './talkSession'
import {
  getTalkSessionConversationWorkspaceDirectory,
  listTalkSessionConversationFilePaths,
} from './talkSession'
import {
  listPersistedSessionFilePaths,
  relocatePersistedSessionArtifacts,
} from './sessionPersistence'
import type { ConversationIcon } from '../shared/conversationIcon'

export interface SessionMeta {
  id: string
  title: string
  titleSource: 'auto' | 'user'
  lastMessage: string
  createdAt: number
  updatedAt: number
  conversationIcon: ConversationIcon
}

export interface AppMessage {
  id: string
  role: string
  content: Array<Record<string, unknown>>
  timestamp: number
  durationMs?: number
  primaryModelId?: string
  primaryRuntimeId?: string
}

export interface DebugLogEntry {
  id: string
  sessionId: string
  timestamp: number
  layer: 'ipc' | 'sdk' | 'runtime'
  direction: 'renderer->main' | 'main->renderer' | 'sdk->app' | 'app->sdk' | 'sdk->runtime' | 'runtime->sdk'
  event: string
  summary: string
  turnId?: string
  data: unknown
}

export interface PersistedSession {
  meta: SessionMeta
  snapshot: SessionSnapshot
  draftText?: string
  appMessages?: AppMessage[]
  pendingTurn?: PendingTurn
  pendingCompaction?: PendingCompaction
  pendingPlanQuestion?: PendingPlanQuestion
  pendingPlanExit?: PendingPlanExit
  pendingPlanExecution?: LegacyPendingPlanExecution
  pendingToolApproval?: PendingToolApproval
  debugLogs?: DebugLogEntry[]
}

export interface PendingTurn {
  turnId: string
  content: Array<Record<string, unknown>>
  startedAt: number
}

export interface PendingCompaction {
  required: boolean
  status: 'pending' | 'running'
  trigger: 'manual' | 'auto' | 'retry'
  reason: string
  requestedAt: number
  thresholdPercent?: number
  lastError?: string
}

export interface PendingPlanQuestion {
  id: string
  turnId?: string
  question: string
  details?: string
  options: string[]
  placeholder?: string
  askedAt: number
}

export interface LegacyPendingPlanExecution {
  id: string
  turnId?: string
  createdAt: number
  recommendedTarget: 'current_session' | 'fresh_session'
  recommendedMode: AppSessionMode
  summary: string
  executionPrompt: string
  assumptions: string[]
  openQuestions: string[]
  source?: 'model' | 'synthetic'
  trigger?: 'prepare_plan_execution' | 'approval_phrase' | 'blocked_build_tool'
  attentionToken?: number
}

export interface PendingPlanExit {
  id: string
  turnId?: string
  createdAt: number
  workMode: AppSessionMode
  summary: string
  details?: string
  source?: 'model' | 'synthetic'
  trigger?: 'exit_plan_mode' | 'legacy_prepare_plan_execution' | 'blocked_build_tool'
  attentionToken?: number
}

export type PlanExitTarget = 'current' | 'fresh_summary'

export interface PendingToolApproval {
  id: string
  turnId?: string
  toolName: string
  argumentsSummary: string
  reason: string
  requestedAt: number
}


export interface SessionStoreDependencies {
  getSessionConfig: (snapshot: SessionSnapshot) => { storageScope: AppSessionStorageScope }
  getUserDataPath: () => string
  isTalkSessionConfig: (config: unknown) => boolean
  normalizePersistedAppMessages: (messages: AppMessage[] | undefined) => AppMessage[] | undefined
  normalizePersistedSessionData: (data: PersistedSession) => PersistedSession
  normalizeSessionMeta: (sessionId: string, raw?: Partial<SessionMeta>) => SessionMeta
  readCurrentTalkSessionIdFromDisk: () => Promise<string | null>
  resolveSessionStorageDirectory: (sessionId: string, snapshot: SessionSnapshot, storageScope: AppSessionStorageScope) => string
  setCurrentTalkSessionId: (sessionId: string | null) => void
  writeFileAtomic: (filePath: string, data: string, encoding: BufferEncoding) => Promise<void>
}

// ── Session Store (disk-backed) ──

export class SessionStore {
  constructor(private readonly dependencies: SessionStoreDependencies) {}
  private meta = new Map<string, SessionMeta>()
  private snapshots = new Map<string, SessionSnapshot>()
  private sessionProjectPaths = new Map<string, string>()
  private sessionStorageScopes = new Map<string, AppSessionStorageScope>()
  private sessionStorageDirectories = new Map<string, string>()
  private draftTexts = new Map<string, string>()
  private appMessages = new Map<string, AppMessage[]>()
  private pendingTurns = new Map<string, PendingTurn | null>()
  private pendingCompactions = new Map<string, PendingCompaction | null>()
  private pendingPlanQuestions = new Map<string, PendingPlanQuestion | null>()
  private pendingPlanExits = new Map<string, PendingPlanExit | null>()
  private pendingToolApprovals = new Map<string, PendingToolApproval | null>()
  private debugLogs = new Map<string, DebugLogEntry[]>()
  private pendingWrites = new Map<string, Promise<void>>()

  async init(projectPaths: string[]): Promise<void> {
    this.meta.clear()
    this.snapshots.clear()
    this.sessionProjectPaths.clear()
    this.sessionStorageScopes.clear()
    this.sessionStorageDirectories.clear()
    this.draftTexts.clear()
    this.appMessages.clear()
    this.pendingTurns.clear()
    this.pendingCompactions.clear()
    this.pendingPlanQuestions.clear()
    this.pendingPlanExits.clear()
    this.pendingToolApprovals.clear()
    this.debugLogs.clear()
    this.pendingWrites.clear()

    const normalizedProjectPaths = [...new Set(
      projectPaths
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => path.resolve(entry)),
    )]

    for (const projectPath of normalizedProjectPaths) {
      await this.loadProject(projectPath)
    }

    await this.loadGlobalTalkSessions()
  }

  private cachePersistedSession(
    data: PersistedSession,
    input: {
      workingDirectory: string
      storageScope?: AppSessionStorageScope
      storageDirectory?: string
    },
  ): PersistedSession {
    const migratedData = this.dependencies.normalizePersistedSessionData(data)
    const normalizedWorkingDirectory = path.resolve(input.workingDirectory)
    const normalizedMeta = this.dependencies.normalizeSessionMeta(
      migratedData.meta?.id ?? migratedData.snapshot.sessionId,
      migratedData.meta,
    )
    const normalizedData =
      migratedData.snapshot.workingDirectory === normalizedWorkingDirectory
        ? migratedData
        : {
            ...migratedData,
            meta: normalizedMeta,
            snapshot: {
              ...migratedData.snapshot,
              workingDirectory: normalizedWorkingDirectory,
            },
          }
    const cachedData =
      normalizedData.meta === normalizedMeta
        ? normalizedData
        : {
            ...normalizedData,
            meta: normalizedMeta,
          }
    const normalizedAppMessages = this.dependencies.normalizePersistedAppMessages(
      cachedData.appMessages,
    )
    const nextCachedData =
      normalizedAppMessages === cachedData.appMessages
        ? cachedData
        : {
            ...cachedData,
            appMessages: normalizedAppMessages,
          }
    const config = this.dependencies.getSessionConfig(nextCachedData.snapshot)
    const storageScope =
      isTalkSessionId(nextCachedData.meta.id) || this.dependencies.isTalkSessionConfig(config)
        ? 'global'
        : normalizeAppSessionStorageScope(input.storageScope ?? config.storageScope)
    const storageDirectory = path.resolve(
      input.storageDirectory
      ?? this.dependencies.resolveSessionStorageDirectory(
        nextCachedData.meta.id,
        nextCachedData.snapshot,
        storageScope,
      ),
    )

    this.sessionProjectPaths.set(nextCachedData.meta.id, normalizedWorkingDirectory)
    this.sessionStorageScopes.set(nextCachedData.meta.id, storageScope)
    this.sessionStorageDirectories.set(nextCachedData.meta.id, storageDirectory)
    this.meta.set(nextCachedData.meta.id, nextCachedData.meta)
    this.snapshots.set(nextCachedData.meta.id, nextCachedData.snapshot)
    this.draftTexts.set(nextCachedData.meta.id, nextCachedData.draftText ?? '')
    this.appMessages.set(nextCachedData.meta.id, nextCachedData.appMessages ?? [])
    this.pendingTurns.set(nextCachedData.meta.id, nextCachedData.pendingTurn ?? null)
    this.pendingCompactions.set(
      nextCachedData.meta.id,
      nextCachedData.pendingCompaction
        ? {
            ...nextCachedData.pendingCompaction,
            status:
              nextCachedData.pendingCompaction.status === 'running'
                ? 'pending'
                : nextCachedData.pendingCompaction.status,
            required: true,
          }
        : null,
    )
    this.pendingPlanQuestions.set(
      nextCachedData.meta.id,
      nextCachedData.pendingPlanQuestion ?? null,
    )
    this.pendingPlanExits.set(nextCachedData.meta.id, nextCachedData.pendingPlanExit ?? null)
    this.pendingToolApprovals.set(
      nextCachedData.meta.id,
      nextCachedData.pendingToolApproval ?? null,
    )
    this.debugLogs.set(nextCachedData.meta.id, nextCachedData.debugLogs ?? [])

    return nextCachedData
  }

  private clearCachedSession(sessionId: string): void {
    this.meta.delete(sessionId)
    this.snapshots.delete(sessionId)
    this.sessionProjectPaths.delete(sessionId)
    this.sessionStorageScopes.delete(sessionId)
    this.sessionStorageDirectories.delete(sessionId)
    this.draftTexts.delete(sessionId)
    this.appMessages.delete(sessionId)
    this.pendingTurns.delete(sessionId)
    this.pendingCompactions.delete(sessionId)
    this.pendingPlanQuestions.delete(sessionId)
    this.pendingPlanExits.delete(sessionId)
    this.pendingToolApprovals.delete(sessionId)
    this.debugLogs.delete(sessionId)
  }

  private async loadProject(workingDirectory: string): Promise<void> {
    const sessionFilePaths = await listPersistedSessionFilePaths(workingDirectory)
    for (const sessionFilePath of sessionFilePaths) {
      try {
        const raw = await fs.readFile(sessionFilePath, 'utf-8')
        const data = JSON.parse(raw) as PersistedSession
        this.cachePersistedSession(data, {
          workingDirectory,
          storageScope: 'project',
          storageDirectory: path.dirname(sessionFilePath),
        })
      } catch (error) {
        console.warn(
          `[gemma-desktop] Failed to load persisted session from ${sessionFilePath}:`,
          error,
        )
        // Skip corrupted files
      }
    }
  }

  private async loadGlobalTalkSessions(): Promise<void> {
    let currentTalkSessionId = await this.dependencies.readCurrentTalkSessionIdFromDisk()
    this.dependencies.setCurrentTalkSessionId(currentTalkSessionId)
    const sessionFilePaths = await listTalkSessionConversationFilePaths(
      this.dependencies.getUserDataPath(),
    )

    for (const sessionFilePath of sessionFilePaths) {
      try {
        const raw = await fs.readFile(sessionFilePath, 'utf-8')
        const data = JSON.parse(raw) as PersistedSession
        this.cachePersistedSession(data, {
          workingDirectory:
            data.snapshot.workingDirectory
            || getTalkSessionConversationWorkspaceDirectory(
              this.dependencies.getUserDataPath(),
              data.meta?.id ?? data.snapshot.sessionId,
            ),
          storageScope: 'global',
          storageDirectory: path.dirname(sessionFilePath),
        })
      } catch (error) {
        console.warn(
          `[gemma-desktop] Failed to load persisted talk session from ${sessionFilePath}:`,
          error,
        )
      }
    }

    if (currentTalkSessionId && !this.snapshots.has(currentTalkSessionId)) {
      currentTalkSessionId = null
      this.dependencies.setCurrentTalkSessionId(null)
    }
  }

  private getSessionFilePath(sessionId: string): string | null {
    const storageDirectory = this.sessionStorageDirectories.get(sessionId)
    if (!storageDirectory) {
      return null
    }

    return path.join(storageDirectory, 'session.json')
  }

  private async queueWrite(
    sessionId: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const previousWrite = this.pendingWrites.get(sessionId) ?? Promise.resolve()
    const nextWrite = previousWrite.then(write, write)
    const trackedWrite = nextWrite.finally(() => {
      if (this.pendingWrites.get(sessionId) === trackedWrite) {
        this.pendingWrites.delete(sessionId)
      }
    })
    this.pendingWrites.set(sessionId, trackedWrite)
    await trackedWrite
  }

  private async waitForPendingWrite(sessionId: string): Promise<void> {
    const pendingWrite = this.pendingWrites.get(sessionId)
    if (!pendingWrite) {
      return
    }

    try {
      await pendingWrite
    } catch {
      // The caller will surface the underlying read or write problem if it persists.
    }
  }

  private async readSessionFile(
    sessionId: string,
    options?: { waitForPendingWrite?: boolean },
  ): Promise<PersistedSession | null> {
    if (options?.waitForPendingWrite !== false) {
      await this.waitForPendingWrite(sessionId)
    }

    const filePath = this.getSessionFilePath(sessionId)
    const workingDirectory = this.sessionProjectPaths.get(sessionId)
    if (!filePath || !workingDirectory) {
      return null
    }

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      return this.cachePersistedSession(
        JSON.parse(raw) as PersistedSession,
        {
          workingDirectory,
          storageScope: this.sessionStorageScopes.get(sessionId),
          storageDirectory: path.dirname(filePath),
        },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[gemma-desktop] Failed to read session file ${sessionId}:`, error)
      }
      return null
    }
  }

  private buildCachedSession(sessionId: string): PersistedSession | null {
    const meta = this.meta.get(sessionId)
    const snapshot = this.snapshots.get(sessionId)

    if (!meta || !snapshot) {
      return null
    }

    return {
      meta,
      snapshot,
      draftText: this.draftTexts.get(sessionId) ?? '',
      appMessages: this.appMessages.get(sessionId),
      pendingTurn: this.pendingTurns.get(sessionId) ?? undefined,
      pendingCompaction: this.pendingCompactions.get(sessionId) ?? undefined,
      pendingPlanQuestion:
        this.pendingPlanQuestions.get(sessionId) ?? undefined,
      pendingPlanExit:
        this.pendingPlanExits.get(sessionId) ?? undefined,
      pendingToolApproval:
        this.pendingToolApprovals.get(sessionId) ?? undefined,
      debugLogs: this.debugLogs.get(sessionId),
    }
  }

  private async writeSessionFile(
    filePath: string,
    data: PersistedSession,
  ): Promise<void> {
    await this.dependencies.writeFileAtomic(filePath, JSON.stringify(data), 'utf-8')
  }

  async save(
    sessionId: string,
    snapshot: SessionSnapshot,
    metaPatch?: Partial<SessionMeta>,
    appMessages?: AppMessage[],
    options?: {
      preserveUpdatedAt?: boolean
    },
  ): Promise<void> {
    let meta = this.meta.get(sessionId)
    if (!meta) {
      meta = this.dependencies.normalizeSessionMeta(sessionId, {
        titleSource: 'auto',
      })
    }
    if (metaPatch) {
      Object.assign(meta, metaPatch)
    }
    meta = this.dependencies.normalizeSessionMeta(sessionId, meta)
    if (!options?.preserveUpdatedAt) {
      meta.updatedAt = Date.now()
    }
    this.meta.set(sessionId, meta)
    this.snapshots.set(sessionId, snapshot)

    if (appMessages) {
      this.appMessages.set(sessionId, appMessages)
    }

    const nextProjectPath = path.resolve(snapshot.workingDirectory)
    const currentProjectPath = this.sessionProjectPaths.get(sessionId)
    const currentStorageScope = this.sessionStorageScopes.get(sessionId) ?? 'project'
    const nextStorageScope = this.dependencies.getSessionConfig(snapshot).storageScope
    const nextStorageDirectory = this.dependencies.resolveSessionStorageDirectory(
      sessionId,
      snapshot,
      nextStorageScope,
    )
    const nextSessionFilePath = path.join(nextStorageDirectory, 'session.json')
    const data: PersistedSession = {
      meta,
      snapshot,
      draftText: this.draftTexts.get(sessionId) ?? '',
      appMessages: this.appMessages.get(sessionId),
      pendingTurn: this.pendingTurns.get(sessionId) ?? undefined,
      pendingCompaction: this.pendingCompactions.get(sessionId) ?? undefined,
      pendingPlanQuestion:
        this.pendingPlanQuestions.get(sessionId) ?? undefined,
      pendingPlanExit:
        this.pendingPlanExits.get(sessionId) ?? undefined,
      pendingToolApproval:
        this.pendingToolApprovals.get(sessionId) ?? undefined,
      debugLogs: this.debugLogs.get(sessionId),
    }
    await this.queueWrite(sessionId, async () => {
      const nextData =
        currentStorageScope === 'project'
        && nextStorageScope === 'project'
        && currentProjectPath
        && currentProjectPath !== nextProjectPath
          ? await relocatePersistedSessionArtifacts({
              data,
              sessionId,
              fromWorkingDirectory: currentProjectPath,
              toWorkingDirectory: nextProjectPath,
            })
          : data
      await this.writeSessionFile(nextSessionFilePath, nextData)
      this.sessionProjectPaths.set(sessionId, nextProjectPath)
      this.sessionStorageScopes.set(sessionId, nextStorageScope)
      this.sessionStorageDirectories.set(
        sessionId,
        path.dirname(nextSessionFilePath),
      )
    })
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    return this.buildCachedSession(sessionId) ?? await this.readSessionFile(sessionId)
  }

  async remove(sessionId: string): Promise<void> {
    const storageDirectory = this.sessionStorageDirectories.get(sessionId)
    this.clearCachedSession(sessionId)
    await this.queueWrite(sessionId, async () => {
      if (!storageDirectory) {
        return
      }
      await fs.rm(storageDirectory, {
        recursive: true,
        force: true,
      })
    })
  }

  getMeta(sessionId: string): SessionMeta | undefined {
    return this.meta.get(sessionId)
  }

  getWorkingDirectory(sessionId: string): string | null {
    return this.sessionProjectPaths.get(sessionId) ?? null
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.snapshots.get(sessionId)
  }

  setSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
    this.snapshots.set(sessionId, snapshot)
    this.sessionProjectPaths.set(sessionId, path.resolve(snapshot.workingDirectory))
  }

  setMeta(sessionId: string, patch: Partial<SessionMeta>): void {
    const meta = this.meta.get(sessionId)
    if (meta) Object.assign(meta, patch)
  }

  upsertAppMessage(sessionId: string, message: AppMessage): void {
    const messages = [...(this.appMessages.get(sessionId) ?? [])]
    const idx = messages.findIndex((entry) => entry.id === message.id)
    if (idx >= 0) {
      messages[idx] = message
    } else {
      messages.push(message)
    }
    messages.sort((a, b) => a.timestamp - b.timestamp)
    this.appMessages.set(sessionId, messages)
  }

  getAppMessages(sessionId: string): AppMessage[] {
    return [...(this.appMessages.get(sessionId) ?? [])]
  }

  setDraftText(sessionId: string, draftText: string): void {
    this.draftTexts.set(sessionId, draftText)
  }

  getDraftText(sessionId: string): string {
    return this.draftTexts.get(sessionId) ?? ''
  }

  setPendingTurn(sessionId: string, pendingTurn: PendingTurn | null): void {
    this.pendingTurns.set(sessionId, pendingTurn)
  }

  getPendingTurn(sessionId: string): PendingTurn | null {
    return this.pendingTurns.get(sessionId) ?? null
  }

  clearPendingTurn(sessionId: string): void {
    this.pendingTurns.delete(sessionId)
  }

  setPendingCompaction(
    sessionId: string,
    pendingCompaction: PendingCompaction | null,
  ): void {
    this.pendingCompactions.set(sessionId, pendingCompaction)
  }

  getPendingCompaction(sessionId: string): PendingCompaction | null {
    return this.pendingCompactions.get(sessionId) ?? null
  }

  clearPendingCompaction(sessionId: string): void {
    this.pendingCompactions.delete(sessionId)
  }

  setPendingPlanQuestion(
    sessionId: string,
    pendingPlanQuestion: PendingPlanQuestion | null,
  ): void {
    this.pendingPlanQuestions.set(sessionId, pendingPlanQuestion)
  }

  getPendingPlanQuestion(sessionId: string): PendingPlanQuestion | null {
    return this.pendingPlanQuestions.get(sessionId) ?? null
  }

  clearPendingPlanQuestion(sessionId: string): void {
    this.pendingPlanQuestions.delete(sessionId)
  }

  setPendingPlanExit(
    sessionId: string,
    pendingPlanExit: PendingPlanExit | null,
  ): void {
    this.pendingPlanExits.set(sessionId, pendingPlanExit)
  }

  getPendingPlanExit(sessionId: string): PendingPlanExit | null {
    return this.pendingPlanExits.get(sessionId) ?? null
  }

  clearPendingPlanExit(sessionId: string): void {
    this.pendingPlanExits.delete(sessionId)
  }

  setPendingToolApproval(
    sessionId: string,
    pendingToolApproval: PendingToolApproval | null,
  ): void {
    this.pendingToolApprovals.set(sessionId, pendingToolApproval)
  }

  getPendingToolApproval(sessionId: string): PendingToolApproval | null {
    return this.pendingToolApprovals.get(sessionId) ?? null
  }

  clearPendingToolApproval(sessionId: string): void {
    this.pendingToolApprovals.delete(sessionId)
  }

  appendDebugLog(sessionId: string, entry: DebugLogEntry): void {
    const logs = [...(this.debugLogs.get(sessionId) ?? []), entry]
    const capped = logs.slice(-1200)
    this.debugLogs.set(sessionId, capped)
  }

  getDebugLogs(sessionId: string): DebugLogEntry[] {
    return [...(this.debugLogs.get(sessionId) ?? [])]
  }

  clearDebugLogs(sessionId: string): void {
    this.debugLogs.set(sessionId, [])
  }

  async flush(sessionId: string): Promise<void> {
    await this.queueWrite(sessionId, async () => {
      const existing = this.buildCachedSession(sessionId)
        ?? await this.readSessionFile(sessionId, {
          waitForPendingWrite: false,
        })
      if (!existing) return

      const data: PersistedSession = {
        ...existing,
        draftText: this.draftTexts.get(sessionId) ?? '',
        appMessages: this.appMessages.get(sessionId),
        pendingTurn: this.pendingTurns.get(sessionId) ?? undefined,
        pendingCompaction: this.pendingCompactions.get(sessionId) ?? undefined,
        pendingPlanQuestion:
          this.pendingPlanQuestions.get(sessionId) ?? undefined,
        pendingPlanExit:
          this.pendingPlanExits.get(sessionId) ?? undefined,
        pendingToolApproval:
          this.pendingToolApprovals.get(sessionId) ?? undefined,
        debugLogs: this.debugLogs.get(sessionId),
      }
      const filePath = this.getSessionFilePath(sessionId)
      if (!filePath) {
        return
      }
      await this.writeSessionFile(filePath, data)
    })
  }

  listMeta(): SessionMeta[] {
    return Array.from(this.meta.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
