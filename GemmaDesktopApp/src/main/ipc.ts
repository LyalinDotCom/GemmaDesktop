import {
  ipcMain,
  BrowserWindow,
  Notification,
  app,
  dialog,
  shell,
  systemPreferences,
} from 'electron'
import { execFile, spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import os from 'os'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  createGemmaDesktop,
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
} from '@gemma-desktop/sdk-node'
import {
  createLlamaCppServerAdapter,
} from '@gemma-desktop/sdk-runtime-llamacpp'
import {
  createLmStudioNativeAdapter,
  createLmStudioOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-lmstudio'
import {
  createOmlxOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-omlx'
import {
  createOllamaNativeAdapter,
  createOllamaOpenAICompatibleAdapter,
} from '@gemma-desktop/sdk-runtime-ollama'
import type {
  GemmaDesktop,
  GemmaDesktopSession,
  ResearchRunStatus,
  SessionDebugSnapshot,
} from '@gemma-desktop/sdk-node'
import type {
  CapabilityRecord,
  SessionSnapshot,
  GemmaDesktopEvent,
  RuntimeDebugEvent,
  ToolResult,
  ModeSelection,
  SessionInput,
  StructuredOutputSpec,
} from '@gemma-desktop/sdk-core'
import { GemmaDesktopError } from '@gemma-desktop/sdk-core'
import {
  createHostTools,
  createWorkspaceSearchBackend,
  renderWorkspaceReadFile,
  renderWorkspaceReadFiles,
  type RegisteredTool,
} from '@gemma-desktop/sdk-tools'
import {
  buildSkillContextBundles,
  defaultSkillRoots,
  discoverInstalledSkills,
  getGemmaDesktopSkillRoot,
  installSkillFromCatalog,
  listAvailableSkills,
  removeInstalledSkill,
  renderSkillCatalogInstructions,
  renderSkillSystemInstructions,
  resolveInstalledSkill,
  searchSkillsCatalog,
  type InstalledSkillRecord,
  skillActivationId,
} from './skills'
import type { ToolPermissionPolicy } from '@gemma-desktop/sdk-tools'
import {
  type AppSessionMode,
  ACTIVATE_SKILL_TOOL,
  ASK_USER_TOOL,
  CONFIGURABLE_TOOL_NAMES,
  CONFIGURABLE_TOOL_NAME_SET,
  EXIT_PLAN_MODE_TOOL,
  LEGACY_ASK_PLAN_QUESTION_TOOL,
  LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
  type AppToolPolicyConfig,
  type BaseSessionMode,
  applyCoBrowseToolRoutingToModeSelection,
  applyToolPolicyToModeSelection,
  buildCoBrowseToolInstructions,
  buildPlanOverlayModeSelection,
  clampModeSelectionToPlanOverlay,
  extractPlanBuildToolFromSurfaceError,
  getDefaultToolPolicySettings,
  normalizeAppSessionMode,
  isBaseSessionMode,
  resolveAppSessionMode,
  isToolAllowedByPolicy,
  normalizePlanExitInput,
  normalizePlanQuestionInput,
  normalizeSkillActivationInput,
  normalizeToolPolicySettings,
  resolveToolPolicyMode,
  SEARCH_WEB_TOOL,
  sessionModeToConfig,
  toSdkSessionMode,
  isCoBrowseSessionMetadata,
  withCoBrowseSessionMetadata,
  withoutCoBrowseSessionMetadata,
  type ConversationKind,
} from './tooling'
import { isManagedPendingAttachmentPath } from './pendingAttachments'
import {
  buildPlanExitKickoffMessage,
  buildPlanExitHandoffMessage,
  buildPlanExitSessionTitle,
  extractPlanDetailsFromText,
  extractPlanSummaryFromText,
  isPlanExitToolName,
} from './planExit'
import {
  AutomationStore,
  computeInitialNextRunAt,
  computeNextRunAt,
  scheduleToText,
  type AutomationLogEntry,
  type AutomationRecord,
  type AutomationSchedule,
} from './automations'
import { openLinkTarget } from './links'
import {
  AppNotificationManager,
} from './notifications'
import {
  listInstalledTerminalApps,
  openDirectoryInTerminal,
} from './terminals'
import { evaluateBuildExecCommandPolicy } from './buildCommandPolicy'
import {
  extractLmStudioInstanceId,
  findLoadedLmStudioInstance,
  findLoadedLmStudioInstanceId,
} from './lmstudioModels'
import {
  buildOptimisticUserMessageContent,
  buildSessionInputFromUserMessage,
  buildUserMessageContent,
  PDF_RENDER_SCALE,
  planPdfAttachmentProcessing,
  persistIncomingAttachments,
  summarizeMessageForDebug,
  type PersistedPdfAttachment,
  type IncomingAttachment,
  type PersistedAttachment,
  PdfAttachmentConversionError,
} from './sessionAttachments'
import {
  getPersistedSessionAssetDirectory,
  getPersistedSessionFilePath,
  getPersistedSessionsDirectory,
  listPersistedSessionFilePaths,
  relocatePersistedSessionArtifacts,
} from './sessionPersistence'
import {
  SESSION_TITLE_RESPONSE_FORMAT,
  buildAutoSessionTitleTask,
  buildFallbackSessionTitle,
  normalizeGeneratedSessionTitle,
} from './sessionTitles'
import {
  TALK_SESSION_ID,
  TALK_SESSION_RUNTIME_ID,
  TALK_SESSION_TITLE,
  getGlobalSessionStateDirectory,
  getTalkSessionFilePath,
  getTalkSessionStorageDirectory,
  getTalkSessionWorkspaceDirectory,
  isHiddenSessionVisibility,
  isTalkSessionId,
  isTalkSessionSurface,
  normalizeAppSessionStorageScope,
  normalizeAppSessionSurface,
  normalizeAppSessionVisibility,
  type AppSessionStorageScope,
  type AppSessionSurface,
  type AppSessionVisibility,
} from './talkSession'
import { globalChatController } from './globalChat'
import { broadcastToWindows } from './windowMessaging'
import {
  getDefaultNotificationSettings,
  normalizeNotificationSettings,
  type NotificationAttentionContext,
} from '../shared/notifications'
import {
  GLOBAL_CHAT_CHANGED_CHANNEL,
  type GlobalChatState,
} from '../shared/globalChat'
import type { FileEditContentBlock } from '../shared/fileEdits'
import {
  sanitizeRenderableContentBlocks,
  stripAssistantTransportArtifacts,
} from '../shared/assistantTextArtifacts'
import {
  buildOllamaOptionsRecord,
  getDefaultOllamaSettings,
  normalizeOllamaSettings,
  ollamaLoadedConfigMatchesManagedProfile,
  resolveManagedOllamaProfile,
  type AppOllamaSettings,
  type OllamaManagedModelProfile,
} from '../shared/ollamaRuntimeConfig'
import {
  resolveOllamaRequestKeepAlive,
  type OllamaServerConfigSnapshot,
} from '../shared/ollamaServerConfig'
import {
  buildLmStudioLoadOptionsRecord,
  buildLmStudioRequestOptionsRecord,
  getDefaultLmStudioSettings,
  normalizeLmStudioSettings,
  resolveManagedLmStudioProfile,
  type AppLmStudioSettings,
  type LmStudioManagedModelProfile,
} from '../shared/lmstudioRuntimeConfig'
import {
  buildDoctorReport,
  collectDoctorCommandChecks,
} from './doctor'
import {
  composeAppSystemInstructions,
  getChatSystemInstructions,
  getPlanningSystemInstructions,
} from './promptFiles'
import {
  appendUserMemoryNote,
  buildMemoryDistillerUserPrompt,
  buildUserMemorySystemSection,
  postProcessDistilledNote,
  readUserMemory,
  sanitizeMemoryNote,
  writeUserMemory,
  USER_MEMORY_DISTILLER_SYSTEM_PROMPT,
} from './userMemory'
import {
  createGemmaInstallManager,
  type EnsureGemmaModelResult,
} from './gemmaInstall'
import {
  captureMacOSScreenshot,
  type MacOSScreenshotTarget,
} from './macosScreenshot'
import { deriveAttachmentSupport } from '../shared/attachmentSupport'
import { assessAttachmentBudget } from '../shared/attachmentBudget'
import { inspectWorkspace } from './workspace'
import { startWorkspaceWatch, stopWorkspaceWatch } from './workspaceWatcher'
import {
  findGemmaCatalogEntryByTag,
  type GemmaCatalogEntry,
} from '../shared/gemmaCatalog'
import {
  getDefaultReasoningSettings,
  normalizeReasoningSettings,
  supportsReasoningControlForModel,
  type AppReasoningSettings,
} from '../shared/reasoningSettings'
import {
  createDefaultModelSelectionSettings,
  normalizeAppModelSelectionSettings,
  resolveConfiguredHelperModelTarget,
  resolveConfiguredSessionPrimaryTarget,
  resolveSavedDefaultSessionPrimaryTarget,
  type AppModelSelectionSettings,
} from '../shared/sessionModelDefaults'
import {
  buildConversationExecutionBlockedMessage,
  findBlockingConversationExecution,
  type ConversationExecutionRun,
  type ConversationExecutionTask,
} from '../shared/conversationExecutionPolicy'
import type { SpeechInspection } from '../shared/speech'
import {
  READ_ALOUD_DEFAULT_SPEED,
  READ_ALOUD_DEFAULT_VOICE,
  READ_ALOUD_VOICE_OPTIONS,
  clampReadAloudSpeed,
  normalizeReadAloudVoice,
  type ReadAloudInspection,
  type ReadAloudTestInput,
  type ReadAloudVoiceId,
} from '../shared/readAloud'
import {
  ASSISTANT_NARRATION_RESPONSE_FORMAT,
  buildAssistantNarrationTask,
  normalizeAssistantNarrationText,
  type AssistantNarrationAttachmentSummary,
  type AssistantNarrationPhase,
} from '../shared/assistantNarration'
import {
  THINKING_SUMMARY_RESPONSE_FORMAT,
  buildThinkingSummaryTask,
  normalizeThinkingSummary,
  shouldSummarizeThinking,
} from '../shared/thinkingSummary'
import type { SessionSearchRequest } from '../shared/sessionSearch'
import {
  shouldPersistDebugLog,
  summarizeSdkEventForDebug,
} from './debugLogging'
import {
  mergeSessionMessages,
  type SessionDetailMessage,
} from './sessionMessages'
import { restoreMissingUserHistoryFromAppMessages } from './sessionHistoryRepair'
import {
  applyAssistantCompletionMessage,
  buildAssistantHelperToolOutput,
  buildAssistantHelperToolSummary,
  normalizeAssistantCompletionMessage,
  normalizeAssistantHeartbeatDecision,
  stripHiddenAssistantHeartbeatMessages,
} from './assistantHeartbeat'
import { extractFileEditBlocksFromToolResult } from './fileEdits'
import {
  searchSessionRecords,
  type SearchableSessionRecord,
} from './sessionSearch'
import {
  ShellSessionManager,
  buildShellContentBlock,
  type LiveShellSessionState,
} from './shellSessions'
import { AppTerminalManager } from './appTerminal'
import {
  buildFailedAssistantMessage,
  buildInterruptedAssistantMessage,
  buildRecoveredFailedAssistantMessage,
  CANCELLED_TURN_ID_SUFFIX,
  CANCELLED_TURN_WARNING,
  INTERRUPTED_TURN_ID_SUFFIX,
  resolveInterruptedTurnTimestamp,
} from './interruptedTurns'
import {
  buildResearchAssistantMessage,
  buildResearchLiveActivity,
  buildResearchPanelContent,
} from './researchPresentation'
import { inferConversationWorkingDirectory } from './sessionPathInference'
import {
  appendToolCallBlock,
  applyDirectToolProgressToBlocks,
  applyDelegatedProgressToBlocks,
  applyToolResultToBlocks,
  createInitialSessionLiveActivity,
  refreshLiveActivityFromToolBlocks,
  type SessionLiveActivity,
  type ToolCallProgressBlock,
  type ToolProgressEntry,
} from './toolProgress'
import { SpeechRuntimeManager } from './speechRuntime'
import { SpeechService } from './speechService'
import { ReadAloudService } from './readAloud'
import {
  BrowserSessionManager,
  inspectAgentBrowserDoctor,
  type BrowserToolStatusRecord,
} from './agentBrowser'
import {
  ChromeMcpSessionManager,
  CHROME_DEVTOOLS_MUTATING_ACTIONS,
} from './chromeMcp'
import {
  LocalRuntimeUnavailableError,
  getLocalRuntimeUnavailableError,
  isLocalRuntimeConnectionFailure,
  toLocalRuntimeUnavailableError,
} from './localRuntimeErrors'
import {
  askGeminiCli,
  ASK_GEMINI_DEFAULT_MODEL,
  ASK_GEMINI_TOOL_NAME,
} from './geminiCli'
import {
  buildProjectBrowserGoogleSearchUrl,
  ProjectBrowserManager,
} from './projectBrowser'
import {
  GET_PROJECT_BROWSER_ERRORS_TOOL,
  OPEN_PROJECT_BROWSER_TOOL,
  PROJECT_BROWSER_TOOL_NAMES,
  RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
  SEARCH_PROJECT_BROWSER_DOM_TOOL,
  type ProjectBrowserPanelBounds,
  type ProjectBrowserState,
} from '../shared/projectBrowser'
import {
  type RunningBackgroundProcessSummary,
  BACKGROUND_PROCESS_TOOL_NAMES,
  PEEK_BACKGROUND_PROCESS_TOOL,
  START_BACKGROUND_PROCESS_TOOL,
  TERMINATE_BACKGROUND_PROCESS_TOOL,
} from '../shared/backgroundProcesses'
import {
  normalizeSessionTags,
  sessionTagsEqual,
  type SessionTag,
} from '../shared/sessionTags'
import {
  ASK_GEMINI_SESSION_TOOL_ID,
  ASK_GEMINI_TOOL_NAME_SET,
  CHROME_BROWSER_TOOL_NAMES,
  CHROME_BROWSER_TOOL_NAME_SET,
  CHROME_DEVTOOLS_SESSION_TOOL_ID,
  CHROME_DEVTOOLS_TOOL_NAME_SET,
  getDefaultSelectedSessionToolIds,
  getSelectedSessionToolIds,
  getSelectedSessionToolInstructions,
  getSelectedSessionToolNames,
  getSessionToolDefinitions,
  type SessionToolDefinition,
} from '../shared/sessionTools'
import {
  cloneSidebarState,
  type SidebarSessionReference,
  type SidebarState,
} from '../shared/sidebar'
import {
  DEFAULT_SHELL_PEEK_CHARS,
  appendShellTranscript,
  formatShellCommandForChat,
  isShellSessionContentBlock,
  normalizePersistedShellBlock,
  peekShellTranscript,
  summarizeShellTranscript,
  type ShellSessionContentBlock,
} from '../shared/shellSession'
import type { AppTerminalState } from '../shared/appTerminal'
import {
  SidebarStateStore,
  normalizeStoredSidebarProjectPath,
  readSidebarStateFileSync,
} from './sidebarState'

// ── Types for IPC serialization ──

interface SessionMeta {
  id: string
  title: string
  titleSource: 'auto' | 'user'
  lastMessage: string
  createdAt: number
  updatedAt: number
  sessionTags: SessionTag[]
}

interface AppMessage {
  id: string
  role: string
  content: Array<Record<string, unknown>>
  timestamp: number
  durationMs?: number
}

interface DebugLogEntry {
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

interface PersistedSession {
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

interface PendingTurn {
  turnId: string
  content: Array<Record<string, unknown>>
  startedAt: number
}

interface PendingCompaction {
  required: boolean
  status: 'pending' | 'running'
  trigger: 'manual' | 'auto' | 'retry'
  reason: string
  requestedAt: number
  thresholdPercent?: number
  lastError?: string
}

interface PendingPlanQuestion {
  id: string
  turnId?: string
  question: string
  details?: string
  options: string[]
  placeholder?: string
  askedAt: number
}

interface LegacyPendingPlanExecution {
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

interface PendingPlanExit {
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

type PlanExitTarget = 'current' | 'fresh_summary'

interface PendingToolApproval {
  id: string
  turnId?: string
  toolName: string
  argumentsSummary: string
  reason: string
  requestedAt: number
}

interface AppSessionConfig {
  conversationKind: ConversationKind
  baseMode: BaseSessionMode
  planMode: boolean
  preferredRuntimeId: string
  selectedSkillIds: string[]
  selectedSkillNames: string[]
  selectedToolIds: string[]
  selectedToolNames: string[]
  surface: AppSessionSurface
  visibility: AppSessionVisibility
  storageScope: AppSessionStorageScope
}

function normalizeConversationKind(value: unknown): ConversationKind {
  return value === 'research' ? 'research' : 'normal'
}

function normalizeSessionConfig(config: AppSessionConfig): AppSessionConfig {
  const conversationKind = normalizeConversationKind(config.conversationKind)
  const baseMode = normalizeAppSessionMode(config.baseMode, 'explore')

  return {
    ...config,
    conversationKind,
    baseMode,
    planMode:
      conversationKind === 'normal' && baseMode === 'build'
        ? Boolean(config.planMode)
        : false,
    surface: normalizeAppSessionSurface(config.surface),
    visibility: normalizeAppSessionVisibility(config.visibility),
    storageScope: normalizeAppSessionStorageScope(config.storageScope),
  }
}

// ── Session Store (disk-backed) ──

class SessionStore {
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

    await this.loadGlobalTalkSession()
  }

  private cachePersistedSession(
    data: PersistedSession,
    input: {
      workingDirectory: string
      storageScope?: AppSessionStorageScope
      storageDirectory?: string
    },
  ): PersistedSession {
    const migratedData = normalizePersistedSessionData(data)
    const normalizedWorkingDirectory = path.resolve(input.workingDirectory)
    const normalizedMeta = normalizeSessionMeta(
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
    const normalizedAppMessages = normalizePersistedAppMessages(
      cachedData.appMessages,
    )
    const nextCachedData =
      normalizedAppMessages === cachedData.appMessages
        ? cachedData
        : {
            ...cachedData,
            appMessages: normalizedAppMessages,
          }
    const config = getSessionConfig(nextCachedData.snapshot)
    const storageScope =
      isTalkSessionId(nextCachedData.meta.id) || isTalkSessionConfig(config)
        ? 'global'
        : normalizeAppSessionStorageScope(input.storageScope ?? config.storageScope)
    const storageDirectory = path.resolve(
      input.storageDirectory
      ?? resolveSessionStorageDirectory(
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

  private async loadGlobalTalkSession(): Promise<void> {
    const sessionFilePath = getTalkSessionFilePath(app.getPath('userData'))

    try {
      const raw = await fs.readFile(sessionFilePath, 'utf-8')
      const data = JSON.parse(raw) as PersistedSession
      this.cachePersistedSession(data, {
        workingDirectory:
          data.snapshot.workingDirectory
          || getTalkSessionWorkspaceDirectory(app.getPath('userData')),
        storageScope: 'global',
        storageDirectory: path.dirname(sessionFilePath),
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[gemma-desktop] Failed to load persisted talk session from ${sessionFilePath}:`,
          error,
        )
      }
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
    const nextWrite = previousWrite
      .catch(() => {})
      .then(write)
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
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`

    try {
      await fs.writeFile(
        tempFilePath,
        JSON.stringify(data),
        'utf-8',
      )
      await fs.rename(tempFilePath, filePath)
    } catch (error) {
      await fs.unlink(tempFilePath).catch(() => {})
      throw error
    }
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
      meta = normalizeSessionMeta(sessionId, {
        titleSource: 'auto',
      })
    }
    if (metaPatch) {
      Object.assign(meta, metaPatch)
    }
    meta = normalizeSessionMeta(sessionId, meta)
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
    const nextStorageScope = getSessionConfig(snapshot).storageScope
    const nextStorageDirectory = resolveSessionStorageDirectory(
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

// ── Module state ──

let gemmaDesktop: GemmaDesktop
const store = new SessionStore()
const automationStore = new AutomationStore()
let sidebarStore: SidebarStateStore | null = null
const liveSessions = new Map<string, GemmaDesktopSession>()
const activeAbortControllers = new Map<string, AbortController>()
const pendingSessionTasks = new Map<string, ConversationExecutionTask>()
const activeSessionTasks = new Map<string, ConversationExecutionTask>()
const activeAutomationRuns = new Set<string>()
const activeAutomationAbortControllers = new Map<string, AbortController>()
let automationScheduler: NodeJS.Timeout | null = null
let keepAwakeProcess: ReturnType<typeof spawn> | null = null
let gemmaInstallManager: ReturnType<typeof createGemmaInstallManager> | null = null
const speechRuntimeManager = new SpeechRuntimeManager()
const readAloudService = new ReadAloudService()
const pendingPlanQuestionResolvers = new Map<
  string,
  {
    sessionId: string
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
>()
const pendingToolApprovalResolvers = new Map<
  string,
  {
    sessionId: string
    resolve: (approved: boolean) => void
    reject: (error: Error) => void
  }
>()
const APP_STORAGE_VERSION = 3
const PLACEHOLDER_SESSION_TITLE = 'New Conversation'
const BUILT_IN_REQUIRED_PRIMARY_MODEL_IDS = [
  createDefaultModelSelectionSettings(os.totalmem()).mainModel.modelId,
]

function getSessionExecutionTask(sessionId: string): ConversationExecutionTask | undefined {
  return activeSessionTasks.get(sessionId) ?? pendingSessionTasks.get(sessionId)
}

function isSessionExecutionBusy(sessionId: string): boolean {
  return (
    activeAbortControllers.has(sessionId)
    || activeSessionTasks.has(sessionId)
    || pendingSessionTasks.has(sessionId)
  )
}

function listConversationExecutions(): ConversationExecutionRun[] {
  const runs = new Map<string, ConversationExecutionRun>()

  for (const [sessionId, task] of pendingSessionTasks) {
    runs.set(sessionId, {
      sessionId,
      task,
      title: store.getMeta(sessionId)?.title,
    })
  }

  for (const [sessionId, task] of activeSessionTasks) {
    runs.set(sessionId, {
      sessionId,
      task,
      title: store.getMeta(sessionId)?.title,
    })
  }

  return [...runs.values()]
}

function beginConversationExecutionGate(
  sessionId: string,
  task: ConversationExecutionTask,
  options: {
    allowExistingPendingTask?: ConversationExecutionTask
  } = {},
): () => void {
  const currentPendingTask = pendingSessionTasks.get(sessionId)
  const canReusePendingGate =
    currentPendingTask !== undefined
    && currentPendingTask === options.allowExistingPendingTask
    && !activeSessionTasks.has(sessionId)
    && !activeAbortControllers.has(sessionId)

  if (isSessionExecutionBusy(sessionId) && !canReusePendingGate) {
    throw new Error('This session is already busy.')
  }

  const blocker = findBlockingConversationExecution(
    listConversationExecutions(),
    sessionId,
  )
  if (blocker) {
    throw new Error(buildConversationExecutionBlockedMessage(blocker))
  }

  if (canReusePendingGate) {
    return () => {}
  }

  pendingSessionTasks.set(sessionId, task)
  void broadcastSessionsChanged().catch(() => {})

  return () => {
    if (pendingSessionTasks.get(sessionId) === task) {
      pendingSessionTasks.delete(sessionId)
      void broadcastSessionsChanged().catch(() => {})
    }
  }
}

function assertNoConversationExecutionRunning(): void {
  const blocker = findBlockingConversationExecution(listConversationExecutions())
  if (blocker) {
    throw new Error(buildConversationExecutionBlockedMessage(blocker))
  }
}

function markConversationExecutionActive(
  sessionId: string,
  task: ConversationExecutionTask,
): void {
  if (pendingSessionTasks.get(sessionId) === task) {
    pendingSessionTasks.delete(sessionId)
  }
  activeSessionTasks.set(sessionId, task)
}

interface PrimaryModelTarget {
  modelId: string
  runtimeId: string
  loadedInstanceId?: string
}

interface BootstrapStateRecord {
  status: 'idle' | 'checking' | 'starting_ollama' | 'pulling_models' | 'loading_helper' | 'ready' | 'warning' | 'error'
  ready: boolean
  message: string
  helperModelId: string
  helperRuntimeId: string
  requiredPrimaryModelIds: string[]
  error?: string
  updatedAt: number
}

function resolveHelperRouterTarget(
  currentSettings?: Pick<AppSettingsRecord, 'modelSelection'> | null,
): PrimaryModelTarget {
  return resolveConfiguredHelperModelTarget(currentSettings?.modelSelection)
}

function isOllamaModelRuntime(runtimeId: string): boolean {
  return runtimeId === 'ollama-native' || runtimeId === 'ollama-openai'
}

function isLmStudioModelRuntime(runtimeId: string): boolean {
  return runtimeId === 'lmstudio-native' || runtimeId === 'lmstudio-openai'
}

function isOmlxModelRuntime(runtimeId: string): boolean {
  return runtimeId === 'omlx-openai'
}

function getEndpointForModelTarget(
  currentSettings: AppSettingsRecord,
  target: Pick<PrimaryModelTarget, 'runtimeId'>,
): string | null {
  if (isOllamaModelRuntime(target.runtimeId)) {
    return currentSettings.runtimes.ollama.endpoint
  }
  if (isLmStudioModelRuntime(target.runtimeId)) {
    return currentSettings.runtimes.lmstudio.endpoint
  }
  if (isOmlxModelRuntime(target.runtimeId)) {
    return currentSettings.runtimes.omlx.endpoint
  }
  if (target.runtimeId === 'llamacpp-server') {
    return currentSettings.runtimes.llamacpp.endpoint
  }
  return null
}

function resolveRequiredPrimaryModelIds(
  currentSettings?: Pick<AppSettingsRecord, 'modelSelection'> | null,
): string[] {
  if (!currentSettings) {
    return [...BUILT_IN_REQUIRED_PRIMARY_MODEL_IDS]
  }

  const configured = [resolveSavedDefaultSessionPrimaryTarget(currentSettings.modelSelection)]

  const requiredModelIds = [...new Set(
    configured
      .filter((target) => isOllamaModelRuntime(target.runtimeId))
      .map((target) => target.modelId),
  )]

  return requiredModelIds
}

async function listPersistedSessionPrimaryTargets(): Promise<PrimaryModelTarget[]> {
  const targets: PrimaryModelTarget[] = []

  for (const meta of store.listMeta()) {
    const persisted = await store.load(meta.id)
    if (!persisted || isHiddenSessionSnapshot(persisted.snapshot)) {
      continue
    }

    targets.push({
      modelId: persisted.snapshot.modelId,
      runtimeId: persisted.snapshot.runtimeId,
    })
  }

  return targets
}

async function resolveStartupSessionPrimaryTarget(): Promise<PrimaryModelTarget | null> {
  if (!sidebarStore) {
    return null
  }

  const sidebarState = sidebarStore.getState()
  const closedProjectPaths = new Set(
    sidebarState.closedProjectPaths.map(normalizeStoredSidebarProjectPath),
  )
  const persistedBySessionId = new Map<string, PersistedSession>()

  for (const meta of store.listMeta()) {
    const persisted = await store.load(meta.id)
    if (!persisted || isHiddenSessionSnapshot(persisted.snapshot)) {
      continue
    }

    const projectPath = normalizeStoredSidebarProjectPath(
      persisted.snapshot.workingDirectory,
    )
    if (projectPath && closedProjectPaths.has(projectPath)) {
      continue
    }

    persistedBySessionId.set(meta.id, persisted)
  }

  for (const sessionId of sidebarState.pinnedSessionIds) {
    const persisted = persistedBySessionId.get(sessionId)
    if (!persisted) {
      continue
    }

    return {
      modelId: persisted.snapshot.modelId,
      runtimeId: persisted.snapshot.runtimeId,
    }
  }

  const firstVisible = store.listMeta()
    .map((meta) => persistedBySessionId.get(meta.id))
    .find((persisted): persisted is PersistedSession => Boolean(persisted))

  return firstVisible
    ? {
        modelId: firstVisible.snapshot.modelId,
        runtimeId: firstVisible.snapshot.runtimeId,
      }
    : null
}

function resolveBootstrapTargets(
  currentSettings?: Pick<AppSettingsRecord, 'modelSelection'> | null,
): Pick<BootstrapStateRecord, 'helperModelId' | 'helperRuntimeId' | 'requiredPrimaryModelIds'> {
  const helperTarget = resolveHelperRouterTarget(currentSettings)
  return {
    helperModelId: helperTarget.modelId,
    helperRuntimeId: helperTarget.runtimeId,
    requiredPrimaryModelIds: resolveRequiredPrimaryModelIds(currentSettings),
  }
}

const primaryModelHoldCounts = new Map<string, number>()
const helperModelHoldCounts = new Map<string, number>()
let activePrimaryModelTarget: PrimaryModelTarget | null = null
let primaryWarmupPromise: Promise<void> | null = null
let lastOptionalPrimaryWarmupWarningKey: string | null = null
const pendingModelLoadCounts = new Map<string, number>()
const pendingModelLoadTargets = new Map<string, PrimaryModelTarget>()
let primaryModelLoadPromise: Promise<PrimaryModelTarget> | null = null
let primaryModelLoadTarget: PrimaryModelTarget | null = null

function modelTargetKey(target: Pick<PrimaryModelTarget, 'runtimeId' | 'modelId'>): string {
  return `${target.runtimeId}::${target.modelId}`
}

function listPendingModelLoadTargets(): PrimaryModelTarget[] {
  return [...pendingModelLoadTargets.values()]
}

interface ModelTokenUsageSnapshot {
  runtimeId: string
  modelId: string
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  totalTokens: number
  turns: number
  lastUpdatedMs: number
}

interface ModelTokenUsageReport {
  startedAtMs: number
  usage: ModelTokenUsageSnapshot[]
}

const modelTokenUsageTrackingStartedAt = Date.now()
const modelTokenUsageByKey = new Map<string, ModelTokenUsageSnapshot>()

function modelTokenUsageKey(runtimeId: string, modelId: string): string {
  return `${runtimeId}::${modelId}`
}

function getModelTokenUsageReport(): ModelTokenUsageReport {
  return {
    startedAtMs: modelTokenUsageTrackingStartedAt,
    usage: Array.from(modelTokenUsageByKey.values()).map((entry) => ({ ...entry })),
  }
}

function broadcastModelTokenUsage(): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'system:model-token-usage-update',
    getModelTokenUsageReport(),
    'system:model-token-usage-update',
  )
}

function recordSessionTokens(
  runtimeId: string | null | undefined,
  modelId: string | null | undefined,
  usage:
    | {
        inputTokens?: number
        outputTokens?: number
        reasoningTokens?: number
        cacheReadTokens?: number
        totalTokens?: number
      }
    | null
    | undefined,
): void {
  if (!runtimeId || !modelId) {
    return
  }
  if (!usage) {
    return
  }

  const inputTokens = Number.isFinite(usage.inputTokens) ? Number(usage.inputTokens) : 0
  const outputTokens = Number.isFinite(usage.outputTokens) ? Number(usage.outputTokens) : 0
  const reasoningTokens = Number.isFinite(usage.reasoningTokens) ? Number(usage.reasoningTokens) : 0
  const cacheReadTokens = Number.isFinite(usage.cacheReadTokens) ? Number(usage.cacheReadTokens) : 0

  if (
    inputTokens === 0
    && outputTokens === 0
    && reasoningTokens === 0
    && cacheReadTokens === 0
  ) {
    return
  }

  const key = modelTokenUsageKey(runtimeId, modelId)
  const existing = modelTokenUsageByKey.get(key) ?? {
    runtimeId,
    modelId,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    turns: 0,
    lastUpdatedMs: Date.now(),
  }

  existing.inputTokens += inputTokens
  existing.outputTokens += outputTokens
  existing.reasoningTokens += reasoningTokens
  existing.cacheReadTokens += cacheReadTokens
  existing.totalTokens =
    existing.inputTokens + existing.outputTokens + existing.reasoningTokens
  existing.turns += 1
  existing.lastUpdatedMs = Date.now()

  modelTokenUsageByKey.set(key, existing)
  broadcastModelTokenUsage()
}

let bootstrapState: BootstrapStateRecord = {
  status: 'idle',
  ready: false,
  message: 'Local models will be prepared when needed.',
  ...resolveBootstrapTargets(),
  updatedAt: Date.now(),
}
let bootstrapPromise: Promise<BootstrapStateRecord> | null = null

type AppSettingsRecord = {
  storageVersion: number
  theme: 'light' | 'dark' | 'system'
  enterToSend: boolean
  defaultMode: AppSessionMode
  defaultProjectDirectory: string
  terminal: {
    preferredAppId: string | null
  }
  modelSelection: AppModelSelectionSettings
  compaction: {
    autoCompactEnabled: boolean
    autoCompactThresholdPercent: number
  }
  skills: {
    scanRoots: string[]
  }
  automations: {
    keepAwakeWhileRunning: boolean
  }
  notifications: {
    enabled: boolean
    automationFinished: boolean
    actionRequired: boolean
    sessionCompleted: boolean
  }
  speech: {
    enabled: boolean
    provider: 'managed-whisper-cpp'
    model: 'large-v3-turbo-q5_0'
  }
  readAloud: {
    enabled: boolean
    provider: 'kokoro-js'
    model: 'Kokoro-82M-v1.0-ONNX'
    dtype: 'q8'
    defaultVoice: ReadAloudVoiceId
    speed: number
  }
  reasoning: AppReasoningSettings
  ollama: AppOllamaSettings
  lmstudio: AppLmStudioSettings
  ambientEffects: {
    enabled: boolean
  }
  tools: {
    chromeMcp: {
      enabled: boolean
      defaultSelected: boolean
      disableUsageStatistics: boolean
      disablePerformanceCrux: boolean
      lastStatus?: BrowserToolStatusRecord
    }
  }
  toolPolicy: AppToolPolicyConfig
  runtimes: {
    ollama: {
      endpoint: string
      numParallel: number
      maxLoadedModels: number
      keepAliveEnabled: boolean
    }
    lmstudio: { endpoint: string; maxConcurrentPredictions: number }
    llamacpp: { endpoint: string }
    omlx: { endpoint: string; apiKey: string }
  }
  integrations: {
    geminiApi: {
      apiKey: string
      model: string
    }
    geminiCli: {
      model: string
    }
  }
}

let settings: AppSettingsRecord | null = null
let storageResetRequired = false
let browserToolManager: BrowserSessionManager | null = null
let chromeDevtoolsToolManager: ChromeMcpSessionManager | null = null
const projectBrowserManager = new ProjectBrowserManager((state: ProjectBrowserState) => {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'browser:state-changed',
    state,
    'browser:state-changed',
  )
})
let speechRuntimeSubscribed = false
let readAloudSubscribed = false
let notificationWindowStateSubscribed = false
let shellShutdownSubscribed = false
const shellMessageFlushTimers = new Map<string, NodeJS.Timeout>()
const shellSummaryBroadcastTimers = new Map<string, NodeJS.Timeout>()
const shellSessionManager = new ShellSessionManager({
  appendTranscript: appendShellTranscript,
  onUpdated: (state) => {
    void handleShellSessionUpdated(state)
  },
})
const appTerminalManager = new AppTerminalManager({
  appendTranscript: appendShellTranscript,
  onUpdated: (state) => {
    broadcastAppTerminalStateChanged(state)
  },
})

function broadcastNotificationEvent(channel: string, payload: unknown): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    channel,
    payload,
    channel,
  )
}

function broadcastAppTerminalStateChanged(state: AppTerminalState): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'terminalDrawer:state-changed',
    state,
    'terminalDrawer:state-changed',
  )
}

function focusNotificationWindow(): void {
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (!target) {
    return
  }

  if (target.isMinimized()) {
    target.restore()
  }

  if (!target.isVisible()) {
    target.show()
  }

  target.focus()
}

let currentAttentionContext: NotificationAttentionContext = {
  currentView: 'chat',
  activeSessionId: null,
}

const notificationManager = new AppNotificationManager({
  supported: process.platform === 'darwin',
  getSettings: () => (settings ?? getDefaultSettings()).notifications,
  notificationFactory: {
    create: (options) => new Notification(options),
    isSupported: () => Notification.isSupported(),
  },
  emitRendererEvent: broadcastNotificationEvent,
  focusApp: focusNotificationWindow,
})

function getDefaultProjectDirectory(): string {
  return path.join(app.getPath('home'), 'gemma-desktop-projects')
}

function normalizeSessionMeta(
  sessionId: string,
  meta?: Partial<SessionMeta> | null,
): SessionMeta {
  return {
    id: sessionId,
    title:
      typeof meta?.title === 'string' && meta.title.trim().length > 0
        ? meta.title
        : PLACEHOLDER_SESSION_TITLE,
    titleSource:
      meta?.titleSource === 'auto' || meta?.titleSource === 'user'
        ? meta.titleSource
        : 'user',
    lastMessage:
      typeof meta?.lastMessage === 'string'
        ? meta.lastMessage
        : '',
    createdAt:
      typeof meta?.createdAt === 'number' && Number.isFinite(meta.createdAt)
        ? meta.createdAt
        : Date.now(),
    updatedAt:
      typeof meta?.updatedAt === 'number' && Number.isFinite(meta.updatedAt)
        ? meta.updatedAt
        : Date.now(),
    sessionTags: normalizeSessionTags(meta?.sessionTags),
  }
}

function buildShellAssistantMessage(
  state: LiveShellSessionState,
): AppMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    content: [buildShellContentBlock(state) as unknown as Record<string, unknown>],
    timestamp: state.startedAt + 1,
    durationMs:
      typeof state.completedAt === 'number'
        ? Math.max(state.completedAt - state.startedAt, 1)
        : undefined,
  }
}

function buildShellUserMessage(
  visibleCommand: string,
  timestamp: number,
): AppMessage {
  return {
    id: `user-${timestamp}-${randomUUID()}`,
    role: 'user',
    content: buildUserMessageContent(visibleCommand, []),
    timestamp,
  }
}

function listSessionShellBlocks(
  sessionId: string,
): ShellSessionContentBlock[] {
  const blocks: unknown[] = store.getAppMessages(sessionId)
    .flatMap((message) => message.content)

  return blocks.filter(
    (block): block is ShellSessionContentBlock => isShellSessionContentBlock(block),
  )
}

function getSessionShellBlock(
  sessionId: string,
  terminalId: string,
): ShellSessionContentBlock | null {
  return listSessionShellBlocks(sessionId).find(
    (block) => block.terminalId === terminalId,
  ) ?? null
}

function getKnownShellProcessIds(sessionId: string): string[] {
  return listSessionShellBlocks(sessionId).map((block) => block.terminalId)
}

function listRunningBackgroundProcesses(
  sessionId: string,
): RunningBackgroundProcessSummary[] {
  return listSessionShellBlocks(sessionId).flatMap((block) => {
    if (block.displayMode !== 'sidebar') {
      return []
    }

    const liveState = shellSessionManager.inspect(sessionId, block.terminalId)
    const status = liveState?.status ?? block.status
    if (status !== 'running') {
      return []
    }

    const transcript = liveState?.transcript ?? block.transcript
    return [{
      terminalId: block.terminalId,
      command: block.command,
      workingDirectory: block.workingDirectory,
      startedAt: liveState?.startedAt ?? block.startedAt,
      previewText: summarizeShellTranscript(transcript),
    }]
  })
}

function normalizePersistedAppMessages(
  messages: AppMessage[] | undefined,
): AppMessage[] | undefined {
  if (!messages || messages.length === 0) {
    return messages
  }

  let changed = false
  const normalizedMessages = messages.map((message) => {
    let messageChanged = false
    let shellCompletedAt: number | undefined
    const nextContent = message.content.map((block) => {
      if (!isShellSessionContentBlock(block)) {
        return block
      }

      const normalizedBlock = normalizePersistedShellBlock(block)
      if (normalizedBlock !== block) {
        changed = true
        messageChanged = true
      }
      shellCompletedAt = normalizedBlock.completedAt
      return normalizedBlock
    })

    if (!messageChanged || nextContent.length === 0) {
      return message
    }

    const nextDurationMs =
      typeof shellCompletedAt === 'number'
        ? Math.max(shellCompletedAt - message.timestamp, 1)
        : message.durationMs

    return {
      ...message,
      content: nextContent as Array<Record<string, unknown>>,
      durationMs: nextDurationMs,
    }
  })

  return changed ? normalizedMessages : messages
}

function updateShellMessageInStore(
  sessionId: string,
  terminalId: string,
  updater: (
    block: ShellSessionContentBlock,
    message: AppMessage,
  ) => ShellSessionContentBlock,
): AppMessage | null {
  const messages = store.getAppMessages(sessionId)
  const targetMessage = messages.find((message) =>
    message.content.some(
      (block) =>
        isShellSessionContentBlock(block)
        && block.terminalId === terminalId,
    ),
  )

  if (!targetMessage) {
    return null
  }

  let changed = false
  const nextContent = targetMessage.content.map((block) => {
    if (
      !isShellSessionContentBlock(block)
      || block.terminalId !== terminalId
    ) {
      return block
    }

    changed = true
    return updater(block, targetMessage)
  })

  if (!changed) {
    return null
  }

  const shellBlock = nextContent.find(isShellSessionContentBlock)
  const nextMessage: AppMessage = {
    ...targetMessage,
    content: nextContent as Array<Record<string, unknown>>,
    durationMs:
      shellBlock && typeof shellBlock.completedAt === 'number'
        ? Math.max(shellBlock.completedAt - targetMessage.timestamp, 1)
        : targetMessage.durationMs,
  }

  store.upsertAppMessage(sessionId, nextMessage)
  return nextMessage
}

function clearScheduledShellFlush(sessionId: string): void {
  const existing = shellMessageFlushTimers.get(sessionId)
  if (!existing) {
    return
  }

  clearTimeout(existing)
  shellMessageFlushTimers.delete(sessionId)
}

function scheduleShellMessageFlush(
  sessionId: string,
  immediate = false,
): void {
  if (!store.getMeta(sessionId)) {
    return
  }

  if (immediate) {
    clearScheduledShellFlush(sessionId)
    void store.flush(sessionId).catch((error) => {
      console.error(`[gemma-desktop] Failed to flush shell message for ${sessionId}:`, error)
    })
    return
  }

  if (shellMessageFlushTimers.has(sessionId)) {
    return
  }

  const timer = setTimeout(() => {
    shellMessageFlushTimers.delete(sessionId)
    void store.flush(sessionId).catch((error) => {
      console.error(`[gemma-desktop] Failed to flush shell message for ${sessionId}:`, error)
    })
  }, 250)
  shellMessageFlushTimers.set(sessionId, timer)
}

function clearScheduledShellSummaryBroadcast(sessionId: string): void {
  const existing = shellSummaryBroadcastTimers.get(sessionId)
  if (!existing) {
    return
  }

  clearTimeout(existing)
  shellSummaryBroadcastTimers.delete(sessionId)
}

function scheduleShellSummaryBroadcast(
  sessionId: string,
  immediate = false,
): void {
  if (!store.getMeta(sessionId)) {
    return
  }

  if (immediate) {
    clearScheduledShellSummaryBroadcast(sessionId)
    void broadcastSessionsChanged().catch(() => {})
    return
  }

  if (shellSummaryBroadcastTimers.has(sessionId)) {
    return
  }

  const timer = setTimeout(() => {
    shellSummaryBroadcastTimers.delete(sessionId)
    void broadcastSessionsChanged().catch(() => {})
  }, 250)
  shellSummaryBroadcastTimers.set(sessionId, timer)
}

async function handleShellSessionUpdated(
  state: LiveShellSessionState,
): Promise<void> {
  if (!store.getMeta(state.sessionId)) {
    return
  }

  const message = buildShellAssistantMessage(state)
  store.upsertAppMessage(state.sessionId, message)
  sendToSession(state.sessionId, {
    type: 'message_updated',
    message,
  })
  scheduleShellMessageFlush(state.sessionId, state.status !== 'running')
  if (state.displayMode === 'sidebar') {
    scheduleShellSummaryBroadcast(
      state.sessionId,
      state.status !== 'running',
    )
  }

  if (state.status !== 'running') {
    appendDebugLog(state.sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.shell.completed',
      summary: `${state.command} ${state.status}`,
      data: {
        terminalId: state.terminalId,
        command: state.command,
        status: state.status,
        exitCode: state.exitCode,
      },
    })
  }
}

function buildDefaultSessionPrimaryTarget(
  config: Pick<AppSessionConfig, 'conversationKind' | 'baseMode' | 'surface'>,
  currentSettings?: Pick<AppSettingsRecord, 'modelSelection'> | null,
): PrimaryModelTarget {
  const resolved = resolveConfiguredSessionPrimaryTarget(
    {
      conversationKind: config.conversationKind,
      baseMode: config.baseMode,
    },
    currentSettings?.modelSelection,
  )

  return {
    modelId: resolved.modelId,
    runtimeId: resolved.runtimeId,
  }
}

function usesTemporaryModelOverride(snapshot?: SessionSnapshot | null): boolean {
  if (!snapshot || isTalkSessionSnapshot(snapshot)) {
    return false
  }

  const config = getSessionConfig(snapshot)
  const defaultTarget = buildDefaultSessionPrimaryTarget(config, settings)
  return !primaryTargetsMatch(
    {
      modelId: snapshot.modelId,
      runtimeId: snapshot.runtimeId,
    },
    defaultTarget,
  )
}

function resolveSessionPrimaryTarget(
  _sessionId: string,
  config: Pick<AppSessionConfig, 'conversationKind' | 'baseMode' | 'surface'>,
  snapshot?: SessionSnapshot | null,
): PrimaryModelTarget {
  if (snapshot && !isTalkSessionSnapshot(snapshot)) {
    return {
      modelId: snapshot.modelId,
      runtimeId: snapshot.runtimeId,
    }
  }

  return buildDefaultSessionPrimaryTarget(config, settings)
}

function primaryTargetsMatch(
  left: PrimaryModelTarget | null | undefined,
  right: PrimaryModelTarget | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.modelId === right.modelId
    && left.runtimeId === right.runtimeId,
  )
}

function shouldWarmModelTarget(
  currentSettings: AppSettingsRecord,
  target: Pick<PrimaryModelTarget, 'runtimeId'>,
): boolean {
  return !isOllamaModelRuntime(target.runtimeId)
    || currentSettings.runtimes.ollama.keepAliveEnabled
}

function describeOptionalPrimaryWarmupUnavailable(
  target: PrimaryModelTarget,
  error: LocalRuntimeUnavailableError,
): string {
  return `${error.runtimeLabel} is offline, so Gemma Desktop skipped warming ${target.modelId}. Start the provider before using sessions that target ${target.runtimeId}.`
}

async function handleOptionalPrimaryWarmupFailure(
  target: PrimaryModelTarget,
  error: unknown,
  context: string,
): Promise<void> {
  const unavailable = getLocalRuntimeUnavailableError(error)
  if (unavailable) {
    const warningKey = `${context}:${modelTargetKey(target)}:${unavailable.endpoint}`
    const message = describeOptionalPrimaryWarmupUnavailable(target, unavailable)
    if (warningKey !== lastOptionalPrimaryWarmupWarningKey) {
      console.warn(`[gemma-desktop] ${message}`)
      lastOptionalPrimaryWarmupWarningKey = warningKey
    }
    const currentSettings = await getSettingsState()
    if (bootstrapState.ready) {
      setBootstrapState({
        status: 'warning',
        ready: true,
        message,
        error: undefined,
      }, currentSettings)
    }
    return
  }

  console.warn(
    context === 'startup'
      ? '[gemma-desktop] Failed to warm the startup primary model:'
      : '[gemma-desktop] Failed to warm selected session primary model:',
    error,
  )
}

async function isTrackedModelTargetResident(
  target: PrimaryModelTarget,
  currentSettings: AppSettingsRecord,
): Promise<boolean> {
  if (isOllamaModelRuntime(target.runtimeId)) {
    const loadedModel = await findOllamaLoadedModel(
      currentSettings.runtimes.ollama.endpoint,
      target.modelId,
    )
    if (!loadedModel) {
      return false
    }

    const profile = resolveManagedOllamaLoadProfile(currentSettings, target)
    if (!ollamaLoadedConfigMatchesManagedProfile(loadedModel.config, profile)) {
      console.warn(
        `[gemma-desktop] Tracked Ollama model ${target.modelId} is resident with a context that does not match the managed profile; reloading it.`,
      )
      return false
    }

    return true
  }

  return true
}

async function ensurePrimaryModelTargetLoaded(
  target: PrimaryModelTarget,
): Promise<void> {
  if (
    currentPrimaryHoldCount() > 0
    && activePrimaryModelTarget
    && !primaryTargetsMatch(activePrimaryModelTarget, target)
  ) {
    return
  }

  if (primaryTargetsMatch(activePrimaryModelTarget, target)) {
    const currentSettings = await getSettingsState()
    const resident = await isTrackedModelTargetResident(target, currentSettings).catch((error) => {
      console.warn(
        `[gemma-desktop] Could not confirm whether ${target.runtimeId} / ${target.modelId} is still resident; reloading it:`,
        error,
      )
      return false
    })
    if (resident) {
      return
    }

    console.warn(
      `[gemma-desktop] Tracked primary model ${target.runtimeId} / ${target.modelId} is no longer resident; reloading it.`,
    )
    activePrimaryModelTarget = null
  }

  if (primaryModelLoadPromise) {
    if (primaryTargetsMatch(primaryModelLoadTarget, target)) {
      activePrimaryModelTarget = await primaryModelLoadPromise
      return
    }

    await primaryModelLoadPromise.catch((error) => {
      console.warn('[gemma-desktop] Previous primary model load failed while waiting for next target:', error)
    })

    if (primaryTargetsMatch(activePrimaryModelTarget, target)) {
      return
    }
  }

  primaryModelLoadTarget = { ...target }
  primaryModelLoadPromise = (async () => {
    const currentSettings = await getSettingsState()
    if (activePrimaryModelTarget && !primaryTargetsMatch(activePrimaryModelTarget, target)) {
      await unloadModelForRuntime(activePrimaryModelTarget).catch((error) => {
        console.warn('[gemma-desktop] Failed to unload previous primary model:', error)
      })
    }

    await unloadConflictingOllamaPrimaryModels(target, currentSettings)
    return await loadModelForRuntime(target)
  })()

  try {
    activePrimaryModelTarget = await primaryModelLoadPromise
  } finally {
    primaryModelLoadPromise = null
    primaryModelLoadTarget = null
  }
}

function currentPrimaryHoldCount(): number {
  let total = 0
  for (const count of primaryModelHoldCounts.values()) {
    total += count
  }
  return total
}

function currentHelperHoldCount(): number {
  let total = 0
  for (const count of helperModelHoldCounts.values()) {
    total += count
  }
  return total
}

function scheduleStartupPrimaryWarmup(): void {
  if (primaryWarmupPromise || currentPrimaryHoldCount() > 0) {
    return
  }

  primaryWarmupPromise = (async () => {
    // Let startup finish painting before we spend more time warming the default primary.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    const latestSettings = await getSettingsState()
    const target =
      await resolveStartupSessionPrimaryTarget()
      ?? resolveSavedDefaultSessionPrimaryTarget(latestSettings.modelSelection)
    if (
      !shouldWarmModelTarget(latestSettings, target)
      || currentPrimaryHoldCount() > 0
    ) {
      return
    }

    await ensurePrimaryModelTargetLoaded(target).catch((error) =>
      handleOptionalPrimaryWarmupFailure(target, error, 'startup'),
    )
  })()
    .catch((error) => {
      console.warn('[gemma-desktop] Startup primary warmup scheduling failed:', error)
    })
    .finally(() => {
      primaryWarmupPromise = null
    })
}

async function unloadIdleOllamaModelsWhenKeepAliveDisabled(
  currentSettingsInput?: AppSettingsRecord,
): Promise<void> {
  const currentSettings = currentSettingsInput ?? await getSettingsState()
  if (
    currentSettings.runtimes.ollama.keepAliveEnabled
    || currentPrimaryHoldCount() > 0
    || currentHelperHoldCount() > 0
  ) {
    return
  }

  const targets = [
    activePrimaryModelTarget,
    resolveHelperRouterTarget(currentSettings),
    resolveSavedDefaultSessionPrimaryTarget(currentSettings.modelSelection),
  ]
    .filter((target): target is PrimaryModelTarget =>
      Boolean(target && isOllamaModelRuntime(target.runtimeId)),
    )

  const uniqueTargets = new Map<string, PrimaryModelTarget>()
  for (const target of targets) {
    uniqueTargets.set(modelTargetKey(target), target)
  }

  for (const target of uniqueTargets.values()) {
    await unloadModelForRuntime(target).catch((error) => {
      console.warn(
        `[gemma-desktop] Failed to unload idle Ollama model ${target.modelId} after keep-alive was disabled:`,
        error,
      )
    })
    if (primaryTargetsMatch(activePrimaryModelTarget, target)) {
      activePrimaryModelTarget = null
    }
  }

  if (uniqueTargets.size > 0) {
    broadcastEnvironmentModelsChanged()
  }
}

async function unloadConflictingOllamaPrimaryModels(
  nextPrimaryTarget: PrimaryModelTarget,
  currentSettings: AppSettingsRecord,
): Promise<void> {
  if (currentPrimaryHoldCount() > 0) {
    return
  }

  const loadedModelIds = await listOllamaLoadedModelIds(
    currentSettings.runtimes.ollama.endpoint,
  ).catch((error) => {
    console.warn(
      '[gemma-desktop] Failed to inspect loaded Ollama models before primary handoff:',
      error,
    )
    return []
  })
  if (loadedModelIds.length === 0) {
    return
  }

  const helperTarget = resolveHelperRouterTarget(currentSettings)
  const protectedModelIds = new Set<string>()
  if (isOllamaModelRuntime(helperTarget.runtimeId)) {
    protectedModelIds.add(helperTarget.modelId)
  }
  if (isOllamaModelRuntime(nextPrimaryTarget.runtimeId)) {
    protectedModelIds.add(nextPrimaryTarget.modelId)
  }

  const appPrimaryModelIds = new Set<string>()
  const addPrimaryTarget = (target: PrimaryModelTarget | null | undefined) => {
    if (target && isOllamaModelRuntime(target.runtimeId)) {
      appPrimaryModelIds.add(target.modelId)
    }
  }

  addPrimaryTarget(resolveSavedDefaultSessionPrimaryTarget(currentSettings.modelSelection))
  addPrimaryTarget(activePrimaryModelTarget)
  addPrimaryTarget(primaryModelLoadTarget)
  for (const target of listPendingModelLoadTargets()) {
    addPrimaryTarget(target)
  }
  for (const target of await listPersistedSessionPrimaryTargets()) {
    addPrimaryTarget(target)
  }

  const unloadModelIds = loadedModelIds.filter(
    (modelId) =>
      appPrimaryModelIds.has(modelId)
      && !protectedModelIds.has(modelId),
  )
  if (unloadModelIds.length === 0) {
    return
  }

  for (const modelId of unloadModelIds) {
    await unloadOllamaModel(currentSettings.runtimes.ollama.endpoint, modelId).catch((error) => {
      console.warn(
        `[gemma-desktop] Failed to unload inactive Ollama primary model ${modelId}:`,
        error,
      )
    })
    if (activePrimaryModelTarget?.modelId === modelId) {
      activePrimaryModelTarget = null
    }
  }

  broadcastEnvironmentModelsChanged()
}

function broadcastBootstrapStateChanged(): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'environment:bootstrap-changed',
    bootstrapState,
    'environment bootstrap state update',
  )
}

function broadcastEnvironmentModelsChanged(): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'environment:models-changed',
    null,
    'environment model state update',
  )
}

function markModelLoadPending(target: PrimaryModelTarget): () => void {
  const key = modelTargetKey(target)
  pendingModelLoadCounts.set(key, (pendingModelLoadCounts.get(key) ?? 0) + 1)
  pendingModelLoadTargets.set(key, { ...target })
  broadcastEnvironmentModelsChanged()

  return () => {
    const current = pendingModelLoadCounts.get(key) ?? 0
    if (current <= 1) {
      pendingModelLoadCounts.delete(key)
      pendingModelLoadTargets.delete(key)
    } else {
      pendingModelLoadCounts.set(key, current - 1)
    }
    broadcastEnvironmentModelsChanged()
  }
}

function setBootstrapState(
  patch: Partial<BootstrapStateRecord>,
  currentSettings?: Pick<AppSettingsRecord, 'modelSelection'> | null,
): BootstrapStateRecord {
  bootstrapState = {
    ...bootstrapState,
    ...patch,
    ...resolveBootstrapTargets(currentSettings ?? settings),
    updatedAt: Date.now(),
  }
  broadcastBootstrapStateChanged()
  return bootstrapState
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body.trim() || `${response.status} ${response.statusText}`.trim())
  }
  return await response.json() as Record<string, unknown>
}

async function canReachOllama(endpoint: string): Promise<boolean> {
  try {
    await requestJson(`${endpoint.replace(/\/$/, '')}/api/version`)
    return true
  } catch {
    return false
  }
}

async function waitForOllama(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canReachOllama(endpoint)) {
      return true
    }
    await delay(500)
  }
  return false
}

async function tryStartOllamaApp(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('open', ['-a', 'Ollama'], {
      env: process.env,
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', () => resolve())
  })
}

async function tryStartOllamaServe(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ollama', ['serve'], {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      stdio: 'ignore',
      detached: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

interface OllamaLoadedModelRecord {
  modelIds: string[]
  config: Record<string, unknown>
}

function extractOllamaLoadedModelIds(model: Record<string, unknown>): string[] {
  return [...new Set(
    [model.name, model.model]
      .filter((value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
      )
      .map((value) => value.trim()),
  )]
}

async function listOllamaLoadedModels(endpoint: string): Promise<OllamaLoadedModelRecord[]> {
  const response = await requestJson(`${endpoint.replace(/\/$/, '')}/api/ps`)
  const models = Array.isArray(response.models)
    ? response.models as Array<Record<string, unknown>>
    : []

  return models
    .map((model) => ({
      modelIds: extractOllamaLoadedModelIds(model),
      config: model,
    }))
    .filter((model) => model.modelIds.length > 0)
}

async function listOllamaLoadedModelIds(endpoint: string): Promise<string[]> {
  return [...new Set(
    (await listOllamaLoadedModels(endpoint)).flatMap((model) => model.modelIds),
  )]
}

async function findOllamaLoadedModel(
  endpoint: string,
  modelId: string,
): Promise<OllamaLoadedModelRecord | undefined> {
  return (await listOllamaLoadedModels(endpoint))
    .find((model) => model.modelIds.includes(modelId))
}

async function ensureOllamaRunning(endpoint: string): Promise<void> {
  if (await canReachOllama(endpoint)) {
    return
  }

  setBootstrapState({
    status: 'starting_ollama',
    ready: false,
    message: 'Starting Ollama…',
    error: undefined,
  })

  try {
    await tryStartOllamaServe()
  } catch (error) {
    console.warn('[gemma-desktop] Failed to start ollama serve:', error)
  }

  if (await waitForOllama(endpoint, 10_000)) {
    return
  }

  try {
    await tryStartOllamaApp()
  } catch {
    // Fall through to the reachability error below.
  }

  if (!(await waitForOllama(endpoint, 10_000))) {
    throw new LocalRuntimeUnavailableError({
      runtimeId: 'ollama-native',
      endpoint,
      action: 'checking local models',
    })
  }
}

async function listOllamaModelTags(endpoint: string): Promise<string[]> {
  const response = await requestJson(`${endpoint.replace(/\/$/, '')}/api/tags`)
  const models = Array.isArray(response.models)
    ? response.models as Array<Record<string, unknown>>
    : []
  return models
    .map((model) => (typeof model.name === 'string' ? model.name.trim() : ''))
    .filter((tag) => tag.length > 0)
}

async function pullOllamaModel(endpoint: string, modelId: string): Promise<void> {
  await requestJson(`${endpoint.replace(/\/$/, '')}/api/pull`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      stream: false,
    }),
  })
}

function resolveManagedOllamaLoadProfile(
  currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string },
): OllamaManagedModelProfile | undefined {
  return resolveManagedOllamaProfile(
    currentSettings.ollama,
    target.modelId,
    target.runtimeId,
  )
}

function resolveManagedLmStudioLoadProfile(
  currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string; displayName?: string },
): LmStudioManagedModelProfile | undefined {
  return resolveManagedLmStudioProfile(
    currentSettings.lmstudio,
    target.modelId,
    target.runtimeId,
    target.displayName,
    os.totalmem(),
  )
}

async function loadOllamaModel(
  endpoint: string,
  modelId: string,
  requestOptions?: Record<string, number>,
  keepAlive?: string,
): Promise<void> {
  await requestJson(`${endpoint.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [],
      ...(requestOptions ? { options: requestOptions } : {}),
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
      stream: false,
    }),
  })
}

async function unloadOllamaModel(endpoint: string, modelId: string): Promise<void> {
  await requestJson(`${endpoint.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [],
      keep_alive: 0,
      stream: false,
    }),
  })
}

function numericConfigValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function lmStudioLoadedConfigMatchesLoadOptions(
  loadedConfig: Record<string, unknown>,
  loadOptions: Record<string, number | boolean> | undefined,
): boolean {
  if (!loadOptions) {
    return true
  }

  const requestedContextLength = numericConfigValue(loadOptions.context_length)
  if (requestedContextLength == null) {
    return true
  }

  const loadedContextLength = numericConfigValue(loadedConfig.context_length)
  return loadedContextLength == null || loadedContextLength === requestedContextLength
}

async function loadLmStudioModel(
  endpoint: string,
  modelId: string,
  loadOptions?: Record<string, number | boolean>,
): Promise<Record<string, unknown>> {
  return await requestJson(`${endpoint.replace(/\/$/, '')}/api/v1/models/load`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      ...(loadOptions ?? {}),
      echo_load_config: true,
    }),
  })
}

function wrapLocalRuntimeLoadError(
  error: unknown,
  currentSettings: AppSettingsRecord,
  target: PrimaryModelTarget,
  action: string,
): unknown {
  const endpoint = getEndpointForModelTarget(currentSettings, target)
  if (!endpoint) {
    return error
  }

  return toLocalRuntimeUnavailableError(error, {
    runtimeId: target.runtimeId,
    endpoint,
    modelId: target.modelId,
    action,
  }) ?? error
}

async function loadModelForRuntime(
  target: PrimaryModelTarget,
): Promise<PrimaryModelTarget> {
  const releasePendingLoad = markModelLoadPending(target)

  try {
    const currentSettings = await getSettingsState()

    if (target.runtimeId === 'ollama-native' || target.runtimeId === 'ollama-openai') {
      const profile = resolveManagedOllamaLoadProfile(currentSettings, target)
      const requestOptions = buildOllamaOptionsRecord(profile)
      const loadedModel = await findOllamaLoadedModel(
        currentSettings.runtimes.ollama.endpoint,
        target.modelId,
      ).catch(() => undefined)
      if (
        loadedModel
        && !ollamaLoadedConfigMatchesManagedProfile(loadedModel.config, profile)
      ) {
        await unloadOllamaModel(
          currentSettings.runtimes.ollama.endpoint,
          target.modelId,
        ).catch((error) => {
          console.warn(
            '[gemma-desktop] Failed to unload mismatched Ollama model before reload:',
            error,
          )
        })
      }

      try {
        await loadOllamaModel(
          currentSettings.runtimes.ollama.endpoint,
          target.modelId,
          requestOptions,
          resolveOllamaRequestKeepAlive(currentSettings.runtimes.ollama),
        )
      } catch (error) {
        throw wrapLocalRuntimeLoadError(error, currentSettings, target, 'loading')
      }
      return target
    }

    if (isLmStudioModelRuntime(target.runtimeId)) {
      const endpoint = currentSettings.runtimes.lmstudio.endpoint.replace(/\/$/, '')
      const visibleModels = await requestJson(`${endpoint}/api/v1/models`).catch((error) => {
        if (isLocalRuntimeConnectionFailure(error)) {
          throw wrapLocalRuntimeLoadError(error, currentSettings, target, 'loading')
        }
        return null
      })
      const loadOptions = buildLmStudioLoadOptionsRecord(
        resolveManagedLmStudioLoadProfile(currentSettings, target),
      )
      const loadedInstance =
        visibleModels
        && findLoadedLmStudioInstance(visibleModels, target.modelId)

      if (
        loadedInstance
        && lmStudioLoadedConfigMatchesLoadOptions(loadedInstance.config, loadOptions)
      ) {
        return {
          ...target,
          loadedInstanceId: loadedInstance.id,
        }
      }

      if (loadedInstance) {
        await requestJson(`${endpoint}/api/v1/models/unload`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            instance_id: loadedInstance.id,
          }),
        }).catch((error) => {
          console.warn('[gemma-desktop] Failed to unload mismatched LM Studio model instance before reload:', error)
        })
      }

      const loadResult = await loadLmStudioModel(
        endpoint,
        target.modelId,
        loadOptions,
      ).catch((error) => {
        throw wrapLocalRuntimeLoadError(error, currentSettings, target, 'loading')
      })
      return {
        ...target,
        loadedInstanceId: extractLmStudioInstanceId(loadResult) ?? target.modelId,
      }
    }

    if (target.runtimeId === 'llamacpp-server') {
      try {
        await requestJson(`${currentSettings.runtimes.llamacpp.endpoint.replace(/\/$/, '')}/models/load`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: target.modelId,
          }),
        })
      } catch (error) {
        throw wrapLocalRuntimeLoadError(error, currentSettings, target, 'loading')
      }
    }

    if (isOmlxModelRuntime(target.runtimeId)) {
      return target
    }

    return target
  } finally {
    releasePendingLoad()
  }
}

async function unloadModelForRuntime(target: PrimaryModelTarget): Promise<void> {
  const currentSettings = await getSettingsState()

  if (target.runtimeId === 'ollama-native' || target.runtimeId === 'ollama-openai') {
    await unloadOllamaModel(currentSettings.runtimes.ollama.endpoint, target.modelId)
    return
  }

  if (target.runtimeId === 'lmstudio-native' || target.runtimeId === 'lmstudio-openai') {
    const endpoint = currentSettings.runtimes.lmstudio.endpoint.replace(/\/$/, '')
    const visibleModels = await requestJson(`${endpoint}/api/v1/models`).catch(() => null)
    const loadedInstanceId =
      target.loadedInstanceId
      ?? (visibleModels ? findLoadedLmStudioInstanceId(visibleModels, target.modelId) : undefined)
      ?? target.modelId

    await requestJson(`${endpoint}/api/v1/models/unload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        instance_id: loadedInstanceId,
      }),
    })
    return
  }

  if (target.runtimeId === 'llamacpp-server') {
    await requestJson(`${currentSettings.runtimes.llamacpp.endpoint.replace(/\/$/, '')}/models/unload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: target.modelId,
      }),
    })
    return
  }

  if (isOmlxModelRuntime(target.runtimeId)) {
    const apiKey = currentSettings.runtimes.omlx.apiKey.trim()
    await requestJson(`${currentSettings.runtimes.omlx.endpoint.replace(/\/$/, '')}/v1/models/${encodeURIComponent(target.modelId)}/unload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({}),
    })
  }
}

async function ensureBootstrapReady(force = false): Promise<BootstrapStateRecord> {
  if (!force) {
    if (bootstrapState.ready) {
      return bootstrapState
    }
    if (bootstrapPromise) {
      return await bootstrapPromise
    }
  }

  bootstrapPromise = (async () => {
    const currentSettings = await getSettingsState()
    const ollamaEndpoint = currentSettings.runtimes.ollama.endpoint
    const helperTarget = resolveHelperRouterTarget(currentSettings)
    const helperModelId = helperTarget.modelId
    const requiredPrimaryModelIds = resolveRequiredPrimaryModelIds(currentSettings)

    setBootstrapState({
      status: 'checking',
      ready: false,
      message: 'Checking local models…',
      error: undefined,
    }, currentSettings)

    try {
      const requiredTags = [...new Set([
        ...(isOllamaModelRuntime(helperTarget.runtimeId) ? [helperModelId] : []),
        ...requiredPrimaryModelIds,
      ])]
      const availableTags = new Set<string>()

      if (requiredTags.length > 0) {
        await ensureOllamaRunning(ollamaEndpoint)
        for (const tag of await listOllamaModelTags(ollamaEndpoint)) {
          availableTags.add(tag)
        }
      }

      for (const modelId of requiredTags) {
        if (availableTags.has(modelId)) {
          continue
        }

        setBootstrapState({
          status: 'pulling_models',
          ready: false,
          message: `Downloading ${modelId}…`,
          error: undefined,
        }, currentSettings)
        await pullOllamaModel(ollamaEndpoint, modelId)
        availableTags.add(modelId)
      }

      if (shouldWarmModelTarget(currentSettings, helperTarget)) {
        setBootstrapState({
          status: 'loading_helper',
          ready: false,
          message: `Loading helper model ${helperModelId}…`,
          error: undefined,
        }, currentSettings)
        await loadModelForRuntime(helperTarget)
      }

      const nextBootstrapState = setBootstrapState({
        status: 'ready',
        ready: true,
        message: shouldWarmModelTarget(currentSettings, helperTarget)
          ? `Helper model ${helperModelId} is ready.`
          : 'Ollama model keep-alive is disabled. Required models are available and will load on demand.',
        error: undefined,
      }, currentSettings)
      scheduleStartupPrimaryWarmup()
      return nextBootstrapState
    } catch (error) {
      const unavailable =
        getLocalRuntimeUnavailableError(error)
        ?? toLocalRuntimeUnavailableError(error, {
          runtimeId: 'ollama-native',
          endpoint: ollamaEndpoint,
          action: 'checking local models',
        })
      if (unavailable) {
        const nextBootstrapState = setBootstrapState({
          status: 'warning',
          ready: true,
          message: unavailable.message,
          error: undefined,
        }, currentSettings)
        scheduleStartupPrimaryWarmup()
        return nextBootstrapState
      }

      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : 'Gemma Desktop could not prepare the required Ollama models.'

      return setBootstrapState({
        status: 'error',
        ready: false,
        message,
        error: message,
      }, currentSettings)
    } finally {
      bootstrapPromise = null
    }
  })()

  return await bootstrapPromise
}

async function acquirePrimaryModelLease(
  ownerId: string,
  target: PrimaryModelTarget,
): Promise<() => void> {
  if (isOllamaModelRuntime(target.runtimeId)) {
    const bootstrap = await ensureBootstrapReady()
    if (!bootstrap.ready) {
      throw new Error(bootstrap.error ?? bootstrap.message)
    }
  }

  if (
    currentPrimaryHoldCount() > 0
    && activePrimaryModelTarget
    && !primaryTargetsMatch(activePrimaryModelTarget, target)
  ) {
    throw new Error(
      `Gemma Desktop is already running ${activePrimaryModelTarget.runtimeId} / ${activePrimaryModelTarget.modelId}. Wait for that work to finish or stop it before starting ${target.runtimeId} / ${target.modelId}.`,
    )
  }

  await ensurePrimaryModelTargetLoaded(target)

  primaryModelHoldCounts.set(ownerId, (primaryModelHoldCounts.get(ownerId) ?? 0) + 1)

  return () => {
    const current = primaryModelHoldCounts.get(ownerId) ?? 0
    if (current <= 1) {
      primaryModelHoldCounts.delete(ownerId)
      void unloadIdleOllamaModelsWhenKeepAliveDisabled()
      return
    }
    primaryModelHoldCounts.set(ownerId, current - 1)
  }
}

async function acquireHelperModelLease(
  ownerId: string,
): Promise<() => void> {
  const bootstrap = await ensureBootstrapReady()
  if (!bootstrap.ready) {
    throw new Error(bootstrap.error ?? bootstrap.message)
  }

  helperModelHoldCounts.set(ownerId, (helperModelHoldCounts.get(ownerId) ?? 0) + 1)

  const releaseLease = () => {
    const current = helperModelHoldCounts.get(ownerId) ?? 0
    if (current <= 1) {
      helperModelHoldCounts.delete(ownerId)
      void unloadIdleOllamaModelsWhenKeepAliveDisabled()
      return
    }

    helperModelHoldCounts.set(ownerId, current - 1)
  }

  try {
    await loadModelForRuntime(resolveHelperRouterTarget(await getSettingsState()))
  } catch (error) {
    releaseLease()
    throw error
  }

  return releaseLease
}

async function acquireSessionExecutionLease(
  ownerId: string,
  snapshot: SessionSnapshot,
): Promise<() => void> {
  if (isTalkSessionSnapshot(snapshot)) {
    return await acquireHelperModelLease(ownerId)
  }

  return await acquirePrimaryModelLease(ownerId, {
    modelId: snapshot.modelId,
    runtimeId: snapshot.runtimeId,
  })
}

function getDefaultSettings(): AppSettingsRecord {
  return {
    storageVersion: APP_STORAGE_VERSION,
    theme: 'system',
    enterToSend: true,
    defaultMode: 'explore',
    defaultProjectDirectory: getDefaultProjectDirectory(),
    terminal: {
      preferredAppId: null,
    },
    modelSelection: createDefaultModelSelectionSettings(os.totalmem()),
    compaction: {
      autoCompactEnabled: true,
      autoCompactThresholdPercent: 45,
    },
    skills: {
      scanRoots: defaultSkillRoots(app.getPath('userData')),
    },
    automations: {
      keepAwakeWhileRunning: false,
    },
    notifications: getDefaultNotificationSettings(),
    speech: {
      enabled: true,
      provider: 'managed-whisper-cpp',
      model: 'large-v3-turbo-q5_0',
    },
    readAloud: {
      enabled: true,
      provider: 'kokoro-js',
      model: 'Kokoro-82M-v1.0-ONNX',
      dtype: 'q8',
      defaultVoice: READ_ALOUD_DEFAULT_VOICE,
      speed: READ_ALOUD_DEFAULT_SPEED,
    },
    reasoning: getDefaultReasoningSettings(),
    ollama: getDefaultOllamaSettings(os.totalmem()),
    lmstudio: getDefaultLmStudioSettings(os.totalmem()),
    ambientEffects: {
      enabled: true,
    },
    tools: {
      chromeMcp: {
        enabled: false,
        defaultSelected: false,
        disableUsageStatistics: true,
        disablePerformanceCrux: true,
        lastStatus: {
          state: 'idle',
          message: 'Managed browser has not been used yet.',
          checkedAt: 0,
        },
      },
    },
    toolPolicy: getDefaultToolPolicySettings(),
    runtimes: {
      ollama: {
        endpoint: 'http://127.0.0.1:11434',
        numParallel: 2,
        maxLoadedModels: 2,
        keepAliveEnabled: true,
      },
      lmstudio: { endpoint: 'http://127.0.0.1:1234', maxConcurrentPredictions: 4 },
      llamacpp: { endpoint: 'http://127.0.0.1:8080' },
      omlx: { endpoint: 'http://127.0.0.1:8000', apiKey: '' },
    },
    integrations: {
      geminiApi: {
        apiKey: '',
        model: 'gemini-3-flash-preview',
      },
      geminiCli: {
        model: ASK_GEMINI_DEFAULT_MODEL,
      },
    },
  }
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN

  if (!Number.isFinite(numeric)) {
    return fallback
  }

  return Math.max(minimum, Math.round(numeric))
}

function normalizeOllamaRuntimeSettings(
  value: Partial<AppSettingsRecord['runtimes']['ollama']> | undefined,
  fallback: AppSettingsRecord['runtimes']['ollama'],
): AppSettingsRecord['runtimes']['ollama'] {
  return {
    endpoint:
      typeof value?.endpoint === 'string' && value.endpoint.trim().length > 0
        ? value.endpoint.trim()
        : fallback.endpoint,
    numParallel: normalizePositiveInteger(value?.numParallel, fallback.numParallel, 1),
    maxLoadedModels: normalizePositiveInteger(
      value?.maxLoadedModels,
      fallback.maxLoadedModels,
      2,
    ),
    keepAliveEnabled:
      typeof value?.keepAliveEnabled === 'boolean'
        ? value.keepAliveEnabled
        : fallback.keepAliveEnabled,
  }
}

async function ensureDirectoryExists(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  await fs.mkdir(resolved, { recursive: true })
  return resolved
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function getLastPickedDirectoryStatePath(): string {
  return path.join(app.getPath('userData'), 'lastPickedDirectory.txt')
}

async function readLastPickedDirectory(): Promise<string | null> {
  try {
    const raw = await fs.readFile(getLastPickedDirectoryStatePath(), 'utf-8')
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function writeLastPickedDirectory(targetPath: string): Promise<void> {
  try {
    const resolved = path.resolve(targetPath)
    await fs.writeFile(getLastPickedDirectoryStatePath(), resolved, 'utf-8')
  } catch (error) {
    console.error('Failed to persist last picked directory:', error)
  }
}

async function loadSettings(): Promise<AppSettingsRecord> {
  const defaults = getDefaultSettings()
  let loaded: Partial<AppSettingsRecord> = {}

  try {
    const raw = fsSync.readFileSync(getSettingsPath(), 'utf-8')
    loaded = JSON.parse(raw) as Partial<AppSettingsRecord>
  } catch {
    loaded = {}
  }

  const canReuseStoredSettings = loaded.storageVersion === APP_STORAGE_VERSION
  const reusable = canReuseStoredSettings ? loaded : {}
  storageResetRequired = !canReuseStoredSettings

  const merged: AppSettingsRecord = {
    ...defaults,
    ...reusable,
    storageVersion: APP_STORAGE_VERSION,
    defaultMode: normalizeAppSessionMode(
      reusable.defaultMode,
      defaults.defaultMode,
    ),
    terminal: {
      preferredAppId:
        typeof reusable.terminal?.preferredAppId === 'string'
          && reusable.terminal.preferredAppId.trim().length > 0
          ? reusable.terminal.preferredAppId
          : null,
    },
    modelSelection: normalizeAppModelSelectionSettings(
      reusable.modelSelection,
      defaults.modelSelection,
    ),
    compaction: {
      ...defaults.compaction,
      ...(reusable.compaction ?? {}),
      autoCompactThresholdPercent:
        typeof reusable.compaction?.autoCompactThresholdPercent === 'number'
        && Number.isFinite(reusable.compaction.autoCompactThresholdPercent)
          ? Math.min(
              90,
              Math.max(5, Math.round(reusable.compaction.autoCompactThresholdPercent)),
            )
          : defaults.compaction.autoCompactThresholdPercent,
    },
    skills: {
      scanRoots: defaults.skills.scanRoots,
    },
    automations: {
      ...defaults.automations,
      ...(reusable.automations ?? {}),
    },
    notifications: normalizeNotificationSettings(
      reusable.notifications,
      defaults.notifications,
    ),
    speech: {
      ...defaults.speech,
      ...(reusable.speech ?? {}),
      enabled:
        typeof reusable.speech?.enabled === 'boolean'
          ? reusable.speech.enabled
          : defaults.speech.enabled,
      provider: 'managed-whisper-cpp',
      model: 'large-v3-turbo-q5_0',
    },
    readAloud: {
      ...defaults.readAloud,
      ...(reusable.readAloud ?? {}),
      enabled:
        typeof reusable.readAloud?.enabled === 'boolean'
          ? reusable.readAloud.enabled
          : defaults.readAloud.enabled,
      provider: 'kokoro-js',
      model: 'Kokoro-82M-v1.0-ONNX',
      dtype: 'q8',
      defaultVoice: normalizeReadAloudVoice(
        reusable.readAloud?.defaultVoice,
      ),
      speed: clampReadAloudSpeed(reusable.readAloud?.speed),
    },
    reasoning: normalizeReasoningSettings(
      reusable.reasoning,
      defaults.reasoning,
    ),
    ollama: normalizeOllamaSettings(
      reusable.ollama,
      defaults.ollama,
    ),
    lmstudio: normalizeLmStudioSettings(
      reusable.lmstudio,
      defaults.lmstudio,
    ),
    tools: {
      ...defaults.tools,
      ...(reusable.tools ?? {}),
      chromeMcp: {
        ...defaults.tools.chromeMcp,
        ...(reusable.tools?.chromeMcp ?? {}),
      },
    },
    toolPolicy: normalizeToolPolicySettings(
      reusable.toolPolicy,
      defaults.toolPolicy,
    ),
    runtimes: {
      ollama: normalizeOllamaRuntimeSettings(
        reusable.runtimes?.ollama,
        defaults.runtimes.ollama,
      ),
      lmstudio: { ...defaults.runtimes.lmstudio, ...(reusable.runtimes?.lmstudio ?? {}) },
      llamacpp: { ...defaults.runtimes.llamacpp, ...(reusable.runtimes?.llamacpp ?? {}) },
      omlx: { ...defaults.runtimes.omlx, ...(reusable.runtimes?.omlx ?? {}) },
    },
    integrations: {
      geminiCli: {
        ...defaults.integrations.geminiCli,
        ...(reusable.integrations?.geminiCli ?? {}),
      },
      geminiApi: (() => {
        const merged = {
          ...defaults.integrations.geminiApi,
          ...(reusable.integrations?.geminiApi ?? {}),
        }
        if (
          merged.model === 'gemini-2.5-flash'
          || merged.model === 'gemini-3.1-flash-preview'
        ) {
          merged.model = defaults.integrations.geminiApi.model
        }
        return merged
      })(),
    },
    defaultProjectDirectory:
      typeof reusable.defaultProjectDirectory === 'string'
        && reusable.defaultProjectDirectory.trim().length > 0
        ? reusable.defaultProjectDirectory
        : defaults.defaultProjectDirectory,
  }

  merged.defaultProjectDirectory = await ensureDirectoryExists(
    merged.defaultProjectDirectory,
  )

  settings = merged
  await fs.writeFile(
    getSettingsPath(),
    JSON.stringify(merged, null, 2),
    'utf-8',
  )
  return merged
}

async function getSettingsState(): Promise<AppSettingsRecord> {
  return settings ?? (await loadSettings())
}

async function saveSettings(
  patch: Partial<AppSettingsRecord>,
): Promise<AppSettingsRecord> {
  const current = await getSettingsState()
  const next: AppSettingsRecord = {
    ...current,
    ...patch,
    storageVersion: APP_STORAGE_VERSION,
    defaultMode: normalizeAppSessionMode(
      patch.defaultMode,
      current.defaultMode,
    ),
    terminal: {
      preferredAppId:
        typeof patch.terminal?.preferredAppId === 'string'
          && patch.terminal.preferredAppId.trim().length > 0
          ? patch.terminal.preferredAppId
          : patch.terminal?.preferredAppId === null
            ? null
            : current.terminal.preferredAppId,
    },
    modelSelection: normalizeAppModelSelectionSettings(
      patch.modelSelection ?? current.modelSelection,
      current.modelSelection,
    ),
    compaction: {
      ...current.compaction,
      ...(patch.compaction ?? {}),
      autoCompactThresholdPercent:
        typeof patch.compaction?.autoCompactThresholdPercent === 'number'
        && Number.isFinite(patch.compaction.autoCompactThresholdPercent)
          ? Math.min(
              90,
              Math.max(5, Math.round(patch.compaction.autoCompactThresholdPercent)),
            )
          : current.compaction.autoCompactThresholdPercent,
    },
    skills: {
      scanRoots: current.skills.scanRoots,
    },
    automations: {
      ...current.automations,
      ...(patch.automations ?? {}),
    },
    notifications: normalizeNotificationSettings(
      patch.notifications ?? current.notifications,
      current.notifications,
    ),
    speech: {
      ...current.speech,
      ...(patch.speech ?? {}),
      enabled:
        typeof patch.speech?.enabled === 'boolean'
          ? patch.speech.enabled
          : current.speech.enabled,
      provider: 'managed-whisper-cpp',
      model: 'large-v3-turbo-q5_0',
    },
    readAloud: {
      ...current.readAloud,
      ...(patch.readAloud ?? {}),
      enabled:
        typeof patch.readAloud?.enabled === 'boolean'
          ? patch.readAloud.enabled
          : current.readAloud.enabled,
      provider: 'kokoro-js',
      model: 'Kokoro-82M-v1.0-ONNX',
      dtype: 'q8',
      defaultVoice: normalizeReadAloudVoice(
        patch.readAloud?.defaultVoice ?? current.readAloud.defaultVoice,
      ),
      speed: clampReadAloudSpeed(
        patch.readAloud?.speed ?? current.readAloud.speed,
      ),
    },
    reasoning: normalizeReasoningSettings(
      patch.reasoning ?? current.reasoning,
      current.reasoning,
    ),
    ollama: normalizeOllamaSettings(
      patch.ollama ?? current.ollama,
      current.ollama,
    ),
    lmstudio: normalizeLmStudioSettings(
      patch.lmstudio ?? current.lmstudio,
      current.lmstudio,
    ),
    ambientEffects: {
      ...current.ambientEffects,
      ...(patch.ambientEffects ?? {}),
    },
    tools: {
      ...current.tools,
      ...(patch.tools ?? {}),
      chromeMcp: {
        ...current.tools.chromeMcp,
        ...(patch.tools?.chromeMcp ?? {}),
      },
    },
    toolPolicy: normalizeToolPolicySettings(
      patch.toolPolicy,
      current.toolPolicy,
    ),
    runtimes: {
      ...current.runtimes,
      ...(patch.runtimes ?? {}),
      ollama: normalizeOllamaRuntimeSettings(
        patch.runtimes?.ollama ?? current.runtimes.ollama,
        current.runtimes.ollama,
      ),
    },
    integrations: {
      geminiApi: {
        ...current.integrations.geminiApi,
        ...(patch.integrations?.geminiApi ?? {}),
      },
      geminiCli: {
        ...current.integrations.geminiCli,
        ...(patch.integrations?.geminiCli ?? {}),
      },
    },
    defaultProjectDirectory:
      typeof patch.defaultProjectDirectory === 'string'
        && patch.defaultProjectDirectory.trim().length > 0
        ? patch.defaultProjectDirectory
        : current.defaultProjectDirectory,
  }

  next.defaultProjectDirectory = await ensureDirectoryExists(
    next.defaultProjectDirectory,
  )
  settings = next

  await fs.writeFile(
    getSettingsPath(),
    JSON.stringify(next, null, 2),
    'utf-8',
  )
  return next
}

function broadcastSettingsChanged(nextSettings: AppSettingsRecord): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'settings:changed',
    nextSettings,
    'settings:changed',
  )
}

async function refreshBootstrapModelSelection(
  nextSettings: AppSettingsRecord,
  patch: Record<string, unknown>,
): Promise<void> {
  setBootstrapState({}, nextSettings)

  const modelSelectionChanged = Object.prototype.hasOwnProperty.call(
    patch,
    'modelSelection',
  )
  const runtimesPatch =
    patch.runtimes && typeof patch.runtimes === 'object' && !Array.isArray(patch.runtimes)
      ? patch.runtimes as Record<string, unknown>
      : undefined
  const ollamaRuntimePatch =
    runtimesPatch?.ollama
    && typeof runtimesPatch.ollama === 'object'
    && !Array.isArray(runtimesPatch.ollama)
      ? runtimesPatch.ollama as Record<string, unknown>
      : undefined
  const keepAliveChanged = Boolean(
    ollamaRuntimePatch
    && Object.prototype.hasOwnProperty.call(ollamaRuntimePatch, 'keepAliveEnabled'),
  )

  if (!modelSelectionChanged && !keepAliveChanged) {
    return
  }

  if (!bootstrapState.ready) {
    return
  }

  if (currentPrimaryHoldCount() > 0 || currentHelperHoldCount() > 0) {
    return
  }

  if (!nextSettings.runtimes.ollama.keepAliveEnabled) {
    await unloadIdleOllamaModelsWhenKeepAliveDisabled(nextSettings)
    setBootstrapState({
      status: 'ready',
      ready: true,
      message: 'Ollama model keep-alive is disabled. Models will load on demand.',
      error: undefined,
    }, nextSettings)
    return
  }

  await ensureBootstrapReady(true)
}

async function persistBrowserToolLastStatus(
  status: BrowserToolStatusRecord,
): Promise<void> {
  const currentSettings = await getSettingsState()
  const nextSettings = await saveSettings({
    tools: {
      chromeMcp: {
        ...currentSettings.tools.chromeMcp,
        lastStatus: status,
      },
    },
  })
  broadcastSettingsChanged(nextSettings)
}

function getAvailableSessionTools(
  currentSettings: AppSettingsRecord,
  input?: {
    chromeDevtoolsAllowed?: boolean
  },
): SessionToolDefinition[] {
  return getSessionToolDefinitions({
    chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
    chromeDevtoolsAllowed: input?.chromeDevtoolsAllowed,
  })
}

function isChromeDevtoolsAllowedForSession(input: {
  conversationKind: ConversationKind
  baseMode: BaseSessionMode
  planMode: boolean
  surface?: AppSessionSurface
}): boolean {
  return (
    input.conversationKind === 'normal'
    && input.baseMode === 'build'
    && !input.planMode
    && !isTalkSessionSurface(input.surface ?? 'default')
  )
}

function normalizeSelectedToolIds(
  selectedToolIds: string[] | undefined,
  currentSettings: AppSettingsRecord,
): string[] {
  const requested =
    Array.isArray(selectedToolIds) && selectedToolIds.length > 0
      ? selectedToolIds
      : getDefaultSelectedSessionToolIds({
          chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
          chromeMcpDefaultSelected:
            currentSettings.tools.chromeMcp.defaultSelected,
        })

  return getSelectedSessionToolIds(requested, {
    chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
  })
}

function buildBrowserToolManager(): BrowserSessionManager {
  return new BrowserSessionManager({
    onStatus: async (status) => {
      await persistBrowserToolLastStatus(status)
    },
    onLog: (sessionId, line) => {
      appendDebugLog(sessionId, {
        layer: 'runtime',
        direction: 'runtime->sdk',
        event: 'browser-tool.log',
        summary: line,
        data: { line },
      })
    },
    persistArtifact: async (input) =>
      await persistChromeBrowserArtifact(input),
  })
}

function buildChromeDevtoolsToolManager(
  currentSettings: AppSettingsRecord,
): ChromeMcpSessionManager {
  return new ChromeMcpSessionManager({
    disableUsageStatistics:
      currentSettings.tools.chromeMcp.disableUsageStatistics,
    disablePerformanceCrux:
      currentSettings.tools.chromeMcp.disablePerformanceCrux,
    onStatus: () => {},
    onLog: (sessionId, line) => {
      appendDebugLog(sessionId, {
        layer: 'runtime',
        direction: 'runtime->sdk',
        event: 'chrome-devtools.log',
        summary: line,
        data: { line },
      })
    },
    persistArtifact: async (input) =>
      await persistChromeBrowserArtifact(input),
  })
}

async function reconfigureBrowserToolManager(
  currentSettings: AppSettingsRecord,
): Promise<void> {
  await browserToolManager?.shutdown()
  await chromeDevtoolsToolManager?.shutdown()
  browserToolManager = buildBrowserToolManager()
  chromeDevtoolsToolManager = buildChromeDevtoolsToolManager(currentSettings)
}

async function clearPersistedAppState(): Promise<void> {
  const sidebarState = readSidebarStateFileSync(getSidebarStatePath())
  await Promise.all([
    ...sidebarState.projectPaths.map(async (projectPath) => {
      await fs.rm(getPersistedSessionsDirectory(projectPath), {
        recursive: true,
        force: true,
      })
    }),
    fs.rm(path.join(app.getPath('userData'), 'automations'), {
      recursive: true,
      force: true,
    }),
    fs.rm(getGlobalSessionStateDirectory(app.getPath('userData')), {
      recursive: true,
      force: true,
    }),
    fs.rm(getSidebarStatePath(), {
      force: true,
    }),
  ])
}

async function isGemmaModelInstalled(tag: string): Promise<boolean> {
  try {
    const environment = await gemmaDesktop.inspectEnvironment()
    const ollamaNative = environment.runtimes.find(
      (runtime) => runtime.runtime.id === 'ollama-native',
    )

    return Boolean(
      ollamaNative?.models.some((model) => model.id === tag),
    )
  } catch {
    return false
  }
}

async function confirmGemmaDownload(
  entry: GemmaCatalogEntry,
): Promise<boolean> {
  const focusedWindow = BrowserWindow.getFocusedWindow() ?? undefined
  const response = focusedWindow
    ? await dialog.showMessageBox(focusedWindow, {
        type: 'question',
        buttons: ['Download model', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: `Download ${entry.label}?`,
        message: `Download ${entry.label} from Ollama now?`,
        detail: [
          `${entry.shortLabel} is the ${entry.tierLabel.toLowerCase()} Gemma preset.`,
          `Gemma Desktop will run \`ollama pull ${entry.tag}\`, wait for the download to finish, then refresh the local model inventory.`,
          'This can take a while depending on the model size and network speed.',
        ].join('\n\n'),
      })
    : await dialog.showMessageBox({
        type: 'question',
        buttons: ['Download model', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: `Download ${entry.label}?`,
        message: `Download ${entry.label} from Ollama now?`,
        detail: [
          `${entry.shortLabel} is the ${entry.tierLabel.toLowerCase()} Gemma preset.`,
          `Gemma Desktop will run \`ollama pull ${entry.tag}\`, wait for the download to finish, then refresh the local model inventory.`,
          'This can take a while depending on the model size and network speed.',
        ].join('\n\n'),
      })

  return response.response === 0
}

async function ensureSessionAssetDirectory(
  sessionId: string,
  workingDirectory?: string,
): Promise<string> {
  const resolvedWorkingDirectory =
    workingDirectory
    || store.getWorkingDirectory(sessionId)

  if (!resolvedWorkingDirectory) {
    throw new Error(`Working directory missing for session ${sessionId}.`)
  }

  const dir = getPersistedSessionAssetDirectory(resolvedWorkingDirectory, sessionId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function persistChromeBrowserArtifact(input: {
  sessionId: string
  action: string
  text: string
  metadata?: Record<string, unknown>
  extension?: 'md' | 'txt'
}): Promise<{
  path: string
  fileUrl: string
}> {
  const assetDirectory = await ensureSessionAssetDirectory(input.sessionId)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeAction = sanitizeExportFilename(input.action || 'browser').replace(/\s+/g, '-')
  const extension = input.extension === 'txt' ? 'txt' : 'md'
  const filename = `browser-${safeAction || 'artifact'}-${timestamp}-${randomUUID().slice(0, 8)}.${extension}`
  const targetPath = path.join(assetDirectory, filename)
  const metadataLines = Object.entries(input.metadata ?? {})
    .flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return []
      }

      return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
    })

  const document = [
    '# Browser Artifact',
    `action: ${input.action}`,
    `capturedAt: ${new Date().toISOString()}`,
    ...metadataLines,
    '',
    input.text,
    '',
  ].join('\n')

  await fs.writeFile(targetPath, document, 'utf-8')

  return {
    path: targetPath,
    fileUrl: pathToFileURL(targetPath).toString(),
  }
}

function toDisplayAssetUrl(url: string): string {
  if (url.startsWith('file://') || url.startsWith('data:')) {
    return url
  }

  if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('\\\\')) {
    return pathToFileURL(url).toString()
  }

  if (/^[A-Za-z][A-Za-z\d+\-.]*:/.test(url)) {
    return url
  }

  return url
}

const APP_SESSION_METADATA_KEY = 'gemmaDesktopApp'
const REQUEST_PREFERENCES_METADATA_KEY = 'requestPreferences'

function readRequestPreferences(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const value = metadata?.[REQUEST_PREFERENCES_METADATA_KEY]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeRequestPreferenceNumericOptions(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === 'number' && Number.isFinite(entry),
  )
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined
}

function sameNumericRecord(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): boolean {
  if (!left && !right) {
    return true
  }
  if (!left || !right) {
    return false
  }

  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key],
  )
}

function resolveEffectiveOllamaOptions(
  currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string },
): Record<string, number> | undefined {
  return buildOllamaOptionsRecord(
    resolveManagedOllamaProfile(
      currentSettings.ollama,
      target.modelId,
      target.runtimeId,
    ),
  )
}

function resolveEffectiveLmStudioOptions(
  currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string; displayName?: string },
): Record<string, number> | undefined {
  return buildLmStudioRequestOptionsRecord(
    resolveManagedLmStudioProfile(
      currentSettings.lmstudio,
      target.modelId,
      target.runtimeId,
      target.displayName,
      os.totalmem(),
    ),
  )
}

function resolveBaseMode(mode: SessionSnapshot['mode']): BaseSessionMode {
  if (typeof mode === 'string') {
    if (mode === 'build') {
      return 'build'
    }
    if (
      mode === 'assistant'
      || mode === 'explore'
      || mode === 'cowork'
      || mode === 'planner'
      || mode === 'plan'
    ) {
      return 'explore'
    }
  }

  if (
    typeof mode === 'object'
    && mode
  ) {
    const base = (mode as { base?: unknown }).base
    if (base === 'build') {
      return 'build'
    }
    if (
      base === 'assistant'
      || base === 'explore'
      || base === 'cowork'
      || base === 'planner'
      || base === 'plan'
    ) {
      return 'explore'
    }
  }

  return 'explore'
}

function resolveLegacyPlanMode(mode: SessionSnapshot['mode']): boolean {
  if (typeof mode === 'string') {
    return mode === 'planner' || mode === 'plan'
  }

  if (typeof mode === 'object' && mode) {
    const base = (mode as { base?: unknown }).base
    return base === 'planner' || base === 'plan'
  }

  return false
}

function getSessionConfigFromMetadata(
  metadataRecord: Record<string, unknown> | undefined,
  fallbackBaseMode: BaseSessionMode,
  fallbackPlanMode = false,
): AppSessionConfig {
  const metadata =
    metadataRecord?.[APP_SESSION_METADATA_KEY] as
      | Partial<AppSessionConfig>
      | undefined

  const selectedSkillIds = Array.isArray(metadata?.selectedSkillIds)
    ? metadata.selectedSkillIds.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedSkillNames = Array.isArray(metadata?.selectedSkillNames)
    ? metadata.selectedSkillNames.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedToolIds = Array.isArray(metadata?.selectedToolIds)
    ? metadata.selectedToolIds.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  const selectedToolNames = Array.isArray(metadata?.selectedToolNames)
    ? metadata.selectedToolNames.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : []
  return {
    conversationKind: normalizeConversationKind(metadata?.conversationKind),
    baseMode: isBaseSessionMode(metadata?.baseMode)
      ? metadata.baseMode
      : fallbackBaseMode,
    planMode:
      typeof metadata?.planMode === 'boolean'
        ? metadata.planMode
        : fallbackPlanMode,
    preferredRuntimeId:
      typeof metadata?.preferredRuntimeId === 'string'
      && metadata.preferredRuntimeId.trim().length > 0
        ? metadata.preferredRuntimeId
        : '',
    selectedSkillIds,
    selectedSkillNames,
    selectedToolIds,
    selectedToolNames,
    surface: normalizeAppSessionSurface(metadata?.surface),
    visibility: normalizeAppSessionVisibility(metadata?.visibility),
    storageScope: normalizeAppSessionStorageScope(metadata?.storageScope),
  }
}

function getSessionConfig(snapshot: SessionSnapshot): AppSessionConfig {
  const config = normalizeSessionConfig(getSessionConfigFromMetadata(
    snapshot.metadata,
    resolveBaseMode(snapshot.mode),
    resolveLegacyPlanMode(snapshot.mode),
  ))

  return {
    ...config,
    preferredRuntimeId:
      config.preferredRuntimeId.trim().length > 0
        ? config.preferredRuntimeId
        : snapshot.runtimeId,
  }
}

function createSessionMetadata(
  snapshot: SessionSnapshot | null,
  config: AppSessionConfig,
): Record<string, unknown> {
  return {
    ...withoutCoBrowseSessionMetadata(snapshot?.metadata ?? {}),
    [APP_SESSION_METADATA_KEY]: {
      conversationKind: config.conversationKind,
      baseMode: config.baseMode,
      planMode: config.planMode,
      preferredRuntimeId: config.preferredRuntimeId,
      selectedSkillIds: [...config.selectedSkillIds],
      selectedSkillNames: [...config.selectedSkillNames],
      selectedToolIds: [...config.selectedToolIds],
      selectedToolNames: [...config.selectedToolNames],
      surface: config.surface,
      visibility: config.visibility,
      storageScope: config.storageScope,
    },
  }
}

function isTalkSessionConfig(
  config: Pick<AppSessionConfig, 'surface'>,
): boolean {
  return isTalkSessionSurface(config.surface)
}

function isHiddenSessionConfig(
  config: Pick<AppSessionConfig, 'visibility'>,
): boolean {
  return isHiddenSessionVisibility(config.visibility)
}

function isTalkSessionSnapshot(snapshot: SessionSnapshot): boolean {
  return isTalkSessionId(snapshot.sessionId) || isTalkSessionConfig(getSessionConfig(snapshot))
}

function isHiddenSessionSnapshot(snapshot: SessionSnapshot): boolean {
  return isTalkSessionSnapshot(snapshot) || isHiddenSessionConfig(getSessionConfig(snapshot))
}

function resolveSessionStorageDirectory(
  sessionId: string,
  snapshot: SessionSnapshot,
  storageScope = getSessionConfig(snapshot).storageScope,
): string {
  if (storageScope === 'global') {
    if (sessionId === TALK_SESSION_ID || isTalkSessionSnapshot(snapshot)) {
      return getTalkSessionStorageDirectory(app.getPath('userData'))
    }
  }

  return path.dirname(
    getPersistedSessionFilePath(snapshot.workingDirectory, sessionId),
  )
}

function buildTalkSessionConfig(): AppSessionConfig {
  return normalizeSessionConfig({
    conversationKind: 'normal',
    baseMode: 'explore',
    planMode: false,
    preferredRuntimeId: TALK_SESSION_RUNTIME_ID,
    selectedSkillIds: [],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    surface: 'talk',
    visibility: 'hidden',
    storageScope: 'global',
  })
}

function migrateLegacyPendingPlanExecution(
  pendingPlanExecution: LegacyPendingPlanExecution | undefined,
): PendingPlanExit | undefined {
  if (!pendingPlanExecution) {
    return undefined
  }

  return {
    id: pendingPlanExecution.id,
    turnId: pendingPlanExecution.turnId,
    createdAt: pendingPlanExecution.createdAt,
    workMode: normalizeAppSessionMode(
      pendingPlanExecution.recommendedMode,
      'build',
    ),
    summary: pendingPlanExecution.summary,
    details:
      pendingPlanExecution.executionPrompt.trim().length > 0
        ? pendingPlanExecution.executionPrompt
        : undefined,
    source: pendingPlanExecution.source,
    trigger:
      pendingPlanExecution.trigger === 'blocked_build_tool'
        ? 'blocked_build_tool'
        : 'legacy_prepare_plan_execution',
    attentionToken: pendingPlanExecution.attentionToken,
  }
}

function normalizePersistedSessionData(
  data: PersistedSession,
): PersistedSession {
  const pendingPlanExit =
    data.pendingPlanExit
    ?? migrateLegacyPendingPlanExecution(data.pendingPlanExecution)
  const metadataRecord =
    data.snapshot.metadata?.[APP_SESSION_METADATA_KEY] as
      | Partial<AppSessionConfig>
      | undefined
  const metadataBaseMode =
    typeof (metadataRecord as Record<string, unknown> | undefined)?.baseMode === 'string'
      ? (metadataRecord as Record<string, unknown>).baseMode
      : undefined
  const legacyPlannerMode =
    resolveLegacyPlanMode(data.snapshot.mode)
    || metadataBaseMode === 'planner'
  const currentConfig = getSessionConfigFromMetadata(
    data.snapshot.metadata,
    resolveBaseMode(data.snapshot.mode),
    resolveLegacyPlanMode(data.snapshot.mode),
  )
  const shouldForceTalkConfig =
    isTalkSessionId(data.meta.id)
    || isTalkSessionId(data.snapshot.sessionId)
    || isTalkSessionSurface(metadataRecord?.surface)
  const nextConfig: AppSessionConfig = shouldForceTalkConfig
    ? buildTalkSessionConfig()
    : {
        ...currentConfig,
        baseMode:
          legacyPlannerMode
            ? pendingPlanExit?.workMode ?? 'explore'
            : currentConfig.baseMode,
        planMode:
          typeof metadataRecord?.planMode === 'boolean'
            ? metadataRecord.planMode
            : legacyPlannerMode || currentConfig.planMode,
      }
  const nextSnapshot: SessionSnapshot = {
    ...data.snapshot,
    mode: toSdkSessionMode(nextConfig.baseMode),
    metadata: createSessionMetadata(data.snapshot, normalizeSessionConfig(nextConfig)),
  }

  return {
    ...data,
    snapshot: nextSnapshot,
    pendingPlanExit,
  }
}

function resolveEffectiveReasoningMode(
  _currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string },
): 'on' | undefined {
  return supportsReasoningControlForModel(target.modelId, target.runtimeId)
    ? 'on'
    : undefined
}

function resolveEffectiveOllamaKeepAlive(
  currentSettings: AppSettingsRecord,
  target: { runtimeId: string },
): string | undefined {
  return target.runtimeId === 'ollama-native'
    ? resolveOllamaRequestKeepAlive(currentSettings.runtimes.ollama)
    : undefined
}

function withResolvedRequestPreferencesMetadata(
  metadata: Record<string, unknown> | undefined,
  currentSettings: AppSettingsRecord,
  target: { modelId: string; runtimeId: string },
): Record<string, unknown> | undefined {
  const reasoningMode = resolveEffectiveReasoningMode(currentSettings, target)
  const ollamaOptions = resolveEffectiveOllamaOptions(currentSettings, target)
  const lmstudioOptions = resolveEffectiveLmStudioOptions(currentSettings, target)
  const ollamaKeepAlive = resolveEffectiveOllamaKeepAlive(currentSettings, target)
  const currentPreferences = readRequestPreferences(metadata)
  const currentReasoningMode =
    currentPreferences?.reasoningMode === 'auto'
    || currentPreferences?.reasoningMode === 'on'
      ? currentPreferences.reasoningMode
      : undefined
  const currentOllamaKeepAlive =
    typeof currentPreferences?.ollamaKeepAlive === 'string'
    && currentPreferences.ollamaKeepAlive.trim().length > 0
      ? currentPreferences.ollamaKeepAlive.trim()
      : undefined
  const currentOllamaOptions = normalizeRequestPreferenceNumericOptions(
    currentPreferences?.ollamaOptions,
  )
  const currentLmStudioOptions = normalizeRequestPreferenceNumericOptions(
    currentPreferences?.lmstudioOptions,
  )

  if (
    currentReasoningMode === reasoningMode
    && currentOllamaKeepAlive === ollamaKeepAlive
    && sameNumericRecord(currentOllamaOptions, ollamaOptions)
    && sameNumericRecord(currentLmStudioOptions, lmstudioOptions)
  ) {
    return metadata
  }

  const nextMetadata = { ...(metadata ?? {}) }

  const nextPreferences = { ...(currentPreferences ?? {}) }
  if (reasoningMode) {
    nextPreferences.reasoningMode = reasoningMode
  } else {
    delete nextPreferences.reasoningMode
  }
  if (ollamaOptions) {
    nextPreferences.ollamaOptions = ollamaOptions
  } else {
    delete nextPreferences.ollamaOptions
  }
  if (ollamaKeepAlive) {
    nextPreferences.ollamaKeepAlive = ollamaKeepAlive
  } else {
    delete nextPreferences.ollamaKeepAlive
  }
  if (lmstudioOptions) {
    nextPreferences.lmstudioOptions = lmstudioOptions
  } else {
    delete nextPreferences.lmstudioOptions
  }

  if (Object.keys(nextPreferences).length > 0) {
    nextMetadata[REQUEST_PREFERENCES_METADATA_KEY] = nextPreferences
  } else {
    delete nextMetadata[REQUEST_PREFERENCES_METADATA_KEY]
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined
}

async function syncSessionRequestPreferences(
  sessionId: string,
  session: GemmaDesktopSession,
  snapshot: SessionSnapshot,
  currentSettings: AppSettingsRecord,
): Promise<{
  session: GemmaDesktopSession
  snapshot: SessionSnapshot
}> {
  const nextMetadata = withResolvedRequestPreferencesMetadata(
    snapshot.metadata,
    currentSettings,
    {
      modelId: snapshot.modelId,
      runtimeId: snapshot.runtimeId,
    },
  )

  if (nextMetadata === snapshot.metadata) {
    return {
      session,
      snapshot,
    }
  }

  const nextSnapshot: SessionSnapshot = {
    ...snapshot,
    metadata: nextMetadata,
    savedAt: new Date().toISOString(),
  }
  const nextSession = await gemmaDesktop.sessions.resume({
    snapshot: nextSnapshot,
  })

  liveSessions.set(sessionId, nextSession)

  return {
    session: nextSession,
    snapshot: nextSnapshot,
  }
}

type SessionCompositionFrame = Pick<
  SessionSnapshot,
  'mode' | 'systemInstructions' | 'metadata'
>

function captureSessionCompositionFrame(
  snapshot: SessionSnapshot,
): SessionCompositionFrame {
  return {
    mode: snapshot.mode,
    systemInstructions: snapshot.systemInstructions,
    metadata: snapshot.metadata,
  }
}

async function applySessionCompositionFrame(
  sessionId: string,
  snapshot: SessionSnapshot,
  frame: SessionCompositionFrame,
): Promise<{
  session: GemmaDesktopSession
  snapshot: SessionSnapshot
}> {
  const nextSnapshot: SessionSnapshot = {
    ...snapshot,
    mode: frame.mode,
    systemInstructions: frame.systemInstructions,
    metadata: frame.metadata,
    savedAt: new Date().toISOString(),
  }
  const nextSession = await gemmaDesktop.sessions.resume({
    snapshot: nextSnapshot,
  })
  liveSessions.set(sessionId, nextSession)

  return {
    session: nextSession,
    snapshot: nextSnapshot,
  }
}

async function applyCoBrowseSessionComposition(
  sessionId: string,
  snapshot: SessionSnapshot,
): Promise<{
  session: GemmaDesktopSession
  snapshot: SessionSnapshot
  restore: (latestSnapshot: SessionSnapshot) => Promise<{
    session: GemmaDesktopSession
    snapshot: SessionSnapshot
  }>
}> {
  const restoreFrame = captureSessionCompositionFrame(snapshot)
  const currentConfig = isTalkSessionSnapshot(snapshot)
    ? buildTalkSessionConfig()
    : getSessionConfig(snapshot)
  const sessionMode = resolveAppSessionMode(currentConfig)
  const target = resolveSessionPrimaryTarget(snapshot.sessionId, currentConfig, snapshot)
  const runtimeSelection = normalizeRuntimeForSessionMode(
    target.runtimeId,
    sessionMode,
  )
  const composition = await resolveSessionComposition({
    snapshot,
    conversationKind: currentConfig.conversationKind,
    sessionMode,
    planMode: currentConfig.planMode,
    modelId: target.modelId,
    runtimeId: runtimeSelection.runtimeId,
    preferredRuntimeId: target.runtimeId,
    selectedSkillIds: currentConfig.selectedSkillIds,
    selectedToolIds: currentConfig.selectedToolIds,
    coBrowseActive: true,
    surface: currentConfig.surface,
    visibility: currentConfig.visibility,
    storageScope: currentConfig.storageScope,
  })
  const coBrowseSnapshot: SessionSnapshot = {
    ...snapshot,
    runtimeId: runtimeSelection.runtimeId,
    modelId: target.modelId,
    mode: composition.mode,
    systemInstructions: composition.systemInstructions,
    metadata: composition.metadata,
    savedAt: new Date().toISOString(),
  }
  const coBrowseSession = await gemmaDesktop.sessions.resume({
    snapshot: coBrowseSnapshot,
  })
  liveSessions.set(sessionId, coBrowseSession)

  return {
    session: coBrowseSession,
    snapshot: coBrowseSnapshot,
    restore: async (latestSnapshot) =>
      await applySessionCompositionFrame(sessionId, latestSnapshot, restoreFrame),
  }
}

function addSessionTools(
  mode: ModeSelection,
  toolNames: string[],
): ModeSelection {
  if (toolNames.length === 0) {
    return mode
  }

  const spec = typeof mode === 'string' ? { base: mode } : mode
  const tools = new Set(spec.tools ?? [])
  const withoutTools = new Set(spec.withoutTools ?? [])

  for (const toolName of toolNames) {
    tools.add(toolName)
    withoutTools.delete(toolName)
  }

  return {
    ...spec,
    tools: [...tools],
    withoutTools:
      withoutTools.size > 0
        ? [...withoutTools]
        : undefined,
  }
}

const TALK_SESSION_WEB_TOOL_NAMES = [
  'fetch_url',
  SEARCH_WEB_TOOL,
] as const
const GROUNDED_SEARCH_WEB_TOOL = createHostTools().find(
  (tool) => tool.name === SEARCH_WEB_TOOL,
)
const CHROME_DEVTOOLS_MUTATING_ACTION_SET = new Set<string>(
  CHROME_DEVTOOLS_MUTATING_ACTIONS,
)

function getGloballyEnabledToolNames(
  _currentSettings: Pick<AppSettingsRecord, 'tools'>,
  _input?: { planMode?: boolean },
): string[] {
  return [...CHROME_BROWSER_TOOL_NAMES]
}

function buildProjectBrowserInstructions(): string {
  return [
    'Project Browser is available in Build conversations for visible app and web verification.',
    '- Use it for CoBrowse-style work when the user should see the current page or may need to complete a human-only step.',
    '- Project Browser is separate from the managed browser tool used for deeper scripted website interaction.',
    '- Outside CoBrowse, use search_web for generic web discovery instead of turning Project Browser into a search engine.',
    `- Use ${OPEN_PROJECT_BROWSER_TOOL} to open or refresh the built-in browser against an http or https URL.`,
    `- Use ${SEARCH_PROJECT_BROWSER_DOM_TOOL} after opening a page when you need to confirm that specific UI text, selectors, or DOM states exist.`,
    `- Use ${GET_PROJECT_BROWSER_ERRORS_TOOL} to inspect recent console and page-load errors without flooding context. Results can be truncated.`,
    '- If the page shows a CAPTCHA, bot block, login challenge, 2FA prompt, payment gate, or permission prompt, stop and ask the user to complete that browser-side action. Continue only after the user resumes.',
  ].join('\n')
}

function coerceStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.filter((entry): entry is string => typeof entry === 'string')
}

async function executeSearchWebThroughProjectBrowser(
  input: unknown,
  context: Parameters<RegisteredTool['execute']>[1],
): Promise<Awaited<ReturnType<RegisteredTool['execute']>>> {
  projectBrowserManager.assertAgentBrowserControl({
    sessionId: context.sessionId,
    coBrowseActive: true,
  })

  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input as {
          query?: unknown
          includeDomains?: unknown
          excludeDomains?: unknown
          maxCharsPerPage?: unknown
        }
      : {}
  const query = typeof record.query === 'string' ? record.query : ''
  const searchUrl = buildProjectBrowserGoogleSearchUrl({
    query,
    includeDomains: coerceStringList(record.includeDomains),
    excludeDomains: coerceStringList(record.excludeDomains),
  })
  const maxChars =
    typeof record.maxCharsPerPage === 'number' && Number.isFinite(record.maxCharsPerPage)
      ? record.maxCharsPerPage
      : undefined

  const result = await projectBrowserManager.open({
    sessionId: context.sessionId,
    url: searchUrl,
    maxChars,
    coBrowseActive: true,
  })
  const structuredOutput =
    result.structuredOutput
    && typeof result.structuredOutput === 'object'
    && !Array.isArray(result.structuredOutput)
      ? result.structuredOutput
      : {}

  appendDebugLog(context.sessionId, {
    layer: 'ipc',
    direction: 'app->sdk',
    event: 'project-browser.google-searched',
    summary: `Searched Google in Project Browser for ${query}`,
    turnId: context.turnId,
    data: {
      query,
      searchUrl,
      structuredOutput,
    },
  })

  return {
    output: [
      `Searched Google in the visible Project Browser for "${query}".`,
      'This CoBrowse search used the browser-backed Google path, not grounded Gemini API search.',
      '',
      result.output,
    ].join('\n'),
    structuredOutput: {
      ...structuredOutput,
      action: 'google_search',
      provider: 'project_browser_google',
      query,
      searchUrl,
    },
  }
}

function buildSearchWebTool(): RegisteredTool {
  if (!GROUNDED_SEARCH_WEB_TOOL) {
    throw new Error('Grounded search_web tool is not available.')
  }

  return {
    name: SEARCH_WEB_TOOL,
    description:
      'Direct tool. Search the web. In CoBrowse sessions this opens Google Search in the visible Project Browser so the user can assist with browser-side challenges. In all other sessions this runs Gemini API search with Google Search grounding. The active session decides the backend; do not try to choose another search backend.',
    inputSchema: GROUNDED_SEARCH_WEB_TOOL.inputSchema,
    strict: GROUNDED_SEARCH_WEB_TOOL.strict,
    metadata: GROUNDED_SEARCH_WEB_TOOL.metadata,
    async execute(input, context) {
      if (isCoBrowseSessionMetadata(context.sessionMetadata)) {
        return await executeSearchWebThroughProjectBrowser(input, context)
      }

      return await GROUNDED_SEARCH_WEB_TOOL.execute(input, context)
    },
  }
}

function buildBackgroundProcessInstructions(): string {
  return [
    'Background process tools are available in Build conversations for long-running local tasks such as dev servers, watchers, and downloads.',
    `- Use ${START_BACKGROUND_PROCESS_TOOL} to start one conversation-scoped process with a command like "npm run dev".`,
    `- Use ${PEEK_BACKGROUND_PROCESS_TOOL} with the returned processId to check whether it is still running and inspect a bounded output tail without flooding context.`,
    '- When you start a dev server or watcher for the user to inspect, leave it running after verification and tell the user the process is still active.',
    `- Use ${TERMINATE_BACKGROUND_PROCESS_TOOL} only when the user asks you to stop it, the process is harmful/stuck, or you must stop it before switching tasks.`,
    '- Treat peek output as a tail, not a full transcript. If the tool says output was truncated, poll again only when you need a fresher snapshot.',
  ].join('\n')
}

function summarizeChromeDevtoolsArguments(input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {}
  const action =
    typeof record.action === 'string' && record.action.trim().length > 0
      ? record.action.trim()
      : 'action'
  const details: string[] = []

  if (typeof record.url === 'string' && record.url.trim().length > 0) {
    details.push(`url=${record.url.trim()}`)
  }
  if (typeof record.pageId === 'number' && Number.isFinite(record.pageId)) {
    details.push(`pageId=${record.pageId}`)
  }
  if (typeof record.ref === 'string' && record.ref.trim().length > 0) {
    details.push(`ref=${record.ref.trim()}`)
  }
  if (
    typeof record.navigation === 'string'
    && record.navigation.trim().length > 0
  ) {
    details.push(`navigation=${record.navigation.trim()}`)
  }

  return details.length > 0
    ? `${action} (${details.join(', ')})`
    : action
}

function buildChromeDevtoolsApprovalReason(action: string | undefined): string {
  switch (action) {
    case undefined:
      return 'Chrome DevTools wants to run a page-mutating action in your live Chrome session.'
    case 'open':
      return 'Chrome DevTools wants to open a new tab in your live Chrome session.'
    case 'navigate':
      return 'Chrome DevTools wants to navigate the current Chrome tab.'
    case 'click':
    case 'fill':
    case 'type':
    case 'press':
      return 'Chrome DevTools wants to interact with the current Chrome page.'
    case 'close':
      return 'Chrome DevTools wants to close a Chrome tab.'
    case 'dialog':
      return 'Chrome DevTools wants to respond to a browser dialog in Chrome.'
    case 'evaluate':
      return 'Chrome DevTools wants to run page script inside your live Chrome tab.'
    default:
      return 'Chrome DevTools wants to run a page-mutating action in your live Chrome session.'
  }
}

async function requestToolApproval(input: {
  sessionId: string
  signal?: AbortSignal
  turnId?: string
  toolName: string
  argumentsSummary: string
  reason: string
}): Promise<boolean> {
  const { sessionId, signal } = input
  if (!signal) {
    throw new Error(`${input.toolName} approval requires an abort signal.`)
  }

  if (signal.aborted) {
    throw new Error(`${input.toolName} approval cancelled.`)
  }

  const approval: PendingToolApproval = {
    id: randomUUID(),
    turnId: input.turnId,
    toolName: input.toolName,
    argumentsSummary: input.argumentsSummary,
    reason: input.reason,
    requestedAt: Date.now(),
  }

  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'app->sdk',
    event: 'tool.approval.requested',
    summary: `${approval.toolName}: ${approval.argumentsSummary}`,
    turnId: input.turnId,
    data: approval,
  })

  setPendingToolApprovalState(sessionId, approval)

  return await new Promise<boolean>((resolve, reject) => {
    const onAbort = () => {
      pendingToolApprovalResolvers.delete(approval.id)
      setPendingToolApprovalState(sessionId, null)
      reject(new Error(`${input.toolName} approval cancelled.`))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    pendingToolApprovalResolvers.set(approval.id, {
      sessionId,
      resolve: (approved) => {
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      },
      reject: (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    })
  })
}

function buildPlanOverlayInstructions(
  baseMode: BaseSessionMode,
): string {
  return getPlanningSystemInstructions(baseMode)
}

async function listInstalledSkills(): Promise<InstalledSkillRecord[]> {
  const currentSettings = await getSettingsState()
  return await discoverInstalledSkills(currentSettings.skills.scanRoots)
}

async function listDiscoverableSkills(): Promise<InstalledSkillRecord[]> {
  const currentSettings = await getSettingsState()
  return await listAvailableSkills({
    scanRoots: currentSettings.skills.scanRoots,
  })
}

async function resolveSessionComposition(input: {
  snapshot: SessionSnapshot | null
  conversationKind: ConversationKind
  sessionMode: AppSessionMode
  planMode: boolean
  modelId: string
  runtimeId: string
  preferredRuntimeId: string
  selectedSkillIds: string[]
  selectedToolIds: string[]
  coBrowseActive?: boolean
  surface?: AppSessionSurface
  visibility?: AppSessionVisibility
  storageScope?: AppSessionStorageScope
}): Promise<{
  mode: ModeSelection
  systemInstructions?: string
  metadata: Record<string, unknown>
}> {
  const currentSettings = await getSettingsState()
  const userMemorySection = buildUserMemorySystemSection(
    await readUserMemory(app.getPath('userData')),
  )
  const nextSessionConfig = normalizeSessionConfig({
    conversationKind: input.conversationKind,
    ...sessionModeToConfig(input.sessionMode),
    planMode: input.planMode,
    preferredRuntimeId: input.preferredRuntimeId,
    selectedSkillIds: [...input.selectedSkillIds],
    selectedSkillNames: [],
    selectedToolIds: [],
    selectedToolNames: [],
    surface: input.surface ?? 'default',
    visibility: input.visibility ?? 'visible',
    storageScope: input.storageScope ?? 'project',
  })
  const chromeDevtoolsAllowed = isChromeDevtoolsAllowedForSession({
    conversationKind: nextSessionConfig.conversationKind,
    baseMode: nextSessionConfig.baseMode,
    planMode: nextSessionConfig.planMode,
    surface: nextSessionConfig.surface,
  })
  const availableSessionTools = getAvailableSessionTools(currentSettings, {
    chromeDevtoolsAllowed,
  })
  const selectedToolIds =
    nextSessionConfig.conversationKind === 'research'
      ? []
      : getSelectedSessionToolIds(input.selectedToolIds, {
          chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
          chromeDevtoolsAllowed,
        })
  const chromeDevtoolsSelected = selectedToolIds.includes(
    CHROME_DEVTOOLS_SESSION_TOOL_ID,
  )
  const globalToolNames = chromeDevtoolsSelected
    ? []
    : getGloballyEnabledToolNames(currentSettings, {
        planMode: input.planMode,
      })
  const selectedToolNames = getSelectedSessionToolNames(selectedToolIds, {
    chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
    chromeDevtoolsAllowed,
  })
  const selectedSessionToolNames = selectedToolIds.flatMap((toolId) =>
    availableSessionTools
      .filter((definition) => definition.id === toolId)
      .flatMap((definition) => definition.toolNames),
  )
  if (isTalkSessionConfig(nextSessionConfig)) {
    const allowedTalkToolNames = new Set<string>([
      ...TALK_SESSION_WEB_TOOL_NAMES,
      ...globalToolNames,
      ...selectedSessionToolNames,
    ])
    const baseTalkMode: ModeSelection = {
      base: 'assistant',
      tools: [...allowedTalkToolNames],
      withoutTools: CONFIGURABLE_TOOL_NAMES.filter(
        (toolName) => !allowedTalkToolNames.has(toolName),
      ),
    }
    const mode = input.coBrowseActive
      ? applyCoBrowseToolRoutingToModeSelection(baseTalkMode)
      : baseTalkMode
    const resolvedSessionConfig: AppSessionConfig = {
      ...nextSessionConfig,
      preferredRuntimeId: input.preferredRuntimeId,
      selectedSkillIds: [],
      selectedSkillNames: [],
      selectedToolIds,
      selectedToolNames,
    }
    const sessionToolInstructions = getSelectedSessionToolInstructions(
      selectedToolIds,
      {
        chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
        chromeDevtoolsAllowed,
      },
    )
    const talkInstructions = composeAppSystemInstructions({
      primaryPrompt: getChatSystemInstructions('assistant'),
      coBrowseTools: input.coBrowseActive ? buildCoBrowseToolInstructions() : undefined,
      sessionTools: sessionToolInstructions,
      userMemory: userMemorySection,
    })
    return {
      mode,
      systemInstructions: talkInstructions,
      metadata: withResolvedRequestPreferencesMetadata(
        input.coBrowseActive
          ? withCoBrowseSessionMetadata(
              createSessionMetadata(input.snapshot, resolvedSessionConfig),
            )
          : createSessionMetadata(input.snapshot, resolvedSessionConfig),
        currentSettings,
        {
          modelId: input.modelId,
          runtimeId: input.runtimeId,
        },
      ) ?? {},
    }
  }

  const discoverableSkills = await listDiscoverableSkills()
  const skillCatalogInstructions = renderSkillCatalogInstructions(discoverableSkills)
  const skillBundles = await buildSkillContextBundles(
    input.selectedSkillIds,
    discoverableSkills,
  )
  const selectedSkillNames = skillBundles.map((bundle) => bundle.skill.name)
  const selectedPlanSafeToolIds = nextSessionConfig.planMode
    ? availableSessionTools
        .filter((definition) => definition.planModeSafe)
        .filter((definition) => selectedToolIds.includes(definition.id))
        .map((definition) => definition.id)
    : selectedToolIds
  const sessionToolInstructions = getSelectedSessionToolInstructions(
    selectedPlanSafeToolIds,
    {
      chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
      chromeDevtoolsAllowed,
    },
  )
  const preloadedSkillInstructions = renderSkillSystemInstructions(skillBundles)
  const primaryPromptInstructions = nextSessionConfig.planMode
    ? buildPlanOverlayInstructions(nextSessionConfig.baseMode)
    : getChatSystemInstructions(nextSessionConfig.baseMode)
  const toolMode = resolveToolPolicyMode(nextSessionConfig.baseMode)
  const baseMode = applyToolPolicyToModeSelection(
    toSdkSessionMode(nextSessionConfig.baseMode),
    toolMode,
    currentSettings.toolPolicy,
  )
  const toolAugmentedMode = addSessionTools(
    baseMode,
    [
      ...((input.coBrowseActive
        || (nextSessionConfig.baseMode === 'build'
          && nextSessionConfig.conversationKind === 'normal'
          && !nextSessionConfig.planMode))
        ? [...PROJECT_BROWSER_TOOL_NAMES]
        : []),
      ...(nextSessionConfig.baseMode === 'build'
        && nextSessionConfig.conversationKind === 'normal'
        && !nextSessionConfig.planMode
        ? [...BACKGROUND_PROCESS_TOOL_NAMES]
        : []),
      ...(!nextSessionConfig.planMode
        && discoverableSkills.length > 0
        && isToolAllowedByPolicy(
          ACTIVATE_SKILL_TOOL,
          toolMode,
          currentSettings.toolPolicy,
        )
        ? [ACTIVATE_SKILL_TOOL]
        : []),
      ...globalToolNames,
      ...selectedPlanSafeToolIds.flatMap((toolId) =>
        availableSessionTools
          .filter((definition) => definition.id === toolId)
          .flatMap((definition) => definition.toolNames),
      ),
    ],
  )
  const routedMode = input.coBrowseActive
    ? applyCoBrowseToolRoutingToModeSelection(toolAugmentedMode)
    : toolAugmentedMode
  const planOverlayMode = nextSessionConfig.planMode
    ? buildPlanOverlayModeSelection(nextSessionConfig.baseMode)
    : null
  const planOverlayTools =
    planOverlayMode && typeof planOverlayMode !== 'string'
      ? (planOverlayMode.tools ?? [])
      : []
  const mode = nextSessionConfig.planMode
    ? clampModeSelectionToPlanOverlay(
        addSessionTools(routedMode, planOverlayTools),
      )
    : routedMode
  const resolvedSessionConfig = {
    ...nextSessionConfig,
    preferredRuntimeId: input.preferredRuntimeId,
    selectedSkillIds: [...input.selectedSkillIds],
    selectedSkillNames,
    selectedToolIds,
    selectedToolNames,
  }
  const systemInstructions = composeAppSystemInstructions({
    primaryPrompt: primaryPromptInstructions,
    skillCatalog: skillCatalogInstructions,
    preloadedSkills: preloadedSkillInstructions,
    sessionTools: sessionToolInstructions,
    coBrowseTools: input.coBrowseActive ? buildCoBrowseToolInstructions() : undefined,
    projectBrowser:
      nextSessionConfig.baseMode === 'build'
        && nextSessionConfig.conversationKind === 'normal'
        && !nextSessionConfig.planMode
        ? buildProjectBrowserInstructions()
        : undefined,
    backgroundProcesses:
      nextSessionConfig.baseMode === 'build'
        && nextSessionConfig.conversationKind === 'normal'
        && !nextSessionConfig.planMode
        ? buildBackgroundProcessInstructions()
        : undefined,
    userMemory: userMemorySection,
  })

  return {
    mode,
    systemInstructions,
    metadata: withResolvedRequestPreferencesMetadata(
      input.coBrowseActive
        ? withCoBrowseSessionMetadata(
            createSessionMetadata(input.snapshot, resolvedSessionConfig),
          )
        : createSessionMetadata(input.snapshot, resolvedSessionConfig),
      currentSettings,
      {
        modelId: input.modelId,
        runtimeId: input.runtimeId,
      },
    ) ?? {},
  }
}

async function resolveSelectedSkillNames(
  selectedSkillIds: string[],
): Promise<string[]> {
  const discoverableSkills = await listDiscoverableSkills()
  return discoverableSkills
    .filter((skill) => selectedSkillIds.includes(skill.id))
    .map((skill) => skill.name)
}

function normalizeRuntimeForSessionMode(
  runtimeId: string,
  _sessionMode: AppSessionMode,
): { runtimeId: string; reason?: string } {
  return { runtimeId }
}

function createAppToolPermissionPolicy(): ToolPermissionPolicy {
  return {
    async authorize({ tool, toolCall, context }) {
      const sessionConfig = getSessionConfigFromMetadata(
        context.sessionMetadata,
        resolveBaseMode(context.mode),
      )
      const currentSettings = await getSettingsState()

      if (CHROME_BROWSER_TOOL_NAME_SET.has(tool.name)) {
        return { allowed: true }
      }

      if (CHROME_DEVTOOLS_TOOL_NAME_SET.has(tool.name)) {
        if (!currentSettings.tools.chromeMcp.enabled) {
          return {
            allowed: false,
            reason:
              'Chrome DevTools is disabled in Settings.',
          }
        }

        const selectedToolIds = getSelectedSessionToolIds(
          sessionConfig.selectedToolIds,
          {
            chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
          },
        )

        if (!selectedToolIds.includes(CHROME_DEVTOOLS_SESSION_TOOL_ID)) {
          return {
            allowed: false,
            reason:
              'Chrome DevTools is not active for this session. Turn it on from the Tools button in the composer first.',
          }
        }

        const record =
          toolCall.input
          && typeof toolCall.input === 'object'
          && !Array.isArray(toolCall.input)
            ? toolCall.input as Record<string, unknown>
            : {}
        const action =
          typeof record.action === 'string' && record.action.trim().length > 0
            ? record.action.trim()
            : undefined

        if (action && CHROME_DEVTOOLS_MUTATING_ACTION_SET.has(action)) {
          const approved = await requestToolApproval({
            sessionId: context.sessionId,
            signal: context.signal,
            turnId: context.turnId,
            toolName: 'Chrome DevTools',
            argumentsSummary: summarizeChromeDevtoolsArguments(toolCall.input),
            reason: buildChromeDevtoolsApprovalReason(action),
          })

          if (!approved) {
            return {
              allowed: false,
              reason:
                'Chrome DevTools action was denied by the user.',
            }
          }
        }

        return { allowed: true }
      }

      if (ASK_GEMINI_TOOL_NAME_SET.has(tool.name)) {
        const selectedToolIds = getSelectedSessionToolIds(
          sessionConfig.selectedToolIds,
          {
            chromeMcpEnabled: currentSettings.tools.chromeMcp.enabled,
          },
        )

        if (!selectedToolIds.includes(ASK_GEMINI_SESSION_TOOL_ID)) {
          return {
            allowed: false,
            reason:
              'Ask Gemini is not active for this session. Turn it on from the Tools button in the composer first.',
          }
        }

        return { allowed: true }
      }

      if (
        tool.name === SEARCH_WEB_TOOL
        && isCoBrowseSessionMetadata(context.sessionMetadata)
      ) {
        return { allowed: true }
      }

      if (tool.name === RELEASE_PROJECT_BROWSER_TO_USER_TOOL) {
        if (isCoBrowseSessionMetadata(context.sessionMetadata)) {
          return { allowed: true }
        }

        return {
          allowed: false,
          reason: 'Project Browser control handoff is only available during CoBrowse.',
        }
      }

      if (PROJECT_BROWSER_TOOL_NAMES.includes(tool.name as (typeof PROJECT_BROWSER_TOOL_NAMES)[number])) {
        if (isCoBrowseSessionMetadata(context.sessionMetadata)) {
          return { allowed: true }
        }

        if (sessionConfig.baseMode !== 'build' || sessionConfig.planMode) {
          return {
            allowed: false,
            reason: 'Project Browser is only available in Build conversations outside Plan mode.',
          }
        }

        return { allowed: true }
      }

      if (BACKGROUND_PROCESS_TOOL_NAMES.includes(tool.name as (typeof BACKGROUND_PROCESS_TOOL_NAMES)[number])) {
        if (sessionConfig.baseMode !== 'build' || sessionConfig.planMode) {
          return {
            allowed: false,
            reason: 'Background process tools are only available in Build conversations outside Plan mode.',
          }
        }

        return { allowed: true }
      }

      if (!CONFIGURABLE_TOOL_NAME_SET.has(tool.name)) {
        return { allowed: true }
      }

      const toolMode = resolveToolPolicyMode(
        resolveAppSessionMode(sessionConfig),
      )

      if (!isToolAllowedByPolicy(tool.name, toolMode, currentSettings.toolPolicy)) {
        return {
          allowed: false,
          reason:
            `Tool "${tool.name}" is blocked by the ${toolMode} tool policy in Settings.`,
        }
      }

      if (
        tool.name === 'exec_command'
        && sessionConfig.baseMode === 'build'
        && !sessionConfig.planMode
      ) {
        const command =
          toolCall.input
          && typeof toolCall.input === 'object'
          && !Array.isArray(toolCall.input)
          && typeof (toolCall.input as Record<string, unknown>).command === 'string'
            ? ((toolCall.input as Record<string, unknown>).command as string)
            : ''
        const commandPolicy = evaluateBuildExecCommandPolicy(command)

        if (commandPolicy.kind === 'deny') {
          throw new GemmaDesktopError('tool_execution_failed', commandPolicy.reason, {
            details: {
              policyKind: 'build_exec_command_denied',
              command: commandPolicy.normalizedCommand,
              rootCommand: commandPolicy.rootCommand,
            },
          })
        }

        if (commandPolicy.kind === 'ask') {
          const approved = await requestToolApproval({
            sessionId: context.sessionId,
            signal: context.signal,
            turnId: context.turnId,
            toolName: 'Shell command',
            argumentsSummary: commandPolicy.normalizedCommand,
            reason: commandPolicy.reason,
          })

          if (!approved) {
            throw new GemmaDesktopError(
              'tool_execution_failed',
              'Shell command approval was denied by the user.',
              {
                details: {
                  policyKind: 'build_exec_command_approval_denied',
                  command: commandPolicy.normalizedCommand,
                  rootCommand: commandPolicy.rootCommand,
                  policyReason: commandPolicy.reason,
                },
              },
            )
          }
        }
      }

      return { allowed: true }
    },
  }
}

async function refreshSessionPolicies(): Promise<void> {
  for (const meta of store.listMeta()) {
    if (isSessionExecutionBusy(meta.id)) {
      continue
    }

    const persisted = await store.load(meta.id)
    if (!persisted) {
      continue
    }

    const liveSession = liveSessions.get(meta.id)
    const currentSnapshot = liveSession?.snapshot() ?? persisted.snapshot
    const nextSnapshot = await rehydrateSessionSnapshot(currentSnapshot)

    try {
      const nextSession = await gemmaDesktop.sessions.resume({
        snapshot: nextSnapshot,
      })
      liveSessions.set(meta.id, nextSession)
      await store.save(meta.id, nextSnapshot, undefined, undefined, {
        preserveUpdatedAt: true,
      })
    } catch (error) {
      console.warn(
        `[gemma-desktop] Failed to refresh tool policy for session ${meta.id}:`,
        error,
      )
    }
  }

  await broadcastSessionsChanged()
}

function areSerializedValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }

  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  } catch {
    return false
  }
}

async function rehydrateSessionSnapshot(
  snapshot: SessionSnapshot,
): Promise<SessionSnapshot> {
  const rawConfig = getSessionConfig(snapshot)
  const isTalkSnapshot = isTalkSessionSnapshot(snapshot)
  const currentConfig = isTalkSnapshot
    ? buildTalkSessionConfig()
    : rawConfig
  const talkWorkingDirectory = isTalkSnapshot
    ? await ensureDirectoryExists(getTalkSessionWorkspaceDirectory(app.getPath('userData')))
    : null
  const sessionMode = resolveAppSessionMode(currentConfig)
  const target = resolveSessionPrimaryTarget(snapshot.sessionId, currentConfig, snapshot)
  const runtimeSelection = normalizeRuntimeForSessionMode(
    target.runtimeId,
    sessionMode,
  )
  const composition = await resolveSessionComposition({
    snapshot,
    conversationKind: currentConfig.conversationKind,
    sessionMode,
    planMode: currentConfig.planMode,
    modelId: target.modelId,
    runtimeId: runtimeSelection.runtimeId,
    preferredRuntimeId: target.runtimeId,
    selectedSkillIds: currentConfig.selectedSkillIds,
    selectedToolIds: currentConfig.selectedToolIds,
    surface: currentConfig.surface,
    visibility: currentConfig.visibility,
    storageScope: currentConfig.storageScope,
  })

  if (
    snapshot.runtimeId === runtimeSelection.runtimeId
    && snapshot.modelId === target.modelId
    && (!isTalkSnapshot || snapshot.sessionId === TALK_SESSION_ID)
    && (!talkWorkingDirectory || snapshot.workingDirectory === talkWorkingDirectory)
    && areSerializedValuesEqual(snapshot.mode, composition.mode)
    && snapshot.systemInstructions === composition.systemInstructions
    && areSerializedValuesEqual(snapshot.metadata, composition.metadata)
  ) {
    return snapshot
  }

  return {
    ...snapshot,
    sessionId: isTalkSnapshot ? TALK_SESSION_ID : snapshot.sessionId,
    runtimeId: runtimeSelection.runtimeId,
    modelId: target.modelId,
    mode: composition.mode,
    workingDirectory: talkWorkingDirectory ?? snapshot.workingDirectory,
    systemInstructions: composition.systemInstructions,
    metadata: composition.metadata,
    savedAt: new Date().toISOString(),
  }
}

async function rehydratePersistedSession(
  sessionId: string,
  persisted: PersistedSession,
): Promise<PersistedSession> {
  const repairedSnapshot = restoreMissingUserHistoryFromAppMessages(
    persisted.snapshot,
    persisted.appMessages,
  )
  const nextSnapshot = await rehydrateSessionSnapshot(repairedSnapshot)
  if (
    repairedSnapshot === persisted.snapshot
    && nextSnapshot === repairedSnapshot
  ) {
    return persisted
  }

  await store.save(sessionId, nextSnapshot, persisted.meta, persisted.appMessages, {
    preserveUpdatedAt: true,
  })

  return {
    ...persisted,
    snapshot: nextSnapshot,
  }
}

async function persistSessionStateWithRecoveredUserHistory(
  sessionId: string,
  session: GemmaDesktopSession,
  options?: {
    metaPatch?: Partial<SessionMeta>
    appMessages?: AppMessage[]
    preserveUpdatedAt?: boolean
  },
): Promise<GemmaDesktopSession> {
  const appMessages = options?.appMessages ?? store.getAppMessages(sessionId)
  const currentSnapshot = session.snapshot()
  const repairedSnapshot = restoreMissingUserHistoryFromAppMessages(
    currentSnapshot,
    appMessages,
  )
  let nextSession = session

  if (repairedSnapshot !== currentSnapshot) {
    nextSession = await gemmaDesktop.sessions.resume({
      snapshot: repairedSnapshot,
    })
    liveSessions.set(sessionId, nextSession)
  }

  await store.save(
    sessionId,
    repairedSnapshot,
    options?.metaPatch,
    appMessages,
    { preserveUpdatedAt: options?.preserveUpdatedAt },
  )

  return nextSession
}

async function ensureLiveSessionCurrent(
  sessionId: string,
  session: GemmaDesktopSession,
  persisted: PersistedSession | null,
): Promise<{
  session: GemmaDesktopSession
  persisted: PersistedSession | null
}> {
  if (isSessionExecutionBusy(sessionId)) {
    return { session, persisted }
  }

  const currentSnapshot = session.snapshot()
  const nextSnapshot = await rehydrateSessionSnapshot(currentSnapshot)
  if (nextSnapshot === currentSnapshot) {
    return { session, persisted }
  }

  const nextSession = await gemmaDesktop.sessions.resume({
    snapshot: nextSnapshot,
  })
  liveSessions.set(sessionId, nextSession)

  if (persisted) {
    await store.save(
      sessionId,
      nextSnapshot,
      persisted.meta,
      persisted.appMessages,
      { preserveUpdatedAt: true },
    )
    return {
      session: nextSession,
      persisted: {
        ...persisted,
        snapshot: nextSnapshot,
      },
    }
  }

  await store.save(sessionId, nextSnapshot, undefined, undefined, {
    preserveUpdatedAt: true,
  })
  return {
    session: nextSession,
    persisted,
  }
}

async function recoverInterruptedPendingTurns(): Promise<void> {
  for (const meta of store.listMeta()) {
    const persisted = await store.load(meta.id)
    const pendingTurn = persisted?.pendingTurn

    if (!persisted || !pendingTurn) {
      continue
    }

    const recoveredMessageId = `${pendingTurn.turnId}${INTERRUPTED_TURN_ID_SUFFIX}`
    const alreadyRecovered = (persisted.appMessages ?? []).some(
      (message) => message.id === recoveredMessageId,
    )

    if (!alreadyRecovered) {
      const recoveredMessage = buildInterruptedAssistantMessage({
        turnId: pendingTurn.turnId,
        content: pendingTurn.content,
        timestamp: resolveInterruptedTurnTimestamp({
          turnStartedAt: pendingTurn.startedAt,
          history: persisted.snapshot.history,
          appMessages: persisted.appMessages,
        }),
      })

      if (recoveredMessage) {
        store.upsertAppMessage(meta.id, recoveredMessage)
      }
    }

    store.clearPendingTurn(meta.id)
    await store.save(
      meta.id,
      persisted.snapshot,
      persisted.meta,
      store.getAppMessages(meta.id),
      { preserveUpdatedAt: true },
    )
  }
}

function automationToSummary(record: AutomationRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    prompt: record.prompt,
    runtimeId: record.runtimeId,
    modelId: record.modelId,
    mode: 'build',
    selectedSkillIds: record.selectedSkillIds,
    selectedSkillNames: record.selectedSkillNames,
    workingDirectory: record.workingDirectory,
    enabled: record.enabled,
    schedule: record.schedule,
    scheduleText: scheduleToText(record.schedule),
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    lastRunStatus: record.lastRunStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runCount: record.runs.length,
  }
}

function automationToDetail(record: AutomationRecord): Record<string, unknown> {
  return {
    ...automationToSummary(record),
    runs: record.runs,
  }
}

function normalizeAutomationSchedule(
  schedule: AutomationSchedule,
): AutomationSchedule {
  if (schedule.kind === 'once') {
    return {
      kind: 'once',
      runAt:
        Number.isFinite(schedule.runAt) && schedule.runAt > 0
          ? schedule.runAt
          : Date.now() + 60 * 60 * 1000,
    }
  }

  return {
    kind: 'interval',
    every:
      Number.isFinite(schedule.every) && schedule.every > 0
        ? Math.round(schedule.every)
        : 1,
    unit:
      schedule.unit === 'minutes'
      || schedule.unit === 'hours'
      || schedule.unit === 'days'
        ? schedule.unit
        : 'hours',
    startAt:
      Number.isFinite(schedule.startAt) && schedule.startAt > 0
        ? schedule.startAt
        : Date.now() + 60 * 60 * 1000,
  }
}

function broadcastAutomationsChanged(): void {
  const summaries = automationStore.list().map((record) => automationToSummary(record))
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'automations:changed',
    summaries,
    'automations:changed',
  )
}

function getSidebarStatePath(): string {
  return path.join(app.getPath('userData'), 'sidebar-state.json')
}

function getSidebarStateStore(): SidebarStateStore {
  if (!sidebarStore) {
    throw new Error('Sidebar state store is not initialized.')
  }

  return sidebarStore
}

function sidebarStateToRecord(state: SidebarState): Record<string, unknown> {
  const nextState = cloneSidebarState(state)
  return {
    pinnedSessionIds: nextState.pinnedSessionIds,
    followUpSessionIds: nextState.followUpSessionIds,
    closedProjectPaths: nextState.closedProjectPaths,
    projectPaths: nextState.projectPaths,
    sessionOrderOverrides: nextState.sessionOrderOverrides,
    projectOrderOverrides: nextState.projectOrderOverrides,
    lastActiveSessionId: nextState.lastActiveSessionId,
  }
}

async function listSidebarSessionReferences(): Promise<SidebarSessionReference[]> {
  const refs: SidebarSessionReference[] = []

  for (const meta of store.listMeta()) {
    const persisted = await store.load(meta.id)
    if (!persisted || isHiddenSessionSnapshot(persisted.snapshot)) {
      continue
    }

    refs.push({
      id: meta.id,
      workingDirectory: normalizeStoredSidebarProjectPath(
        persisted.snapshot.workingDirectory,
      ),
    })
  }

  return refs
}

function broadcastSidebarChanged(state: SidebarState): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'sidebar:changed',
    sidebarStateToRecord(state),
    'sidebar:changed',
  )
}

function getGlobalChatStateRecord(state: GlobalChatState): GlobalChatState {
  return {
    assignedSessionId: state.assignedSessionId,
    target: { ...state.target },
  }
}

function getGlobalChatStateInternal(): GlobalChatState {
  return getGlobalChatStateRecord(globalChatController.getState())
}

async function getGlobalChatSessionDetailInternal(): Promise<Record<string, unknown>> {
  const state = getGlobalChatStateInternal()

  if (state.target.kind === 'assigned') {
    return await getSessionDetailInternal(state.target.sessionId)
  }

  return await ensureTalkSessionInternal()
}

async function broadcastGlobalChatChanged(): Promise<void> {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    GLOBAL_CHAT_CHANGED_CHANNEL,
    getGlobalChatStateInternal(),
    GLOBAL_CHAT_CHANGED_CHANNEL,
  )
}

async function syncSidebarState(): Promise<SidebarState> {
  const result = await getSidebarStateStore().prune(
    await listSidebarSessionReferences(),
  )

  if (result.changed) {
    broadcastSidebarChanged(result.state)
  }

  return result.state
}

// ── Helpers ──

function summarizeGemmaDesktopEvent(event: GemmaDesktopEvent): string {
  switch (event.type) {
    case 'content.delta':
      return `${String((event.payload as Record<string, unknown>).channel ?? 'assistant')} delta`
    case 'tool.call':
      return `Tool call: ${String((event.payload as Record<string, unknown>).toolName ?? 'unknown')}`
    case 'tool.progress':
      return `Tool progress: ${String((event.payload as Record<string, unknown>).label ?? 'Working')}`
    case 'tool.result':
      return `${typeof (event.payload as Record<string, unknown>).error === 'string' ? 'Tool error' : 'Tool result'}: ${String((event.payload as Record<string, unknown>).toolName ?? 'unknown')}`
    case 'warning.raised':
      return String((event.payload as Record<string, unknown>).warning ?? 'Warning')
    case 'error.raised':
      return String((event.payload as Record<string, unknown>).message ?? 'Error')
    default:
      return event.type
  }
}

function summarizeRuntimeDebugEvent(event: RuntimeDebugEvent): string {
  switch (event.stage) {
    case 'request':
      return `${event.transport} request`
    case 'response':
      return `${event.transport} response`
    case 'stream':
      return `${event.transport} stream`
    case 'error':
      return `${event.transport} error`
  }
}

function createDebugEntry(
  sessionId: string,
  input: Omit<DebugLogEntry, 'id' | 'sessionId' | 'timestamp'>,
): DebugLogEntry {
  return {
    id: randomUUID(),
    sessionId,
    timestamp: Date.now(),
    ...input,
  }
}

function summarizeMode(mode: SessionSnapshot['mode']): string {
  return typeof mode === 'string' ? mode : mode.base ?? 'custom'
}

function sanitizeExportFilename(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

function estimateCharsFromUnknown(value: unknown): number {
  if (typeof value === 'string') {
    return value.length
  }

  if (Array.isArray(value)) {
    return value.reduce<number>(
      (sum, item) => sum + estimateCharsFromUnknown(item),
      0,
    )
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, item) => sum + estimateCharsFromUnknown(item),
      0,
    )
  }

  return 0
}

function estimateGeneratedTokens(text: string, reasoning?: string): number {
  const chars = text.length + (reasoning?.length ?? 0)
  return Math.max(1, Math.round(chars / 4))
}

function setPendingCompactionState(
  sessionId: string,
  pendingCompaction: PendingCompaction | null,
): void {
  store.setPendingCompaction(sessionId, pendingCompaction)
  sendToSession(sessionId, {
    type: 'compaction_state',
    pendingCompaction,
    isCompacting: pendingCompaction?.status === 'running',
  })
  void store.flush(sessionId).catch(() => {})
}

async function resolveSessionContextLength(snapshot: SessionSnapshot): Promise<number> {
  try {
    const env = await gemmaDesktop.inspectEnvironment()
    const currentSettings = await getSettingsState().catch(() => null)
    const models = mapModels(env.runtimes, currentSettings)
    const matched = models.find(
      (model) =>
        model.id === snapshot.modelId && model.runtimeId === snapshot.runtimeId,
    )
    const exactContextLength = resolveMappedModelContextLength(matched)
    if (exactContextLength) {
      return exactContextLength
    }

    const family = runtimeFamilyFromRuntimeId(snapshot.runtimeId)
    const familyMatch = models.find(
      (model) =>
        model.id === snapshot.modelId
        && runtimeFamilyFromRuntimeId(model.runtimeId) === family
        && resolveMappedModelContextLength(model),
    )
    const familyContextLength = resolveMappedModelContextLength(familyMatch)
    if (familyContextLength) {
      return familyContextLength
    }

    const sameModel = models.find(
      (model) =>
        model.id === snapshot.modelId
        && resolveMappedModelContextLength(model),
    )
    return resolveMappedModelContextLength(sameModel) ?? 32768
  } catch {
    return 32768
  }
}

function runtimeFamilyFromRuntimeId(runtimeId: string): string {
  if (runtimeId.startsWith('ollama')) {
    return 'ollama'
  }
  if (runtimeId.startsWith('lmstudio')) {
    return 'lmstudio'
  }
  if (runtimeId.startsWith('llamacpp')) {
    return 'llamacpp'
  }
  if (runtimeId.startsWith('omlx')) {
    return 'omlx'
  }
  return runtimeId
}

function resolveMappedModelContextLength(
  model: MappedModelSummary | undefined,
): number | undefined {
  return model?.contextLength
    ?? model?.runtimeConfig?.loadedContextLength
    ?? model?.runtimeConfig?.nominalContextLength
    ?? model?.runtimeConfig?.requestedOptions?.num_ctx
    ?? model?.runtimeConfig?.requestedOptions?.context_length
}

async function validateOutgoingAttachmentsForSession(input: {
  attachments: IncomingAttachment[]
  snapshot: SessionSnapshot
}): Promise<void> {
  if (input.attachments.length === 0) {
    return
  }

  const support = deriveAttachmentSupport(input.snapshot.capabilityContext?.modelCapabilities ?? [])
  const hasUnsupportedAudio = input.attachments.some((attachment) =>
    attachment.kind === 'audio' && !support.audio,
  )
  if (hasUnsupportedAudio) {
    throw new Error(
      `Model "${input.snapshot.modelId}" is not marked as supporting audio files, so Gemma Desktop cannot send those attachments in this session.`,
    )
  }

  const unsupportedPdf = input.attachments.find((attachment) =>
    attachment.kind === 'pdf'
    && (!support.image || attachment.fitStatus === 'worker_unavailable'),
  )
  if (unsupportedPdf?.kind === 'pdf') {
    throw new Error(
      `Model "${input.snapshot.modelId}" is not marked as supporting PDF preparation in this session.`,
    )
  }

  const blockedPdf = input.attachments.find((attachment) =>
    attachment.kind === 'pdf'
    && attachment.fitStatus
    && attachment.fitStatus !== 'ready',
  )
  if (blockedPdf?.kind === 'pdf') {
    throw new Error(
      blockedPdf.planningReason
      ?? `${blockedPdf.name} is not ready for PDF preparation in this session.`,
    )
  }

  const contextLength = await resolveSessionContextLength(input.snapshot)
  const budget = assessAttachmentBudget({
    attachments: input.attachments.map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      size: attachment.size,
      durationMs:
        attachment.kind === 'audio' || attachment.kind === 'video'
          ? attachment.durationMs
          : undefined,
      pageCount: attachment.kind === 'pdf' ? attachment.pageCount : undefined,
      batchCount: attachment.kind === 'pdf' ? attachment.batchCount : undefined,
      fitStatus: attachment.kind === 'pdf' ? attachment.fitStatus : undefined,
      sampledFrameCount:
        attachment.kind === 'video'
          ? attachment.sampledFrames?.length ?? 0
          : undefined,
    })),
    support,
    contextLength,
  })
  if (budget.issues.length > 0) {
    throw new Error(budget.issues.join(' '))
  }
}

async function getAutoCompactionDecision(snapshot: SessionSnapshot): Promise<{
  shouldCompact: boolean
  tokensUsed: number
  contextLength: number
  thresholdPercent: number
}> {
  const currentSettings = await getSettingsState()
  const thresholdPercent =
    currentSettings.compaction.autoCompactThresholdPercent

  const contextLength = await resolveSessionContextLength(snapshot)
  const debugSnapshot = gemmaDesktop.describeSession(snapshot)

  const tokensUsed = Math.max(
    0,
    Math.round(
      (
        estimateCharsFromUnknown(debugSnapshot.requestPreview?.messages)
        + estimateCharsFromUnknown(debugSnapshot.requestPreview?.tools)
      ) / 4,
    ),
  )

  const shouldCompact =
    currentSettings.compaction.autoCompactEnabled
    && contextLength > 0
    && tokensUsed / contextLength >= thresholdPercent / 100

  return {
    shouldCompact,
    tokensUsed,
    contextLength,
    thresholdPercent,
  }
}

type StreamingTextBlock = {
  type: 'text'
  text: string
  rawText?: string
}

type StreamingThinkingBlock = {
  type: 'thinking'
  text: string
  summary?: string
  rawText?: string
}

type StreamingToolCallBlock = ToolCallProgressBlock

type StreamingFileEditBlock = FileEditContentBlock & {
  sourceToolCallId?: string
}

type StreamingWarningBlock = {
  type: 'warning'
  message: string
}

type StreamingContentBlock =
  | StreamingTextBlock
  | StreamingThinkingBlock
  | StreamingToolCallBlock
  | StreamingFileEditBlock
  | StreamingWarningBlock

function isStreamingToolCallBlock(
  block: StreamingContentBlock,
): block is StreamingToolCallBlock {
  return block.type === 'tool_call'
}

function normalizeUnknownRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function serializeStreamingBlocks(
  blocks: StreamingContentBlock[],
  options?: { cancelled?: boolean },
): Array<Record<string, unknown>> {
  return sanitizeRenderableContentBlocks(
    blocks.reduce<Array<Record<string, unknown>>>((serialized, block) => {
      if (block.type === 'tool_call') {
        const { callId: _, ...rest } = block
        if (options?.cancelled && (rest.status === 'running' || rest.status === 'pending')) {
          serialized.push({ ...rest, status: 'error' })
          return serialized
        }
        serialized.push(rest)
        return serialized
      }
      if (block.type === 'file_edit') {
        const { sourceToolCallId: _, ...rest } = block
        serialized.push(rest)
        return serialized
      }
      if ((block.type === 'text' || block.type === 'thinking') && block.text.length === 0) {
        return serialized
      }
      if (block.type === 'text' || block.type === 'thinking') {
        const { rawText: _, ...rest } = block
        serialized.push(rest)
        return serialized
      }
      serialized.push(block)
      return serialized
    }, []),
  )
}

function appendStreamingDelta(
  blocks: StreamingContentBlock[],
  type: 'text' | 'thinking',
  delta: string,
): string {
  if (delta.length === 0) {
    return ''
  }

  const last = blocks[blocks.length - 1]
  if (last?.type === type) {
    const previousText = last.text
    const nextRawText = `${last.rawText ?? last.text}${delta}`
    const nextText = stripAssistantTransportArtifacts(nextRawText)
    last.rawText = nextRawText
    last.text = nextText
    return nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : ''
  }

  const nextText = stripAssistantTransportArtifacts(delta)
  if (nextText.length === 0) {
    return ''
  }

  blocks.push({ type, text: nextText, rawText: delta })
  return nextText
}

function buildFallbackStreamingBlocks(result: {
  text: string
  reasoning?: string
  toolResults: ToolResult[]
  workingDirectory?: string
}): StreamingContentBlock[] {
  const blocks: StreamingContentBlock[] = []

  const sanitizedReasoning = result.reasoning
    ? stripAssistantTransportArtifacts(result.reasoning)
    : ''
  if (sanitizedReasoning) {
    blocks.push({ type: 'thinking', text: sanitizedReasoning })
  }

  const sanitizedText = result.text
    ? stripAssistantTransportArtifacts(result.text)
    : ''
  if (sanitizedText) {
    blocks.push({ type: 'text', text: sanitizedText })
  }

  for (const toolResult of result.toolResults) {
    const fileEditBlocks = result.workingDirectory
      ? extractFileEditBlocksFromToolResult({
          toolName: toolResult.toolName,
          structuredOutput: toolResult.structuredOutput,
          workingDirectory: result.workingDirectory,
        }).map((block) => ({
          ...block,
          sourceToolCallId: toolResult.callId,
        }))
      : []
    if (fileEditBlocks.length > 0) {
      blocks.push(...fileEditBlocks)
      continue
    }
    blocks.push({
      type: 'tool_call',
      toolName: toolResult.toolName,
      input: {},
      output: toolResult.output,
      status: isErroredToolResult(toolResult) ? 'error' : 'success',
      callId: toolResult.callId,
    })
  }

  return blocks
}

function isErroredToolResult(toolResult: ToolResult): boolean {
  const metadata = normalizeUnknownRecord(toolResult.metadata)
  if (metadata.toolError === true) {
    return true
  }

  const structured = normalizeUnknownRecord(toolResult.structuredOutput)
  return structured.ok === false || typeof structured.error === 'string'
}

function stripProvisionalToolTextBlocks(
  blocks: StreamingContentBlock[],
): StreamingContentBlock[] {
  return blocks.filter((block, index) => {
    if (block.type !== 'text') {
      return true
    }

    let sawToolCall = false
    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      const next = blocks[cursor]
      if (!next || next.type === 'thinking') {
        continue
      }

      if (next.type === 'tool_call' || next.type === 'file_edit') {
        sawToolCall = true
        continue
      }

      if (next.type === 'text') {
        return !sawToolCall
      }

      return true
    }

    return true
  })
}

function finalizeStreamingBlocks(
  blocks: StreamingContentBlock[],
  result: {
    text: string
    reasoning?: string
    toolResults: ToolResult[]
    workingDirectory?: string
  },
): StreamingContentBlock[] {
  if (blocks.length === 0) {
    return buildFallbackStreamingBlocks(result)
  }

  const finalized = stripProvisionalToolTextBlocks(
    blocks.map((block) => ({ ...block })),
  )
  const hasThinking = finalized.some((block) => block.type === 'thinking')
  const hasText = finalized.some((block) => block.type === 'text')
  const sanitizedReasoning = result.reasoning
    ? stripAssistantTransportArtifacts(result.reasoning)
    : ''
  const sanitizedText = result.text
    ? stripAssistantTransportArtifacts(result.text)
    : ''

  if (sanitizedReasoning && !hasThinking) {
    finalized.unshift({ type: 'thinking', text: sanitizedReasoning })
  }

  if (sanitizedText && !hasText) {
    finalized.push({ type: 'text', text: sanitizedText })
  }

  for (const toolResult of result.toolResults) {
    const fileEditBlocks = result.workingDirectory
      ? extractFileEditBlocksFromToolResult({
          toolName: toolResult.toolName,
          structuredOutput: toolResult.structuredOutput,
          workingDirectory: result.workingDirectory,
        }).map((block) => ({
          ...block,
          sourceToolCallId: toolResult.callId,
        }))
      : []
    const existingFileEditIndex = finalized.findIndex(
      (block) => block.type === 'file_edit' && block.sourceToolCallId === toolResult.callId,
    )
    const idx = finalized.findIndex(
      (block) =>
        block.type === 'tool_call'
        && block.callId === toolResult.callId,
    )

    if (fileEditBlocks.length > 0) {
      if (idx >= 0) {
        finalized.splice(idx, 1, ...fileEditBlocks)
        continue
      }
      if (existingFileEditIndex >= 0) {
        continue
      }
      finalized.push(...fileEditBlocks)
      continue
    }

    if (idx >= 0) {
      const block = finalized[idx]
      if (block && isStreamingToolCallBlock(block)) {
        finalized[idx] = {
          ...block,
          output: toolResult.output,
          status: isErroredToolResult(toolResult) ? 'error' : 'success',
        }
        continue
      }
    }

    finalized.push({
      type: 'tool_call',
      toolName: toolResult.toolName,
      input: {},
      output: toolResult.output,
      status: isErroredToolResult(toolResult) ? 'error' : 'success',
      callId: toolResult.callId,
    })
  }

  const stillMissingUserFacingText = !finalized.some(
    (block) => block.type === 'text' || block.type === 'file_edit',
  )
  if (stillMissingUserFacingText && result.toolResults.length > 0) {
    finalized.push({
      type: 'text',
      text:
        'Completed tool work, but the model did not produce a final written response. Review the tool output above.',
    })
  }

  return finalized
}

function buildCancelledAssistantMessage(
  turnId: string,
  blocks: StreamingContentBlock[],
  durationMs?: number,
): AppMessage | null {
  return buildInterruptedAssistantMessage({
    turnId,
    content: serializeStreamingBlocks(blocks, { cancelled: true }),
    timestamp: Date.now(),
    durationMs,
    idSuffix: CANCELLED_TURN_ID_SUFFIX,
    warningMessage: CANCELLED_TURN_WARNING,
  })
}

function buildCompletedAssistantMessageFromBlocks(
  turnId: string,
  blocks: StreamingContentBlock[],
  durationMs?: number,
): AppMessage | null {
  const content = sanitizeRenderableContentBlocks(
    serializeStreamingBlocks(
      finalizeStreamingBlocks(blocks, {
        text: '',
        toolResults: [],
      }),
    ),
  )

  if (content.length === 0) {
    return null
  }

  return {
    id: turnId,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    durationMs,
  }
}

function appMessageContentMatches(
  left: AppMessage['content'],
  right: AppMessage['content'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function buildUserMessagePreviewText(
  text: string,
  attachments: Array<Pick<IncomingAttachment, 'kind' | 'name'>> = [],
): string {
  const textPreview = text.trim().slice(0, 120)
  if (textPreview.length > 0) {
    return textPreview
  }

  const firstAttachment = attachments[0]
  if (!firstAttachment) {
    return ''
  }

  return `[${firstAttachment.kind}] ${firstAttachment.name || 'attachment'}`
}

function publishOptimisticUserMessage(input: {
  sessionId: string
  snapshot: SessionSnapshot
  message: AppMessage
  lastMessagePreview: string
}): void {
  store.upsertAppMessage(input.sessionId, input.message)
  sendToSession(input.sessionId, {
    type: 'user_message',
    message: input.message,
  })
  void store.save(
    input.sessionId,
    input.snapshot,
    { lastMessage: input.lastMessagePreview },
    store.getAppMessages(input.sessionId),
  ).catch((error) => {
    console.error(`[gemma-desktop] Failed to persist optimistic user message for ${input.sessionId}:`, error)
  })
  void broadcastSessionsChanged().catch(() => {})
}

function refreshOptimisticUserMessage(input: {
  sessionId: string
  snapshot: SessionSnapshot
  message: AppMessage
}): void {
  store.upsertAppMessage(input.sessionId, input.message)
  sendToSession(input.sessionId, {
    type: 'message_updated',
    message: input.message,
  })
  void store.save(
    input.sessionId,
    input.snapshot,
    undefined,
    store.getAppMessages(input.sessionId),
    { preserveUpdatedAt: true },
  ).catch((error) => {
    console.error(`[gemma-desktop] Failed to refresh optimistic user message for ${input.sessionId}:`, error)
  })
}

function makeStructuredResponseFormat(
  name: string,
  properties: Record<string, unknown>,
  required: string[],
): StructuredOutputSpec {
  return {
    name,
    strict: false,
    schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: true,
    },
  }
}

type HelperStructuredTaskResult = {
  helperModelId: string
  helperRuntimeId: string
  structuredOutput: Record<string, unknown>
  outputText: string
}

const ASSISTANT_TURN_AUDIT_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'assistant_turn_audit',
  {
    action: {
      type: 'string',
      enum: ['noop', 'complete', 'restart'],
    },
    completionMessage: { type: 'string' },
    restartInstruction: { type: 'string' },
  },
  ['action'],
)

const ASSISTANT_TURN_RECOVERY_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'assistant_turn_recovery',
  {
    completionMessage: { type: 'string' },
  },
  ['completionMessage'],
)

async function runHelperStructuredTask(input: {
  ownerId: string
  sessionRole: string
  workingDirectory: string
  systemInstructions: string
  sessionInput: SessionInput
  responseFormat?: StructuredOutputSpec
  signal?: AbortSignal
}): Promise<HelperStructuredTaskResult> {
  const currentSettings = await getSettingsState()
  const helperTarget = resolveHelperRouterTarget(currentSettings)
  const helperModelId = helperTarget.modelId
  const helperRuntimeId = helperTarget.runtimeId
  const leaseId = `helper-${input.sessionRole}-${input.ownerId}-${Date.now()}-${randomUUID()}`
  const releaseLease = await acquireHelperModelLease(leaseId)

  try {
    const metadata = withResolvedRequestPreferencesMetadata(
      {
        session_role: input.sessionRole,
      },
      currentSettings,
      {
        modelId: helperModelId,
        runtimeId: helperRuntimeId,
      },
    ) ?? {
      session_role: input.sessionRole,
    }
    const helperSession = await gemmaDesktop.sessions.create({
      runtime: helperRuntimeId,
      model: helperModelId,
      mode: 'minimal',
      workingDirectory: input.workingDirectory,
      systemInstructions: input.systemInstructions,
      metadata,
    })
    const result = await helperSession.run(input.sessionInput, {
      maxSteps: 1,
      responseFormat: input.responseFormat,
      signal: input.signal,
    })

    return {
      helperModelId,
      helperRuntimeId,
      structuredOutput:
        result.structuredOutput && typeof result.structuredOutput === 'object'
          ? result.structuredOutput as Record<string, unknown>
          : {},
      outputText: result.text,
    }
  } finally {
    releaseLease()
  }
}

const SESSION_TAG_EMOJI_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'session_tag_emoji',
  {
    emoji: { type: 'string' },
  },
  ['emoji'],
)

function extractFirstEmojiGrapheme(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const graphemes = Array.from(trimmed)
  for (const grapheme of graphemes) {
    if (/\p{Extended_Pictographic}/u.test(grapheme)) {
      const graphemeIndex = graphemes.indexOf(grapheme)
      let result = grapheme
      for (let index = graphemeIndex + 1; index < graphemes.length; index += 1) {
        const next = graphemes[index]
        if (!next) {
          break
        }
        const codePoint = next.codePointAt(0)
        const isEmojiModifier =
          codePoint !== undefined
          && codePoint >= 0x1F3FB
          && codePoint <= 0x1F3FF
        if (next === '\u200D' || next === '\uFE0F' || isEmojiModifier) {
          result += next
        } else {
          break
        }
      }
      return result
    }
  }
  return graphemes[0] ?? null
}

const PDF_PAGE_EXTRACTION_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'pdf_page_extraction',
  {
    markdown: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  ['markdown'],
)
const PDF_CHUNK_SUMMARY_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'pdf_chunk_summary',
  {
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  ['summary'],
)
const PDF_ATTACHMENT_SYNTHESIS_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'pdf_attachment_synthesis',
  {
    summary: { type: 'string' },
    promptText: { type: 'string' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  ['summary', 'promptText'],
)
const FILE_TEXT_EXTRACTION_RESPONSE_FORMAT = makeStructuredResponseFormat(
  'file_text_extraction',
  {
    text: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  ['text'],
)

const SMART_READ_DEFAULT_LINE_LIMIT = 200
const SMART_READ_DEFAULT_MAX_BYTES = 50 * 1024
const SMART_MULTI_READ_DEFAULT_MAX_BYTES = 120 * 1024
const PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS = 80
const PDF_EMBEDDED_TEXT_MIN_CHARS_PER_PAGE = 20

type InspectableFileKind = 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'unknown'

interface FileWorkerCapabilitySnapshot {
  modelId: string
  runtimeId: string
  imageSupported: boolean
  audioSupported: boolean
}

interface MultimodalFileWorkerResult {
  structuredOutput: Record<string, unknown>
  outputText: string
}

interface PdfDerivedPageRecord {
  pageNumber: number
  markdown: string
  warnings: string[]
}

interface PdfDerivedArtifactRecord {
  sourceName: string
  sourcePath: string
  pageCount: number
  processedRange: {
    startPage: number
    endPage: number
  }
  derivedAt: string
  worker: {
    modelId: string
    runtimeId: string
  }
  goal: string
  summary: string
  promptText: string
  promptTokenEstimate: number
  evidence: string[]
  warnings: string[]
  pages: PdfDerivedPageRecord[]
}

interface PdfDerivationResult {
  artifactPath?: string
  textPath?: string
  summary: string
  promptText: string
  promptTokenEstimate: number
  evidence: string[]
  warnings: string[]
  pageCount: number
  batchCount: number
  pages: PdfDerivedPageRecord[]
}

interface ResolvedInspectableFile {
  path: string
  fileUrl: string
  name: string
  mediaType: string | undefined
  kind: InspectableFileKind
  size: number
  modifiedAtMs: number
}

const IMAGE_FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
])
const AUDIO_FILE_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff',
  '.caf',
])
const VIDEO_FILE_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
])
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.zsh',
  '.fish',
  '.sql',
])

function inferInspectableMediaType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf':
      return 'application/pdf'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.heic':
      return 'image/heic'
    case '.heif':
      return 'image/heif'
    case '.avif':
      return 'image/avif'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.wav':
      return 'audio/wav'
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.ogg':
    case '.oga':
      return 'audio/ogg'
    case '.opus':
      return 'audio/opus'
    case '.aif':
    case '.aiff':
      return 'audio/aiff'
    case '.caf':
      return 'audio/x-caf'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.m4v':
      return 'video/x-m4v'
    case '.webm':
      return 'video/webm'
    default:
      return undefined
  }
}

function detectInspectableKind(
  filePath: string,
  mediaType: string | undefined,
): InspectableFileKind {
  const normalizedMediaType = mediaType?.trim().toLowerCase()
  const ext = path.extname(filePath).toLowerCase()

  if (normalizedMediaType === 'application/pdf' || ext === '.pdf') {
    return 'pdf'
  }
  if (normalizedMediaType?.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(ext)) {
    return 'image'
  }
  if (normalizedMediaType?.startsWith('audio/') || AUDIO_FILE_EXTENSIONS.has(ext)) {
    return 'audio'
  }
  if (normalizedMediaType?.startsWith('video/') || VIDEO_FILE_EXTENSIONS.has(ext)) {
    return 'video'
  }
  if (normalizedMediaType?.startsWith('text/') || TEXT_FILE_EXTENSIONS.has(ext)) {
    return 'text'
  }

  return 'unknown'
}

function normalizeInspectableInputPath(
  rawPath: string,
  workingDirectory: string,
): string {
  const trimmed = rawPath.trim()
  if (trimmed.startsWith('file://')) {
    return fileURLToPath(trimmed)
  }
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workingDirectory, trimmed)
}

async function readFileProbe(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function isLikelyTextProbe(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true
  }
  let controlBytes = 0
  for (const byte of buffer) {
    if (byte === 0) {
      return false
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      controlBytes += 1
    }
  }
  return controlBytes / buffer.length < 0.08
}

async function resolveInspectableFile(
  input: {
    path: string
    mediaType?: string
  },
  workingDirectory: string,
): Promise<ResolvedInspectableFile> {
  const resolvedPath = normalizeInspectableInputPath(input.path, workingDirectory)
  const stats = await fs.stat(resolvedPath)
  if (!stats.isFile()) {
    throw new Error(`Expected a file path, received: ${input.path}`)
  }

  const mediaType = input.mediaType?.trim() || inferInspectableMediaType(resolvedPath)
  let kind = detectInspectableKind(resolvedPath, mediaType)
  if (kind === 'unknown') {
    const probe = await readFileProbe(resolvedPath)
    if (isLikelyTextProbe(probe)) {
      kind = 'text'
    }
  }

  return {
    path: resolvedPath,
    fileUrl: pathToFileURL(resolvedPath).toString(),
    name: path.basename(resolvedPath),
    mediaType,
    kind,
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
  }
}

async function resolveSessionFileWorkerCapabilitySnapshot(
  sessionId: string,
): Promise<FileWorkerCapabilitySnapshot> {
  const { session } = await getOrResumeLiveSession(sessionId)
  const snapshot = session.snapshot()

  try {
    const env = await gemmaDesktop.inspectEnvironment()
    const matched = mapModels(env.runtimes).find(
      (model) =>
        model.id === snapshot.modelId
        && model.runtimeId === snapshot.runtimeId,
    )

    return {
      modelId: snapshot.modelId,
      runtimeId: snapshot.runtimeId,
      imageSupported: matched?.attachmentSupport.image ?? false,
      audioSupported: matched?.attachmentSupport.audio ?? false,
    }
  } catch {
    return {
      modelId: snapshot.modelId,
      runtimeId: snapshot.runtimeId,
      imageSupported: false,
      audioSupported: false,
    }
  }
}

function toWorkerSnapshot(model: {
  id: string
  runtimeId: string
  attachmentSupport?: {
    image?: boolean
    audio?: boolean
  }
}): FileWorkerCapabilitySnapshot {
  return {
    modelId: model.id,
    runtimeId: model.runtimeId,
    imageSupported: model.attachmentSupport?.image === true,
    audioSupported: model.attachmentSupport?.audio === true,
  }
}

async function resolvePreferredFileReadWorker(input: {
  sessionId: string
  kind: 'pdf' | 'audio' | 'image'
}): Promise<FileWorkerCapabilitySnapshot> {
  const { session } = await getOrResumeLiveSession(input.sessionId)
  const snapshot = session.snapshot()
  const env = await gemmaDesktop.inspectEnvironment()
  const models = mapModels(env.runtimes)
  const currentModel = models.find(
    (model) =>
      model.id === snapshot.modelId
      && model.runtimeId === snapshot.runtimeId,
  )

  const pickByTags = (
    tags: string[],
    predicate: (model: typeof models[number]) => boolean,
  ): typeof models[number] | undefined => {
    for (const tag of tags) {
      const sameRuntime = models.find((model) =>
        model.id === tag
        && model.runtimeId === snapshot.runtimeId
        && predicate(model),
      )
      if (sameRuntime) {
        return sameRuntime
      }
      const anyRuntime = models.find((model) =>
        model.id === tag
        && predicate(model),
      )
      if (anyRuntime) {
        return anyRuntime
      }
    }
    return undefined
  }

  const isResident = (model: typeof models[number]) =>
    model.status === 'loaded' || model.status === 'loading'

  const isLowestGemmaTier = (model: typeof models[number]) =>
    model.id === 'gemma4:e2b'

  const preferResidentModel = (
    predicate: (model: typeof models[number]) => boolean,
    orderedTags: string[],
  ): typeof models[number] | undefined => {
    if (
      currentModel
      && isResident(currentModel)
      && predicate(currentModel)
      && !isLowestGemmaTier(currentModel)
    ) {
      return currentModel
    }

    const residentByTags = pickByTags(
      orderedTags,
      (candidate) => isResident(candidate) && predicate(candidate),
    )
    if (residentByTags && !isLowestGemmaTier(residentByTags)) {
      return residentByTags
    }

    const residentCompatible = models.find((candidate) =>
      candidate.runtimeId === snapshot.runtimeId
      && isResident(candidate)
      && predicate(candidate)
      && !isLowestGemmaTier(candidate),
    )
      ?? models.find((candidate) =>
        isResident(candidate)
        && predicate(candidate)
        && !isLowestGemmaTier(candidate),
      )

    if (residentCompatible) {
      return residentCompatible
    }

    return undefined
  }

  const defaultHelperTags = ['gemma4:26b', 'gemma4:31b', 'gemma4:e4b', 'gemma4:e2b']

  if (input.kind === 'pdf') {
    const model =
      preferResidentModel(
        (candidate) => candidate.attachmentSupport.image,
        ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
      )
      ?? pickByTags(
        ['gemma4:26b', 'gemma4:31b', 'gemma4:e4b', 'gemma4:e2b'],
        (candidate) => candidate.attachmentSupport.image,
      )
      ?? (currentModel?.attachmentSupport.image ? currentModel : undefined)
    if (!model) {
      throw new Error('Gemma Desktop could not find a vision-capable Gemma helper for PDF reading. Install Gemma 4 26B, 31B, or another image-capable Gemma runtime.')
    }
    return toWorkerSnapshot(model)
  }

  if (input.kind === 'audio') {
    const model =
      preferResidentModel(
        (candidate) => candidate.attachmentSupport.audio,
        ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
      )
      ?? pickByTags(
        defaultHelperTags,
        (candidate) => candidate.attachmentSupport.audio,
      )
      ?? (currentModel?.attachmentSupport.audio ? currentModel : undefined)
    if (!model) {
      throw new Error('Gemma Desktop could not find an audio-capable helper model for audio reading.')
    }
    return toWorkerSnapshot(model)
  }

  const model =
    preferResidentModel(
      (candidate) => candidate.attachmentSupport.image,
      ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
    )
    ?? pickByTags(
      defaultHelperTags,
      (candidate) => candidate.attachmentSupport.image,
    )
    ?? (currentModel?.attachmentSupport.image ? currentModel : undefined)
  if (!model) {
    throw new Error('Gemma Desktop could not find a vision-capable helper model for image reading.')
  }
  return toWorkerSnapshot(model)
}

const SMART_FILE_READ_CACHE_VERSION = 'v2'

async function ensureSmartFileReadCacheRoot(workingDirectory: string): Promise<string> {
  const root = path.join(workingDirectory, '.gemma', 'file-read-cache')
  await fs.mkdir(root, { recursive: true })
  return root
}

async function buildSmartFileReadCacheDirectory(input: {
  workingDirectory: string
  file: ResolvedInspectableFile
  worker?: Pick<FileWorkerCapabilitySnapshot, 'modelId' | 'runtimeId'>
  mode: string
}): Promise<string> {
  const root = await ensureSmartFileReadCacheRoot(input.workingDirectory)
  const digest = createHash('sha256')
    .update([
      SMART_FILE_READ_CACHE_VERSION,
      input.mode,
      input.file.path,
      String(input.file.size),
      String(input.file.modifiedAtMs),
      input.worker?.modelId ?? '',
      input.worker?.runtimeId ?? '',
    ].join('\n'))
    .digest('hex')
  const directory = path.join(root, digest)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

function renderReadWindow(input: {
  sourcePath: string
  displayPath: string
  text: string
  offset?: number
  limit?: number
  maxBytes?: number
}): {
  content: string
  numberedContent: string
  lines: Array<{ line: number; text: string }>
  truncated: boolean
  nextOffset?: number
  totalLines: number
} {
  const allLines = input.text.replace(/\r\n/g, '\n').split('\n')
  const offset = Math.max(input.offset ?? 1, 1)
  const limit = Math.max(input.limit ?? SMART_READ_DEFAULT_LINE_LIMIT, 1)
  const maxBytes = Math.max(input.maxBytes ?? SMART_READ_DEFAULT_MAX_BYTES, 256)
  const lines: Array<{ line: number; text: string }> = []
  let truncated = false
  let nextOffset: number | undefined
  let renderedBytes = 0

  for (let index = offset - 1; index < allLines.length; index += 1) {
    const lineNumber = index + 1
    if (lines.length >= limit) {
      truncated = true
      nextOffset = lineNumber
      break
    }

    const line = allLines[index] ?? ''
    const renderedLine = `${lineNumber}: ${line}`
    const renderedLineBytes = Buffer.byteLength(
      `${lines.length === 0 ? '' : '\n'}${renderedLine}`,
      'utf8',
    )
    if (renderedBytes + renderedLineBytes > maxBytes) {
      truncated = true
      nextOffset = lineNumber
      break
    }

    lines.push({ line: lineNumber, text: line })
    renderedBytes += renderedLineBytes
  }

  return {
    content: lines.map((line) => line.text).join('\n'),
    numberedContent: lines.map((line) => `${line.line}: ${line.text}`).join('\n'),
    lines,
    truncated,
    nextOffset,
    totalLines: allLines.length,
  }
}

function displayPathForToolOutput(
  sourcePath: string,
  workingDirectory: string,
): string {
  const relative = path.relative(workingDirectory, sourcePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : sourcePath
}

type SmartReadStrategy =
  | 'direct_text'
  | 'pdf_to_text'
  | 'image_to_text'
  | 'audio_to_text'

type ContentMaterializeTarget = 'auto' | 'text' | 'markdown'

interface MaterializedContentInternal {
  artifactId: string
  artifactPath: string
  displayArtifactPath: string
  sourcePath: string
  displaySourcePath: string
  cachePath?: string
  outputPath?: string
  displayOutputPath?: string
  target: ContentMaterializeTarget
  kind: InspectableFileKind
  mediaType?: string
  strategy: SmartReadStrategy
  bytes: number
  lineCount: number
  helperModelId?: string
  helperRuntimeId?: string
  cacheHit?: boolean
  text: string
}

interface ContentSearchMatch {
  path: string
  line: number
  text: string
  submatches: Array<{
    text: string
    start: number
    end: number
  }>
  beforeContext?: Array<{ line: number; text: string }>
  afterContext?: Array<{ line: number; text: string }>
}

type SmartFileReadProgress = {
  id: string
  label: string
  tone?: 'info' | 'success' | 'warning'
}

function emitSmartFileReadProgress(
  callback: ((progress: SmartFileReadProgress) => void) | undefined,
  progress: SmartFileReadProgress,
): void {
  callback?.(progress)
}

function hasUsefulEmbeddedPdfText(input: {
  pageCount: number
  extractedCharCount: number
  pages: Array<{ charCount: number }>
}): boolean {
  if (input.extractedCharCount >= Math.max(
    PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS,
    input.pageCount * PDF_EMBEDDED_TEXT_MIN_CHARS_PER_PAGE,
  )) {
    return true
  }

  return input.pages.some((page) => page.charCount >= PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS)
}

function buildEmbeddedPdfMarkdown(
  pages: Array<{ pageNumber: number; text: string }>,
): string {
  return pages
    .filter((page) => page.text.trim().length > 0)
    .map((page) => `## Page ${page.pageNumber}\n\n${page.text.trim()}`)
    .join('\n\n')
}

function formatInspectFileOutput(input: {
  file: ResolvedInspectableFile
  displayPath: string
  canReadWithReadFile: boolean
  suggestedTool?: string
  suggestedStrategy: string
  reasoning: string
  warnings: string[]
  pageCount?: number
}): string {
  return [
    `File: ${input.file.name}`,
    `Path: ${input.displayPath}`,
    `Kind: ${input.file.kind}`,
    `Media type: ${input.file.mediaType ?? 'unknown'}`,
    `Bytes: ${input.file.size}`,
    typeof input.pageCount === 'number' ? `PDF pages: ${input.pageCount}` : '',
    `Can read with read_file: ${input.canReadWithReadFile ? 'yes' : 'no'}`,
    input.suggestedTool ? `Suggested tool: ${input.suggestedTool}` : '',
    `Suggested strategy: ${input.suggestedStrategy}`,
    `Why: ${input.reasoning}`,
    input.warnings.length > 0 ? `Warnings:\n- ${input.warnings.join('\n- ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function inspectFileForReadStrategy(input: {
  file: ResolvedInspectableFile
  workingDirectory: string
}): Promise<{
  file: ResolvedInspectableFile
  displayPath: string
  canReadWithReadFile: boolean
  suggestedTool?: 'read_file'
  suggestedStrategy: string
  reasoning: string
  warnings: string[]
  pageCount?: number
}> {
  const warnings: string[] = []
  const displayPath = displayPathForToolOutput(
    input.file.path,
    input.workingDirectory,
  )
  let pageCount: number | undefined

  switch (input.file.kind) {
    case 'text': {
      if (input.file.size > 256 * 1024) {
        warnings.push(
          'Large text file. Prefer one broader read_file window instead of many tiny slices.',
        )
      }
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: true,
        suggestedTool: 'read_file',
        suggestedStrategy: 'direct_text',
        reasoning: 'This looks like a text-like file, so read_file can paginate it directly.',
        warnings,
      }
    }
    case 'pdf': {
      try {
        const pdfInfo = await inspectPdfDocument(input.file.path)
        pageCount = pdfInfo.pageCount
        if (pdfInfo.pageCount > 40) {
          warnings.push(
            `Large PDF (${pdfInfo.pageCount} pages). Expect extraction to take longer the first time.`,
          )
        }
      } catch (error) {
        warnings.push(
          error instanceof Error
            ? `Could not inspect PDF page count: ${error.message}`
            : 'Could not inspect PDF page count.',
        )
      }
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: true,
        suggestedTool: 'read_file',
        suggestedStrategy: 'pdf_to_text',
        reasoning:
          'Use read_file. Gemma Desktop will convert the PDF into cached text with a helper model, then return a paginated text window.',
        warnings,
        pageCount,
      }
    }
    case 'image':
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: true,
        suggestedTool: 'read_file',
        suggestedStrategy: 'image_to_text',
        reasoning:
          'Use read_file. Gemma Desktop will run image reading once, cache the extracted text or description, and return text.',
        warnings,
      }
    case 'audio':
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: true,
        suggestedTool: 'read_file',
        suggestedStrategy: 'audio_to_text',
        reasoning:
          'Use read_file. Gemma Desktop will transcribe or describe the audio once, cache the text, and return a paginated text window.',
        warnings,
      }
    case 'video':
      warnings.push(
        'Raw video is not readable through read_file yet. Attach it or prepare keyframes first.',
      )
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: false,
        suggestedStrategy: 'unsupported_video',
        reasoning:
          'read_file does not currently extract raw video into text. The model needs prepared frames or an attached video path.',
        warnings,
      }
    case 'unknown':
    default:
      warnings.push(
        'This file does not look safely text-readable. Inspect the format before trying shell or ad-hoc parsing.',
      )
      return {
        file: input.file,
        displayPath,
        canReadWithReadFile: false,
        suggestedStrategy: 'unknown_binary',
        reasoning:
          'Gemma Desktop could not classify this file as text, PDF, image, or audio, so read_file may not be safe or useful.',
        warnings,
      }
  }
}

function buildReadWindowResult(input: {
  file: ResolvedInspectableFile
  displayPath: string
  offset?: number
  limit?: number
  maxBytes?: number
  text: string
  strategy: SmartReadStrategy
  helperModelId?: string
  helperRuntimeId?: string
  cacheHit?: boolean
}) {
  const window = renderReadWindow({
    sourcePath: input.file.path,
    displayPath: input.displayPath,
    text: input.text,
    offset: input.offset,
    limit: input.limit,
    maxBytes: input.maxBytes,
  })
  const offset = Math.max(input.offset ?? 1, 1)
  const limit = Math.max(input.limit ?? SMART_READ_DEFAULT_LINE_LIMIT, 1)
  const maxBytes = Math.max(input.maxBytes ?? SMART_READ_DEFAULT_MAX_BYTES, 256)
  const lineEnd =
    window.lines.at(-1)?.line ?? Math.max(0, offset - 1)

  return {
    path: input.displayPath,
    absolutePath: input.file.path,
    offset,
    limit,
    maxBytes,
    content: window.content,
    numberedContent: window.numberedContent,
    lines: window.lines,
    truncated: window.truncated,
    nextOffset: window.nextOffset,
    lineEnd,
    totalLinesScanned: window.totalLines,
    mediaType: input.file.mediaType,
    kind: input.file.kind,
    strategy: input.strategy,
    helperModelId: input.helperModelId,
    helperRuntimeId: input.helperRuntimeId,
    cacheHit: input.cacheHit,
  }
}

function countMaterializedTextLines(text: string): number {
  return text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeMaterializedTextOutput(input: {
  outputPath: string
  text: string
  createDirectories?: boolean
  overwrite?: boolean
}): Promise<void> {
  if (input.createDirectories) {
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
  }

  if (input.overwrite !== true && await fileExists(input.outputPath)) {
    throw new Error(
      `Refusing to overwrite existing content artifact: ${input.outputPath}. Retry with overwrite=true if replacing it is intentional.`,
    )
  }

  await fs.writeFile(input.outputPath, input.text, 'utf8')
  const verified = await fs.readFile(input.outputPath, 'utf8')
  if (verified !== input.text) {
    throw new Error(
      `Write verification failed for ${input.outputPath}. Re-read the artifact before continuing.`,
    )
  }
}

function materializedContentForStructuredOutput(
  input: MaterializedContentInternal,
): Omit<MaterializedContentInternal, 'text'> {
  const structured: Partial<MaterializedContentInternal> = { ...input }
  delete structured.text
  return structured as Omit<MaterializedContentInternal, 'text'>
}

function formatMaterializedContentOutput(input: MaterializedContentInternal): string {
  return [
    'Materialized content artifact.',
    `Source: ${input.displaySourcePath}`,
    `Artifact path: ${input.displayArtifactPath}`,
    input.displayOutputPath ? `Output path: ${input.displayOutputPath}` : '',
    input.cachePath && input.cachePath !== input.artifactPath
      ? `Cache path: ${input.cachePath}`
      : '',
    `Kind: ${input.kind}`,
    `Target: ${input.target}`,
    `Strategy: ${input.strategy}`,
    input.helperModelId ? `Helper model: ${input.helperModelId}` : '',
    input.cacheHit != null ? `Cache hit: ${input.cacheHit ? 'yes' : 'no'}` : '',
    `Bytes: ${input.bytes}`,
    `Lines: ${input.lineCount}`,
    `Next: use read_content or search_content with path "${input.displayArtifactPath}".`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function materializeInspectableContent(input: {
  path: string
  mediaType?: string
  outputPath?: string
  target?: ContentMaterializeTarget
  createDirectories?: boolean
  overwrite?: boolean
  workingDirectory: string
  sessionId: string
  signal?: AbortSignal
  onProgress?: (progress: SmartFileReadProgress) => void
}): Promise<MaterializedContentInternal> {
  emitSmartFileReadProgress(input.onProgress, {
    id: 'resolve-file',
    label: 'Resolving content source',
  })
  const file = await resolveInspectableFile(
    { path: input.path, mediaType: input.mediaType },
    input.workingDirectory,
  )
  const displaySourcePath = displayPathForToolOutput(file.path, input.workingDirectory)
  const target = input.target ?? 'auto'
  let textPath: string
  let text: string
  let strategy: SmartReadStrategy
  let helperModelId: string | undefined
  let helperRuntimeId: string | undefined
  let cacheHit: boolean | undefined

  if (file.kind === 'text') {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'read-text',
      label: 'Materializing text file',
    })
    textPath = file.path
    text = await fs.readFile(file.path, 'utf8')
    if (text.includes('\u0000')) {
      throw new Error(`Refusing to materialize binary-looking file: ${file.path}`)
    }
    strategy = 'direct_text'
    cacheHit = true
  } else if (file.kind === 'pdf') {
    const extracted = await extractPdfToCachedText({
      file,
      workingDirectory: input.workingDirectory,
      sessionId: input.sessionId,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    textPath = extracted.textPath
    text = await fs.readFile(textPath, 'utf8')
    strategy = 'pdf_to_text'
    helperModelId = extracted.helperModelId
    helperRuntimeId = extracted.helperRuntimeId
    cacheHit = extracted.cacheHit
  } else if (file.kind === 'image' || file.kind === 'audio') {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'select-helper',
      label: `Selecting ${file.kind} helper model`,
    })
    const worker = await resolvePreferredFileReadWorker({
      sessionId: input.sessionId,
      kind: file.kind,
    })
    const extracted = await extractMultimodalFileToCachedText({
      file,
      worker,
      workingDirectory: input.workingDirectory,
      kind: file.kind,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    textPath = extracted.textPath
    text = await fs.readFile(textPath, 'utf8')
    strategy = file.kind === 'image' ? 'image_to_text' : 'audio_to_text'
    helperModelId = extracted.helperModelId
    helperRuntimeId = extracted.helperRuntimeId
    cacheHit = extracted.cacheHit
  } else if (file.kind === 'video') {
    throw new Error(
      `${file.name} is a video file. materialize_content does not currently extract raw video into text.`,
    )
  } else {
    throw new Error(
      `${file.name} is not safely materializable as text. Use inspect_file first and avoid shell-based parsing guesses.`,
    )
  }

  let artifactPath = textPath
  let outputPath: string | undefined
  if (input.outputPath?.trim()) {
    outputPath = normalizeInspectableInputPath(
      input.outputPath,
      input.workingDirectory,
    )
    emitSmartFileReadProgress(input.onProgress, {
      id: 'write-artifact',
      label: 'Writing content artifact',
    })
    await writeMaterializedTextOutput({
      outputPath,
      text,
      createDirectories: input.createDirectories,
      overwrite: input.overwrite,
    })
    artifactPath = outputPath
  }

  return {
    artifactId: artifactPath,
    artifactPath,
    displayArtifactPath: displayPathForToolOutput(artifactPath, input.workingDirectory),
    sourcePath: file.path,
    displaySourcePath,
    cachePath: textPath,
    outputPath,
    displayOutputPath: outputPath
      ? displayPathForToolOutput(outputPath, input.workingDirectory)
      : undefined,
    target,
    kind: file.kind,
    mediaType: file.mediaType,
    strategy,
    bytes: Buffer.byteLength(text, 'utf8'),
    lineCount: countMaterializedTextLines(text),
    helperModelId,
    helperRuntimeId,
    cacheHit,
    text,
  }
}

function buildMaterializedReadResult(input: {
  materialized: MaterializedContentInternal
  offset?: number
  limit?: number
  maxBytes?: number
}) {
  return buildReadWindowResult({
    file: {
      path: input.materialized.artifactPath,
      fileUrl: pathToFileURL(input.materialized.artifactPath).toString(),
      name: path.basename(input.materialized.artifactPath),
      mediaType: 'text/markdown',
      kind: 'text',
      size: input.materialized.bytes,
      modifiedAtMs: Date.now(),
    },
    displayPath: input.materialized.displayArtifactPath,
    offset: input.offset,
    limit: input.limit,
    maxBytes: input.maxBytes,
    text: input.materialized.text,
    strategy: input.materialized.strategy,
    helperModelId: input.materialized.helperModelId,
    helperRuntimeId: input.materialized.helperRuntimeId,
    cacheHit: input.materialized.cacheHit,
  })
}

function searchMaterializedText(input: {
  text: string
  path: string
  query: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  before?: number
  after?: number
  limit?: number
}): {
  matches: ContentSearchMatch[]
  truncated: boolean
  regex: boolean
} {
  const query = input.query.trim()
  if (!query) {
    throw new Error('search_content requires a non-empty query.')
  }

  const lines = input.text.replace(/\r\n/g, '\n').split('\n')
  const before = Math.max(0, Math.min(Math.floor(input.before ?? 0), 20))
  const after = Math.max(0, Math.min(Math.floor(input.after ?? 0), 20))
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 500))
  const matches: ContentSearchMatch[] = []
  const flags = input.caseSensitive ? 'g' : 'gi'
  const pattern = input.regex === true
    ? new RegExp(query, flags)
    : new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        flags,
      )
  const finalPattern = input.wholeWord === true
    ? new RegExp(`\\b(?:${pattern.source})\\b`, flags)
    : pattern

  for (const [index, line] of lines.entries()) {
    finalPattern.lastIndex = 0
    const submatches = [...line.matchAll(finalPattern)].map((match) => ({
      text: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }))
    if (submatches.length === 0) {
      continue
    }

    const lineNumber = index + 1
    matches.push({
      path: input.path,
      line: lineNumber,
      text: line,
      submatches,
      beforeContext: before > 0
        ? lines
            .slice(Math.max(0, index - before), index)
            .map((text, contextIndex) => ({
              line: Math.max(0, index - before) + contextIndex + 1,
              text,
            }))
        : undefined,
      afterContext: after > 0
        ? lines
            .slice(index + 1, Math.min(lines.length, index + after + 1))
            .map((text, contextIndex) => ({
              line: index + contextIndex + 2,
              text,
            }))
        : undefined,
    })

    if (matches.length >= limit) {
      return {
        matches,
        truncated: true,
        regex: input.regex === true,
      }
    }
  }

  return {
    matches,
    truncated: false,
    regex: input.regex === true,
  }
}

function formatContentSearchOutput(input: {
  path: string
  query: string
  matches: ContentSearchMatch[]
  truncated: boolean
}): string {
  if (input.matches.length === 0) {
    return `[search_content] No matches for ${JSON.stringify(input.query)} in ${input.path}.`
  }

  const lines = [
    `[search_content] ${input.truncated ? 'First ' : ''}${input.matches.length} match${input.matches.length === 1 ? '' : 'es'} for ${JSON.stringify(input.query)} in ${input.path}${input.truncated ? ' (truncated)' : ''}.`,
  ]

  for (const match of input.matches) {
    lines.push(`${match.path}:${match.line}: ${match.text}`)
    for (const context of match.beforeContext ?? []) {
      lines.push(`${match.path}:${context.line}- ${context.text}`)
    }
    for (const context of match.afterContext ?? []) {
      lines.push(`${match.path}:${context.line}+ ${context.text}`)
    }
  }

  if (input.truncated) {
    lines.push(
      'Narrow the query or raise limit if you need more matches before reading targeted windows.',
    )
  }

  return lines.join('\n')
}

async function readInspectableFileForTool(input: {
  path: string
  mediaType?: string
  offset?: number
  limit?: number
  maxBytes?: number
  workingDirectory: string
  sessionId: string
  signal?: AbortSignal
  onProgress?: (progress: SmartFileReadProgress) => void
}) {
  emitSmartFileReadProgress(input.onProgress, {
    id: 'resolve-file',
    label: 'Resolving file path',
  })
  const file = await resolveInspectableFile(
    { path: input.path, mediaType: input.mediaType },
    input.workingDirectory,
  )
  const displayPath = displayPathForToolOutput(file.path, input.workingDirectory)

  if (file.kind === 'text') {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'read-text',
      label: 'Reading text window',
    })
    const backend = createWorkspaceSearchBackend({
      workingDirectory: input.workingDirectory,
      signal: input.signal,
    })
    const result = await backend.readFile({
      path: displayPath,
      offset: input.offset,
      limit: input.limit,
      maxBytes: input.maxBytes,
    })
    return {
      ...result,
      mediaType: file.mediaType,
      kind: file.kind,
      strategy: 'direct_text' as const,
      cacheHit: true,
    }
  }

  if (file.kind === 'pdf') {
    const extracted = await extractPdfToCachedText({
      file,
      workingDirectory: input.workingDirectory,
      sessionId: input.sessionId,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    emitSmartFileReadProgress(input.onProgress, {
      id: 'load-cached-text',
      label: 'Loading extracted PDF text',
    })
    const text = await fs.readFile(extracted.textPath, 'utf8')
    return buildReadWindowResult({
      file,
      displayPath,
      offset: input.offset,
      limit: input.limit,
      maxBytes: input.maxBytes,
      text,
      strategy: 'pdf_to_text',
      helperModelId: extracted.helperModelId,
      helperRuntimeId: extracted.helperRuntimeId,
      cacheHit: extracted.cacheHit,
    })
  }

  if (file.kind === 'image' || file.kind === 'audio') {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'select-helper',
      label: `Selecting ${file.kind} helper model`,
    })
    const worker = await resolvePreferredFileReadWorker({
      sessionId: input.sessionId,
      kind: file.kind,
    })
    const extracted = await extractMultimodalFileToCachedText({
      file,
      worker,
      workingDirectory: input.workingDirectory,
      kind: file.kind,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    emitSmartFileReadProgress(input.onProgress, {
      id: 'load-cached-text',
      label: `Loading extracted ${file.kind} text`,
    })
    const text = await fs.readFile(extracted.textPath, 'utf8')
    return buildReadWindowResult({
      file,
      displayPath,
      offset: input.offset,
      limit: input.limit,
      maxBytes: input.maxBytes,
      text,
      strategy: file.kind === 'image' ? 'image_to_text' : 'audio_to_text',
      helperModelId: extracted.helperModelId,
      helperRuntimeId: extracted.helperRuntimeId,
      cacheHit: extracted.cacheHit,
    })
  }

  if (file.kind === 'video') {
    throw new Error(
      `${file.name} is a video file. read_file does not currently extract raw video into text.`,
    )
  }

  throw new Error(
    `${file.name} is not safely readable as text. Use inspect_file first and avoid shell-based parsing guesses.`,
  )
}

async function extractPdfToCachedText(input: {
  file: ResolvedInspectableFile
  workingDirectory: string
  sessionId: string
  signal?: AbortSignal
  onProgress?: (progress: SmartFileReadProgress) => void
}): Promise<{
  textPath: string
  helperModelId?: string
  helperRuntimeId?: string
  cacheHit: boolean
}> {
  const directCacheDir = await buildSmartFileReadCacheDirectory({
    workingDirectory: input.workingDirectory,
    file: input.file,
    mode: 'pdf-text-direct',
  })
  const directTextPath = path.join(directCacheDir, 'content.md')
  const directMetaPath = path.join(directCacheDir, 'meta.json')
  try {
    await fs.access(directTextPath)
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-cache',
      label: 'Using cached PDF text',
      tone: 'success',
    })
    return {
      textPath: directTextPath,
      cacheHit: true,
    }
  } catch {
    // Cache miss; continue with PDF extraction.
  }

  let pageCount: number | undefined

  try {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-embedded-text',
      label: 'Checking embedded PDF text',
    })
    const extractedText = await extractPdfText({
      path: input.file.path,
    })
    pageCount = extractedText.pageCount

    if (hasUsefulEmbeddedPdfText(extractedText)) {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-embedded-text',
        label: 'Using embedded PDF text',
        tone: 'success',
      })
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-write-cache',
        label: 'Caching extracted PDF text',
      })
      await fs.writeFile(
        directTextPath,
        buildEmbeddedPdfMarkdown(extractedText.pages),
        'utf8',
      )
      await fs.writeFile(
        directMetaPath,
        JSON.stringify({
          version: SMART_FILE_READ_CACHE_VERSION,
          sourcePath: input.file.path,
          pageCount: extractedText.pageCount,
          extractionMode: 'embedded_text',
        }, null, 2),
        'utf8',
      )

      return {
        textPath: directTextPath,
        cacheHit: false,
      }
    }

    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-embedded-text',
      label: 'Embedded PDF text was sparse, falling back to page reading',
      tone: 'warning',
    })
  } catch (error) {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-embedded-text',
      label:
        error instanceof Error
          ? `Embedded PDF text extraction failed: ${error.message}`
          : 'Embedded PDF text extraction failed, falling back to page reading',
      tone: 'warning',
    })
  }

  emitSmartFileReadProgress(input.onProgress, {
    id: 'select-helper',
    label: 'Selecting PDF helper model',
  })
  const worker = await resolvePreferredFileReadWorker({
    sessionId: input.sessionId,
    kind: 'pdf',
  })
  const workerCacheDir = await buildSmartFileReadCacheDirectory({
    workingDirectory: input.workingDirectory,
    file: input.file,
    worker,
    mode: 'pdf-text-ocr',
  })
  const textPath = path.join(workerCacheDir, 'content.md')
  const metaPath = path.join(workerCacheDir, 'meta.json')
  try {
    await fs.access(textPath)
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-cache',
      label: 'Using cached PDF text',
      tone: 'success',
    })
    return {
      textPath,
      helperModelId: worker.modelId,
      helperRuntimeId: worker.runtimeId,
      cacheHit: true,
    }
  } catch {
    // Cache miss; continue with OCR extraction.
  }

  const resolvedPageCount = pageCount ?? (await inspectPdfDocument(input.file.path)).pageCount
  const renderedDir = path.join(workerCacheDir, 'rendered-pages')
  await fs.mkdir(renderedDir, { recursive: true })
  emitSmartFileReadProgress(input.onProgress, {
    id: 'pdf-render',
    label: `Rendering ${resolvedPageCount} PDF page${resolvedPageCount === 1 ? '' : 's'}`,
  })
  const renderedPages = await renderPdfPages({
    path: input.file.path,
    startPage: 1,
    endPage: resolvedPageCount,
    scale: PDF_RENDER_SCALE,
    outputDir: renderedDir,
    filenamePrefix: 'page',
  })
  const pageMarkdown: string[] = []
  const totalPages = renderedPages.length
  for (const page of renderedPages) {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-extract',
      label: `Reading page ${page.pageNumber} of ${totalPages}`,
    })
    const extracted = await runPdfPageExtractionSession({
      fileName: input.file.name,
      pageNumber: page.pageNumber,
      pageImageUrl: pathToFileURL(page.path).toString(),
      worker,
      workingDirectory: path.dirname(input.file.path),
      signal: input.signal,
    })
    pageMarkdown.push(`## Page ${extracted.pageNumber}\n\n${extracted.markdown}`)
  }

  emitSmartFileReadProgress(input.onProgress, {
    id: 'pdf-write-cache',
    label: 'Caching extracted PDF text',
  })
  await fs.writeFile(textPath, pageMarkdown.join('\n\n'), 'utf8')
  await fs.writeFile(
    metaPath,
    JSON.stringify({
        version: SMART_FILE_READ_CACHE_VERSION,
        sourcePath: input.file.path,
        helperModelId: worker.modelId,
        helperRuntimeId: worker.runtimeId,
        pageCount: resolvedPageCount,
        extractionMode: 'page_ocr',
      }, null, 2),
    'utf8',
  )

  return {
    textPath,
    helperModelId: worker.modelId,
    helperRuntimeId: worker.runtimeId,
    cacheHit: false,
  }
}

async function extractMultimodalFileToCachedText(input: {
  file: ResolvedInspectableFile
  worker: FileWorkerCapabilitySnapshot
  workingDirectory: string
  kind: 'audio' | 'image'
  signal?: AbortSignal
  onProgress?: (progress: SmartFileReadProgress) => void
}): Promise<{
  textPath: string
  helperModelId: string
  helperRuntimeId: string
  cacheHit: boolean
}> {
  const cacheDir = await buildSmartFileReadCacheDirectory({
    workingDirectory: input.workingDirectory,
    file: input.file,
    worker: input.worker,
    mode: `${input.kind}-text`,
  })
  const textPath = path.join(cacheDir, 'content.txt')
  const metaPath = path.join(cacheDir, 'meta.json')
  try {
    await fs.access(textPath)
    emitSmartFileReadProgress(input.onProgress, {
      id: `${input.kind}-cache`,
      label: `Using cached ${input.kind} text`,
      tone: 'success',
    })
    return {
      textPath,
      helperModelId: input.worker.modelId,
      helperRuntimeId: input.worker.runtimeId,
      cacheHit: true,
    }
  } catch {
    // Cache miss; continue with multimodal extraction.
  }

  emitSmartFileReadProgress(input.onProgress, {
    id: `${input.kind}-helper`,
    label:
      input.kind === 'audio'
        ? 'Listening with helper model'
        : 'Reading image with helper model',
  })
  const workerResult = await runMultimodalFileWorkerSession({
    worker: input.worker,
    workingDirectory: path.dirname(input.file.path),
    signal: input.signal,
    responseFormat: FILE_TEXT_EXTRACTION_RESPONSE_FORMAT,
    systemInstructions:
      input.kind === 'audio'
        ? [
            'You are Gemma Desktop\'s internal audio-to-text reader.',
            'Listen faithfully and return the spoken content as plain text.',
            'If there is no speech, describe the important audible content briefly as plain text.',
          ].join('\n')
        : [
            'You are Gemma Desktop\'s internal image-to-text reader.',
            'Read visible text faithfully.',
            'If the image has little text, return a concise plain-text description of the important visible content.',
          ].join('\n'),
    sessionInput: input.kind === 'audio'
      ? [
          { type: 'text', text: `Audio file: ${input.file.name}\nRead this file into plain text.` },
          { type: 'audio_url', url: input.file.fileUrl, mediaType: input.file.mediaType },
        ]
      : [
          { type: 'text', text: `Image file: ${input.file.name}\nRead this image into plain text.` },
          { type: 'image_url', url: input.file.fileUrl, mediaType: input.file.mediaType },
        ],
  })
  const extractedText =
    toTrimmedString(workerResult.structuredOutput.text)
    ?? toTrimmedString(workerResult.outputText)
    ?? ''
  if (!extractedText) {
    throw new Error(`Gemma Desktop could not extract readable text from ${input.file.name}.`)
  }

  emitSmartFileReadProgress(input.onProgress, {
    id: `${input.kind}-write-cache`,
    label: `Caching ${input.kind} text`,
  })
  await fs.writeFile(textPath, extractedText, 'utf8')
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      version: SMART_FILE_READ_CACHE_VERSION,
      sourcePath: input.file.path,
      helperModelId: input.worker.modelId,
      helperRuntimeId: input.worker.runtimeId,
      kind: input.kind,
    }, null, 2),
    'utf8',
  )

  return {
    textPath,
    helperModelId: input.worker.modelId,
    helperRuntimeId: input.worker.runtimeId,
    cacheHit: false,
  }
}

async function runMultimodalFileWorkerSession(input: {
  worker: FileWorkerCapabilitySnapshot
  workingDirectory: string
  systemInstructions: string
  sessionInput: SessionInput
  responseFormat?: StructuredOutputSpec
  signal?: AbortSignal
  sessionMetadata?: Record<string, unknown>
}): Promise<MultimodalFileWorkerResult> {
  const leaseId = `file-worker-${Date.now()}-${randomUUID()}`
  const releaseLease = await acquirePrimaryModelLease(leaseId, {
    modelId: input.worker.modelId,
    runtimeId: input.worker.runtimeId,
  })

  try {
    const workerSession = await gemmaDesktop.sessions.create({
      runtime: input.worker.runtimeId,
      model: input.worker.modelId,
      mode: 'minimal',
      workingDirectory: input.workingDirectory,
      systemInstructions: input.systemInstructions,
      metadata: {
        ...(await buildPdfWorkerSessionMetadata({
          modelId: input.worker.modelId,
          runtimeId: input.worker.runtimeId,
        })),
        ...(input.sessionMetadata ?? {}),
      },
    })
    const result = await workerSession.run(input.sessionInput, {
      maxSteps: 1,
      responseFormat: input.responseFormat,
      signal: input.signal,
    })
    return {
      structuredOutput:
        result.structuredOutput && typeof result.structuredOutput === 'object'
          ? result.structuredOutput as Record<string, unknown>
          : {},
      outputText: result.text,
    }
  } finally {
    releaseLease()
  }
}

async function distillMemoryNote(input: {
  rawInput: string
  sessionId?: string
}): Promise<string> {
  const snapshot = input.sessionId
    ? await resolveKnownSessionSnapshot(input.sessionId)
    : undefined
  if (!snapshot) {
    return ''
  }

  const leaseId = `memory-distiller-${Date.now()}-${randomUUID()}`
  const releaseLease = await acquirePrimaryModelLease(leaseId, {
    modelId: snapshot.modelId,
    runtimeId: snapshot.runtimeId,
  })

  try {
    const distillerSession = await gemmaDesktop.sessions.create({
      runtime: snapshot.runtimeId,
      model: snapshot.modelId,
      mode: 'minimal',
      workingDirectory: snapshot.workingDirectory,
      systemInstructions: USER_MEMORY_DISTILLER_SYSTEM_PROMPT,
      metadata: {
        session_role: 'memory_distiller',
      },
    })
    const result = await distillerSession.run(
      [{ type: 'text', text: buildMemoryDistillerUserPrompt(input.rawInput) }],
      { maxSteps: 1 },
    )
    return postProcessDistilledNote(result.text ?? '')
  } finally {
    releaseLease()
  }
}

function toTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function toTrimmedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function estimateTextTokens(text: string): number {
  return Math.max(Math.ceil(text.trim().length / 4), 0)
}

function truncateTextToApproxTokens(text: string, tokenBudget: number): string {
  const trimmed = text.trim()
  if (!trimmed || tokenBudget <= 0) {
    return ''
  }

  if (estimateTextTokens(trimmed) <= tokenBudget) {
    return trimmed
  }

  const charBudget = Math.max(tokenBudget * 4, 512)
  const truncated = trimmed.slice(0, charBudget)
  const breakCandidates = [
    truncated.lastIndexOf('\n\n'),
    truncated.lastIndexOf('\n'),
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf(' '),
  ].filter((value) => value >= Math.floor(charBudget * 0.6))
  const cutIndex = breakCandidates.length > 0
    ? Math.max(...breakCandidates)
    : truncated.length

  return `${truncated.slice(0, cutIndex).trim()}\n\n[Truncated by Gemma Desktop to stay within the current model context budget.]`
}

function chunkPdfPagesByTokenBudget(
  pages: PdfDerivedPageRecord[],
  maxTokensPerChunk: number,
): PdfDerivedPageRecord[][] {
  if (pages.length === 0) {
    return []
  }

  const safeBudget = Math.max(maxTokensPerChunk, 1_500)
  const chunks: PdfDerivedPageRecord[][] = []
  let currentChunk: PdfDerivedPageRecord[] = []
  let currentTokens = 0

  for (const page of pages) {
    const pageTokens = Math.max(estimateTextTokens(page.markdown), 200)
    if (currentChunk.length > 0 && currentTokens + pageTokens > safeBudget) {
      chunks.push(currentChunk)
      currentChunk = []
      currentTokens = 0
    }
    currentChunk.push(page)
    currentTokens += pageTokens
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

async function runPdfPageExtractionSession(input: {
  fileName: string
  pageNumber: number
  pageImageUrl: string
  worker: FileWorkerCapabilitySnapshot
  sessionMetadata?: Record<string, unknown>
  workingDirectory: string
  signal?: AbortSignal
}): Promise<PdfDerivedPageRecord> {
  const result = await runMultimodalFileWorkerSession({
    worker: input.worker,
    workingDirectory: input.workingDirectory,
    sessionMetadata: input.sessionMetadata,
    signal: input.signal,
    responseFormat: PDF_PAGE_EXTRACTION_RESPONSE_FORMAT,
    systemInstructions: [
      'You are Gemma Desktop\'s internal PDF page extraction worker.',
      'You will receive exactly one rendered PDF page image.',
      'Extract the visible content faithfully into markdown.',
      'Preserve headings, lists, tables, labels, formulas, and figure captions when they are visible.',
      'Do not summarize across pages and do not omit text just because it looks repetitive.',
      'If the page is mostly visual or has little readable text, say that plainly in the markdown.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `PDF: ${input.fileName}`,
          `Page: ${input.pageNumber}`,
          'Extract this page into faithful markdown.',
        ].join('\n'),
      },
      {
        type: 'image_url',
        url: input.pageImageUrl,
        mediaType: 'image/png',
      },
    ],
  })

  const markdown =
    toTrimmedString(result.structuredOutput.markdown)
    ?? toTrimmedString(result.outputText)
    ?? 'No readable content could be extracted from this page.'

  return {
    pageNumber: input.pageNumber,
    markdown,
    warnings: toTrimmedStringArray(result.structuredOutput.warnings),
  }
}

async function runPdfChunkSummarySession(input: {
  fileName: string
  goal: string
  chunkPages: PdfDerivedPageRecord[]
  worker: FileWorkerCapabilitySnapshot
  sessionMetadata?: Record<string, unknown>
  workingDirectory: string
  signal?: AbortSignal
}): Promise<{
  summary: string
  evidence: string[]
  warnings: string[]
}> {
  const chunkText = input.chunkPages
    .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown}`)
    .join('\n\n')
  const result = await runMultimodalFileWorkerSession({
    worker: input.worker,
    workingDirectory: input.workingDirectory,
    sessionMetadata: input.sessionMetadata,
    signal: input.signal,
    responseFormat: PDF_CHUNK_SUMMARY_RESPONSE_FORMAT,
    systemInstructions: [
      'You are Gemma Desktop\'s internal PDF chunk synthesis worker.',
      'You will receive extracted markdown from a contiguous chunk of PDF pages.',
      'Produce a compact chunk summary grounded only in the provided text.',
      'Surface important facts, labels, and caveats that later synthesis should keep.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `PDF: ${input.fileName}`,
          `Goal: ${input.goal}`,
          `Chunk page range: ${input.chunkPages[0]?.pageNumber ?? 0}-${input.chunkPages[input.chunkPages.length - 1]?.pageNumber ?? 0}`,
          'Chunk markdown:',
          chunkText,
        ].join('\n\n'),
      },
    ],
  })

  return {
    summary:
      toTrimmedString(result.structuredOutput.summary)
      ?? toTrimmedString(result.outputText)
      ?? 'Chunk processed.',
    evidence: toTrimmedStringArray(result.structuredOutput.evidence),
    warnings: toTrimmedStringArray(result.structuredOutput.warnings),
  }
}

async function runPdfAttachmentSynthesisSession(input: {
  fileName: string
  goal: string
  pageCount: number
  promptTokenBudget: number
  synthesisSourceText: string
  worker: FileWorkerCapabilitySnapshot
  sessionMetadata?: Record<string, unknown>
  workingDirectory: string
  signal?: AbortSignal
}): Promise<{
  summary: string
  promptText: string
  evidence: string[]
  warnings: string[]
}> {
  const result = await runMultimodalFileWorkerSession({
    worker: input.worker,
    workingDirectory: input.workingDirectory,
    sessionMetadata: input.sessionMetadata,
    signal: input.signal,
    responseFormat: PDF_ATTACHMENT_SYNTHESIS_RESPONSE_FORMAT,
    systemInstructions: [
      'You are Gemma Desktop\'s internal PDF attachment synthesis worker.',
      'You will receive extracted PDF content or chunk summaries.',
      'Prepare a compact, high-signal payload for a parent chat turn.',
      'The promptText must stay within the requested token budget and should preserve the most relevant details for later conversation.',
      'Prefer faithful compression over broad paraphrase.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `PDF: ${input.fileName}`,
          `Goal: ${input.goal}`,
          `Total pages: ${input.pageCount}`,
          `Maximum prompt budget: about ${input.promptTokenBudget} tokens.`,
          'Return:',
          '- summary: a short user-facing overview',
          '- promptText: a compact parent-turn payload within budget',
          '- evidence: short bullets for key supporting facts',
          '- warnings: any important caveats',
          '',
          'Source material:',
          input.synthesisSourceText,
        ].join('\n'),
      },
    ],
  })

  return {
    summary:
      toTrimmedString(result.structuredOutput.summary)
      ?? 'PDF prepared.',
    promptText:
      truncateTextToApproxTokens(
        toTrimmedString(result.structuredOutput.promptText)
        ?? toTrimmedString(result.outputText)
        ?? '',
        input.promptTokenBudget,
      ),
    evidence: toTrimmedStringArray(result.structuredOutput.evidence),
    warnings: toTrimmedStringArray(result.structuredOutput.warnings),
  }
}

async function derivePdfArtifact(input: {
  file: ResolvedInspectableFile
  goal: string
  worker: FileWorkerCapabilitySnapshot
  contextLength: number
  promptTokenBudget: number
  processedRange?: { startPage: number; endPage: number }
  renderedPages?: Array<{ path: string; fileUrl?: string; pageNumber?: number }>
  pageCount?: number
  batchCount?: number
  artifactDirectory?: string
  sessionMetadata?: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (progress:
    | { stage: 'start'; pageCount: number; renderedPageCount: number }
    | { stage: 'page'; pageNumber: number; totalPages: number }
    | { stage: 'chunk'; chunkIndex: number; chunkCount: number }
    | { stage: 'synthesis' }
    | { stage: 'complete'; promptTokenEstimate: number }) => void
}): Promise<PdfDerivationResult> {
  if (!input.worker.imageSupported) {
    throw new Error('This session model is not marked as vision-capable, so PDF preparation is unavailable.')
  }

  const pageCount = input.pageCount ?? (await inspectPdfDocument(input.file.path)).pageCount
  const processedRange = input.processedRange ?? {
    startPage: 1,
    endPage: pageCount,
  }

  let renderedPages = input.renderedPages?.map((page, index) => ({
    pageNumber: page.pageNumber ?? (processedRange.startPage + index),
    fileUrl: page.fileUrl ?? pathToFileURL(page.path).toString(),
    path: page.path,
  }))
  let temporaryRenderDirectory: string | undefined

  if (!renderedPages || renderedPages.length === 0) {
    temporaryRenderDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-pdf-derive-'))
    const rendered = await renderPdfPages({
      path: input.file.path,
      startPage: processedRange.startPage,
      endPage: processedRange.endPage,
      scale: PDF_RENDER_SCALE,
      outputDir: temporaryRenderDirectory,
      filenamePrefix: 'page',
    })
    renderedPages = rendered.map((page) => ({
      pageNumber: page.pageNumber,
      fileUrl: pathToFileURL(page.path).toString(),
      path: page.path,
    }))
  }

  try {
    input.onProgress?.({
      stage: 'start',
      pageCount,
      renderedPageCount: renderedPages.length,
    })

    const pages: PdfDerivedPageRecord[] = []
    for (const renderedPage of renderedPages) {
      const page = await runPdfPageExtractionSession({
        fileName: input.file.name,
        pageNumber: renderedPage.pageNumber,
        pageImageUrl: renderedPage.fileUrl,
        worker: input.worker,
        sessionMetadata: input.sessionMetadata,
        workingDirectory: path.dirname(input.file.path),
        signal: input.signal,
      })
      pages.push(page)
      input.onProgress?.({
        stage: 'page',
        pageNumber: renderedPage.pageNumber,
        totalPages: renderedPages.length,
      })
    }

    const combinedMarkdown = pages
      .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown}`)
      .join('\n\n')

    const synthesisInputTokenBudget = Math.max(
      Math.floor(input.contextLength * 0.5),
      8_000,
    )
    const pageWarnings = pages.flatMap((page) => page.warnings)
    let synthesisSourceText = combinedMarkdown
    let synthesisWarnings = [...pageWarnings]
    let synthesisEvidence: string[] = []

    if (estimateTextTokens(combinedMarkdown) > synthesisInputTokenBudget) {
      const chunks = chunkPdfPagesByTokenBudget(
        pages,
        Math.max(Math.floor(synthesisInputTokenBudget * 0.7), 4_000),
      )
      const chunkSummaries: string[] = []

      for (const [index, chunkPages] of chunks.entries()) {
        input.onProgress?.({
          stage: 'chunk',
          chunkIndex: index + 1,
          chunkCount: chunks.length,
        })
        const chunkResult = await runPdfChunkSummarySession({
          fileName: input.file.name,
          goal: input.goal,
          chunkPages,
          worker: input.worker,
          sessionMetadata: input.sessionMetadata,
          workingDirectory: path.dirname(input.file.path),
          signal: input.signal,
        })
        chunkSummaries.push(
          [
            `### Pages ${chunkPages[0]?.pageNumber ?? 0}-${chunkPages[chunkPages.length - 1]?.pageNumber ?? 0}`,
            chunkResult.summary,
            chunkResult.evidence.length > 0
              ? ['Evidence:', ...chunkResult.evidence.map((entry) => `- ${entry}`)].join('\n')
              : '',
          ].filter(Boolean).join('\n\n'),
        )
        synthesisWarnings = [...synthesisWarnings, ...chunkResult.warnings]
        synthesisEvidence = [...synthesisEvidence, ...chunkResult.evidence]
      }

      synthesisSourceText = [
        'Full extracted text was larger than one clean synthesis pass, so Gemma Desktop summarized it in chunks first.',
        ...chunkSummaries,
      ].join('\n\n')
    }

    input.onProgress?.({ stage: 'synthesis' })
    const synthesis = await runPdfAttachmentSynthesisSession({
      fileName: input.file.name,
      goal: input.goal,
      pageCount,
      promptTokenBudget: input.promptTokenBudget,
      synthesisSourceText,
      worker: input.worker,
      sessionMetadata: input.sessionMetadata,
      workingDirectory: path.dirname(input.file.path),
      signal: input.signal,
    })

    const promptTokenEstimate = estimateTextTokens(synthesis.promptText)
    input.onProgress?.({
      stage: 'complete',
      promptTokenEstimate,
    })

    let artifactPath: string | undefined
    let textPath: string | undefined

    if (input.artifactDirectory) {
      await fs.mkdir(input.artifactDirectory, { recursive: true })
      textPath = path.join(input.artifactDirectory, 'document.md')
      artifactPath = path.join(input.artifactDirectory, 'document.json')

      const artifactRecord: PdfDerivedArtifactRecord = {
        sourceName: input.file.name,
        sourcePath: input.file.path,
        pageCount,
        processedRange,
        derivedAt: new Date().toISOString(),
        worker: {
          modelId: input.worker.modelId,
          runtimeId: input.worker.runtimeId,
        },
        goal: input.goal,
        summary: synthesis.summary,
        promptText: synthesis.promptText,
        promptTokenEstimate,
        evidence: synthesis.evidence,
        warnings: [...synthesisWarnings, ...synthesis.warnings],
        pages,
      }

      await fs.writeFile(
        textPath,
        [
          `# ${input.file.name}`,
          '',
          `Processed pages: ${processedRange.startPage}-${processedRange.endPage} of ${pageCount}`,
          '',
          '## Summary',
          '',
          synthesis.summary,
          '',
          '## Extracted Content',
          '',
          ...pages.map((page) => `### Page ${page.pageNumber}\n\n${page.markdown}`),
        ].join('\n'),
        'utf8',
      )
      await fs.writeFile(
        artifactPath,
        JSON.stringify(artifactRecord, null, 2),
        'utf8',
      )
    }

    return {
      artifactPath,
      textPath,
      summary: synthesis.summary,
      promptText: synthesis.promptText,
      promptTokenEstimate,
      evidence: synthesisEvidence.length > 0
        ? synthesisEvidence
        : synthesis.evidence,
      warnings: [...synthesisWarnings, ...synthesis.warnings],
      pageCount,
      batchCount: input.batchCount ?? 1,
      pages,
    }
  } finally {
    if (temporaryRenderDirectory) {
      await fs.rm(temporaryRenderDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function buildPdfWorkerSessionMetadata(
  workerTarget: PrimaryModelTarget,
): Promise<Record<string, unknown>> {
  const currentSettings = await getSettingsState()

  return withResolvedRequestPreferencesMetadata(
    createSessionMetadata(
      null,
      normalizeSessionConfig({
        baseMode: 'explore',
        conversationKind: 'normal',
        planMode: false,
        preferredRuntimeId: workerTarget.runtimeId,
        selectedSkillIds: [],
        selectedSkillNames: [],
        selectedToolIds: [],
        selectedToolNames: [],
        surface: 'default',
        visibility: 'visible',
        storageScope: 'project',
      }),
    ),
    currentSettings,
    {
      modelId: workerTarget.modelId,
      runtimeId: workerTarget.runtimeId,
    },
  ) ?? {}
}

async function resolveKnownSessionSnapshot(
  sessionId: string,
): Promise<SessionSnapshot | undefined> {
  return (
    liveSessions.get(sessionId)?.snapshot()
    ?? store.getSnapshot(sessionId)
    ?? (await getPersistedSession(sessionId))?.snapshot
  )
}

async function derivePersistedPdfAttachmentForTurn(input: {
  attachment: PersistedPdfAttachment
  goal: string
  worker: FileWorkerCapabilitySnapshot
  contextLength: number
  promptTokenBudget: number
  sessionMetadata?: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: Parameters<typeof derivePdfArtifact>[0]['onProgress']
}): Promise<PersistedPdfAttachment> {
  const artifactDirectory = path.join(
    path.dirname(input.attachment.path),
    `${path.basename(input.attachment.path, path.extname(input.attachment.path))}-derived-${Date.now()}`,
  )

  try {
    const attachmentStats = await fs.stat(input.attachment.path)
    const derived = await derivePdfArtifact({
      file: {
        path: input.attachment.path,
        fileUrl: input.attachment.fileUrl,
        name: input.attachment.name,
        mediaType: input.attachment.mediaType,
        kind: 'pdf',
        size: input.attachment.size,
        modifiedAtMs: attachmentStats.mtimeMs,
      },
      goal: input.goal,
      worker: input.worker,
      contextLength: input.contextLength,
      promptTokenBudget: input.promptTokenBudget,
      processedRange: input.attachment.processedRange,
      renderedPages: input.attachment.renderedPages.map((page, index) => ({
        path: page.path,
        fileUrl: page.fileUrl,
        pageNumber: input.attachment.processedRange.startPage + index,
      })),
      pageCount: input.attachment.pageCount,
      batchCount: input.attachment.batchCount,
      artifactDirectory,
      sessionMetadata: input.sessionMetadata,
      signal: input.signal,
      onProgress: input.onProgress,
    })

    return {
      ...input.attachment,
      derivedArtifactPath: derived.artifactPath,
      derivedTextPath: derived.textPath,
      derivedSummary: derived.summary,
      derivedPromptText: derived.promptText,
      derivedPromptTokenEstimate: derived.promptTokenEstimate,
      derivedByModelId: input.worker.modelId,
      derivedByRuntimeId: input.worker.runtimeId,
      batchCount: derived.batchCount,
    }
  } catch (error) {
    await fs.rm(artifactDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function buildCompactionCompletedMessage(result: {
  historyCount: number
  originalMessageCount?: number
}): AppMessage {
  const summaryParts = [
    'Session compaction completed.',
    `Model-visible history now includes ${result.historyCount} message${result.historyCount === 1 ? '' : 's'}.`,
  ]

  if (typeof result.originalMessageCount === 'number') {
    summaryParts.push(
      `Previous window: ${result.originalMessageCount} message${result.originalMessageCount === 1 ? '' : 's'}.`,
    )
  }

  return {
    id: `system-compact-${Date.now()}-${randomUUID()}`,
    role: 'system',
    content: [
      {
        type: 'text',
        text: summaryParts.join(' '),
      },
    ],
    timestamp: Date.now(),
  }
}

async function maybeGenerateAutoSessionTitle(input: {
  sessionId: string
  snapshot: SessionSnapshot
  promptText: string
  fallbackSummary: string
}): Promise<void> {
  if (isTalkSessionSnapshot(input.snapshot)) {
    return
  }

  const meta = store.getMeta(input.sessionId)
  if (
    !meta
    || meta.titleSource === 'user'
    || meta.title !== PLACEHOLDER_SESSION_TITLE
  ) {
    return
  }

  const userMessageCount = store.getAppMessages(input.sessionId)
    .filter((message) => message.role === 'user')
    .length

  if (userMessageCount !== 1) {
    return
  }

  const promptSeed = input.promptText.trim() || input.fallbackSummary.trim()
  if (!promptSeed) {
    return
  }

  const titleTask = buildAutoSessionTitleTask({
    conversationKind: getSessionConfig(input.snapshot).conversationKind,
    promptSeed,
  })

  try {
    const result = await runHelperStructuredTask({
      ownerId: input.sessionId,
      sessionRole: 'session_title',
      workingDirectory: input.snapshot.workingDirectory,
      systemInstructions: titleTask.systemInstructions,
      responseFormat: SESSION_TITLE_RESPONSE_FORMAT,
      sessionInput: titleTask.sessionInput,
    })

    const nextTitle =
      normalizeGeneratedSessionTitle(
        result.structuredOutput,
        titleTask.fallbackMaxWords,
      )
      ?? buildFallbackSessionTitle(promptSeed, titleTask.fallbackMaxWords)
    if (!nextTitle) {
      return
    }

    const latestMeta = store.getMeta(input.sessionId)
    if (
      !latestMeta
      || latestMeta.titleSource === 'user'
      || latestMeta.title !== PLACEHOLDER_SESSION_TITLE
    ) {
      return
    }

    const live = liveSessions.get(input.sessionId)
    const persisted = live ? null : await getPersistedSession(input.sessionId)
    const snapshot = live?.snapshot() ?? persisted?.snapshot
    if (!snapshot) {
      return
    }

    await store.save(
      input.sessionId,
      snapshot,
      {
        title: nextTitle,
        titleSource: 'auto',
      },
      undefined,
      { preserveUpdatedAt: true },
    )
    await broadcastSessionsChanged()
  } catch (error) {
    const fallbackTitle = buildFallbackSessionTitle(
      promptSeed,
      titleTask.fallbackMaxWords,
    )
    if (fallbackTitle) {
      const latestMeta = store.getMeta(input.sessionId)
      if (
        latestMeta
        && latestMeta.titleSource !== 'user'
        && latestMeta.title === PLACEHOLDER_SESSION_TITLE
      ) {
        const live = liveSessions.get(input.sessionId)
        const persisted = live ? null : await getPersistedSession(input.sessionId)
        const snapshot = live?.snapshot() ?? persisted?.snapshot
        if (snapshot) {
          await store.save(
            input.sessionId,
            snapshot,
            {
              title: fallbackTitle,
              titleSource: 'auto',
            },
            undefined,
            { preserveUpdatedAt: true },
          )
          await broadcastSessionsChanged()
          return
        }
      }
    }

    console.warn(
      '[gemma-desktop] Auto title generation failed; keeping the existing placeholder title.',
      {
        sessionId: input.sessionId,
        modelId: input.snapshot.modelId,
        runtimeId: input.snapshot.runtimeId,
        workingDirectory: input.snapshot.workingDirectory,
        promptSeedLength: promptSeed.length,
        nonFatal: true,
        timeoutLike: isTitleGenerationTimeoutError(error),
      },
      error,
    )
  }
}

function summarizeHeartbeatContentBlocks(
  content: Array<Record<string, unknown>>,
): string {
  const parts: string[] = []

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
      continue
    }

    if (block.type === 'thinking' && typeof block.summary === 'string' && block.summary.trim()) {
      parts.push(`[thinking] ${block.summary.trim()}`)
      continue
    }

    if (block.type === 'error' && typeof block.message === 'string') {
      parts.push(`[error] ${block.message.trim()}`)
      continue
    }

    if (block.type === 'warning' && typeof block.message === 'string') {
      parts.push(`[warning] ${block.message.trim()}`)
      continue
    }

    if (block.type === 'tool_call' && typeof block.toolName === 'string') {
      const summary =
        typeof block.summary === 'string' && block.summary.trim().length > 0
          ? block.summary.trim()
          : typeof block.output === 'string' && block.output.trim().length > 0
            ? block.output.trim()
            : 'tool activity'
      parts.push(`[tool:${block.toolName}] ${summary}`)
      continue
    }
  }

  const joined = parts.join('\n').trim()
  if (!joined) {
    return '[no visible content]'
  }

  return joined.slice(0, 1_200)
}

function buildAssistantHeartbeatConversationContext(
  sessionId: string,
  snapshot: SessionSnapshot,
): string {
  const messages = buildSessionDetailMessages(
    snapshot,
    store.getAppMessages(sessionId),
  ).slice(-6)

  return messages
    .map((message) => [
      `${message.role.toUpperCase()}:`,
      summarizeHeartbeatContentBlocks(
        message.content as Array<Record<string, unknown>>,
      ),
    ].join('\n'))
    .join('\n\n')
    .trim()
}

function summarizeToolResultsForHeartbeat(toolResults: ToolResult[]): string {
  if (toolResults.length === 0) {
    return 'No tools were used in the final turn.'
  }

  return toolResults
    .map((toolResult) => {
      const outputPreview = toolResult.output.trim().slice(0, 240)
      const status = isErroredToolResult(toolResult) ? 'error' : 'success'
      return [
        `- ${toolResult.toolName} (${status})`,
        outputPreview ? `  ${outputPreview}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
}

function summarizeFailedTurnBlocksForRecovery(
  content: Array<Record<string, unknown>>,
): string {
  const parts: string[] = []

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(`[assistant] ${block.text.trim().slice(0, 900)}`)
      continue
    }

    if (block.type === 'thinking' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(`[thinking] ${truncateTextToApproxTokens(block.text, 220)}`)
      continue
    }

    if (block.type === 'error' && typeof block.message === 'string') {
      parts.push(`[error] ${block.message.trim().slice(0, 700)}`)
      continue
    }

    if (block.type === 'warning' && typeof block.message === 'string') {
      parts.push(`[warning] ${block.message.trim().slice(0, 700)}`)
      continue
    }

    if (block.type === 'tool_call' && typeof block.toolName === 'string') {
      const input = normalizeUnknownRecord(block.input)
      const inputHints = Object.entries(input)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${String(value).slice(0, 240)}`)
        .join(', ')
      const status = typeof block.status === 'string' ? block.status : 'unknown'
      const output =
        typeof block.output === 'string' && block.output.trim().length > 0
          ? block.output.trim().slice(0, 900)
          : 'no output captured'
      parts.push([
        `[tool:${block.toolName}] status=${status}`,
        inputHints ? `input: ${inputHints}` : null,
        `output: ${output}`,
      ].filter(Boolean).join('\n'))
    }
  }

  const joined = parts.join('\n\n').trim()
  return joined.length > 0 ? joined.slice(0, 6_000) : '[no failed turn content]'
}

async function auditAssistantTurnWithHelper(input: {
  sessionId: string
  workingDirectory: string
  snapshot: SessionSnapshot
  userPrompt: string
  assistantText: string
  reasoningText: string
  toolResults: ToolResult[]
  signal?: AbortSignal
}): Promise<{
  decision: ReturnType<typeof normalizeAssistantHeartbeatDecision>
  helperModelId: string
  helperRuntimeId: string
}> {
  const conversationContext = buildAssistantHeartbeatConversationContext(
    input.sessionId,
    input.snapshot,
  )
  const result = await runHelperStructuredTask({
    ownerId: `${input.sessionId}-turn-audit`,
    sessionRole: 'assistant_turn_audit',
    workingDirectory: input.workingDirectory,
    signal: input.signal,
    responseFormat: ASSISTANT_TURN_AUDIT_RESPONSE_FORMAT,
    systemInstructions: [
      'You are Gemma Desktop\'s hidden Assistant Chat turn auditor.',
      'You inspect a just-finished assistant turn and decide whether the user already got a solid completion.',
      'Choose exactly one action:',
      '- noop: the assistant already completed the turn well enough.',
      '- complete: the assistant got somewhere useful but failed to give a crisp final user-facing completion message. Write that missing completion message.',
      '- restart: the assistant gave up too early, stopped on next-step narration, or should continue immediately with one focused hidden instruction. Write a short imperative restart instruction for the primary assistant.',
      'Prefer complete over restart when a concise user-facing message can finish the turn safely.',
      'Prefer noop when the visible answer is already good.',
      'Never mention auditing, helper models, or hidden instructions in completionMessage.',
      'restartInstruction must be a hidden steer for the primary assistant, not a user-facing answer.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `Recent conversation:\n${conversationContext || '[no conversation context]'}`,
          `Latest user message:\n${input.userPrompt.trim().slice(0, 800) || '[no prompt text]'}`,
          `Latest assistant visible text:\n${input.assistantText.trim() || '[none]'}`,
          `Latest assistant reasoning excerpt:\n${truncateTextToApproxTokens(input.reasoningText, 500) || '[none]'}`,
          `Latest tool activity:\n${summarizeToolResultsForHeartbeat(input.toolResults)}`,
          'Return the best action now.',
        ].join('\n\n'),
      },
    ],
  })

  return {
    decision: normalizeAssistantHeartbeatDecision(result.structuredOutput),
    helperModelId: result.helperModelId,
    helperRuntimeId: result.helperRuntimeId,
  }
}

async function recoverFailedAssistantTurnWithHelper(input: {
  sessionId: string
  workingDirectory: string
  snapshot: SessionSnapshot
  userPrompt: string
  errorMessage: string
  content: Array<Record<string, unknown>>
  signal?: AbortSignal
}): Promise<{
  completionMessage: string
  helperModelId: string
  helperRuntimeId: string
}> {
  const conversationContext = buildAssistantHeartbeatConversationContext(
    input.sessionId,
    input.snapshot,
  )
  const result = await runHelperStructuredTask({
    ownerId: `${input.sessionId}-turn-recovery`,
    sessionRole: 'assistant_turn_recovery',
    workingDirectory: input.workingDirectory,
    signal: input.signal,
    responseFormat: ASSISTANT_TURN_RECOVERY_RESPONSE_FORMAT,
    systemInstructions: [
      'You are Gemma Desktop\'s hidden Assistant Chat failed-turn recovery agent.',
      'The primary assistant turn failed after doing some visible work.',
      'Write one concise user-facing completion message that helps the user understand the useful evidence and the blocker.',
      'Use only the conversation, failed turn transcript, tool outputs, and error string provided to you.',
      'Do not pretend unverified facts are verified.',
      'Be specific about what was confirmed, what could not be confirmed, and why the turn stopped.',
      'Do not mention helper models, hidden recovery, JSON, or internal event names.',
      'Translate technical errors into plain language unless the exact error text is useful to the user.',
    ].join('\n'),
    sessionInput: [
      {
        type: 'text',
        text: [
          `Recent conversation:\n${conversationContext || '[no conversation context]'}`,
          `Latest user message:\n${input.userPrompt.trim().slice(0, 800) || '[no prompt text]'}`,
          `Primary turn error:\n${input.errorMessage.trim().slice(0, 1_000) || '[no error text]'}`,
          `Failed turn transcript:\n${summarizeFailedTurnBlocksForRecovery(input.content)}`,
          'Return only the best user-facing completionMessage.',
        ].join('\n\n'),
      },
    ],
  })
  const completionMessage =
    normalizeAssistantCompletionMessage(result.structuredOutput.completionMessage)
    ?? normalizeAssistantCompletionMessage(result.outputText)

  if (!completionMessage) {
    throw new Error('Helper did not produce a recovery completion message.')
  }

  return {
    completionMessage,
    helperModelId: result.helperModelId,
    helperRuntimeId: result.helperRuntimeId,
  }
}

function isTitleGenerationTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const stack = [error.message]
  const errorCode =
    'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (errorCode) {
    stack.push(errorCode)
  }

  const cause =
    'cause' in error && error.cause instanceof Error
      ? error.cause
      : undefined
  if (cause) {
    stack.push(cause.message)
    if ('code' in cause && typeof cause.code === 'string') {
      stack.push(cause.code)
    }
  }

  const haystack = stack.join('\n')
  return /Body Timeout Error|UND_ERR_BODY_TIMEOUT|terminated/i.test(haystack)
}

function extractPlannerSummaryFromText(text: string): string | undefined {
  return extractPlanSummaryFromText(text)
}

function extractPlannerDetailsFromText(text: string): string | undefined {
  return extractPlanDetailsFromText(text)
}

function extractPlannerSummaryFromAppMessages(messages: AppMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') {
      continue
    }

    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const summary = extractPlannerSummaryFromText(block.text)
        if (summary) {
          return summary
        }
      }
    }
  }

  return undefined
}

function extractPlannerDetailsFromAppMessages(messages: AppMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') {
      continue
    }

    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const details = extractPlannerDetailsFromText(block.text)
        if (details) {
          return details
        }
      }
    }
  }

  return undefined
}

function extractPlannerSummaryFromSnapshot(
  snapshot: SessionSnapshot,
): string | undefined {
  for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
    const message = snapshot.history[index]
    if (!message || message.role !== 'assistant') {
      continue
    }
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      continue
    }

    const compaction = message.metadata?.compaction as Record<string, unknown> | undefined
    if (compaction?.kind === 'summary') {
      continue
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        const summary = extractPlannerSummaryFromText(block.text)
        if (summary) {
          return summary
        }
      }
    }
  }

  return undefined
}

function extractPlannerDetailsFromSnapshot(
  snapshot: SessionSnapshot,
): string | undefined {
  for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
    const message = snapshot.history[index]
    if (!message || message.role !== 'assistant') {
      continue
    }
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      continue
    }

    const compaction = message.metadata?.compaction as Record<string, unknown> | undefined
    if (compaction?.kind === 'summary') {
      continue
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        const details = extractPlannerDetailsFromText(block.text)
        if (details) {
          return details
        }
      }
    }
  }

  return undefined
}

function normalizeComparablePlanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function mergePlanExitDetails(
  preferredDetails?: string,
  extractedDetails?: string,
): string | undefined {
  const normalizedPreferred = preferredDetails?.trim()
  const normalizedExtracted = extractedDetails?.trim()

  if (!normalizedPreferred) {
    return normalizedExtracted
  }

  if (!normalizedExtracted) {
    return normalizedPreferred
  }

  const comparablePreferred = normalizeComparablePlanText(normalizedPreferred)
  const comparableExtracted = normalizeComparablePlanText(normalizedExtracted)

  if (
    comparablePreferred.includes(comparableExtracted)
    || comparableExtracted.includes(comparablePreferred)
  ) {
    return normalizedPreferred.length >= normalizedExtracted.length
      ? normalizedPreferred
      : normalizedExtracted
  }

  if (normalizedPreferred.length <= 240 && normalizedExtracted.length > normalizedPreferred.length) {
    return `${normalizedExtracted}\n\nHandoff notes:\n${normalizedPreferred}`
  }

  return `${normalizedPreferred}\n\nApproved plan context from the planning chat:\n${normalizedExtracted}`
}

function buildSyntheticPlanExit(
  sessionId: string,
  snapshot: SessionSnapshot,
  trigger: 'blocked_build_tool',
  turnId?: string,
): PendingPlanExit | null {
  const summary =
    extractPlannerSummaryFromAppMessages(store.getAppMessages(sessionId))
    ?? extractPlannerSummaryFromSnapshot(snapshot)
  const extractedDetails =
    extractPlannerDetailsFromAppMessages(store.getAppMessages(sessionId))
    ?? extractPlannerDetailsFromSnapshot(snapshot)

  if (!summary) {
    return null
  }

  const createdAt = Date.now()
  return {
    id: randomUUID(),
    turnId,
    createdAt,
    workMode: getSessionConfig(snapshot).baseMode,
    summary,
    details: extractedDetails
      ? [
          extractedDetails,
          '',
          'Handoff notes:',
          '- Use the latest approved planning response in this session as the source of truth.',
          '- Switch this session back to work mode before implementing the plan.',
        ].join('\n')
      : [
          'Handoff notes:',
          '- Use the latest approved planning response in this session as the source of truth.',
          '- Switch this session back to work mode before implementing the plan.',
        ].join('\n'),
    source: 'synthetic',
    trigger,
    attentionToken: createdAt,
  }
}

function buildPlanExitPromptMessage(
  toolName?: string,
): AppMessage {
  const detail = toolName
    ? `Plan mode attempted ${toolName}, which is only available in build work mode.`
    : 'Plan mode is ready to switch back to work mode.'

  return {
    id: `system-plan-exec-${Date.now()}-${randomUUID()}`,
    role: 'system',
    content: [
      {
        type: 'warning',
        message: 'Plan is ready to switch back to work mode.',
      },
      {
        type: 'text',
        text: `${detail} Use the plan exit card below to continue in the underlying work mode.`,
      },
    ],
    timestamp: Date.now(),
  }
}

function buildPlanExitFallbackMessage(
  toolName?: string,
): AppMessage {
  const detail = toolName
    ? `Plan mode attempted ${toolName}, but there was not enough concrete plan context to prepare the work handoff automatically.`
    : 'There was not enough concrete planning output to prepare the work handoff automatically.'

  return {
    id: `system-plan-fallback-${Date.now()}-${randomUUID()}`,
    role: 'system',
    content: [
      {
        type: 'error',
        message: 'Plan mode could not prepare the work handoff yet.',
      },
      {
        type: 'text',
        text: `${detail} Ask the model to restate the implementation plan clearly, then try again.`,
      },
    ],
    timestamp: Date.now(),
  }
}

function reissuePendingPlanExit(
  pending: PendingPlanExit,
): PendingPlanExit {
  return {
    ...pending,
    source: pending.source ?? 'model',
    trigger: pending.trigger ?? 'exit_plan_mode',
    attentionToken: Date.now(),
  }
}

async function getPersistedSession(
  sessionId: string,
): Promise<PersistedSession | null> {
  return await store.load(sessionId)
}

async function getOrResumeLiveSession(sessionId: string): Promise<{
  session: GemmaDesktopSession
  persisted: PersistedSession | null
}> {
  let session = liveSessions.get(sessionId)
  let persisted = await getPersistedSession(sessionId)

  if (!session) {
    if (!persisted) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    persisted = await rehydratePersistedSession(sessionId, persisted)
    session = await gemmaDesktop.sessions.resume({
      snapshot: persisted.snapshot,
    })
    liveSessions.set(sessionId, session)
  } else {
    const refreshed = await ensureLiveSessionCurrent(sessionId, session, persisted)
    session = refreshed.session
    persisted = refreshed.persisted
  }

  return {
    session,
    persisted,
  }
}

async function ensureTalkSessionInternal(): Promise<Record<string, unknown>> {
  let persisted = await getPersistedSession(TALK_SESSION_ID)
  const talkConfig = buildTalkSessionConfig()
  const talkWorkingDirectory = await ensureDirectoryExists(
    getTalkSessionWorkspaceDirectory(app.getPath('userData')),
  )

  if (!persisted) {
    const bootstrap = await ensureBootstrapReady()
    if (!bootstrap.ready) {
      throw new Error(bootstrap.error ?? bootstrap.message)
    }

    const defaultTarget = buildDefaultSessionPrimaryTarget(talkConfig, settings)
    const composition = await resolveSessionComposition({
      snapshot: null,
      conversationKind: talkConfig.conversationKind,
      sessionMode: talkConfig.baseMode,
      planMode: talkConfig.planMode,
      modelId: defaultTarget.modelId,
      runtimeId: defaultTarget.runtimeId,
      preferredRuntimeId: defaultTarget.runtimeId,
      selectedSkillIds: [],
      selectedToolIds: [],
      surface: talkConfig.surface,
      visibility: talkConfig.visibility,
      storageScope: talkConfig.storageScope,
    })
    const createdSession = await gemmaDesktop.sessions.create({
      runtime: defaultTarget.runtimeId,
      model: defaultTarget.modelId,
      mode: composition.mode,
      workingDirectory: talkWorkingDirectory,
      systemInstructions: composition.systemInstructions,
      metadata: composition.metadata,
    })
    const initialSnapshot: SessionSnapshot = {
      ...createdSession.snapshot(),
      sessionId: TALK_SESSION_ID,
      savedAt: new Date().toISOString(),
    }
    const talkSession = await gemmaDesktop.sessions.resume({
      snapshot: initialSnapshot,
    })
    const talkMeta: SessionMeta = {
      id: TALK_SESSION_ID,
      title: TALK_SESSION_TITLE,
      titleSource: 'user',
      lastMessage: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionTags: [],
    }

    liveSessions.set(TALK_SESSION_ID, talkSession)
    await store.save(TALK_SESSION_ID, initialSnapshot, talkMeta, [])
    persisted = await getPersistedSession(TALK_SESSION_ID)
  }

  if (!persisted) {
    throw new Error('Assistant Chat could not be created.')
  }

  const { session, persisted: currentPersisted } = await getOrResumeLiveSession(
    TALK_SESSION_ID,
  )
  const effectivePersisted = currentPersisted ?? persisted
  const talkMeta = normalizeSessionMeta(TALK_SESSION_ID, {
    ...effectivePersisted.meta,
    title: TALK_SESSION_TITLE,
    titleSource: 'user',
  })
  let snapshot = session.snapshot()
  const currentConfig = getSessionConfig(snapshot)
  const reconciledComposition = await resolveSessionComposition({
    snapshot,
    conversationKind: talkConfig.conversationKind,
    sessionMode: talkConfig.baseMode,
    planMode: talkConfig.planMode,
    modelId: snapshot.modelId,
    runtimeId: snapshot.runtimeId,
    preferredRuntimeId: currentConfig.preferredRuntimeId,
    selectedSkillIds: talkConfig.selectedSkillIds,
    selectedToolIds: talkConfig.selectedToolIds,
    surface: talkConfig.surface,
    visibility: talkConfig.visibility,
    storageScope: talkConfig.storageScope,
  })

  if (
    snapshot.workingDirectory !== talkWorkingDirectory
    || snapshot.sessionId !== TALK_SESSION_ID
    || JSON.stringify(reconciledComposition.mode) !== JSON.stringify(snapshot.mode)
    || reconciledComposition.systemInstructions !== snapshot.systemInstructions
    || JSON.stringify(reconciledComposition.metadata ?? {}) !== JSON.stringify(snapshot.metadata ?? {})
  ) {
    const nextSnapshot: SessionSnapshot = {
      ...snapshot,
      sessionId: TALK_SESSION_ID,
      workingDirectory: talkWorkingDirectory,
      mode: reconciledComposition.mode,
      systemInstructions: reconciledComposition.systemInstructions,
      metadata: reconciledComposition.metadata,
      savedAt: new Date().toISOString(),
    }
    const nextSession = await gemmaDesktop.sessions.resume({
      snapshot: nextSnapshot,
    })
    liveSessions.set(TALK_SESSION_ID, nextSession)
    await store.save(
      TALK_SESSION_ID,
      nextSnapshot,
      talkMeta,
      store.getAppMessages(TALK_SESSION_ID),
      { preserveUpdatedAt: true },
    )
    snapshot = nextSnapshot
  }

  if (
    talkMeta.title !== effectivePersisted.meta.title
    || talkMeta.titleSource !== effectivePersisted.meta.titleSource
  ) {
    await store.save(
      TALK_SESSION_ID,
      snapshot,
      talkMeta,
      effectivePersisted.appMessages,
      { preserveUpdatedAt: true },
    )
  }

  return snapshotToDetail(
    snapshot,
    talkMeta,
    store.getDraftText(TALK_SESSION_ID),
    store.getAppMessages(TALK_SESSION_ID),
    store.getPendingTurn(TALK_SESSION_ID) ?? effectivePersisted.pendingTurn ?? null,
    store.getPendingCompaction(TALK_SESSION_ID)
      ?? effectivePersisted.pendingCompaction
      ?? null,
    store.getPendingPlanQuestion(TALK_SESSION_ID)
      ?? effectivePersisted.pendingPlanQuestion
      ?? null,
    store.getPendingPlanExit(TALK_SESSION_ID)
      ?? effectivePersisted.pendingPlanExit
      ?? null,
    store.getPendingToolApproval(TALK_SESSION_ID)
      ?? effectivePersisted.pendingToolApproval
      ?? null,
    getSessionExecutionTask(TALK_SESSION_ID) === 'generation',
    getSessionExecutionTask(TALK_SESSION_ID) === 'compaction',
  )
}

async function getSessionDetailInternal(
  sessionId: string,
): Promise<Record<string, unknown>> {
  let persisted = await store.load(sessionId)
  if (!persisted) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  let liveSession = liveSessions.get(sessionId) ?? null
  if (liveSession) {
    const refreshed = await ensureLiveSessionCurrent(
      sessionId,
      liveSession,
      persisted,
    )
    liveSession = refreshed.session
    persisted = refreshed.persisted ?? persisted
  } else {
    persisted = await rehydratePersistedSession(sessionId, persisted)
  }

  const snapshot = liveSession?.snapshot() ?? persisted.snapshot
  const pendingTurn = store.getPendingTurn(sessionId) ?? persisted.pendingTurn ?? null
  const activeTask = getSessionExecutionTask(sessionId)
  const pendingCompaction =
    store.getPendingCompaction(sessionId)
    ?? persisted.pendingCompaction
    ?? null

  return snapshotToDetail(
    snapshot,
    persisted.meta,
    store.getDraftText(sessionId),
    persisted.appMessages,
    pendingTurn,
    pendingCompaction,
    store.getPendingPlanQuestion(sessionId) ?? persisted.pendingPlanQuestion ?? null,
    store.getPendingPlanExit(sessionId) ?? persisted.pendingPlanExit ?? null,
    store.getPendingToolApproval(sessionId) ?? persisted.pendingToolApproval ?? null,
    activeTask === 'generation',
    activeTask === 'compaction',
  )
}

async function warmSelectedSessionPrimary(sessionId: string): Promise<void> {
  const liveSession = liveSessions.get(sessionId)
  const persisted = liveSession ? null : await store.load(sessionId)
  const snapshot = liveSession?.snapshot() ?? persisted?.snapshot
  if (!snapshot || isHiddenSessionSnapshot(snapshot)) {
    return
  }

  const currentSettings = await getSettingsState()
  const target = {
    modelId: snapshot.modelId,
    runtimeId: snapshot.runtimeId,
  }

  if (!shouldWarmModelTarget(currentSettings, target)) {
    return
  }

  await ensurePrimaryModelTargetLoaded(target).catch((error) =>
    handleOptionalPrimaryWarmupFailure(target, error, `selected-session:${sessionId}`),
  )
}

function scheduleSelectedSessionPrimaryWarmup(sessionId: string): void {
  void warmSelectedSessionPrimary(sessionId).catch((error) => {
    console.warn(
      `[gemma-desktop] Failed to warm selected session primary model for ${sessionId}:`,
      error,
    )
  })
}

async function clearTalkSessionInternal(): Promise<Record<string, unknown>> {
  if (isSessionExecutionBusy(TALK_SESSION_ID)) {
    throw new Error('Cannot clear Assistant Chat while it is running.')
  }

  liveSessions.delete(TALK_SESSION_ID)
  await store.remove(TALK_SESSION_ID)
  await ensureTalkSessionInternal()
  const detail = await getSessionDetailInternal(TALK_SESSION_ID)
  sendToSession(TALK_SESSION_ID, {
    type: 'session_reset',
    session: detail,
  })
  await broadcastSessionsChanged()
  return detail
}

async function runSessionCompactionInternal(
  sessionId: string,
  input: {
    trigger: 'manual' | 'auto' | 'retry'
    reason: string
    thresholdPercent?: number
    keepRequiredOnFailure?: boolean
    allowWhilePreparingGeneration?: boolean
  },
): Promise<{ status: 'completed' | 'cancelled' | 'error'; error?: string }> {
  const sameSessionIsPreparingGeneration =
    input.allowWhilePreparingGeneration
    && pendingSessionTasks.get(sessionId) === 'generation'
    && !activeSessionTasks.has(sessionId)
    && !activeAbortControllers.has(sessionId)

  if (isSessionExecutionBusy(sessionId) && !sameSessionIsPreparingGeneration) {
    throw new Error('This session is already busy.')
  }

  const releaseExecutionGate = beginConversationExecutionGate(sessionId, 'compaction', {
    allowExistingPendingTask: sameSessionIsPreparingGeneration
      ? 'generation'
      : undefined,
  })
  const { session, persisted } = await getOrResumeLiveSession(sessionId).catch((error) => {
    releaseExecutionGate()
    throw error
  })
  const releasePrimaryLease = await acquireSessionExecutionLease(
    sessionId,
    session.snapshot(),
  ).catch((error) => {
    releaseExecutionGate()
    throw error
  })
  const abortController = new AbortController()
  activeAbortControllers.set(sessionId, abortController)
  markConversationExecutionActive(sessionId, 'compaction')

  const runningState: PendingCompaction = {
    required: false,
    status: 'running',
    trigger: input.trigger,
    reason: input.reason,
    requestedAt: Date.now(),
    thresholdPercent: input.thresholdPercent,
  }

  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'app->sdk',
    event: 'sessions.compaction.started',
    summary: input.reason,
    data: runningState,
  })
  setPendingCompactionState(sessionId, runningState)
  void broadcastSessionsChanged().catch(() => {})

  try {
    const result = await session.compact({
      signal: abortController.signal,
      debug: (event) => {
        appendDebugLog(sessionId, {
          layer: 'runtime',
          direction:
            event.stage === 'request'
              ? 'sdk->runtime'
              : 'runtime->sdk',
          event: `runtime.${event.transport}.${event.stage}`,
          summary: summarizeRuntimeDebugEvent(event),
          data: event,
        })
      },
    })

    setPendingCompactionState(sessionId, null)
    const completionMessage = buildCompactionCompletedMessage(result)
    store.upsertAppMessage(sessionId, completionMessage)
    await store.save(
      sessionId,
      session.snapshot(),
      persisted?.meta,
      store.getAppMessages(sessionId),
    )

    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'sdk->app',
      event: 'sessions.compaction.completed',
      summary: `Compacted session to ${result.historyCount} model-visible messages`,
      data: result,
    })
    sendToSession(sessionId, {
      type: 'turn_complete',
      message: completionMessage,
    })

    return { status: 'completed' }
  } catch (error) {
    const cancelled = abortController.signal.aborted
    const errorMessage =
      error instanceof Error ? error.message : String(error)

    const pendingState =
      cancelled || input.keepRequiredOnFailure
        ? {
            ...runningState,
            required: true,
            status: 'pending' as const,
            trigger: 'retry' as const,
            lastError: cancelled ? undefined : errorMessage,
          }
        : null

    setPendingCompactionState(sessionId, pendingState)
    await store.save(sessionId, session.snapshot(), persisted?.meta)

    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'sdk->app',
      event: cancelled
        ? 'sessions.compaction.cancelled'
        : 'sessions.compaction.error',
      summary: cancelled ? 'Compaction cancelled' : errorMessage,
      data: {
        error: cancelled ? undefined : errorMessage,
        pendingCompaction: pendingState,
      },
    })

    return cancelled
      ? { status: 'cancelled' }
      : { status: 'error', error: errorMessage }
  } finally {
    activeAbortControllers.delete(sessionId)
    activeSessionTasks.delete(sessionId)
    releaseExecutionGate()
    releasePrimaryLease()
    void broadcastSessionsChanged().catch(() => {})
  }
}

async function runSessionClearInternal(sessionId: string): Promise<void> {
  if (isSessionExecutionBusy(sessionId)) {
    throw new Error('Cannot clear a session while it is running.')
  }

  const { session: currentSession, persisted } =
    await getOrResumeLiveSession(sessionId)
  const currentSnapshot = currentSession.snapshot()
  const workingDirectory = path.resolve(currentSnapshot.workingDirectory)

  // Build a cleared snapshot — same identity/config, no history, not started,
  // no compaction state — then resume into a fresh live session with the
  // same sessionId so renderer references stay valid.
  const clearedSnapshot: SessionSnapshot = {
    ...currentSnapshot,
    history: [],
    started: false,
    compaction: undefined,
    savedAt: new Date().toISOString(),
  }

  const freshSession = await gemmaDesktop.sessions.resume({
    snapshot: clearedSnapshot,
  })
  liveSessions.set(sessionId, freshSession)

  // Clear in-memory pending state — nothing from the old session should
  // leak forward into the fresh one.
  store.setPendingTurn(sessionId, null)
  store.setPendingCompaction(sessionId, null)
  store.setPendingPlanQuestion(sessionId, null)
  store.setPendingPlanExit(sessionId, null)
  store.setPendingToolApproval(sessionId, null)
  store.clearDebugLogs(sessionId)
  store.setDraftText(sessionId, '')

  // Wipe the session's assets directory inside .gemma — never touches
  // anything in the project directory itself.
  try {
    await fs.rm(
      getPersistedSessionAssetDirectory(workingDirectory, sessionId),
      { recursive: true, force: true },
    )
  } catch {
    // Missing directory is fine; we only care that it ends up gone.
  }

  // Persist the cleared snapshot with empty app messages.
  await store.save(
    sessionId,
    freshSession.snapshot(),
    persisted?.meta,
    [],
  )

  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'app->sdk',
    event: 'sessions.clear.completed',
    summary: 'Session history and assets cleared',
    data: { sessionId },
  })

  await broadcastSessionsChanged()
}

async function ensureSessionCompactedBeforeMessage(
  sessionId: string,
  session: GemmaDesktopSession,
): Promise<{ status: 'ready' | 'cancelled' | 'error'; error?: string }> {
  const pendingCompaction = store.getPendingCompaction(sessionId)
  if (pendingCompaction?.required) {
    const retried = await runSessionCompactionInternal(sessionId, {
      trigger: 'retry',
      reason: pendingCompaction.reason,
      thresholdPercent: pendingCompaction.thresholdPercent,
      keepRequiredOnFailure: true,
      allowWhilePreparingGeneration: true,
    })

    if (retried.status === 'completed') {
      return { status: 'ready' }
    }

    return retried.status === 'cancelled'
      ? { status: 'cancelled' }
      : { status: 'error', error: retried.error }
  }

  const snapshot = session.snapshot()
  const decision = await getAutoCompactionDecision(snapshot)
  if (!decision.shouldCompact) {
    return { status: 'ready' }
  }

  const compacted = await runSessionCompactionInternal(sessionId, {
    trigger: 'auto',
    reason: `Session is using about ${Math.round((decision.tokensUsed / decision.contextLength) * 100)}% of its model context, so Gemma Desktop is compacting before the next turn.`,
    thresholdPercent: decision.thresholdPercent,
    keepRequiredOnFailure: true,
    allowWhilePreparingGeneration: true,
  })

  if (compacted.status === 'completed') {
    return { status: 'ready' }
  }

  return compacted.status === 'cancelled'
    ? { status: 'cancelled' }
    : { status: 'error', error: compacted.error }
}

async function getSessionDebugSnapshot(
  sessionId: string,
): Promise<SessionDebugSnapshot | null> {
  const liveSession = liveSessions.get(sessionId)
  if (liveSession) {
    return gemmaDesktop.describeSession(liveSession.snapshot())
  }

  const persisted = await getPersistedSession(sessionId)
  if (!persisted) {
    return null
  }

  return gemmaDesktop.describeSession(persisted.snapshot)
}

async function runShellCommandInternal(
  sessionId: string,
  input: { command: string },
): Promise<void> {
  const normalizedCommand =
    typeof input.command === 'string' ? input.command.trim() : ''
  if (normalizedCommand.length === 0) {
    throw new Error('Shell command cannot be empty.')
  }

  const persisted = await getPersistedSession(sessionId)
  const snapshot = liveSessions.get(sessionId)?.snapshot() ?? persisted?.snapshot
  if (!snapshot) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const workingDirectory = path.resolve(snapshot.workingDirectory)
  const startedAt = Date.now()
  const terminalId = `terminal-${startedAt}-${randomUUID()}`
  const messageId = `shell-${startedAt}-${randomUUID()}`
  const visibleCommand = formatShellCommandForChat(normalizedCommand)
  const userMessage = buildShellUserMessage(visibleCommand, startedAt)
  const assistantMessage = buildShellAssistantMessage({
    terminalId,
    sessionId,
    messageId,
    command: normalizedCommand,
    workingDirectory,
    status: 'running',
    startedAt,
    transcript: '',
    collapsed: false,
    displayMode: 'chat',
  })

  store.upsertAppMessage(sessionId, userMessage)
  store.upsertAppMessage(sessionId, assistantMessage)
  sendToSession(sessionId, {
    type: 'user_message',
    message: userMessage,
  })
  sendToSession(sessionId, {
    type: 'turn_complete',
    message: assistantMessage,
  })
  await store.save(
    sessionId,
    snapshot,
    {
      lastMessage: visibleCommand.slice(0, 120),
    },
    store.getAppMessages(sessionId),
  )
  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'renderer->main',
    event: 'sessions.shell.started',
    summary: `Run shell command ${normalizedCommand}`,
    data: {
      terminalId,
      command: normalizedCommand,
      workingDirectory,
    },
  })
  void broadcastSessionsChanged().catch(() => {})

  try {
    shellSessionManager.start({
      terminalId,
      sessionId,
      messageId,
      command: normalizedCommand,
      workingDirectory,
      startedAt,
    })
  } catch (error) {
    const errorMessage =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : 'Gemma Desktop could not start the shell command.'
    const failedMessage = updateShellMessageInStore(
      sessionId,
      terminalId,
      (block) => ({
        ...block,
        status: 'error',
        transcript: appendShellTranscript(
          block.transcript,
          `${errorMessage}\n`,
        ),
        collapsed: true,
        completedAt: Date.now(),
      }),
    )

    if (failedMessage) {
      sendToSession(sessionId, {
        type: 'message_updated',
        message: failedMessage,
      })
      scheduleShellMessageFlush(sessionId, true)
    }
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.shell.error',
      summary: errorMessage,
      data: {
        terminalId,
        command: normalizedCommand,
        workingDirectory,
      },
    })
  }
}

async function startBackgroundProcessInternal(
  sessionId: string,
  input: {
    command: string
    workingDirectory: string
  },
): Promise<LiveShellSessionState> {
  const normalizedCommand =
    typeof input.command === 'string' ? input.command.trim() : ''
  if (normalizedCommand.length === 0) {
    throw new Error('Background process command cannot be empty.')
  }

  const startedAt = Date.now()
  const terminalId = `terminal-${startedAt}-${randomUUID()}`
  const messageId = `process-${startedAt}-${randomUUID()}`
  const state = shellSessionManager.start({
    terminalId,
    sessionId,
    messageId,
    command: normalizedCommand,
    workingDirectory: input.workingDirectory,
    startedAt,
    displayMode: 'sidebar',
  })
  const assistantMessage = buildShellAssistantMessage(state)

  store.upsertAppMessage(sessionId, assistantMessage)
  sendToSession(sessionId, {
    type: 'message_appended',
    message: assistantMessage,
  })
  scheduleShellMessageFlush(sessionId, false)
  scheduleShellSummaryBroadcast(sessionId, true)

  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'app->sdk',
    event: 'sessions.process.started',
    summary: `Started background process ${normalizedCommand}`,
    data: {
      terminalId,
      command: normalizedCommand,
      workingDirectory: input.workingDirectory,
    },
  })

  return state
}

function resolveShellProcessOrThrow(
  sessionId: string,
  terminalId: string,
): ShellSessionContentBlock {
  const block = getSessionShellBlock(sessionId, terminalId)
  if (block) {
    return block
  }

  const knownIds = getKnownShellProcessIds(sessionId)
  throw new Error(
    knownIds.length > 0
      ? `Process not found: ${terminalId}. Known process ids in this conversation: ${knownIds.join(', ')}`
      : `Process not found: ${terminalId}. No tracked conversation processes exist yet.`,
  )
}

async function closeShellCardInternal(
  sessionId: string,
  terminalId: string,
): Promise<void> {
  const liveState = shellSessionManager.close(sessionId, terminalId)
  if (liveState) {
    scheduleShellMessageFlush(sessionId, liveState.status !== 'running')
    return
  }

  const updatedMessage = updateShellMessageInStore(
    sessionId,
    terminalId,
    (block) => {
      const timestamp = Date.now()
      const interrupted =
        block.status === 'running'
          ? normalizePersistedShellBlock(block, timestamp)
          : block

      return {
        ...interrupted,
        collapsed: true,
      }
    },
  )

  if (!updatedMessage) {
    return
  }

  sendToSession(sessionId, {
    type: 'message_updated',
    message: updatedMessage,
  })
  scheduleShellMessageFlush(sessionId, true)
  if (
    updatedMessage.content.some(
      (content) =>
        isShellSessionContentBlock(content)
        && content.displayMode === 'sidebar',
    )
  ) {
    scheduleShellSummaryBroadcast(sessionId, true)
  }
}

async function resolveExistingDirectory(
  targetPath: string | undefined,
): Promise<string | null> {
  if (!targetPath || targetPath.trim().length === 0) {
    return null
  }

  const resolvedPath = path.resolve(targetPath)
  try {
    const stats = await fs.stat(resolvedPath)
    if (!stats.isDirectory()) {
      return null
    }
    return resolvedPath
  } catch {
    return null
  }
}

async function resolveAppTerminalWorkingDirectory(
  requestedPath?: string,
): Promise<string> {
  return await resolveExistingDirectory(requestedPath)
    ?? await resolveExistingDirectory(os.homedir())
    ?? os.homedir()
}

function appendDebugLog(
  sessionId: string,
  input: Omit<DebugLogEntry, 'id' | 'sessionId' | 'timestamp'>,
): void {
  const entry = createDebugEntry(sessionId, input)
  if (!shouldPersistDebugLog(entry)) {
    return
  }
  store.appendDebugLog(sessionId, entry)
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    `debug:log:${sessionId}`,
    entry,
    `debug:log:${sessionId}`,
  )
}

function summarizeStreamingBlocksForDebug(
  blocks: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(blocks)) {
    return []
  }

  return blocks.map((block) => {
    if (!block || typeof block !== 'object') {
      return { type: typeof block }
    }

    const record = block as Record<string, unknown>
    const type = record.type

    if (type === 'text' || type === 'thinking') {
      const text = typeof record.text === 'string' ? record.text : ''
      return {
        type,
        textLength: text.length,
        preview: text.slice(0, 120),
      }
    }

    if (type === 'tool_call') {
      const output = typeof record.output === 'string' ? record.output : ''
      const input = record.input
      return {
        type,
        toolName: record.toolName,
        status: record.status,
        inputKeys:
          input && typeof input === 'object' && !Array.isArray(input)
            ? Object.keys(input as Record<string, unknown>)
            : [],
        outputLength: output.length,
        outputPreview: output.slice(0, 120),
      }
    }

    if (type === 'file_edit') {
      const diff = typeof record.diff === 'string' ? record.diff : ''
      return {
        type,
        path: record.path,
        changeType: record.changeType,
        addedLines: record.addedLines,
        removedLines: record.removedLines,
        diffLength: diff.length,
        diffPreview: diff.slice(0, 120),
      }
    }

    if (type === 'shell_session') {
      const transcript =
        typeof record.transcript === 'string' ? record.transcript : ''
      return {
        type,
        terminalId: record.terminalId,
        command: record.command,
        status: record.status,
        collapsed: record.collapsed,
        exitCode: record.exitCode,
        transcriptLength: transcript.length,
        transcriptPreview: transcript.slice(-120),
      }
    }

    if (type === 'warning') {
      return {
        type,
        message: record.message,
      }
    }

    return {
      type,
      keys: Object.keys(record),
    }
  })
}

function summarizeSessionEventForDebug(event: unknown): unknown {
  if (!event || typeof event !== 'object') {
    return event
  }

  const record = event as Record<string, unknown>
  if (record.type === 'content_delta') {
    return {
      type: record.type,
      blocks: summarizeStreamingBlocksForDebug(record.blocks),
    }
  }

  if (record.type === 'content_delta_append') {
    return {
      type: record.type,
      blockType: record.blockType,
      deltaLength:
        typeof record.delta === 'string' ? record.delta.length : 0,
      preview:
        typeof record.delta === 'string' ? record.delta.slice(0, 120) : '',
    }
  }

  if (
    record.type === 'message_appended'
    || record.type === 'message_updated'
    || record.type === 'turn_complete'
  ) {
    const message =
      record.message && typeof record.message === 'object'
        ? record.message as Record<string, unknown>
        : null

    return {
      type: record.type,
      messageId: message?.id,
      role: message?.role,
      content: summarizeStreamingBlocksForDebug(message?.content),
    }
  }

  return event
}

function sendToSession(sessionId: string, event: unknown): void {
  const sessionEvent = event as { type?: string }
  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'main->renderer',
    event: `session.event.${sessionEvent.type ?? 'unknown'}`,
    summary: `Renderer event: ${sessionEvent.type ?? 'unknown'}`,
    data: summarizeSessionEventForDebug(event),
  })

  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    `session:event:${sessionId}`,
    event,
    `session:event:${sessionId}`,
  )
}

function sendSpeechEvent(sessionId: string, event: unknown): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    `speech:event:${sessionId}`,
    event,
    `speech:event:${sessionId}`,
  )
}

function getSessionNotificationTitle(sessionId: string): string | undefined {
  return store.getMeta(sessionId)?.title
}

function isHiddenSessionId(sessionId: string): boolean {
  const snapshot = store.getSnapshot(sessionId)
  return snapshot ? isHiddenSessionSnapshot(snapshot) : false
}

function buildNotificationPreview(message: AppMessage): string {
  for (const block of message.content) {
    if (typeof block.text === 'string' && block.text.trim().length > 0) {
      return block.text.replace(/\s+/g, ' ').trim().slice(0, 180)
    }

    if (typeof block.message === 'string' && block.message.trim().length > 0) {
      return block.message.replace(/\s+/g, ' ').trim().slice(0, 180)
    }

    if (
      block.type === 'file_edit'
      && typeof block.path === 'string'
      && typeof block.addedLines === 'number'
      && typeof block.removedLines === 'number'
    ) {
      const label = block.changeType === 'created' ? 'Created' : 'Edited'
      return `${label} ${block.path} (+${block.addedLines} -${block.removedLines})`
    }
  }

  return ''
}

function notifyActionRequired(
  sessionId: string,
  input: {
    dedupeId: string
    kind: 'tool_approval' | 'plan_question' | 'plan_exit'
    toolName?: string
  },
): void {
  if (isHiddenSessionId(sessionId)) {
    return
  }

  notificationManager.notifyActionRequired({
    sessionId,
    dedupeId: input.dedupeId,
    sessionTitle: getSessionNotificationTitle(sessionId),
    kind: input.kind,
    toolName: input.toolName,
  })
}

function notifySessionCompleted(sessionId: string, message: AppMessage): void {
  if (message.role !== 'assistant' || isHiddenSessionId(sessionId)) {
    return
  }

  notificationManager.notifySessionCompleted({
    sessionId,
    turnId: message.id,
    sessionTitle: getSessionNotificationTitle(sessionId),
    preview: buildNotificationPreview(message),
  })
}

async function inspectSpeechStatus(): Promise<SpeechInspection> {
  const currentSettings = await getSettingsState()
  return await speechRuntimeManager.inspect({
    enabled: currentSettings.speech.enabled,
  })
}

async function inspectReadAloudStatus(): Promise<ReadAloudInspection> {
  const currentSettings = await getSettingsState()
  return await readAloudService.inspect({
    enabled: currentSettings.readAloud.enabled,
  })
}

function parseOllamaServerConfigNumber(
  line: string,
  key: 'OLLAMA_NUM_PARALLEL' | 'OLLAMA_MAX_LOADED_MODELS' | 'OLLAMA_CONTEXT_LENGTH',
): number | undefined {
  const match = new RegExp(`${key}:(\\d+)`).exec(line)
  if (!match?.[1]) {
    return undefined
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseOllamaServerConfigString(
  line: string,
  key: 'OLLAMA_KEEP_ALIVE',
): string | undefined {
  const match = new RegExp(`${key}:([^\\s\\]]+)`).exec(line)
  return match?.[1]?.trim() || undefined
}

async function inspectOllamaServerConfig(): Promise<OllamaServerConfigSnapshot | null> {
  try {
    const logPath = path.join(os.homedir(), '.ollama', 'logs', 'server.log')
    const contents = await fs.readFile(logPath, 'utf-8')
    const latestConfigLine = contents
      .trim()
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.includes('msg="server config"'))

    if (!latestConfigLine) {
      return null
    }

    return {
      numParallel: parseOllamaServerConfigNumber(latestConfigLine, 'OLLAMA_NUM_PARALLEL'),
      maxLoadedModels: parseOllamaServerConfigNumber(latestConfigLine, 'OLLAMA_MAX_LOADED_MODELS'),
      contextLength: parseOllamaServerConfigNumber(latestConfigLine, 'OLLAMA_CONTEXT_LENGTH'),
      keepAlive: parseOllamaServerConfigString(latestConfigLine, 'OLLAMA_KEEP_ALIVE'),
    }
  } catch (error) {
    const missing =
      typeof error === 'object'
      && error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'

    if (!missing) {
      console.warn('[gemma-desktop] Failed to inspect Ollama server config:', error)
    }
    return null
  }
}

function broadcastSpeechStatusChanged(nextStatus: SpeechInspection): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'speech:status-changed',
    nextStatus,
    'speech:status-changed',
  )
}

function broadcastReadAloudStatusChanged(nextStatus: ReadAloudInspection): void {
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'read-aloud:status-changed',
    nextStatus,
    'read-aloud:status-changed',
  )
}

function normalizeAssistantNarrationPhase(value: unknown): AssistantNarrationPhase {
  return value === 'result' ? 'result' : 'submission'
}

function normalizeAssistantNarrationAttachments(
  value: unknown,
): AssistantNarrationAttachmentSummary[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry): AssistantNarrationAttachmentSummary | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null
      }
      const record = entry as Record<string, unknown>
      const kind = record.kind
      if (
        kind !== 'image'
        && kind !== 'audio'
        && kind !== 'video'
        && kind !== 'pdf'
      ) {
        return null
      }
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      return {
        kind,
        ...(name ? { name } : {}),
      }
    })
    .filter((entry): entry is AssistantNarrationAttachmentSummary => Boolean(entry))
}

const speechService = new SpeechService(
  speechRuntimeManager,
  {
    emit: (sessionId, event) => {
      sendSpeechEvent(sessionId, event)
    },
  },
)

function setPendingPlanQuestionState(
  sessionId: string,
  question: PendingPlanQuestion | null,
): void {
  const previous = store.getPendingPlanQuestion(sessionId)
  store.setPendingPlanQuestion(sessionId, question)
  sendToSession(sessionId, {
    type: question ? 'plan_question' : 'plan_question_cleared',
    question,
  })
  if (!previous && question) {
    notifyActionRequired(sessionId, {
      dedupeId: question.id,
      kind: 'plan_question',
    })
  }
  void store.flush(sessionId).catch(() => {})
}

function setPendingPlanExitState(
  sessionId: string,
  planExit: PendingPlanExit | null,
): void {
  const previous = store.getPendingPlanExit(sessionId)
  store.setPendingPlanExit(sessionId, planExit)
  sendToSession(sessionId, {
    type: planExit ? 'plan_exit_ready' : 'plan_exit_cleared',
    exit: planExit,
  })
  if (!previous && planExit) {
    notifyActionRequired(sessionId, {
      dedupeId: planExit.id,
      kind: 'plan_exit',
    })
  }
  void store.flush(sessionId).catch(() => {})
}

function setPendingToolApprovalState(
  sessionId: string,
  approval: PendingToolApproval | null,
): void {
  const previous = store.getPendingToolApproval(sessionId)
  store.setPendingToolApproval(sessionId, approval)
  sendToSession(sessionId, {
    type: approval ? 'tool_approval' : 'tool_approval_cleared',
    approval,
  })
  if (!previous && approval) {
    notifyActionRequired(sessionId, {
      dedupeId: approval.id,
      kind: 'tool_approval',
      toolName: approval.toolName,
    })
  }
  void store.flush(sessionId).catch(() => {})
}

function createAutomationLogEntry(
  input: Omit<AutomationLogEntry, 'id' | 'timestamp'>,
): AutomationLogEntry {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    ...input,
  }
}

function stopKeepAwake(): void {
  if (keepAwakeProcess) {
    keepAwakeProcess.kill()
    keepAwakeProcess = null
  }
}

async function refreshKeepAwakeState(): Promise<void> {
  const currentSettings = await getSettingsState()
  const shouldKeepAwake =
    process.platform === 'darwin'
    && currentSettings.automations.keepAwakeWhileRunning
    && activeAutomationRuns.size > 0

  if (shouldKeepAwake) {
    if (!keepAwakeProcess) {
      keepAwakeProcess = spawn('caffeinate', ['-dimsu'])
      keepAwakeProcess.on('exit', () => {
        keepAwakeProcess = null
      })
    }
    return
  }

  stopKeepAwake()
}

async function runAutomation(
  automationId: string,
  trigger: 'schedule' | 'manual',
): Promise<void> {
  if (activeAutomationRuns.has(automationId)) {
    return
  }

  const record = automationStore.get(automationId)
  if (!record) {
    return
  }

  const abortController = new AbortController()
  activeAutomationRuns.add(automationId)
  activeAutomationAbortControllers.set(automationId, abortController)
  await refreshKeepAwakeState()

  const run = await automationStore.createRun(
    automationId,
    trigger === 'schedule' ? 'Scheduled run started' : 'Manual run started',
    trigger,
  )
  broadcastAutomationsChanged()

  let assistantText = ''
  let reasoningText = ''
  const startedAt = Date.now()
  const releasePrimaryLease = await acquirePrimaryModelLease(
    `automation:${automationId}`,
    {
      modelId: record.modelId,
      runtimeId: record.runtimeId,
    },
  )

  try {
    const sessionMode: AppSessionMode = 'build'
    const runtimeSelection = normalizeRuntimeForSessionMode(
      record.runtimeId,
      sessionMode,
    )
    const composition = await resolveSessionComposition({
      snapshot: null,
      conversationKind: 'normal',
      sessionMode,
      planMode: false,
      modelId: record.modelId,
      runtimeId: runtimeSelection.runtimeId,
      preferredRuntimeId: record.runtimeId,
      selectedSkillIds: record.selectedSkillIds,
      selectedToolIds: [],
    })

    const session = await gemmaDesktop.sessions.create({
      runtime: runtimeSelection.runtimeId,
      model: record.modelId,
      mode: composition.mode,
      workingDirectory: record.workingDirectory,
      systemInstructions: composition.systemInstructions,
      metadata: composition.metadata,
    })

    const streamed = await session.runStreamed(record.prompt, {
      signal: abortController.signal,
      debug: (event) => {
        void automationStore.appendRunLog(
          automationId,
          run.id,
          createAutomationLogEntry({
            layer: 'runtime',
            event: `runtime.${event.transport}.${event.stage}`,
            summary: summarizeRuntimeDebugEvent(event),
            data: event,
          }),
        ).then(() => {
          broadcastAutomationsChanged()
        }).catch((error) => {
          console.error('Failed to append automation runtime log:', error)
        })
      },
    })

    for await (const event of streamed.events) {
      if (abortController.signal.aborted) {
        break
      }

      const gemmaDesktopEvent = event as GemmaDesktopEvent

      await automationStore.appendRunLog(
        automationId,
        run.id,
        createAutomationLogEntry({
          layer: 'sdk',
          event: gemmaDesktopEvent.type,
          summary: summarizeGemmaDesktopEvent(gemmaDesktopEvent),
          data: gemmaDesktopEvent,
        }),
      )

      if (gemmaDesktopEvent.type === 'content.delta') {
        const payload = gemmaDesktopEvent.payload as { channel?: string; delta?: string }
        if (payload.channel === 'reasoning') {
          reasoningText += payload.delta ?? ''
        } else {
          assistantText += payload.delta ?? ''
        }
      }
    }

    const result = await streamed.completed
    const durationMs = Math.max(Date.now() - startedAt, 1)
    const outputTokens = result.usage?.outputTokens
    const reasoningTokens = result.usage?.reasoningTokens ?? 0
    const estimated = outputTokens == null && reasoningTokens === 0
    const generatedTokens = estimated
      ? estimateGeneratedTokens(result.text, result.reasoning)
      : (outputTokens ?? 0) + reasoningTokens
    const tokensPerSecond = roundToSingleDecimal(
      generatedTokens / (durationMs / 1000),
    )

    recordSessionTokens(result.runtimeId, result.modelId, result.usage)

    await automationStore.completeRun(automationId, run.id, {
      status: 'success',
      summary:
        result.text.slice(0, 180)
        || assistantText.slice(0, 180)
        || 'Completed successfully',
      outputText: [reasoningText.trim(), result.text.trim()]
        .filter(Boolean)
        .join('\n\n'),
      generatedTokens,
      tokensPerSecond,
      finishedAt: Date.now(),
    })

    const latest = automationStore.get(automationId)
    if (latest && trigger === 'schedule') {
      await automationStore.update(automationId, {
        nextRunAt: computeNextRunAt(latest),
      })
    }

    notificationManager.notifyAutomationFinished({
      automationId,
      runId: run.id,
      name: record.name,
      status: 'success',
      summary:
        result.text.slice(0, 180)
        || assistantText.slice(0, 180)
        || 'Completed successfully',
    })
  } catch (error) {
    const cancelled = abortController.signal.aborted
    const message = cancelled
      ? 'Run cancelled'
      : error instanceof Error
        ? error.message
        : String(error)
    await automationStore.completeRun(automationId, run.id, {
      status: cancelled ? 'cancelled' : 'error',
      summary: message,
      errorMessage: cancelled ? undefined : message,
      outputText: [reasoningText.trim(), assistantText.trim()]
        .filter(Boolean)
        .join('\n\n'),
      finishedAt: Date.now(),
    })

    const latest = automationStore.get(automationId)
    if (latest && trigger === 'schedule') {
      await automationStore.update(automationId, {
        nextRunAt: computeNextRunAt(latest),
      })
    }

    notificationManager.notifyAutomationFinished({
      automationId,
      runId: run.id,
      name: record.name,
      status: cancelled ? 'cancelled' : 'error',
      summary: message,
    })
  } finally {
    activeAutomationRuns.delete(automationId)
    activeAutomationAbortControllers.delete(automationId)
    releasePrimaryLease()
    await refreshKeepAwakeState()
    broadcastAutomationsChanged()
  }
}

async function checkDueAutomations(): Promise<void> {
  const now = Date.now()
  const dueAutomations = automationStore
    .list()
    .filter(
      (record) =>
        record.enabled
        && record.nextRunAt !== null
        && record.nextRunAt <= now
        && !activeAutomationRuns.has(record.id),
    )

  for (const record of dueAutomations) {
    void runAutomation(record.id, 'schedule')
  }
}

function createAppTools(): RegisteredTool[] {
  const buildAskUserTool = (
    name: string,
    description: string,
  ): RegisteredTool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        question: {},
        details: {},
        options: {},
        placeholder: {},
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizePlanQuestionInput(input)
      const request: PendingPlanQuestion = {
        id: randomUUID(),
        turnId: context.turnId,
        question: normalizedInput.question,
        details: normalizedInput.details,
        options: normalizedInput.options.slice(0, 6),
        placeholder: normalizedInput.placeholder,
        askedAt: Date.now(),
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'plan.question.requested',
        summary: request.question,
        turnId: context.turnId,
        data: {
          request,
          normalizedFrom: input,
          toolName: name,
        },
      })

      setPendingPlanQuestionState(context.sessionId, request)
      const signal = context.signal

      if (!signal) {
        throw new Error('Plan question requires an abort signal.')
      }

      const answer = await new Promise<string>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Plan question cancelled.'))
          return
        }

        const onAbort = () => {
          pendingPlanQuestionResolvers.delete(request.id)
          setPendingPlanQuestionState(context.sessionId, null)
          reject(new Error('Plan question cancelled.'))
        }

        signal.addEventListener('abort', onAbort, { once: true })
        pendingPlanQuestionResolvers.set(request.id, {
          sessionId: context.sessionId,
          resolve: (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          reject: (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        })
      })

      setPendingPlanQuestionState(context.sessionId, null)
      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'plan.question.answered',
        summary: 'Plan question answered',
        turnId: context.turnId,
        data: {
          requestId: request.id,
          answer,
          toolName: name,
        },
      })

      return {
        output: answer,
        structuredOutput: {
          answer,
        },
      }
    },
  })

  const askUserTool = buildAskUserTool(
    ASK_USER_TOOL,
    'Ask the user a direct planning question when you are blocked by a missing decision or requirement.',
  )
  const legacyAskPlanQuestionTool = buildAskUserTool(
    LEGACY_ASK_PLAN_QUESTION_TOOL,
    'Deprecated alias for ask_user. Ask the user a direct planning question when you are blocked.',
  )

  const activateSkillTool: RegisteredTool = {
    name: ACTIVATE_SKILL_TOOL,
    description:
      'Load a discoverable skill into the session context when it becomes relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
        reason: { type: 'string' },
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizeSkillActivationInput(input)
      if (!normalizedInput.skillId) {
        throw new Error('activate_skill requires a skillId from the available skill catalog.')
      }

      const installedSkills = await listDiscoverableSkills()
      const target = resolveInstalledSkill(
        normalizedInput.skillId,
        installedSkills,
      )

      if (!target) {
        const available = installedSkills
          .map((skill) => `${skillActivationId(skill)} (${skill.name})`)
          .join(', ')
        throw new Error(
          available.length > 0
            ? `Skill not found: ${normalizedInput.skillId}. Available skills: ${available}`
            : 'No discoverable skills are available to activate.',
        )
      }

      const [bundle] = await buildSkillContextBundles([target.id], installedSkills)
      if (!bundle) {
        throw new Error(`Failed to load instructions for ${target.name}.`)
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'skills.activated',
        summary: `Activated skill ${target.name}`,
        turnId: context.turnId,
        data: {
          requestedSkillId: normalizedInput.skillId,
          activationId: skillActivationId(target),
          reason: normalizedInput.reason,
          skill: {
            id: target.id,
            name: target.name,
            location: target.location,
            directory: target.directory,
          },
        },
      })

      return {
        title: target.name,
        output: [
          `Activated skill: ${target.name}`,
          `Activation id: ${skillActivationId(target)}`,
          bundle.text,
          bundle.truncated
            ? 'Note: some skill content or bundled resource listings were trimmed to keep the session usable.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        structuredOutput: {
          activationId: skillActivationId(target),
          skillId: target.id,
          name: target.name,
          location: target.location,
          directory: target.directory,
          truncated: bundle.truncated,
        },
      }
    },
  }

  const inspectFileTool: RegisteredTool<{
    path: string
    mediaType?: string
  }> = {
    name: 'inspect_file',
    description:
      'Direct tool. Resolve a local file path, classify it, and suggest the safest way to use read_file without guessing from the extension alone.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(input, context) {
      const file = await resolveInspectableFile(input, context.workingDirectory)
      const result = await inspectFileForReadStrategy({
        file,
        workingDirectory: context.workingDirectory,
      })
      return {
        output: formatInspectFileOutput(result),
        structuredOutput: {
          path: result.displayPath,
          absolutePath: file.path,
          name: file.name,
          kind: file.kind,
          mediaType: file.mediaType,
          size: file.size,
          modifiedAtMs: file.modifiedAtMs,
          pageCount: result.pageCount,
          canReadWithReadFile: result.canReadWithReadFile,
          suggestedTool: result.suggestedTool,
          suggestedStrategy: result.suggestedStrategy,
          reasoning: result.reasoning,
          warnings: result.warnings,
        },
      }
    },
  }

  const materializeContentTool: RegisteredTool<{
    path: string
    mediaType?: string
    outputPath?: string
    target?: ContentMaterializeTarget
    createDirectories?: boolean
    overwrite?: boolean
  }> = {
    name: 'materialize_content',
    description:
      'Direct tool. Convert a known local source into an addressable text artifact without loading the whole artifact into model context. Supports text files, PDFs, image OCR/description, and audio transcription when helper models are available.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        outputPath: { type: 'string' },
        target: { type: 'string', enum: ['auto', 'text', 'markdown'] },
        createDirectories: { type: 'boolean' },
        overwrite: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        ...input,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      return {
        output: formatMaterializedContentOutput(materialized),
        structuredOutput: materializedContentForStructuredOutput(materialized),
      }
    },
  }

  const readContentTool: RegisteredTool<{
    path: string
    mediaType?: string
    offset?: number
    limit?: number
    maxBytes?: number
  }> = {
    name: 'read_content',
    description:
      'Direct tool. Read a materialized content artifact or source file with line-based pagination. If the path is a PDF, image, or audio file, Gemma Desktop materializes it to cached text first.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
        maxBytes: { type: 'integer', minimum: 256, maximum: 524288 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        path: input.path,
        mediaType: input.mediaType,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      const result = buildMaterializedReadResult({
        materialized,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
      })
      return {
        output: renderWorkspaceReadFile(result),
        structuredOutput: {
          ...result,
          materialized: materializedContentForStructuredOutput(materialized),
        },
        metadata: { truncated: result.truncated },
      }
    },
  }

  const searchContentTool: RegisteredTool<{
    path: string
    query: string
    mediaType?: string
    regex?: boolean
    caseSensitive?: boolean
    wholeWord?: boolean
    before?: number
    after?: number
    limit?: number
  }> = {
    name: 'search_content',
    description:
      'Direct tool. Search within one materialized content artifact or source file. For PDFs, images, and audio, Gemma Desktop materializes cached text first, then searches that artifact.',
    inputSchema: {
      type: 'object',
      required: ['path', 'query'],
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        mediaType: { type: 'string' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        wholeWord: { type: 'boolean' },
        before: { type: 'integer', minimum: 0, maximum: 20 },
        after: { type: 'integer', minimum: 0, maximum: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const materialized = await materializeInspectableContent({
        path: input.path,
        mediaType: input.mediaType,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      const result = searchMaterializedText({
        text: materialized.text,
        path: materialized.displayArtifactPath,
        query: input.query,
        regex: input.regex,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        before: input.before,
        after: input.after,
        limit: input.limit,
      })
      return {
        output: formatContentSearchOutput({
          path: materialized.displayArtifactPath,
          query: input.query,
          matches: result.matches,
          truncated: result.truncated,
        }),
        structuredOutput: {
          path: materialized.displayArtifactPath,
          artifactPath: materialized.artifactPath,
          query: input.query,
          regex: result.regex,
          matches: result.matches,
          truncated: result.truncated,
          materialized: materializedContentForStructuredOutput(materialized),
        },
        metadata: { truncated: result.truncated },
      }
    },
  }

  const smartReadFileTool: RegisteredTool<{
    path: string
    mediaType?: string
    offset?: number
    limit?: number
    maxBytes?: number
  }> = {
    name: 'read_file',
    description:
      'Direct tool. Read a known file with line-based pagination. For PDFs, images, and audio, Gemma Desktop first converts the file into cached text, then returns a paginated text window.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        mediaType: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 10000 },
        maxBytes: { type: 'integer', minimum: 256, maximum: 524288 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const result = await readInspectableFileForTool({
        ...input,
        workingDirectory: context.workingDirectory,
        sessionId: context.sessionId,
        signal: context.signal,
        onProgress: context.emitProgress,
      })
      return {
        output: renderWorkspaceReadFile(result),
        structuredOutput: result,
        metadata: { truncated: result.truncated },
      }
    },
  }

  const smartReadFilesTool: RegisteredTool<{
    requests: Array<{
      path: string
      mediaType?: string
      offset?: number
      limit?: number
    }>
    maxTotalBytes?: number
  }> = {
    name: 'read_files',
    description:
      'Direct tool. Batch-read several known files under one shared byte budget. Gemma Desktop converts PDFs, images, and audio into cached text before returning paginated text windows.',
    inputSchema: {
      type: 'object',
      required: ['requests'],
      properties: {
        requests: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string' },
              mediaType: { type: 'string' },
              offset: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 10000 },
            },
            additionalProperties: false,
          },
        },
        maxTotalBytes: { type: 'integer', minimum: 256, maximum: 2097152 },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const maxTotalBytes = Math.max(
        Math.min(
          typeof input.maxTotalBytes === 'number'
            ? Math.floor(input.maxTotalBytes)
            : SMART_MULTI_READ_DEFAULT_MAX_BYTES,
          2 * 1024 * 1024,
        ),
        256,
      )
      const results: Array<Awaited<ReturnType<typeof readInspectableFileForTool>>> = []
      let totalBytes = 0
      let truncated = false
      let exhaustedBudget = false

      for (const request of input.requests) {
        const remainingBytes = maxTotalBytes - totalBytes
        if (remainingBytes <= 0) {
          exhaustedBudget = true
          truncated = true
          break
        }

        const requestPath = typeof request.path === 'string' ? request.path.trim() : ''
        const requestLabel = requestPath.length > 0 ? path.basename(requestPath) : `file ${results.length + 1}`
        const result = await readInspectableFileForTool({
          ...request,
          maxBytes: remainingBytes,
          workingDirectory: context.workingDirectory,
          sessionId: context.sessionId,
          signal: context.signal,
          onProgress: context.emitProgress
            ? (progress) => {
                context.emitProgress?.({
                  id: `request-${results.length + 1}-${progress.id}`,
                  label: `${requestLabel}: ${progress.label}`,
                  tone: progress.tone,
                })
              }
            : undefined,
        })
        results.push(result)
        totalBytes += Buffer.byteLength(result.numberedContent, 'utf8')
        if (result.truncated) {
          truncated = true
        }
      }

      if (results.length < input.requests.length) {
        truncated = true
      }

      const structuredOutput = {
        results,
        truncated,
        exhaustedBudget,
        maxTotalBytes,
        totalBytes,
      }

      return {
        output: renderWorkspaceReadFiles(structuredOutput),
        structuredOutput,
        metadata: { truncated },
      }
    },
  }

  const startBackgroundProcessTool: RegisteredTool = {
    name: START_BACKGROUND_PROCESS_TOOL,
    description:
      'Start one conversation-scoped background process for a long-running local command such as a dev server, watcher, or download.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { command?: unknown }
          : {}
      const command =
        typeof record.command === 'string' ? record.command.trim() : ''
      const state = await startBackgroundProcessInternal(context.sessionId, {
        command,
        workingDirectory: context.workingDirectory,
      })

      return {
        output: [
          `Started background process ${state.terminalId}.`,
          `Command: ${state.command}`,
          `Working directory: ${state.workingDirectory}`,
          `Status: ${state.status}`,
          `Use ${PEEK_BACKGROUND_PROCESS_TOOL} to inspect bounded output or ${TERMINATE_BACKGROUND_PROCESS_TOOL} to stop it.`,
        ].join('\n'),
        structuredOutput: {
          processId: state.terminalId,
          command: state.command,
          workingDirectory: state.workingDirectory,
          status: state.status,
          startedAt: state.startedAt,
        },
      }
    },
  }

  const peekBackgroundProcessTool: RegisteredTool = {
    name: PEEK_BACKGROUND_PROCESS_TOOL,
    description:
      'Check whether a tracked background process is still running and return a bounded tail of its recent output.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { processId?: unknown; maxChars?: unknown }
          : {}
      const processId =
        typeof record.processId === 'string' ? record.processId.trim() : ''
      if (processId.length === 0) {
        throw new Error('peek_background_process requires a processId.')
      }

      const liveState = shellSessionManager.inspect(context.sessionId, processId)
      const block = resolveShellProcessOrThrow(context.sessionId, processId)
      const peek = peekShellTranscript(
        liveState?.transcript ?? block.transcript,
        typeof record.maxChars === 'number' ? record.maxChars : DEFAULT_SHELL_PEEK_CHARS,
      )
      const status = liveState?.status ?? block.status
      const exitCode = liveState?.exitCode ?? block.exitCode
      const completedAt = liveState?.completedAt ?? block.completedAt
      const notes = [
        peek.peekTruncated
          ? `Showing only the last ${peek.returnedChars} characters of ${peek.totalChars} retained transcript characters.`
          : undefined,
        peek.storageTruncated
          ? 'Older process output was already dropped from retained transcript storage.'
          : undefined,
      ].filter((entry): entry is string => Boolean(entry))

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'sessions.process.peeked',
        summary: `Peeked background process ${processId}`,
        turnId: context.turnId,
        data: {
          processId,
          status,
          exitCode,
          peekTruncated: peek.peekTruncated,
          storageTruncated: peek.storageTruncated,
          returnedChars: peek.returnedChars,
        },
      })

      return {
        output: [
          `Process: ${processId}`,
          `Command: ${block.command}`,
          `Status: ${status}${exitCode == null ? '' : ` (exit ${exitCode})`}`,
          `Working directory: ${block.workingDirectory}`,
          ...(completedAt != null ? [`Completed at: ${new Date(completedAt).toISOString()}`] : []),
          ...(notes.length > 0 ? [`Notes: ${notes.join(' ')}`] : []),
          'Recent output:',
          peek.text.length > 0 ? peek.text : '[no output recorded yet]',
        ].join('\n'),
        structuredOutput: {
          processId,
          command: block.command,
          workingDirectory: block.workingDirectory,
          status,
          exitCode,
          startedAt: block.startedAt,
          completedAt,
          output: peek.text,
          outputChars: peek.returnedChars,
          retainedTranscriptChars: peek.totalChars,
          peekTruncated: peek.peekTruncated,
          storageTruncated: peek.storageTruncated,
        },
      }
    },
  }

  const terminateBackgroundProcessTool: RegisteredTool = {
    name: TERMINATE_BACKGROUND_PROCESS_TOOL,
    description:
      'Terminate a tracked background process in the current conversation only when the user asked you to stop it or it must be stopped for safety or task progress.',
    inputSchema: {
      type: 'object',
      properties: {
        processId: { type: 'string' },
      },
      required: ['processId'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { processId?: unknown }
          : {}
      const processId =
        typeof record.processId === 'string' ? record.processId.trim() : ''
      if (processId.length === 0) {
        throw new Error('terminate_background_process requires a processId.')
      }

      const block = resolveShellProcessOrThrow(context.sessionId, processId)
      const liveState = shellSessionManager.inspect(context.sessionId, processId)

      if (liveState?.status === 'running') {
        await closeShellCardInternal(context.sessionId, processId)
        appendDebugLog(context.sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'sessions.process.terminate.requested',
          summary: `Terminate requested for ${processId}`,
          turnId: context.turnId,
          data: {
            processId,
            command: block.command,
          },
        })
        return {
          output: [
            `Termination requested for ${processId}.`,
            `Command: ${block.command}`,
            `Use ${PEEK_BACKGROUND_PROCESS_TOOL} if you need to confirm the final exit state.`,
          ].join('\n'),
          structuredOutput: {
            processId,
            command: block.command,
            status: 'termination_requested',
          },
        }
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'sessions.process.terminate.noop',
        summary: `Background process ${processId} was already ${block.status}`,
        turnId: context.turnId,
        data: {
          processId,
          command: block.command,
          status: block.status,
          exitCode: block.exitCode,
        },
      })

      return {
        output: [
          `Process ${processId} is not running.`,
          `Command: ${block.command}`,
          `Status: ${block.status}${block.exitCode == null ? '' : ` (exit ${block.exitCode})`}`,
        ].join('\n'),
        structuredOutput: {
          processId,
          command: block.command,
          status: block.status,
          exitCode: block.exitCode,
          completedAt: block.completedAt,
        },
      }
    },
  }

  const openProjectBrowserTool: RegisteredTool = {
    name: OPEN_PROJECT_BROWSER_TOOL,
    description:
      'Open or refresh the visible Project Browser for an http or https URL and return a bounded page snapshot for verification.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              url?: unknown
              timeoutMs?: unknown
              maxChars?: unknown
            }
          : {}

      const result = await projectBrowserManager.open({
        sessionId: context.sessionId,
        url: typeof record.url === 'string' ? record.url : '',
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
        timeoutMs:
          typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)
            ? record.timeoutMs
            : undefined,
        maxChars:
          typeof record.maxChars === 'number' && Number.isFinite(record.maxChars)
            ? record.maxChars
            : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.opened',
        summary:
          typeof record.url === 'string' && record.url.trim().length > 0
            ? `Opened Project Browser for ${record.url}`
            : 'Opened Project Browser',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const searchProjectBrowserDomTool: RegisteredTool = {
    name: SEARCH_PROJECT_BROWSER_DOM_TOOL,
    description:
      'Search the current Project Browser page for selectors or text patterns and return bounded DOM matches.',
    inputSchema: {
      type: 'object',
      properties: {
        selectors: {
          type: 'array',
          items: { type: 'string' },
        },
        textPatterns: {
          type: 'array',
          items: { type: 'string' },
        },
        maxMatches: { type: 'number' },
        includeHtml: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      projectBrowserManager.assertAgentBrowserControl({
        sessionId: context.sessionId,
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
      })

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              selectors?: unknown
              textPatterns?: unknown
              maxMatches?: unknown
              includeHtml?: unknown
            }
          : {}

      const result = await projectBrowserManager.searchDom({
        selectors: Array.isArray(record.selectors)
          ? record.selectors.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        textPatterns: Array.isArray(record.textPatterns)
          ? record.textPatterns.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        maxMatches:
          typeof record.maxMatches === 'number' && Number.isFinite(record.maxMatches)
            ? record.maxMatches
            : undefined,
        includeHtml: record.includeHtml === true,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.dom-searched',
        summary: 'Searched Project Browser DOM',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const releaseProjectBrowserToUserTool: RegisteredTool = {
    name: RELEASE_PROJECT_BROWSER_TO_USER_TOOL,
    description:
      'Release visible CoBrowse browser control to the user for login, CAPTCHA, permission, payment, or other human-only browser actions.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      if (!isCoBrowseSessionMetadata(context.sessionMetadata)) {
        throw new Error('Project Browser control handoff is only available during CoBrowse.')
      }

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { reason?: unknown }
          : {}
      const state = projectBrowserManager.releaseControlToUser({
        sessionId: context.sessionId,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.control-released-to-user',
        summary: 'Released Project Browser control to the user',
        turnId: context.turnId,
        data: {
          input: record,
          state,
        },
      })

      return {
        output: [
          'Released Project Browser control to the user.',
          'Browser tools are blocked until the user clicks Release control.',
        ].join('\n'),
        structuredOutput: {
          action: 'release_control_to_user',
          controlOwner: state.controlOwner,
          controlReason: state.controlReason,
          needsUserRelease: true,
        },
      }
    },
  }

  const getProjectBrowserErrorsTool: RegisteredTool = {
    name: GET_PROJECT_BROWSER_ERRORS_TOOL,
    description:
      'Return recent console and page-load errors captured from the current Project Browser page with bounded output.',
    inputSchema: {
      type: 'object',
      properties: {
        maxItems: { type: 'number' },
      },
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      projectBrowserManager.assertAgentBrowserControl({
        sessionId: context.sessionId,
        coBrowseActive: isCoBrowseSessionMetadata(context.sessionMetadata),
      })

      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as { maxItems?: unknown }
          : {}

      const result = projectBrowserManager.getConsoleErrors({
        maxItems:
          typeof record.maxItems === 'number' && Number.isFinite(record.maxItems)
            ? record.maxItems
            : undefined,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'project-browser.errors-read',
        summary: 'Read Project Browser console errors',
        turnId: context.turnId,
        data: {
          input: record,
          structuredOutput: result.structuredOutput,
        },
      })

      return result
    },
  }

  const browserTools: RegisteredTool[] = (browserToolManager?.getToolDefinitions() ?? [])
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      async execute(input: unknown, context) {
        if (!browserToolManager) {
          throw new Error('Browser tool is not initialized.')
        }

        const argumentsRecord =
          input && typeof input === 'object' && !Array.isArray(input)
            ? input as Record<string, unknown>
            : {}

        const result = await browserToolManager.callTool(
          context.sessionId,
          tool.name,
          argumentsRecord,
        )

        appendDebugLog(context.sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'chrome.tool.executed',
          summary: `Executed ${tool.name}`,
          turnId: context.turnId,
          data: {
            toolName: tool.name,
            arguments: argumentsRecord,
            structuredOutput: result.structuredOutput,
          },
        })

        return {
          output: result.output,
          structuredOutput: result.structuredOutput,
        }
      },
    }))

  const chromeDevtoolsTools: RegisteredTool[] = (
    chromeDevtoolsToolManager?.getToolDefinitions() ?? []
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    async execute(input: unknown, context) {
      if (!chromeDevtoolsToolManager) {
        throw new Error('Chrome DevTools is not initialized.')
      }

      const argumentsRecord =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {}

      const result = await chromeDevtoolsToolManager.callTool(
        context.sessionId,
        tool.name,
        argumentsRecord,
      )

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'chrome-devtools.tool.executed',
        summary: `Executed ${tool.name}`,
        turnId: context.turnId,
        data: {
          toolName: tool.name,
          arguments: argumentsRecord,
          structuredOutput: result.structuredOutput,
        },
      })

      return {
        output: result.output,
        structuredOutput: result.structuredOutput,
      }
    },
  }))

  const askGeminiTool: RegisteredTool = {
    name: ASK_GEMINI_TOOL_NAME,
    description:
      'Ask the locally installed Gemini CLI a detailed question in headless read-only mode and use the answer as advisory input.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(input: unknown, context) {
      const record =
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as {
              question?: unknown
              context?: unknown
              model?: unknown
            }
          : {}
      const question =
        typeof record.question === 'string' ? record.question.trim() : ''
      const contextText =
        typeof record.context === 'string' && record.context.trim().length > 0
          ? record.context.trim()
          : undefined
      const requestedModel =
        typeof record.model === 'string' && record.model.trim().length > 0
          ? record.model.trim()
          : undefined
      const currentSettings = await getSettingsState()
      const configuredModel = currentSettings.integrations.geminiCli.model.trim()
        || ASK_GEMINI_DEFAULT_MODEL

      const result = await askGeminiCli({
        question,
        context: contextText,
        model: requestedModel ?? configuredModel,
        workingDirectory: context.workingDirectory,
      })

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'gemini.tool.executed',
        summary: result.ok
          ? 'Received Ask Gemini response'
          : `Ask Gemini failed: ${result.errorKind}`,
        turnId: context.turnId,
        data: {
          question,
          requestedModel: requestedModel ?? configuredModel,
          result,
        },
      })

      if (!result.ok) {
        return {
          output: `Ask Gemini failed: ${result.error}`,
          structuredOutput: result,
        }
      }

      return {
        output: [
          result.response,
          ...(result.warnings && result.warnings.length > 0
            ? ['', `Warnings: ${result.warnings.join(' ')}`]
            : []),
        ].join('\n'),
        structuredOutput: result,
      }
    },
  }

  const buildExitPlanModeTool = (
    name: string,
    trigger: PendingPlanExit['trigger'],
    description: string,
  ): RegisteredTool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {},
        details: {},
        executionPrompt: {},
        workMode: {},
        recommendedMode: {},
        mode: {},
        raw: { type: 'string' },
      },
      additionalProperties: true,
    },
    async execute(input: unknown, context) {
      const normalizedInput = normalizePlanExitInput(input)
      const planExit: PendingPlanExit = {
        id: randomUUID(),
        turnId: context.turnId,
        createdAt: Date.now(),
        workMode: normalizedInput.workMode,
        summary: normalizedInput.summary,
        details: normalizedInput.details,
        source: 'model',
        trigger,
        attentionToken: Date.now(),
      }

      appendDebugLog(context.sessionId, {
        layer: 'ipc',
        direction: 'app->sdk',
        event: 'plan.exit.prepared',
        summary: planExit.summary.slice(0, 140),
        turnId: context.turnId,
        data: {
          planExit,
          normalizedFrom: input,
          toolName: name,
        },
      })

      setPendingPlanExitState(context.sessionId, planExit)

      return {
        output:
          'Plan exit prepared. Tell the user the plan is ready and they can switch this session back to work mode.',
        structuredOutput: planExit,
      }
    },
  })

  return [
    buildSearchWebTool(),
    askUserTool,
    legacyAskPlanQuestionTool,
    activateSkillTool,
    inspectFileTool,
    materializeContentTool,
    readContentTool,
    searchContentTool,
    smartReadFileTool,
    smartReadFilesTool,
    startBackgroundProcessTool,
    peekBackgroundProcessTool,
    terminateBackgroundProcessTool,
    openProjectBrowserTool,
    searchProjectBrowserDomTool,
    releaseProjectBrowserToUserTool,
    getProjectBrowserErrorsTool,
    askGeminiTool,
    ...browserTools,
    ...chromeDevtoolsTools,
    buildExitPlanModeTool(
      EXIT_PLAN_MODE_TOOL,
      'exit_plan_mode',
      'Prepare the current plan to exit plan mode and switch this session back to its underlying work mode.',
    ),
    buildExitPlanModeTool(
      LEGACY_PREPARE_PLAN_EXECUTION_TOOL,
      'legacy_prepare_plan_execution',
      'Deprecated alias for exit_plan_mode. Prepare the current plan to switch this session back to work mode.',
    ),
  ]
}

function sanitizeVersion(raw?: string): string | undefined {
  if (!raw) return undefined
  // Strip ANSI escape codes
  const clean = raw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
  // Try to extract a semver-like version number
  const match = /(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/.exec(clean)
  return match ? match[1] : clean.trim().slice(0, 20) || undefined
}

function mapRuntimes(inspectionResults: Array<{ runtime: { id: string; displayName: string; endpoint: string }; healthy: boolean; reachable: boolean; installed: boolean; version?: string }>): Array<{ id: string; name: string; status: 'running' | 'stopped' | 'not_installed'; version?: string }> {
  return inspectionResults.map((r) => ({
    id: r.runtime.id,
    name: r.runtime.displayName,
    status: r.healthy ? 'running' : r.installed ? 'stopped' : 'not_installed',
    version: sanitizeVersion(r.version),
  }))
}

function coerceNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number') {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

function normalizeNumericRecord(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === 'number' && Number.isFinite(entry),
  )
  return entries.length > 0
    ? Object.fromEntries(entries) as Record<string, number>
    : undefined
}

function computeApproxGpuResidencyPercent(
  config: Record<string, unknown>,
): number | undefined {
  const size = coerceNumber(config.size)
  const sizeVram = coerceNumber(config.sizeVram, config.size_vram)
  if (!size || !sizeVram || size <= 0) {
    return undefined
  }

  return Math.max(0, Math.min(100, Math.round((sizeVram / size) * 100)))
}

function createConfiguredRuntimeAdapters(currentSettings: AppSettingsRecord) {
  return [
    createOllamaNativeAdapter({
      baseUrl: currentSettings.runtimes.ollama.endpoint,
    }),
    createOllamaOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.ollama.endpoint,
    }),
    createLmStudioNativeAdapter({
      baseUrl: currentSettings.runtimes.lmstudio.endpoint,
    }),
    createLmStudioOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.lmstudio.endpoint,
    }),
    createLlamaCppServerAdapter({
      baseUrl: currentSettings.runtimes.llamacpp.endpoint,
    }),
    createOmlxOpenAICompatibleAdapter({
      baseUrl: currentSettings.runtimes.omlx.endpoint,
      apiKey: currentSettings.runtimes.omlx.apiKey.trim() || undefined,
    }),
  ]
}

type MappedModelRuntimeConfig = {
  provider: 'ollama' | 'lmstudio' | 'omlx'
  baseParameters?: Record<string, unknown>
  baseParametersText?: string
  requestedOptions?: Record<string, number>
  loadedOptions?: Record<string, unknown>
  nominalContextLength?: number
  loadedContextLength?: number
  approxGpuResidencyPercent?: number
}

type MappedModelSummary = {
  id: string
  name: string
  runtimeId: string
  runtimeName: string
  parameterCount?: string
  quantization?: string
  contextLength?: number
  status: 'loaded' | 'available' | 'loading'
  attachmentSupport: ReturnType<typeof deriveAttachmentSupport>
  runtimeConfig?: MappedModelRuntimeConfig
}

function mapModels(
  inspectionResults: Array<{ runtime: { id: string; displayName: string }; models: Array<{ id: string; runtimeId: string; kind: string; metadata: Record<string, unknown>; capabilities: Array<{ id: string; status: string; scope?: string; source?: string }> }>; loadedInstances: Array<{ modelId: string; status: string }> }>,
  currentSettings?: Pick<AppSettingsRecord, 'ollama' | 'lmstudio'> | null,
): MappedModelSummary[] {
  const models: MappedModelSummary[] = []
  const pendingLoadTargets = listPendingModelLoadTargets()
  const pendingLoadKeys = new Set(pendingLoadTargets.map(modelTargetKey))
  const mappedKeys = new Set<string>()

  for (const rt of inspectionResults) {
    const loadedInstancesByModel = new Map(
      rt.loadedInstances.map((instance) => [instance.modelId, instance]),
    )
    const loadedIds = new Set(
      rt.loadedInstances
        .filter((i) => i.status === 'loaded' || i.status === 'loading')
        .map((i) => i.modelId),
    )
    const loadingIds = new Set(
      rt.loadedInstances
        .filter((i) => i.status === 'loading')
        .map((i) => i.modelId),
    )

    for (const m of rt.models) {
      if (m.kind === 'embedding') continue

      const meta = m.metadata as Record<string, unknown>
      const loadedInstance = loadedInstancesByModel.get(m.id) as
        | { config?: Record<string, unknown> }
        | undefined
      const loadedConfig =
        loadedInstance && typeof loadedInstance.config === 'object'
          ? (loadedInstance.config as Record<string, unknown>)
          : {}

      // Metadata fields may be objects (e.g. quantization: {name, bits_per_weight})
      // Flatten to strings for the renderer
      let quantization: string | undefined
      if (meta.quantization != null) {
        quantization = typeof meta.quantization === 'object'
          ? (meta.quantization as Record<string, unknown>).name as string
          : String(meta.quantization)
      }

      let parameterCount: string | undefined
      const rawParameterCount =
        meta.parameterCount
        ?? meta.paramsString
        ?? meta.params_string
      if (rawParameterCount != null) {
        parameterCount = typeof rawParameterCount === 'object'
          ? JSON.stringify(rawParameterCount)
          : String(rawParameterCount)
      }

      const contextLength = coerceNumber(
        loadedConfig.context_length,
        loadedConfig.num_ctx,
        meta.contextLength,
        meta.contextWindow,
        meta.context_size,
        meta.num_ctx,
        meta.maxContextLength,
        meta.max_context_length,
      )
      const nominalContextLength = coerceNumber(
        meta.contextLength,
        meta.contextWindow,
        meta.context_size,
        meta.num_ctx,
        meta.maxContextLength,
        meta.max_context_length,
        meta.maxContextWindow,
        meta.max_context_window,
        meta.maxTokens,
        meta.max_tokens,
      )
      const loadedContextLength = coerceNumber(
        loadedConfig.context_length,
        loadedConfig.num_ctx,
        loadedConfig.maxContextWindow,
        loadedConfig.max_context_window,
        loadedConfig.maxTokens,
        loadedConfig.max_tokens,
      )

      let displayName = m.id
      if (meta.displayName != null) {
        displayName = typeof meta.displayName === 'string' ? meta.displayName : m.id
      } else if (meta.display_name != null) {
        displayName = typeof meta.display_name === 'string' ? meta.display_name : m.id
      } else if (meta.name != null) {
        displayName = typeof meta.name === 'string' ? meta.name : m.id
      }

      const ollamaRequestedOptions = currentSettings
        ? buildOllamaOptionsRecord(
            resolveManagedOllamaProfile(
              currentSettings.ollama,
              m.id,
              m.runtimeId,
            ),
          )
        : undefined
      const lmstudioRequestedOptions = currentSettings
        ? buildLmStudioRequestOptionsRecord(
            resolveManagedLmStudioProfile(
              currentSettings.lmstudio,
              m.id,
              m.runtimeId,
              displayName,
              os.totalmem(),
            ),
          )
        : undefined
      const runtimeConfig =
        m.runtimeId === 'ollama-native' || m.runtimeId === 'ollama-openai'
          ? {
              provider: 'ollama' as const,
              baseParameters: normalizeNumericRecord(meta.parameters),
              baseParametersText:
                typeof meta.parametersText === 'string'
                  ? meta.parametersText
                  : typeof meta.parameters === 'string'
                    ? meta.parameters
                    : undefined,
              requestedOptions: ollamaRequestedOptions,
              loadedOptions:
                Object.keys(loadedConfig).length > 0
                  ? loadedConfig
                  : undefined,
              nominalContextLength,
              loadedContextLength,
              approxGpuResidencyPercent: computeApproxGpuResidencyPercent(loadedConfig),
            }
          : m.runtimeId === 'lmstudio-native' || m.runtimeId === 'lmstudio-openai'
            ? {
                provider: 'lmstudio' as const,
                requestedOptions: lmstudioRequestedOptions,
                loadedOptions:
                  Object.keys(loadedConfig).length > 0
                    ? loadedConfig
                    : undefined,
                nominalContextLength,
                loadedContextLength,
              }
              : m.runtimeId === 'omlx-openai'
                ? {
                    provider: 'omlx' as const,
                    loadedOptions:
                      Object.keys(loadedConfig).length > 0
                        ? loadedConfig
                        : undefined,
                    nominalContextLength,
                    loadedContextLength,
                  }
          : undefined

      const modelKey = modelTargetKey({
        runtimeId: rt.runtime.id,
        modelId: m.id,
      })
      mappedKeys.add(modelKey)

      models.push({
        id: m.id,
        name: displayName,
        runtimeId: rt.runtime.id,
        runtimeName: rt.runtime.displayName,
        parameterCount,
        quantization,
        contextLength,
        status: pendingLoadKeys.has(modelKey) || loadingIds.has(m.id)
          ? 'loading'
          : loadedIds.has(m.id)
            ? 'loaded'
            : 'available',
        attachmentSupport: deriveAttachmentSupport(m.capabilities as CapabilityRecord[]),
        runtimeConfig,
      })
    }

    for (const target of pendingLoadTargets) {
      const modelKey = modelTargetKey(target)
      if (target.runtimeId !== rt.runtime.id || mappedKeys.has(modelKey)) {
        continue
      }

      mappedKeys.add(modelKey)
      models.push({
        id: target.modelId,
        name: target.modelId,
        runtimeId: rt.runtime.id,
        runtimeName: rt.runtime.displayName,
        status: 'loading',
        attachmentSupport: deriveAttachmentSupport([]),
      })
    }
  }

  return models
}

function buildSessionDetailMessages(
  snapshot: SessionSnapshot,
  appMessages?: AppMessage[],
): SessionDetailMessage[] {
  const sanitizedAppMessages = (appMessages ?? []).map((message) => {
    if (message.role !== 'assistant') {
      return message
    }

    const content = sanitizeRenderableContentBlocks(message.content)
    return content === message.content
      ? message
      : {
          ...message,
          content,
        }
  })
  // Build messages from SDK history
  const sdkMessages: SessionDetailMessage[] = snapshot.history
    .filter((m) => {
      if (m.role === 'user') {
        return true
      }

      if (m.role !== 'assistant') {
        return false
      }

      if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        return false
      }

      const compaction = m.metadata?.compaction as Record<string, unknown> | undefined
      if (compaction?.kind === 'summary') {
        return false
      }

      return m.content.some(
        (content) =>
          content.type === 'text'
          && stripAssistantTransportArtifacts(content.text).trim().length > 0,
      )
    })
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.map((c) => {
        if (c.type === 'text') {
          return {
            type: 'text',
            text: stripAssistantTransportArtifacts(c.text),
          }
        }
        if (c.type === 'image_url') {
          const displayUrl = toDisplayAssetUrl(c.url)
          return {
            type: 'image',
            url: displayUrl,
            alt: path.basename(c.url),
            filename: path.basename(c.url),
            mediaType: c.mediaType,
          }
        }
        if (c.type === 'audio_url') {
          return {
            type: 'audio',
            url: toDisplayAssetUrl(c.url),
            filename: path.basename(c.url),
            mediaType: c.mediaType,
          }
        }
        return { type: 'text', text: '[unsupported content]' }
      }),
      timestamp: new Date(m.createdAt).getTime(),
    }))

  return mergeSessionMessages(sdkMessages, sanitizedAppMessages)
}

function snapshotToDetail(
  snapshot: SessionSnapshot,
  meta: SessionMeta,
  draftText = '',
  appMessages?: AppMessage[],
  pendingTurn?: PendingTurn | null,
  pendingCompaction?: PendingCompaction | null,
  pendingPlanQuestion?: PendingPlanQuestion | null,
  pendingPlanExit?: PendingPlanExit | null,
  pendingToolApproval?: PendingToolApproval | null,
  isGenerating = false,
  isCompacting = false,
): Record<string, unknown> {
  const config = getSessionConfig(snapshot)
  const sessionMode = resolveAppSessionMode(config)
  const allMessages = buildSessionDetailMessages(snapshot, appMessages)

  return {
    id: meta.id,
    title: meta.title,
    titleSource: meta.titleSource,
    modelId: snapshot.modelId,
    runtimeId: snapshot.runtimeId,
    usesTemporaryModelOverride: usesTemporaryModelOverride(snapshot),
    conversationKind: config.conversationKind,
    workMode: sessionMode,
    planMode: config.planMode,
    selectedSkillIds: config.selectedSkillIds,
    selectedSkillNames: config.selectedSkillNames,
    selectedToolIds: config.selectedToolIds,
    selectedToolNames: config.selectedToolNames,
    workingDirectory: snapshot.workingDirectory,
    lastMessage: meta.lastMessage,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sessionTags: meta.sessionTags ?? [],
    draftText,
    messages: allMessages,
    isGenerating,
    isCompacting,
    pendingCompaction,
    pendingPlanQuestion,
    pendingPlanExit,
    pendingToolApproval,
    streamingContent:
      pendingTurn && pendingTurn.content.length > 0
        ? sanitizeRenderableContentBlocks(pendingTurn.content)
        : null,
  }
}

function metaToSummary(
  meta: SessionMeta,
  snapshot?: SessionSnapshot | null,
  activeTask?: 'generation' | 'compaction',
): Record<string, unknown> {
  const config = snapshot ? getSessionConfig(snapshot) : null
  return {
    id: meta.id,
    title: meta.title,
    titleSource: meta.titleSource,
    modelId: snapshot?.modelId ?? '',
    runtimeId: snapshot?.runtimeId ?? '',
    usesTemporaryModelOverride: usesTemporaryModelOverride(snapshot),
    conversationKind: config?.conversationKind ?? 'normal',
    workMode: config ? resolveAppSessionMode(config) : 'explore',
    planMode: config?.planMode ?? false,
    selectedSkillIds: config?.selectedSkillIds ?? [],
    selectedSkillNames: config?.selectedSkillNames ?? [],
    selectedToolIds: config?.selectedToolIds ?? [],
    selectedToolNames: config?.selectedToolNames ?? [],
    workingDirectory: snapshot?.workingDirectory ?? '',
    lastMessage: meta.lastMessage,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    isGenerating: activeTask === 'generation',
    isCompacting: activeTask === 'compaction',
    runningProcesses: listRunningBackgroundProcesses(meta.id),
    sessionTags: meta.sessionTags ?? [],
  }
}

async function listSessionSummaries(): Promise<Record<string, unknown>[]> {
  const metas = store.listMeta()
  const summaries = []
  for (const meta of metas) {
    const persisted = await store.load(meta.id)
    if (persisted?.snapshot && isHiddenSessionSnapshot(persisted.snapshot)) {
      continue
    }
    summaries.push(
        metaToSummary(
          meta,
          persisted?.snapshot,
          getSessionExecutionTask(meta.id),
        ),
    )
  }
  return summaries
}

async function broadcastSessionsChanged(): Promise<void> {
  const summaries = await listSessionSummaries()
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'sessions:changed',
    summaries,
    'sessions:changed',
  )

  if (sidebarStore) {
    await syncSidebarState()
  }
}

// ── System Stats (macOS) ──

let lastCpuTimes: { idle: number; total: number } | null = null

function getCpuUsage(): number {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
  }

  if (!lastCpuTimes) {
    lastCpuTimes = { idle, total }
    return 0
  }

  const idleDelta = idle - lastCpuTimes.idle
  const totalDelta = total - lastCpuTimes.total
  lastCpuTimes = { idle, total }

  if (totalDelta === 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 100)
}

function getGpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    execFile('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], (err, stdout) => {
      if (err || !stdout) {
        resolve(-1)
        return
      }

      const patterns = [
        /"Device Utilization %"\s*=\s*(\d+)/g,
        /"Renderer Utilization %"\s*=\s*(\d+)/g,
        /"GPU Core Utilization\(%\)"\s*=\s*(\d+)/g,
        /"gpu-core-utilization"\s*=\s*(\d+)/g,
      ]

      const matches = patterns.flatMap((pattern) =>
        Array.from(stdout.matchAll(pattern), (match) =>
          parseInt(match[1] ?? '0', 10),
        ),
      )

      resolve(matches.length > 0 ? Math.max(...matches) : -1)
    })
  })
}

function getMemoryUsage(): Promise<{ usedGB: number; totalGB: number }> {
  const totalBytes = os.totalmem()
  const totalGB = totalBytes / 1073741824

  return new Promise((resolve) => {
    // vm_stat gives accurate memory breakdown matching Activity Monitor
    execFile('vm_stat', (err, stdout) => {
      if (err || !stdout) {
        // Fallback to os.freemem (less accurate)
        const used = totalBytes - os.freemem()
        resolve({ usedGB: Math.round((used / 1073741824) * 10) / 10, totalGB: Math.round(totalGB * 10) / 10 })
        return
      }

      const pageSizeMatch = /page size of (\d+) bytes/.exec(stdout)
      const pageSize = pageSizeMatch?.[1]
        ? parseInt(pageSizeMatch[1], 10)
        : 16384

      const parse = (label: string): number => {
        const match = new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)
        return match?.[1] ? parseInt(match[1], 10) : 0
      }

      // Match Activity Monitor's "Memory Used" = Anonymous + Wired + Compressor
      const anonymous = parse('Anonymous pages')
      const wired = parse('Pages wired down')
      const compressor = parse('Pages occupied by compressor')

      const usedBytes = (anonymous + wired + compressor) * pageSize
      const usedGB = Math.round((usedBytes / 1073741824) * 100) / 100

      resolve({
        usedGB: Math.round(usedGB * 10) / 10,
        totalGB: Math.round(totalGB * 10) / 10,
      })
    })
  })
}

async function getSystemStats() {
  const [mem, gpuPercent] = await Promise.all([getMemoryUsage(), getGpuUsage()])

  return {
    memoryUsedGB: mem.usedGB,
    memoryTotalGB: mem.totalGB,
    gpuUsagePercent: gpuPercent >= 0 ? gpuPercent : 0,
    cpuUsagePercent: getCpuUsage(),
  }
}

// ── Initialization ──

export async function initializeGemmaDesktop(): Promise<void> {
  const currentSettings = await loadSettings()
  primaryModelHoldCounts.clear()
  activePrimaryModelTarget = null
  primaryWarmupPromise = null
  primaryModelLoadPromise = null
  primaryModelLoadTarget = null
  bootstrapPromise = null
  bootstrapState = {
    status: 'idle',
    ready: false,
    message: 'Local models will be prepared when needed.',
    ...resolveBootstrapTargets(currentSettings),
    updatedAt: Date.now(),
  }
  notificationManager.setPermissionStatus(undefined)
  if (storageResetRequired) {
    await clearPersistedAppState()
    storageResetRequired = false
  }
  await reconfigureBrowserToolManager(currentSettings)
  const extraTools = createAppTools()
  const toolPolicy = createAppToolPermissionPolicy()

  try {
    gemmaDesktop = await createGemmaDesktop({
      workingDirectory: currentSettings.defaultProjectDirectory,
      adapters: createConfiguredRuntimeAdapters(currentSettings),
      extraTools,
      toolPolicy,
      geminiApiKey: currentSettings.integrations.geminiApi.apiKey,
      geminiApiModel: currentSettings.integrations.geminiApi.model,
    })
  } catch (err) {
    console.error('[gemma-desktop] Failed to initialize SDK:', err)
    // Create with defaults — inspectEnvironment will just return empty
    gemmaDesktop = await createGemmaDesktop({
      workingDirectory: currentSettings.defaultProjectDirectory,
      adapters: createConfiguredRuntimeAdapters(currentSettings),
      extraTools,
      toolPolicy,
      geminiApiKey: currentSettings.integrations.geminiApi.apiKey,
      geminiApiModel: currentSettings.integrations.geminiApi.model,
    })
  }

  gemmaInstallManager = createGemmaInstallManager({
    confirmDownload: confirmGemmaDownload,
    isModelInstalled: isGemmaModelInstalled,
    onStatesChanged: (states) => {
      broadcastToWindows(
        BrowserWindow.getAllWindows(),
        'environment:gemma-install-changed',
        states,
        'gemma install state update',
      )
    },
  })

  sidebarStore = new SidebarStateStore(getSidebarStatePath())
  const initialSidebarState = readSidebarStateFileSync(getSidebarStatePath())
  await store.init(initialSidebarState.projectPaths)
  await recoverInterruptedPendingTurns()
  await getSidebarStateStore().init(await listSidebarSessionReferences())
  await automationStore.init()

  if (!notificationWindowStateSubscribed) {
    notificationWindowStateSubscribed = true
    app.on('browser-window-focus', () => {
      notificationManager.setWindowFocused(true)
    })
    app.on('browser-window-blur', () => {
      notificationManager.setWindowFocused(false)
    })
  }

  // Resume live sessions from persisted snapshots (best-effort)
  for (const meta of store.listMeta()) {
    let persisted = await store.load(meta.id)
    if (persisted) {
      try {
        persisted = await rehydratePersistedSession(meta.id, persisted)
        const session = await gemmaDesktop.sessions.resume({
          snapshot: persisted.snapshot,
        })
        liveSessions.set(meta.id, session)
      } catch (err) {
        console.warn(`[gemma-desktop] Could not resume session ${meta.id}:`, err)
      }
    }
  }

  if (automationScheduler) {
    clearInterval(automationScheduler)
  }
  automationScheduler = setInterval(() => {
    void checkDueAutomations()
  }, 15_000)
  void checkDueAutomations()
}

type SendSessionMessageOptions = {
  hiddenUserMessage?: boolean
  coBrowse?: boolean
}

async function sendTalkMessageInternal(
  sessionId: string,
  message: { text: string; attachments?: IncomingAttachment[] },
  options: SendSessionMessageOptions = {},
): Promise<void> {
  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'renderer->main',
    event: 'sessions.talk.send-message.request',
    summary: 'Send talk message request',
    data: summarizeMessageForDebug(message),
  })

  return await sendSessionMessageInternal(sessionId, message, 'renderer', options)
}

function stripHiddenUserMessageFromHistory(
  history: SessionSnapshot['history'],
  previousHistoryLength: number,
): SessionSnapshot['history'] {
  const prefix = history.slice(0, previousHistoryLength)
  const suffix = history.slice(previousHistoryLength)
  const hiddenUserIndex = suffix.findIndex((message) => message.role === 'user')

  return [
    ...prefix,
    ...suffix.filter((_, index) => index !== hiddenUserIndex),
  ]
}

async function sendSessionMessageInternal(
  sessionId: string,
  message: { text: string; attachments?: IncomingAttachment[] },
  source: 'renderer' | 'menu_bar' = 'renderer',
  options: SendSessionMessageOptions = {},
): Promise<void> {
  const hiddenUserMessage = options.hiddenUserMessage === true
  const coBrowseTurn = options.coBrowse === true
  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: source === 'menu_bar' ? 'main->renderer' : 'renderer->main',
    event:
      source === 'menu_bar'
        ? 'sessions.send-message.menu-bar-request'
        : 'sessions.send-message.request',
    summary:
      hiddenUserMessage
        ? 'Hidden continuation instruction'
        : source === 'menu_bar'
          ? 'Menu bar screenshot send request'
          : 'Send message request',
    data: summarizeMessageForDebug(message),
  })

  if (hiddenUserMessage && (message.attachments?.length ?? 0) > 0) {
    throw new Error('Hidden continuation instructions do not accept attachments.')
  }

  if (
    message.text.trim().length === 0
    && (message.attachments?.length ?? 0) === 0
  ) {
    throw new Error('Cannot send an empty message.')
  }

  const requestStartedAt = Date.now()

  if (isSessionExecutionBusy(sessionId)) {
    throw new Error('This session is already generating a response.')
  }
  const releaseExecutionGate = beginConversationExecutionGate(sessionId, 'generation')

  let session!: GemmaDesktopSession
  let persisted: PersistedSession | null
  let sessionSnapshot: SessionSnapshot
  let currentSettings: AppSettingsRecord
  let restoreCoBrowseSessionComposition: ((latestSnapshot: SessionSnapshot) => Promise<{
    session: GemmaDesktopSession
    snapshot: SessionSnapshot
  }>) | null = null
  const restoreCoBrowseCompositionIfNeeded = async (): Promise<void> => {
    if (!restoreCoBrowseSessionComposition) {
      return
    }

    const restored = await restoreCoBrowseSessionComposition(session.snapshot())
    session = restored.session
    sessionSnapshot = restored.snapshot
    restoreCoBrowseSessionComposition = null
  }

  try {
    const resumed = await getOrResumeLiveSession(sessionId)
    session = resumed.session
    persisted = resumed.persisted
    sessionSnapshot = session.snapshot()
    currentSettings = await getSettingsState()
    const inferredWorkingDirectory = hiddenUserMessage
      ? null
      : await inferConversationWorkingDirectory({
          currentWorkingDirectory: sessionSnapshot.workingDirectory,
          defaultWorkingDirectory: currentSettings.defaultProjectDirectory,
          currentMessageText: message.text,
          appMessages: store.getAppMessages(sessionId),
        })

    if (
      inferredWorkingDirectory
      && inferredWorkingDirectory.workingDirectory !== sessionSnapshot.workingDirectory
    ) {
      const nextSnapshot: SessionSnapshot = {
        ...sessionSnapshot,
        workingDirectory: inferredWorkingDirectory.workingDirectory,
        savedAt: new Date().toISOString(),
      }

      session = await gemmaDesktop.sessions.resume({
        snapshot: nextSnapshot,
      })
      persisted = await getPersistedSession(sessionId)
      sessionSnapshot = nextSnapshot
      liveSessions.set(sessionId, session)
      await store.save(
        sessionId,
        nextSnapshot,
        undefined,
        store.getAppMessages(sessionId),
      )
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'sessions.send-message.auto-reanchor',
        summary:
          inferredWorkingDirectory.source === 'current_message'
            ? `Auto-switched session folder to ${inferredWorkingDirectory.workingDirectory}`
            : `Recovered session folder from earlier user path ${inferredWorkingDirectory.matchedPath}`,
        data: inferredWorkingDirectory,
      })
      const currentMeta = store.getMeta(sessionId) ?? persisted?.meta
      if (!currentMeta) {
        throw new Error(`Session metadata missing for ${sessionId}`)
      }
      sendToSession(sessionId, {
        type: 'session_reset',
        session: snapshotToDetail(
          nextSnapshot,
          currentMeta,
          store.getDraftText(sessionId),
          store.getAppMessages(sessionId),
          store.getPendingTurn(sessionId),
          store.getPendingCompaction(sessionId),
          store.getPendingPlanQuestion(sessionId),
          store.getPendingPlanExit(sessionId),
          store.getPendingToolApproval(sessionId),
          false,
          false,
        ),
      })
      await broadcastSessionsChanged()
    }

    const syncedPreferences = await syncSessionRequestPreferences(
      sessionId,
      session,
      sessionSnapshot,
      currentSettings,
    )
    session = syncedPreferences.session
    sessionSnapshot = syncedPreferences.snapshot

    if (coBrowseTurn) {
      const coBrowseComposition = await applyCoBrowseSessionComposition(
        sessionId,
        sessionSnapshot,
      )
      session = coBrowseComposition.session
      sessionSnapshot = coBrowseComposition.snapshot
      restoreCoBrowseSessionComposition = coBrowseComposition.restore
    }
  } catch (error) {
    releaseExecutionGate()
    throw error
  }

  const userMessagePreview = buildUserMessagePreviewText(
    message.text,
    message.attachments ?? [],
  )
  let userMessage: AppMessage | null = hiddenUserMessage
    ? null
    : {
        id: `user-${Date.now()}-${randomUUID()}`,
        role: 'user',
        content: buildOptimisticUserMessageContent(
          message.text,
          message.attachments ?? [],
        ),
        timestamp: requestStartedAt,
      }
  if (userMessage) {
    publishOptimisticUserMessage({
      sessionId,
      snapshot: sessionSnapshot,
      message: userMessage,
      lastMessagePreview: userMessagePreview,
    })
  }

  const primaryTarget: PrimaryModelTarget = {
    modelId: sessionSnapshot.modelId,
    runtimeId: sessionSnapshot.runtimeId,
  }
  let releasePrimaryLease: (() => void) | null = null
  try {
    releasePrimaryLease = await acquirePrimaryModelLease(sessionId, primaryTarget)
    await validateOutgoingAttachmentsForSession({
      attachments: message.attachments ?? [],
      snapshot: sessionSnapshot,
    })

    let persistedAttachments: PersistedAttachment[] = []
    try {
      const result = await persistIncomingAttachments({
        attachments: message.attachments ?? [],
        getAssetDirectory: async () =>
          await ensureSessionAssetDirectory(sessionId, sessionSnapshot.workingDirectory),
      })
      persistedAttachments = result.attachments

      for (const record of result.pdfDebugRecords) {
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'main->renderer',
          event: 'sessions.attachments.pdf-converted',
          summary: `Converted ${record.sourceName} pages ${record.processedRange.startPage}-${record.processedRange.endPage}`,
          data: record,
        })
      }
    } catch (error) {
      if (error instanceof PdfAttachmentConversionError) {
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'main->renderer',
          event: 'sessions.attachments.pdf-conversion-error',
          summary: error.message,
          data: error.debugData,
        })
      }
      throw error
    }

    const finalizedUserMessageContent = buildUserMessageContent(
      message.text,
      persistedAttachments,
    )
    if (
      userMessage
      && !appMessageContentMatches(userMessage.content, finalizedUserMessageContent)
    ) {
      userMessage = {
        ...userMessage,
        content: finalizedUserMessageContent,
      }
      refreshOptimisticUserMessage({
        sessionId,
        snapshot: sessionSnapshot,
        message: userMessage,
      })
    }

    const compactionStatus = await ensureSessionCompactedBeforeMessage(
      sessionId,
      session,
    )
    if (compactionStatus.status === 'cancelled') {
      await persistSessionStateWithRecoveredUserHistory(sessionId, session)
      return
    }
    if (compactionStatus.status === 'error') {
      throw new Error(
        compactionStatus.error
          ?? 'Compaction failed before the next turn could start.',
      )
    }
  const abortController = new AbortController()
  activeAbortControllers.set(sessionId, abortController)
  markConversationExecutionActive(sessionId, 'generation')
  const turnStartedAt = requestStartedAt
  let liveActivity = createInitialSessionLiveActivity(turnStartedAt)
  let runtimeTurnId: string | undefined
  const contentBlocks: StreamingContentBlock[] = []
  let lastPendingFlushAt = 0

  const persistPendingTurn = (force = false): void => {
    if (!runtimeTurnId) {
      return
    }

    store.setSnapshot(sessionId, session.snapshot())
    store.setPendingTurn(sessionId, {
      turnId: runtimeTurnId,
      content: serializeStreamingBlocks(contentBlocks),
      startedAt: turnStartedAt,
    })

    const now = Date.now()
    if (!force && now - lastPendingFlushAt < 400) {
      return
    }

    lastPendingFlushAt = now
    void store.flush(sessionId).catch(() => {})
  }

  const buildStreamingBlocks = () => serializeStreamingBlocks(contentBlocks)
  const getToolBlocks = (): StreamingToolCallBlock[] =>
    contentBlocks.filter(isStreamingToolCallBlock)
  const replaceToolBlocks = (nextBlocks: StreamingToolCallBlock[]): void => {
    let nextIndex = 0
    for (let index = 0; index < contentBlocks.length; index += 1) {
      const block = contentBlocks[index]
      if (!block || !isStreamingToolCallBlock(block)) {
        continue
      }

      contentBlocks[index] = nextBlocks[nextIndex]!
      nextIndex += 1
    }
  }
  const replaceToolCallBlockContent = (
    callId: string,
    nextBlocks: StreamingContentBlock[],
    progressDelta = 1,
  ): void => {
    const timestamp = Date.now()
    const blockIndex = contentBlocks.findIndex(
      (block) => isStreamingToolCallBlock(block) && block.callId === callId,
    )
    if (blockIndex < 0) {
      return
    }

    contentBlocks.splice(blockIndex, 1, ...nextBlocks)
    emitLiveToolActivity(timestamp, progressDelta)
    sendToSession(sessionId, {
      type: 'content_delta',
      blocks: buildStreamingBlocks(),
    })
  }
  const emitLiveToolActivity = (
    timestamp: number,
    progressDelta = 1,
  ): void => {
    liveActivity = refreshLiveActivityFromToolBlocks(
      liveActivity,
      getToolBlocks(),
      timestamp,
      progressDelta,
    )
    sendToSession(sessionId, { type: 'live_activity', activity: liveActivity })
  }

  const pushStreamingToolBlock = (block: StreamingToolCallBlock): void => {
    contentBlocks.push(block)
    emitLiveToolActivity(block.startedAt ?? Date.now())
    sendToSession(sessionId, {
      type: 'content_delta',
      blocks: buildStreamingBlocks(),
    })
  }

  const updateStreamingToolBlock = (
    callId: string,
    updater: (block: StreamingToolCallBlock, timestamp: number) => StreamingToolCallBlock,
    progressDelta = 1,
  ): void => {
    const timestamp = Date.now()
    let changed = false
    for (let index = 0; index < contentBlocks.length; index += 1) {
      const block = contentBlocks[index]
      if (!block || !isStreamingToolCallBlock(block) || block.callId !== callId) {
        continue
      }
      contentBlocks[index] = updater(block, timestamp)
      changed = true
      break
    }
    if (!changed) {
      return
    }
    emitLiveToolActivity(timestamp, progressDelta)
    sendToSession(sessionId, {
      type: 'content_delta',
      blocks: buildStreamingBlocks(),
    })
  }

  const helperToolCallId = `assistant-helper-${requestStartedAt}`
  const helperActivity = {
    consultedForTurnAudit: false,
    completedTurnMessage: false,
    restartedTurn: false,
    recoveredFailedTurn: false,
    restartInstruction: null as string | null,
    completionMessage: null as string | null,
    helperModelId: null as string | null,
    helperRuntimeId: null as string | null,
  }

  const recordHelperConsultation = (input: {
    helperModelId: string
    helperRuntimeId: string
    progressId: string
    label: string
    summary?: string
    tone?: ToolProgressEntry['tone']
  }): void => {
    const timestamp = Date.now()
    helperActivity.helperModelId = input.helperModelId
    helperActivity.helperRuntimeId = input.helperRuntimeId
    const existingBlock = getToolBlocks().find((block) => block.callId === helperToolCallId)

    if (!existingBlock) {
      pushStreamingToolBlock({
        type: 'tool_call',
        toolName: 'Gemma low helper',
        input: {
          modelId: input.helperModelId,
          runtimeId: input.helperRuntimeId,
        },
        status: 'running',
        summary: input.summary,
        startedAt: timestamp,
        callId: helperToolCallId,
        progressEntries: [{
          id: input.progressId,
          label: input.label,
          timestamp,
          tone: input.tone,
        }],
      })
      return
    }

    updateStreamingToolBlock(helperToolCallId, (block) =>
      appendStreamingToolProgress(
        {
          ...block,
          input: {
            ...block.input,
            modelId: input.helperModelId,
            runtimeId: input.helperRuntimeId,
          },
          status: 'running',
          summary: input.summary ?? block.summary,
        },
        {
          id: input.progressId,
          label: input.label,
          timestamp,
          tone: input.tone,
        },
      ),
    )
  }

  const finalizeHelperToolBlock = (): void => {
    const existingBlock = getToolBlocks().find((block) => block.callId === helperToolCallId)
    if (!existingBlock) {
      return
    }

    updateStreamingToolBlock(helperToolCallId, (block, timestamp) => ({
      ...block,
      status: 'success',
      summary: buildAssistantHelperToolSummary(helperActivity),
      output: buildAssistantHelperToolOutput(helperActivity) ?? block.output,
      input: {
        ...block.input,
        ...(helperActivity.restartInstruction
          ? { restartInstruction: helperActivity.restartInstruction }
          : {}),
        ...(helperActivity.completionMessage
          ? { completionMessage: helperActivity.completionMessage }
          : {}),
      },
      completedAt: timestamp,
    }), 0)
  }

  const appendStreamingToolProgress = (
    block: StreamingToolCallBlock,
    input: {
      id: string
      label: string
      timestamp: number
      tone?: ToolProgressEntry['tone']
    },
  ): StreamingToolCallBlock => {
    const progressEntries = [...(block.progressEntries ?? [])]
    const existingIndex = progressEntries.findIndex((entry) => entry.id === input.id)
    const nextEntry: ToolProgressEntry = {
      id: input.id,
      label: input.label,
      timestamp: input.timestamp,
      tone: input.tone,
    }

    if (existingIndex >= 0) {
      progressEntries[existingIndex] = nextEntry
    } else {
      progressEntries.push(nextEntry)
    }

    return {
      ...block,
      progressEntries: progressEntries.slice(-8),
    }
  }

  if (!hiddenUserMessage) {
    void maybeGenerateAutoSessionTitle({
      sessionId,
      snapshot: session.snapshot(),
      promptText: message.text,
      fallbackSummary: userMessagePreview,
    })
  }
  sendToSession(sessionId, { type: 'generation_started' })
  sendToSession(sessionId, { type: 'live_activity', activity: liveActivity })
  void broadcastSessionsChanged().catch(() => {})

    try {
    const contextLength = await resolveSessionContextLength(sessionSnapshot)
    const pdfWorker = await resolveSessionFileWorkerCapabilitySnapshot(sessionId)
    const pdfAttachments = persistedAttachments.filter(
      (attachment): attachment is PersistedPdfAttachment =>
        attachment.kind === 'pdf',
    )

    if (pdfAttachments.length > 0) {
      const totalPdfPromptBudget = Math.max(
        Math.floor(contextLength * 0.3),
        6_000,
      )
      const perPdfPromptBudget = Math.max(
        2_500,
        Math.floor(totalPdfPromptBudget / pdfAttachments.length),
      )

      const derivedAttachments: PersistedAttachment[] = []
      for (const attachment of persistedAttachments) {
        if (attachment.kind !== 'pdf') {
          derivedAttachments.push(attachment)
          continue
        }

        const callId = `prepare-pdf-${randomUUID()}`
        pushStreamingToolBlock({
          type: 'tool_call',
          toolName: 'prepare_pdf_attachment',
          input: {
            filename: attachment.name,
            processedPages: `${attachment.processedRange.startPage}-${attachment.processedRange.endPage}`,
            pageCount: attachment.pageCount,
          },
          status: 'running',
          startedAt: Date.now(),
          callId,
          summary: `Preparing ${attachment.name}`,
          progressEntries: [
            {
              id: 'pdf-start',
              label: 'Starting PDF preparation',
              timestamp: Date.now(),
            },
          ],
        })

        try {
          const derivedAttachment = await derivePersistedPdfAttachmentForTurn({
            attachment,
            goal: message.text.trim().length > 0
              ? message.text.trim()
              : `Prepare ${attachment.name} for later conversation.`,
            worker: pdfWorker,
            contextLength,
            promptTokenBudget: perPdfPromptBudget,
            sessionMetadata: await buildPdfWorkerSessionMetadata(primaryTarget),
            signal: abortController.signal,
            onProgress: (progress) => {
              updateStreamingToolBlock(callId, (block, timestamp) => {
                switch (progress.stage) {
                  case 'start':
                    return appendStreamingToolProgress(block, {
                      id: 'pdf-start',
                      label: `Queued ${progress.renderedPageCount} page${progress.renderedPageCount === 1 ? '' : 's'} for extraction`,
                      timestamp,
                    })
                  case 'page':
                    return appendStreamingToolProgress(block, {
                      id: `pdf-page-${progress.pageNumber}`,
                      label: `Extracted page ${progress.pageNumber} of ${progress.totalPages}`,
                      timestamp,
                    })
                  case 'chunk':
                    return appendStreamingToolProgress(block, {
                      id: `pdf-chunk-${progress.chunkIndex}`,
                      label: `Condensed chunk ${progress.chunkIndex} of ${progress.chunkCount}`,
                      timestamp,
                    })
                  case 'synthesis':
                    return appendStreamingToolProgress(block, {
                      id: 'pdf-synthesis',
                      label: 'Synthesizing reusable PDF context',
                      timestamp,
                    })
                  case 'complete':
                    return {
                      ...appendStreamingToolProgress(block, {
                        id: 'pdf-complete',
                        label: `Prepared about ${progress.promptTokenEstimate.toLocaleString()} tokens of PDF context`,
                        timestamp,
                        tone: 'success',
                      }),
                      summary: `Prepared ${attachment.name}`,
                    }
                }
              })
            },
          })
          derivedAttachments.push(derivedAttachment)

          updateStreamingToolBlock(callId, (block, timestamp) => ({
            ...block,
            status: 'success',
            completedAt: timestamp,
            summary: derivedAttachment.derivedSummary ?? `Prepared ${attachment.name}`,
            output: derivedAttachment.derivedSummary
              ? [
                  derivedAttachment.derivedSummary,
                  derivedAttachment.derivedPromptTokenEstimate != null
                    ? `Prepared context: about ${derivedAttachment.derivedPromptTokenEstimate.toLocaleString()} tokens.`
                    : null,
                ].filter(Boolean).join('\n\n')
              : `Prepared ${attachment.name}.`,
          }))
          appendDebugLog(sessionId, {
            layer: 'ipc',
            direction: 'main->renderer',
            event: 'sessions.attachments.pdf-derived',
            summary: `Prepared ${attachment.name}`,
            data: {
              file: attachment.path,
              derivedTextPath: derivedAttachment.derivedTextPath,
              derivedArtifactPath: derivedAttachment.derivedArtifactPath,
              derivedPromptTokenEstimate: derivedAttachment.derivedPromptTokenEstimate,
              derivedByModelId: derivedAttachment.derivedByModelId,
              derivedByRuntimeId: derivedAttachment.derivedByRuntimeId,
            },
          })
        } catch (error) {
          updateStreamingToolBlock(callId, (block, timestamp) => ({
            ...block,
            status: 'error',
            completedAt: timestamp,
            output: error instanceof Error ? error.message : String(error),
          }))
          throw error
        }
      }

      persistedAttachments = derivedAttachments
      const derivedUserMessageContent = buildUserMessageContent(
        message.text,
        persistedAttachments,
      )
      if (
        userMessage
        && !appMessageContentMatches(userMessage.content, derivedUserMessageContent)
      ) {
        userMessage = {
          ...userMessage,
          content: derivedUserMessageContent,
        }
        refreshOptimisticUserMessage({
          sessionId,
          snapshot: sessionSnapshot,
          message: userMessage,
        })
      }
    }

    const hiddenInputHistoryLength = hiddenUserMessage
      ? session.snapshot().history.length
      : null
    const sessionInput = buildSessionInputFromUserMessage({
      text: message.text,
      attachments: persistedAttachments,
      capabilityContext: sessionSnapshot.capabilityContext,
    })

    const streamResult = await session.runStreamed(sessionInput, {
      signal: abortController.signal,
      debug: (event) => {
        appendDebugLog(sessionId, {
          layer: 'runtime',
          direction:
            event.stage === 'request'
              ? 'sdk->runtime'
              : 'runtime->sdk',
          event: `runtime.${event.transport}.${event.stage}`,
          summary: summarizeRuntimeDebugEvent(event),
          turnId: runtimeTurnId,
          data: event,
        })
      },
    })
    runtimeTurnId = streamResult.turnId
    store.setSnapshot(sessionId, session.snapshot())
    store.setPendingTurn(sessionId, {
      turnId: runtimeTurnId,
      content: serializeStreamingBlocks(contentBlocks),
      startedAt: turnStartedAt,
    })
    void store.flush(sessionId).catch(() => {})

    let autoCompletedPlanExit = false

    streamLoop:
    for await (const event of streamResult.events) {
      if (abortController.signal.aborted) break

      const e = event as GemmaDesktopEvent
      appendDebugLog(sessionId, {
        layer: 'sdk',
        direction: 'sdk->app',
        event: e.type,
        summary: summarizeGemmaDesktopEvent(e),
        turnId: e.turnId,
        data: summarizeSdkEventForDebug(e),
      })

      switch (e.type) {
        case 'session.started':
        case 'turn.started':
        case 'turn.step.started':
        case 'content.completed':
        case 'runtime.lifecycle': {
          liveActivity = {
            ...liveActivity,
            lifecycleEvents: liveActivity.lifecycleEvents + 1,
            lastEventAt: Date.now(),
          }
          sendToSession(sessionId, { type: 'live_activity', activity: liveActivity })
          break
        }
        case 'content.delta': {
          const payload = e.payload as { channel?: string; delta?: string }
          if (payload.channel === 'assistant' || !payload.channel) {
            const sanitizedDelta = appendStreamingDelta(
              contentBlocks,
              'text',
              payload.delta ?? '',
            )
            liveActivity = {
              ...liveActivity,
              state: 'streaming',
              lastChannel: 'assistant',
              assistantUpdates: liveActivity.assistantUpdates + 1,
              lastEventAt: Date.now(),
              firstTokenAt: liveActivity.firstTokenAt ?? Date.now(),
            }
            if (sanitizedDelta.length > 0) {
              sendToSession(sessionId, {
                type: 'content_delta_append',
                blockType: 'text',
                delta: sanitizedDelta,
              })
            }
            sendToSession(sessionId, { type: 'live_activity', activity: liveActivity })
            persistPendingTurn()
          } else if (payload.channel === 'reasoning') {
            const sanitizedDelta = appendStreamingDelta(
              contentBlocks,
              'thinking',
              payload.delta ?? '',
            )
            liveActivity = {
              ...liveActivity,
              state: liveActivity.assistantUpdates > 0 ? 'streaming' : 'thinking',
              lastChannel: 'reasoning',
              reasoningUpdates: liveActivity.reasoningUpdates + 1,
              lastEventAt: Date.now(),
            }
            if (sanitizedDelta.length > 0) {
              sendToSession(sessionId, {
                type: 'content_delta_append',
                blockType: 'thinking',
                delta: sanitizedDelta,
              })
            }
            sendToSession(sessionId, { type: 'live_activity', activity: liveActivity })
            persistPendingTurn()
          }
          break
        }
        case 'tool.call': {
          const payload = e.payload as {
            toolName?: string
            input?: unknown
            callId?: string
          }
          const timestamp = Date.now()
          const nextToolBlocks = appendToolCallBlock(
            getToolBlocks(),
            {
              toolName: payload.toolName,
              input: normalizeUnknownRecord(payload.input),
              callId: payload.callId,
            },
            timestamp,
          )
          const nextToolBlock = nextToolBlocks[nextToolBlocks.length - 1]
          if (nextToolBlock) {
            contentBlocks.push(nextToolBlock)
          }
          emitLiveToolActivity(timestamp)
          sendToSession(sessionId, {
            type: 'content_delta',
            blocks: buildStreamingBlocks(),
          })
          persistPendingTurn(true)
          break
        }
        case 'tool.result': {
          const payload = e.payload as {
            callId?: string
            output?: string
            error?: string
            metadata?: Record<string, unknown>
            structuredOutput?: unknown
          }
          const matchedTool = getToolBlocks().find(
            (block) => block.callId === payload.callId,
          )
          const timestamp = Date.now()
          const fileEditBlocks =
            matchedTool && !isErroredToolResult({
              toolName: matchedTool.toolName,
              output: payload.output ?? '',
              metadata: payload.metadata,
              structuredOutput: payload.structuredOutput,
            } as ToolResult)
              ? extractFileEditBlocksFromToolResult({
                  toolName: matchedTool.toolName,
                  structuredOutput: payload.structuredOutput,
                  workingDirectory: sessionSnapshot.workingDirectory,
                }).map((block) => ({
                  ...block,
                  sourceToolCallId: payload.callId,
                }))
              : []
          replaceToolBlocks(
            applyToolResultToBlocks(getToolBlocks(), payload, timestamp),
          )
          if (payload.callId && fileEditBlocks.length > 0) {
            replaceToolCallBlockContent(payload.callId, fileEditBlocks, 1)
            persistPendingTurn(true)
          } else {
            emitLiveToolActivity(timestamp)
            sendToSession(sessionId, {
              type: 'content_delta',
              blocks: buildStreamingBlocks(),
            })
            persistPendingTurn(true)
          }
          if (
            !isErroredToolResult({
              toolName: matchedTool?.toolName ?? '',
              output: payload.output ?? '',
              metadata: payload.metadata,
              structuredOutput: payload.structuredOutput,
            } as ToolResult)
            && isPlanExitToolName(matchedTool?.toolName)
          ) {
            autoCompletedPlanExit = true
            abortController.abort()
            break streamLoop
          }
          break
        }
        case 'tool.progress': {
          const payload = e.payload as {
            callId?: string
            toolName?: string
            id?: string
            label?: string
            tone?: 'info' | 'success' | 'warning'
          }
          const timestamp = Date.now()
          const { blocks: nextToolBlocks, changed } = applyDirectToolProgressToBlocks(
            getToolBlocks(),
            payload,
            timestamp,
          )
          if (changed) {
            replaceToolBlocks(nextToolBlocks)
            sendToSession(sessionId, {
              type: 'content_delta',
              blocks: buildStreamingBlocks(),
            })
            persistPendingTurn(true)
          }
          emitLiveToolActivity(timestamp)
          break
        }
        case 'tool.subsession.started':
        case 'tool.subsession.event':
        case 'tool.subsession.completed': {
          const payload = e.payload as {
            toolName?: string
            childSessionId?: string
            childTurnId?: string
            childEventType?: string
            childPayload?: unknown
          }
          const timestamp = Date.now()
          const { blocks: nextToolBlocks, changed } = applyDelegatedProgressToBlocks(
            getToolBlocks(),
            {
              parentToolCallId: e.parentToolCallId,
              parentToolName: payload.toolName,
              kind:
                e.type === 'tool.subsession.started'
                  ? 'started'
                  : e.type === 'tool.subsession.completed'
                  ? 'completed'
                  : 'event',
              childSessionId: payload.childSessionId,
              childTurnId: payload.childTurnId,
              childEventType: payload.childEventType,
              childPayload: payload.childPayload,
            },
            timestamp,
          )
          if (changed) {
            replaceToolBlocks(nextToolBlocks)
            sendToSession(sessionId, {
              type: 'content_delta',
              blocks: buildStreamingBlocks(),
            })
            persistPendingTurn(true)
          }
          emitLiveToolActivity(timestamp)
          break
        }
      }
    }

    if (autoCompletedPlanExit) {
      try {
        await streamResult.completed
      } catch {
        // Aborting after exit_plan_mode is expected; we keep the rendered handoff content.
      }

      finalizeHelperToolBlock()

      const durationMs = Math.max(Date.now() - turnStartedAt, 1)
      const assistantMessage =
        buildCompletedAssistantMessageFromBlocks(
          runtimeTurnId ?? streamResult.turnId,
          contentBlocks,
          durationMs,
        )
        ?? {
          id: runtimeTurnId ?? streamResult.turnId,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Plan handoff prepared. Switch this session back to work mode when you are ready.',
            },
          ],
          timestamp: Date.now(),
          durationMs,
        }

      store.clearPendingTurn(sessionId)
      store.upsertAppMessage(sessionId, assistantMessage)
      sendToSession(sessionId, { type: 'live_activity', activity: null })
      sendToSession(sessionId, {
        type: 'turn_complete',
        message: assistantMessage,
      })
      notifySessionCompleted(sessionId, assistantMessage)

      const handoffPreview = assistantMessage.content.find(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )
      const handoffPreviewText =
        handoffPreview && typeof handoffPreview.text === 'string'
          ? handoffPreview.text
          : userMessagePreview
      await store.save(sessionId, session.snapshot(), {
        lastMessage: handoffPreviewText.slice(0, 120) || userMessagePreview,
      })

      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.turn.auto-completed-plan-exit',
        summary: 'Stopped the turn after exit_plan_mode prepared the handoff',
        turnId: runtimeTurnId ?? streamResult.turnId,
        data: {
          sessionId,
          turnId: runtimeTurnId ?? streamResult.turnId,
        },
      })
      void broadcastSessionsChanged().catch(() => {})
      return
    }

    let effectiveResult = await streamResult.completed
    let snapshot = session.snapshot()
    if (hiddenInputHistoryLength !== null) {
      const sanitizedSnapshot: SessionSnapshot = {
        ...snapshot,
        history: stripHiddenUserMessageFromHistory(
          snapshot.history,
          hiddenInputHistoryLength,
        ),
        savedAt: new Date().toISOString(),
      }
      session = await gemmaDesktop.sessions.resume({
        snapshot: sanitizedSnapshot,
      })
      liveSessions.set(sessionId, session)
      snapshot = sanitizedSnapshot
    }
    if (restoreCoBrowseSessionComposition) {
      const restored = await restoreCoBrowseSessionComposition(snapshot)
      session = restored.session
      snapshot = restored.snapshot
      restoreCoBrowseSessionComposition = null
    }
    let assistantHistoryMessage = [...snapshot.history]
      .reverse()
      .find((entry) => entry.role === 'assistant')
    let helperCompletionMessage: string | undefined

    if (isTalkSessionConfig(getSessionConfig(snapshot)) && !abortController.signal.aborted) {
      const heartbeatAudit = await auditAssistantTurnWithHelper({
        sessionId,
        workingDirectory: snapshot.workingDirectory,
        snapshot,
        userPrompt: message.text,
        assistantText: effectiveResult.text,
        reasoningText: effectiveResult.reasoning ?? '',
        toolResults: effectiveResult.toolResults,
        signal: abortController.signal,
      })
      const heartbeatDecision = heartbeatAudit.decision
      helperActivity.consultedForTurnAudit = true
      recordHelperConsultation({
        helperModelId: heartbeatAudit.helperModelId,
        helperRuntimeId: heartbeatAudit.helperRuntimeId,
        progressId: 'turn-audit',
        label: 'Checking the completed Assistant Chat turn',
        summary: 'Checking whether the turn needs a cleaner finish',
      })

      if (
        heartbeatDecision.action === 'complete'
        && heartbeatDecision.completionMessage
      ) {
        helperCompletionMessage = heartbeatDecision.completionMessage
        helperActivity.completedTurnMessage = true
        helperActivity.completionMessage = heartbeatDecision.completionMessage
        recordHelperConsultation({
          helperModelId: heartbeatAudit.helperModelId,
          helperRuntimeId: heartbeatAudit.helperRuntimeId,
          progressId: 'turn-completion',
          label: 'Filling in the missing completion',
          summary: 'Filling in the missing completion',
          tone: 'success',
        })
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'sessions.assistant-heartbeat.complete',
          summary: 'Helper supplied a missing assistant completion message',
          turnId: effectiveResult.turnId,
          data: {
            sessionId,
            turnId: effectiveResult.turnId,
            completionMessage: helperCompletionMessage,
          },
        })
      } else if (
        heartbeatDecision.action === 'restart'
        && heartbeatDecision.restartInstruction
      ) {
        helperActivity.restartedTurn = true
        helperActivity.restartInstruction = heartbeatDecision.restartInstruction
        recordHelperConsultation({
          helperModelId: heartbeatAudit.helperModelId,
          helperRuntimeId: heartbeatAudit.helperRuntimeId,
          progressId: 'turn-restart',
          label: 'Restarting the turn with one hidden nudge',
          summary: 'Restarting the turn once with a hidden nudge',
          tone: 'warning',
        })
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'app->sdk',
          event: 'sessions.assistant-heartbeat.restart',
          summary: 'Helper requested one hidden continuation of the assistant turn',
          turnId: effectiveResult.turnId,
          data: {
            sessionId,
            turnId: effectiveResult.turnId,
            restartInstruction: heartbeatDecision.restartInstruction,
          },
        })

        try {
          const previousHistoryLength = snapshot.history.length
          const previousAssistantMessageId = assistantHistoryMessage?.id
          const retainedBlocks = contentBlocks.filter((block) =>
            block.type === 'tool_call'
              || block.type === 'warning'
              || block.type === 'file_edit'
          )
          const continuationResult = await session.run(
            [{ type: 'text', text: heartbeatDecision.restartInstruction }],
            {
              signal: abortController.signal,
              debug: (event) => {
                appendDebugLog(sessionId, {
                  layer: 'runtime',
                  direction:
                    event.stage === 'request'
                      ? 'sdk->runtime'
                      : 'runtime->sdk',
                  event: `runtime.${event.transport}.${event.stage}`,
                  summary: summarizeRuntimeDebugEvent(event),
                  turnId: runtimeTurnId,
                  data: {
                    ...event,
                    hiddenHeartbeat: true,
                  },
                })
              },
            },
          )
          const rawContinuationSnapshot = session.snapshot()
          const sanitizedSnapshot: SessionSnapshot = {
            ...rawContinuationSnapshot,
            history: stripHiddenAssistantHeartbeatMessages(
              rawContinuationSnapshot.history,
              {
                previousAssistantMessageId,
                previousHistoryLength,
              },
            ),
            savedAt: new Date().toISOString(),
          }

          session = await gemmaDesktop.sessions.resume({
            snapshot: sanitizedSnapshot,
          })
          liveSessions.set(sessionId, session)
          snapshot = sanitizedSnapshot
          assistantHistoryMessage = [...snapshot.history]
            .reverse()
            .find((entry) => entry.role === 'assistant')
          effectiveResult = continuationResult

          contentBlocks.splice(
            0,
            contentBlocks.length,
            ...retainedBlocks,
            ...buildFallbackStreamingBlocks({
              ...continuationResult,
              workingDirectory: snapshot.workingDirectory,
            }),
          )
        } catch (error) {
          if (abortController.signal.aborted) {
            throw error
          }

          appendDebugLog(sessionId, {
            layer: 'ipc',
            direction: 'app->sdk',
            event: 'sessions.assistant-heartbeat.restart-failed',
            summary:
              error instanceof Error
                ? error.message
                : 'Hidden assistant continuation failed',
            turnId: effectiveResult.turnId,
            data: {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    }

    finalizeHelperToolBlock()

    let finalContent = serializeStreamingBlocks(
      finalizeStreamingBlocks(contentBlocks, {
        ...effectiveResult,
        workingDirectory: snapshot.workingDirectory,
      }),
    )

    if (helperCompletionMessage) {
      finalContent = applyAssistantCompletionMessage(
        finalContent,
        helperCompletionMessage,
      )
    }

    if (effectiveResult.warnings.length > 0) {
      for (const warning of effectiveResult.warnings) {
        finalContent.push({ type: 'warning', message: warning })
      }
    }
    const durationMs = Math.max(Date.now() - turnStartedAt, 1)

    const assistantMessage: AppMessage = {
      id: assistantHistoryMessage?.id ?? effectiveResult.turnId,
      role: 'assistant',
      content:
        finalContent.length > 0
          ? finalContent
          : [{
              type: 'text',
              text: (helperCompletionMessage ?? effectiveResult.text) || '',
            }],
      timestamp: Date.now(),
      durationMs,
    }
    store.clearPendingTurn(sessionId)
    store.upsertAppMessage(sessionId, assistantMessage)

    recordSessionTokens(
      effectiveResult.runtimeId,
      effectiveResult.modelId,
      effectiveResult.usage,
    )

    const outputTokens = effectiveResult.usage?.outputTokens
    const reasoningTokens = effectiveResult.usage?.reasoningTokens ?? 0
    const estimated = outputTokens == null && reasoningTokens === 0
    const generatedTokens = estimated
      ? estimateGeneratedTokens(
          helperCompletionMessage ?? effectiveResult.text,
          effectiveResult.reasoning,
        )
      : (outputTokens ?? 0) + reasoningTokens
    const tokensPerSecond = roundToSingleDecimal(
      generatedTokens / (durationMs / 1000),
    )

    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.turn.metrics',
      summary: `${tokensPerSecond.toFixed(1)} TPS`,
      turnId: effectiveResult.turnId,
      data: {
        sessionId,
        turnId: effectiveResult.turnId,
        runtimeId: effectiveResult.runtimeId,
        modelId: effectiveResult.modelId,
        durationMs,
        generatedTokens,
        outputTokens: outputTokens ?? null,
        reasoningTokens,
        tokensPerSecond,
        estimated,
      },
    })

    sendToSession(sessionId, { type: 'live_activity', activity: null })
    sendToSession(sessionId, {
      type: 'turn_complete',
      message: assistantMessage,
    })
    notifySessionCompleted(sessionId, assistantMessage)

    const assistantPreview = buildNotificationPreview(assistantMessage)
    const lastMsg = ((helperCompletionMessage ?? effectiveResult.text) || '')
      .slice(0, 120)
      || assistantPreview
      || userMessagePreview
    await store.save(sessionId, snapshot, { lastMessage: lastMsg })
    void broadcastSessionsChanged().catch(() => {})
  } catch (err: unknown) {
    const aborted = abortController.signal.aborted
    if (aborted) {
      const cancelledMessage = buildCancelledAssistantMessage(
        runtimeTurnId ?? randomUUID(),
        contentBlocks,
        Math.max(Date.now() - turnStartedAt, 1),
      )

      if (cancelledMessage) {
        store.clearPendingTurn(sessionId)
        store.upsertAppMessage(sessionId, cancelledMessage)
        sendToSession(sessionId, {
          type: 'turn_complete',
          message: cancelledMessage,
        })
      } else {
        store.clearPendingTurn(sessionId)
      }

      sendToSession(sessionId, { type: 'live_activity', activity: null })
      sendToSession(sessionId, { type: 'generation_cancelled' })
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.send-message.cancelled',
        summary: 'Generation cancelled',
        data: {
          sessionId,
          preservedPartialContent: Boolean(cancelledMessage),
        },
      })
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[gemma-desktop] Session ${sessionId} turn failed:`, err)
      store.clearPendingTurn(sessionId)
      sendToSession(sessionId, { type: 'live_activity', activity: null })

      const currentSnapshot = session.snapshot()
      const currentConfig = getSessionConfig(currentSnapshot)
      const blockedBuildTool =
        currentConfig.planMode
          ? extractPlanBuildToolFromSurfaceError(errMsg)
          : undefined

      if (blockedBuildTool) {
        const existingPending = store.getPendingPlanExit(sessionId)
        const planExit = existingPending
          ? reissuePendingPlanExit(existingPending)
          : buildSyntheticPlanExit(
              sessionId,
              currentSnapshot,
              'blocked_build_tool',
              runtimeTurnId,
            )
        const handoffMessage = planExit
          ? buildPlanExitPromptMessage(blockedBuildTool)
          : buildPlanExitFallbackMessage(blockedBuildTool)

        if (planExit) {
          setPendingPlanExitState(sessionId, planExit)
        }

        store.upsertAppMessage(sessionId, handoffMessage)
        sendToSession(sessionId, {
          type: 'turn_complete',
          message: handoffMessage,
        })
        notifySessionCompleted(sessionId, handoffMessage)
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'main->renderer',
          event: planExit
            ? 'sessions.send-message.plan-exit-ready'
            : 'sessions.send-message.plan-exit-failed',
          summary: planExit
            ? `Plan exit prepared after blocked tool ${blockedBuildTool}`
            : `Plan exit could not be prepared after blocked tool ${blockedBuildTool}`,
          data: {
            error: errMsg,
            toolName: blockedBuildTool,
            usedExistingPending: Boolean(existingPending),
            planExit,
          },
        })
      } else {
        const durationMs = Math.max(Date.now() - turnStartedAt, 1)
        let recoveredMessage: AppMessage | null = null

        if (isTalkSessionConfig(currentConfig) && !abortController.signal.aborted) {
          const failedTurnContent = serializeStreamingBlocks(contentBlocks, { cancelled: true })
          try {
            const recovery = await recoverFailedAssistantTurnWithHelper({
              sessionId,
              workingDirectory: currentSnapshot.workingDirectory,
              snapshot: currentSnapshot,
              userPrompt: message.text,
              errorMessage: errMsg,
              content: failedTurnContent,
              signal: abortController.signal,
            })
            helperActivity.recoveredFailedTurn = true
            helperActivity.completionMessage = recovery.completionMessage
            recordHelperConsultation({
              helperModelId: recovery.helperModelId,
              helperRuntimeId: recovery.helperRuntimeId,
              progressId: 'turn-recovery',
              label: 'Recovering the failed Assistant Chat turn',
              summary: 'Recovering a final message from the failed turn',
              tone: 'warning',
            })
            appendDebugLog(sessionId, {
              layer: 'ipc',
              direction: 'app->sdk',
              event: 'sessions.assistant-heartbeat.recover',
              summary: 'Helper supplied a final message after the primary turn failed',
              turnId: runtimeTurnId,
              data: {
                sessionId,
                turnId: runtimeTurnId,
                originalError: errMsg,
                completionMessage: recovery.completionMessage,
              },
            })
            finalizeHelperToolBlock()
            recoveredMessage = buildRecoveredFailedAssistantMessage({
              turnId: runtimeTurnId ?? randomUUID(),
              content: serializeStreamingBlocks(contentBlocks, { cancelled: true }),
              recoveryMessage: recovery.completionMessage,
              timestamp: Date.now(),
              durationMs,
            }) as AppMessage | null
          } catch (recoveryError) {
            if (abortController.signal.aborted) {
              throw recoveryError
            }
            appendDebugLog(sessionId, {
              layer: 'ipc',
              direction: 'app->sdk',
              event: 'sessions.assistant-heartbeat.recovery-failed',
              summary:
                recoveryError instanceof Error
                  ? recoveryError.message
                  : 'Failed turn recovery helper failed',
              turnId: runtimeTurnId,
              data: {
                sessionId,
                originalError: errMsg,
                recoveryError:
                  recoveryError instanceof Error
                    ? recoveryError.message
                    : String(recoveryError),
              },
            })
          }
        }

        const errorMessage: AppMessage =
          recoveredMessage
          ?? buildFailedAssistantMessage({
              turnId: runtimeTurnId ?? randomUUID(),
              content: serializeStreamingBlocks(contentBlocks, { cancelled: true }),
              errorMessage: errMsg,
              timestamp: Date.now(),
              durationMs,
            })
          ?? {
              id: `err-${Date.now()}`,
              role: 'assistant',
              content: [{ type: 'error', message: errMsg }],
              timestamp: Date.now(),
              durationMs,
            }

        sendToSession(sessionId, {
          type: 'turn_complete',
          message: errorMessage,
        })
        notifySessionCompleted(sessionId, errorMessage)

        store.upsertAppMessage(sessionId, errorMessage)
        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'main->renderer',
          event: recoveredMessage
            ? 'sessions.send-message.recovered-error'
            : 'sessions.send-message.error',
          summary: recoveredMessage
            ? 'Recovered a user-facing completion after the primary turn failed'
            : errMsg,
          data: recoveredMessage
            ? { originalError: errMsg, recovered: true }
            : { error: errMsg },
        })
      }
    }

    try {
      await restoreCoBrowseCompositionIfNeeded()
      session = await persistSessionStateWithRecoveredUserHistory(sessionId, session)
    } catch {
      // Best effort
    }
    } finally {
      activeAbortControllers.delete(sessionId)
      activeSessionTasks.delete(sessionId)
      releaseExecutionGate()
      void broadcastSessionsChanged().catch(() => {})
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[gemma-desktop] Session ${sessionId} preflight failed:`, err)

    const errorMessage: AppMessage = {
      id: `err-${Date.now()}`,
      role: 'assistant',
      content: [{ type: 'error', message: errMsg }],
      timestamp: Date.now(),
      durationMs: Math.max(Date.now() - requestStartedAt, 1),
    }

    sendToSession(sessionId, {
      type: 'turn_complete',
      message: errorMessage,
    })
    notifySessionCompleted(sessionId, errorMessage)
    store.upsertAppMessage(sessionId, errorMessage)
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.send-message.error',
      summary: errMsg,
      data: { error: errMsg },
    })

    try {
      await restoreCoBrowseCompositionIfNeeded()
      session = await persistSessionStateWithRecoveredUserHistory(sessionId, session)
    } catch {
      // Best effort
    }
  } finally {
    releasePrimaryLease?.()
    releaseExecutionGate()
  }
}

async function runSessionResearchInternal(
  sessionId: string,
  message: { text: string },
): Promise<void> {
  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'renderer->main',
    event: 'sessions.run-research.request',
    summary: 'Run deep research request',
    data: {
      textLength: message.text.length,
      textPreview: message.text.trim().slice(0, 160),
    },
  })

  if (message.text.trim().length === 0) {
    throw new Error('Deep research requires a non-empty text prompt.')
  }

  if (isSessionExecutionBusy(sessionId)) {
    throw new Error('This session is already generating a response.')
  }
  const releaseExecutionGate = beginConversationExecutionGate(sessionId, 'generation')

  const requestStartedAt = Date.now()
  let { session } = await getOrResumeLiveSession(sessionId).catch((error) => {
    releaseExecutionGate()
    throw error
  })
  let abortController: AbortController | null = null
  let latestResearchStatus: ResearchRunStatus | undefined
  let releasePrimaryLease: (() => void) | null = null
  const userMessagePreview = buildUserMessagePreviewText(message.text)
  const userMessage: AppMessage = {
    id: `user-${requestStartedAt}-${randomUUID()}`,
    role: 'user',
    content: buildUserMessageContent(message.text, []),
    timestamp: requestStartedAt,
  }
  publishOptimisticUserMessage({
    sessionId,
    snapshot: session.snapshot(),
    message: userMessage,
    lastMessagePreview: userMessagePreview,
  })

  try {
    releasePrimaryLease = await acquirePrimaryModelLease(sessionId, {
      modelId: session.snapshot().modelId,
      runtimeId: session.snapshot().runtimeId,
    })
    abortController = new AbortController()
    const pendingTurnId = `research-${requestStartedAt}-${randomUUID()}`
    const initialResearchActivity: SessionLiveActivity = {
      source: 'research',
      state: 'working',
      stage: 'planning',
      startedAt: requestStartedAt,
      assistantUpdates: 0,
      reasoningUpdates: 0,
      lifecycleEvents: 0,
      activeToolName: 'planning',
      activeToolLabel: 'Planning',
      runningToolCount: 1,
      completedToolCount: 0,
      recentProgressCount: 0,
    }
    const progressBlocks = buildResearchPanelContent(undefined, {
      promptText: message.text,
    })

    activeAbortControllers.set(sessionId, abortController)
    markConversationExecutionActive(sessionId, 'generation')
    store.setPendingTurn(sessionId, {
      turnId: pendingTurnId,
      content: progressBlocks,
      startedAt: requestStartedAt,
    })
    void maybeGenerateAutoSessionTitle({
      sessionId,
      snapshot: session.snapshot(),
      promptText: message.text,
      fallbackSummary: userMessagePreview,
    })
    sendToSession(sessionId, { type: 'generation_started' })
    sendToSession(sessionId, {
      type: 'live_activity',
      activity: initialResearchActivity,
    })
    sendToSession(sessionId, {
      type: 'content_delta',
      blocks: progressBlocks,
    })
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.run-research.started',
      summary: 'Deep research started',
      data: {
        pendingTurnId,
      },
    })
    void broadcastSessionsChanged().catch(() => {})

    const result = await session.runResearch(message.text, {
      profile: 'deep',
      signal: abortController.signal,
      onStatus: async (status) => {
        latestResearchStatus = status
        const blocks = buildResearchPanelContent(status, {
          promptText: message.text,
        })
        store.setPendingTurn(sessionId, {
          turnId: pendingTurnId,
          content: blocks,
          startedAt: requestStartedAt,
        })
        sendToSession(sessionId, {
          type: 'content_delta',
          blocks,
        })
        sendToSession(sessionId, {
          type: 'live_activity',
          activity: buildResearchLiveActivity(status),
        })
      },
    })
    const durationMs = Math.max(Date.now() - requestStartedAt, 1)
    const assistantMessage = buildResearchAssistantMessage(result, durationMs)

    store.clearPendingTurn(sessionId)
    store.upsertAppMessage(sessionId, assistantMessage)
    sendToSession(sessionId, { type: 'live_activity', activity: null })
    sendToSession(sessionId, {
      type: 'turn_complete',
      message: assistantMessage,
    })
    notifySessionCompleted(sessionId, assistantMessage)
    await store.save(sessionId, session.snapshot(), {
      lastMessage: result.summary.trim().slice(0, 120) || userMessagePreview,
    })
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.run-research.completed',
      summary: `Deep research completed with ${result.plan.topics.length} topics and ${result.sources.length} sources`,
      data: {
        runId: result.runId,
        artifactDirectory: result.artifactDirectory,
        topics: result.plan.topics.map((topic) => ({
          id: topic.id,
          title: topic.title,
        })),
        sourceCount: result.sources.length,
        confidence: result.confidence,
        completedAt: result.completedAt,
      },
    })
    void broadcastSessionsChanged().catch(() => {})
  } catch (err: unknown) {
    const aborted = abortController?.signal.aborted ?? false
    if (aborted) {
      store.clearPendingTurn(sessionId)
      sendToSession(sessionId, { type: 'live_activity', activity: null })
      sendToSession(sessionId, { type: 'generation_cancelled' })
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.run-research.cancelled',
        summary: 'Deep research cancelled',
        data: { sessionId },
      })
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[gemma-desktop] Session ${sessionId} research failed:`, err)
      const failureContent: Array<Record<string, unknown>> = latestResearchStatus
        ? buildResearchPanelContent(latestResearchStatus, {
            promptText: message.text,
          })
        : []
      failureContent.push({ type: 'error', message: errMsg })
      if (latestResearchStatus?.artifactDirectory) {
        failureContent.push({
          type: 'folder_link',
          path: latestResearchStatus.artifactDirectory,
          label: 'Open research artifacts',
        })
      }
      const errorMessage: AppMessage = {
        id: `research-err-${Date.now()}`,
        role: 'assistant',
        content:
          failureContent.length > 0
            ? failureContent
            : [{ type: 'error', message: errMsg }],
        timestamp: Date.now(),
        durationMs: Math.max(Date.now() - requestStartedAt, 1),
      }
      store.clearPendingTurn(sessionId)
      store.upsertAppMessage(sessionId, errorMessage)
      sendToSession(sessionId, { type: 'live_activity', activity: null })
      sendToSession(sessionId, {
        type: 'turn_complete',
        message: errorMessage,
      })
      notifySessionCompleted(sessionId, errorMessage)
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.run-research.error',
        summary: errMsg,
        data: { error: errMsg },
      })
    }

    try {
      session = await persistSessionStateWithRecoveredUserHistory(sessionId, session)
    } catch {
      // Best effort
    }
  } finally {
    activeAbortControllers.delete(sessionId)
    activeSessionTasks.delete(sessionId)
    releaseExecutionGate()
    releasePrimaryLease?.()
    void broadcastSessionsChanged().catch(() => {})
  }
}

export async function captureAndQueueMacOSScreenshotToActiveSession(
  target: MacOSScreenshotTarget,
): Promise<{
  queued: boolean
  cancelled?: boolean
  sessionId?: string
  screenshotPath?: string
}> {
  if (process.platform !== 'darwin') {
    throw new Error('Menu bar screenshots are only available on macOS.')
  }

  const sessionId = currentAttentionContext.activeSessionId
  if (!sessionId) {
    throw new Error('Select a chat session in Gemma Desktop before taking a screenshot.')
  }

  const persisted = await getPersistedSession(sessionId)
  const snapshot = liveSessions.get(sessionId)?.snapshot() ?? persisted?.snapshot
  if (!snapshot) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const config = getSessionConfig(snapshot)
  if (isTalkSessionConfig(config)) {
    throw new Error('Menu bar screenshots are not available for Assistant Chat.')
  }
  if (config.conversationKind === 'research') {
    throw new Error('Menu bar screenshots are not available for Research conversations.')
  }

  const assetDirectory = await ensureSessionAssetDirectory(
    sessionId,
    snapshot.workingDirectory,
  )
  const capture = await captureMacOSScreenshot({
    target,
    destinationDirectory: path.join(assetDirectory, 'screenshots'),
  })

  if (!capture) {
    return {
      queued: false,
      cancelled: true,
      sessionId,
    }
  }

  const captureStats = await fs.stat(capture.path)
  broadcastToWindows(
    BrowserWindow.getAllWindows(),
    'attachments:pending-added',
    {
      sessionId,
      attachment: {
        kind: 'image',
        name: path.basename(capture.path),
        size: captureStats.size,
        path: capture.path,
        previewUrl: capture.fileUrl,
        mediaType: 'image/png',
        source: 'file',
      },
    },
    'attachments:pending-added',
  )

  appendDebugLog(sessionId, {
    layer: 'ipc',
    direction: 'main->renderer',
    event: 'macos.screenshot.menu-bar-queued',
    summary:
      target === 'window'
        ? 'Queued menu bar window screenshot in the active composer'
        : 'Queued menu bar full screen screenshot in the active composer',
    data: {
      target,
      path: capture.path,
      permissionStatus: capture.permissionStatus,
      sessionId,
    },
  })

  focusNotificationWindow()
  broadcastNotificationEvent('notifications:activate-target', {
    kind: 'session',
    sessionId,
  })

  return {
    queued: true,
    sessionId,
    screenshotPath: capture.path,
  }
}

// ── IPC Handlers ──

export function registerIpcHandlers(): void {
  if (!shellShutdownSubscribed) {
    shellShutdownSubscribed = true
    app.once('before-quit', () => {
      for (const sessionId of [...shellMessageFlushTimers.keys()]) {
        clearScheduledShellFlush(sessionId)
      }
      appTerminalManager.shutdown()
      shellSessionManager.shutdown()
    })
  }

  if (!speechRuntimeSubscribed) {
    speechRuntimeSubscribed = true
    speechRuntimeManager.onChanged(() => {
      void inspectSpeechStatus()
        .then((status) => {
          broadcastSpeechStatusChanged(status)
        })
        .catch((error) => {
          console.error('[gemma-desktop] speech status refresh failed:', error)
        })
    })
  }

  if (!readAloudSubscribed) {
    readAloudSubscribed = true
    readAloudService.onChanged(() => {
      void inspectReadAloudStatus()
        .then((status) => {
          broadcastReadAloudStatusChanged(status)
        })
        .catch((error) => {
          console.error('[gemma-desktop] read aloud status refresh failed:', error)
        })
    })
  }

  // ── Sidebar ──

  ipcMain.handle('sidebar:get', async () => {
    return sidebarStateToRecord(await syncSidebarState())
  })

  ipcMain.handle('sidebar:pin-session', async (_, sessionId: string) => {
    const result = await getSidebarStateStore().pinSession(
      sessionId,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    return sidebarStateToRecord(result.state)
  })

  ipcMain.handle('sidebar:unpin-session', async (_, sessionId: string) => {
    const result = await getSidebarStateStore().unpinSession(
      sessionId,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    return sidebarStateToRecord(result.state)
  })

  ipcMain.handle('sidebar:flag-followup', async (_, sessionId: string) => {
    const result = await getSidebarStateStore().flagFollowUp(
      sessionId,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    return sidebarStateToRecord(result.state)
  })

  ipcMain.handle('sidebar:unflag-followup', async (_, sessionId: string) => {
    const result = await getSidebarStateStore().unflagFollowUp(
      sessionId,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    return sidebarStateToRecord(result.state)
  })

  ipcMain.handle(
    'sidebar:remember-active-session',
    async (_, sessionId: string | null) => {
      const result = await getSidebarStateStore().rememberActiveSession(
        sessionId,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle(
    'sidebar:move-pinned-session',
    async (_, sessionId: string, toIndex: number) => {
      const result = await getSidebarStateStore().movePinnedSession(
        sessionId,
        toIndex,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle(
    'sidebar:set-session-order',
    async (_, sessionId: string, toIndex: number) => {
      const result = await getSidebarStateStore().setSessionOrder(
        sessionId,
        toIndex,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle(
    'sidebar:clear-session-order',
    async (_, sessionId: string) => {
      const result = await getSidebarStateStore().clearSessionOrder(
        sessionId,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle(
    'sidebar:set-project-order',
    async (_, projectPath: string, toIndex: number) => {
      const result = await getSidebarStateStore().setProjectOrder(
        projectPath,
        toIndex,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle(
    'sidebar:clear-project-order',
    async (_, projectPath: string) => {
      const result = await getSidebarStateStore().clearProjectOrder(
        projectPath,
        await listSidebarSessionReferences(),
      )

      if (result.changed) {
        broadcastSidebarChanged(result.state)
      }

      return sidebarStateToRecord(result.state)
    },
  )

  ipcMain.handle('sidebar:close-project', async (_, projectPath: string) => {
    const normalizedProjectPath = normalizeStoredSidebarProjectPath(projectPath)
    const assignedGlobalChatSessionId = getGlobalChatStateInternal().assignedSessionId
    let globalChatCleared = false

    if (assignedGlobalChatSessionId && normalizedProjectPath) {
      const assignedSnapshot = await resolveKnownSessionSnapshot(
        assignedGlobalChatSessionId,
      )
      const assignedProjectPath = assignedSnapshot
        ? normalizeStoredSidebarProjectPath(assignedSnapshot.workingDirectory)
        : ''

      if (!assignedSnapshot) {
        globalChatCleared = globalChatController.clearIfAssignedSession(
          assignedGlobalChatSessionId,
        )
      } else {
        globalChatCleared = globalChatController.clearIfAssignedProject(
          normalizedProjectPath,
          assignedProjectPath,
        )
      }
    }

    const result = await getSidebarStateStore().closeProject(
      projectPath,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    if (globalChatCleared) {
      await broadcastGlobalChatChanged()
    }

    return sidebarStateToRecord(result.state)
  })

  ipcMain.handle('sidebar:reopen-project', async (_, projectPath: string) => {
    const result = await getSidebarStateStore().reopenProject(
      projectPath,
      await listSidebarSessionReferences(),
    )

    if (result.changed) {
      broadcastSidebarChanged(result.state)
    }

    return sidebarStateToRecord(result.state)
  })

  // ── Assistant Chat ──

  ipcMain.handle('global-chat:get-state', async () => {
    return getGlobalChatStateInternal()
  })

  ipcMain.handle('global-chat:get-session', async () => {
    return await getGlobalChatSessionDetailInternal()
  })

  ipcMain.handle('global-chat:assign-session', async (_, sessionId: string) => {
    const normalizedSessionId =
      typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!normalizedSessionId) {
      throw new Error('Assistant Chat requires a valid conversation id.')
    }

    const snapshot = await resolveKnownSessionSnapshot(normalizedSessionId)
    if (!snapshot) {
      throw new Error(`Session not found: ${normalizedSessionId}`)
    }

    if (isHiddenSessionSnapshot(snapshot) || isTalkSessionSnapshot(snapshot)) {
      throw new Error('The built-in Assistant Chat cannot be assigned from the chat list.')
    }

    if (getSessionConfig(snapshot).conversationKind !== 'normal') {
      throw new Error('Only normal conversations can be used as Assistant Chat.')
    }

    const changed = globalChatController.assignSession(normalizedSessionId)
    if (changed) {
      await broadcastGlobalChatChanged()
    }

    return getGlobalChatStateInternal()
  })

  ipcMain.handle('global-chat:clear-assignment', async () => {
    const changed = globalChatController.clearAssignment()
    if (changed) {
      await broadcastGlobalChatChanged()
    }

    return getGlobalChatStateInternal()
  })

  // ── Sessions ──

  ipcMain.handle('sessions:list', async () => {
    return await listSessionSummaries()
  })

  ipcMain.handle(
    'sessions:search',
    async (_, input: SessionSearchRequest | undefined) => {
      const query = typeof input?.query === 'string' ? input.query.trim() : ''
      if (query.length === 0) {
        return []
      }

      const sessionIds = [...new Set(
        (Array.isArray(input?.sessionIds) ? input.sessionIds : [])
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      )]

      if (sessionIds.length === 0) {
        return []
      }

      const records: SearchableSessionRecord[] = []
      for (const sessionId of sessionIds) {
        const persisted = await getPersistedSession(sessionId)
        const snapshot = liveSessions.get(sessionId)?.snapshot() ?? persisted?.snapshot
        const meta = store.getMeta(sessionId) ?? persisted?.meta

        if (!snapshot || !meta || isHiddenSessionSnapshot(snapshot)) {
          continue
        }

        records.push({
          sessionId: meta.id,
          title: meta.title,
          workingDirectory: snapshot.workingDirectory,
          conversationKind: getSessionConfig(snapshot).conversationKind,
          updatedAt: meta.updatedAt,
          messages: buildSessionDetailMessages(snapshot, persisted?.appMessages),
        })
      }

      return searchSessionRecords(records, query)
    },
  )

  ipcMain.handle('talk:ensure-session', async () => {
    return await ensureTalkSessionInternal()
  })

  ipcMain.handle('talk:clear-session', async () => {
    appendDebugLog(TALK_SESSION_ID, {
      layer: 'ipc',
      direction: 'renderer->main',
      event: 'talk.clear.request',
      summary: 'Clear Talk session history and draft',
      data: { sessionId: TALK_SESSION_ID },
    })
    const detail = await clearTalkSessionInternal()
    appendDebugLog(TALK_SESSION_ID, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'talk.clear.response',
      summary: 'Cleared Talk session history and draft',
      data: { sessionId: TALK_SESSION_ID },
    })
    return detail
  })

  ipcMain.handle(
    'sessions:create',
    async (
      _,
      opts: {
        modelId: string
        runtimeId: string
        mode?: AppSessionMode
        conversationKind?: ConversationKind
        workMode?: AppSessionMode
        planMode?: boolean
        selectedSkillIds?: string[]
        selectedToolIds?: string[]
        workingDirectory?: string
        title?: string
      },
    ) => {
      const currentSettings = await getSettingsState()
      const conversationKind = normalizeConversationKind(opts.conversationKind)
      assertNoConversationExecutionRunning()
      const sessionMode = normalizeAppSessionMode(
        opts.workMode ?? opts.mode,
        conversationKind === 'research' ? 'explore' : currentSettings.defaultMode,
      )
      const nextSessionConfig = normalizeSessionConfig({
        conversationKind,
        ...sessionModeToConfig(sessionMode),
        planMode: typeof opts.planMode === 'boolean' ? opts.planMode : false,
        preferredRuntimeId: opts.runtimeId,
        selectedSkillIds: [],
        selectedSkillNames: [],
        selectedToolIds: [],
        selectedToolNames: [],
        surface: 'default',
        visibility: 'visible',
        storageScope: 'project',
      })
      if (opts.planMode === true && !nextSessionConfig.planMode) {
        throw new Error('Plan mode is only available in Build conversations.')
      }
      const workingDirectory = await ensureDirectoryExists(
        opts.workingDirectory ?? currentSettings.defaultProjectDirectory,
      )
      const runtimeSelection = normalizeRuntimeForSessionMode(
        opts.runtimeId,
        nextSessionConfig.baseMode,
      )
      const composition = await resolveSessionComposition({
        snapshot: null,
        conversationKind: nextSessionConfig.conversationKind,
        sessionMode: nextSessionConfig.baseMode,
        planMode: nextSessionConfig.planMode,
        modelId: opts.modelId,
        runtimeId: runtimeSelection.runtimeId,
        preferredRuntimeId: opts.runtimeId,
        selectedSkillIds: Array.isArray(opts.selectedSkillIds)
          ? opts.selectedSkillIds
          : [],
        selectedToolIds:
          nextSessionConfig.conversationKind === 'research'
            ? []
            : normalizeSelectedToolIds(
                Array.isArray(opts.selectedToolIds) ? opts.selectedToolIds : undefined,
                currentSettings,
              ),
        surface: nextSessionConfig.surface,
        visibility: nextSessionConfig.visibility,
        storageScope: nextSessionConfig.storageScope,
      })

      assertNoConversationExecutionRunning()
      const session = await gemmaDesktop.sessions.create({
        runtime: runtimeSelection.runtimeId,
        model: opts.modelId,
        mode: composition.mode,
        workingDirectory,
        systemInstructions: composition.systemInstructions,
        metadata: composition.metadata,
      })

      const snapshot = session.snapshot()
      const meta: SessionMeta = {
        id: session.id,
        title: opts.title ?? PLACEHOLDER_SESSION_TITLE,
        titleSource: 'auto',
        lastMessage: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionTags: [],
      }

      liveSessions.set(session.id, session)
      await store.save(session.id, snapshot, meta)
      await broadcastSessionsChanged()

      appendDebugLog(session.id, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'sessions.create.request',
        summary: `Create session request for ${runtimeSelection.runtimeId}/${opts.modelId}`,
        data: {
          ...opts,
          normalizedRuntimeId: runtimeSelection.runtimeId,
          runtimeNormalizationReason: runtimeSelection.reason,
        },
      })
      appendDebugLog(session.id, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.create.response',
        summary: `Created session ${session.id}`,
        data: metaToSummary(meta, snapshot),
      })

      return metaToSummary(meta, snapshot)
    },
  )

  ipcMain.handle('sessions:get', async (_, sessionId: string) => {
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'renderer->main',
      event: 'sessions.get.request',
      summary: `Load session ${sessionId}`,
      data: { sessionId },
    })
    const detail = await getSessionDetailInternal(sessionId)
    scheduleSelectedSessionPrimaryWarmup(sessionId)
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'main->renderer',
      event: 'sessions.get.response',
      summary: `Loaded session ${sessionId}`,
      data: detail,
    })
    return detail
  })

  ipcMain.handle(
    'sessions:save-draft',
    async (_, sessionId: string, draftText: string) => {
      const normalizedDraftText = typeof draftText === 'string' ? draftText : ''
      const snapshot = await resolveKnownSessionSnapshot(sessionId)
      if (!snapshot) {
        return { ok: true }
      }

      store.setDraftText(sessionId, normalizedDraftText)
      await store.flush(sessionId)
      return { ok: true }
    },
  )

  ipcMain.handle(
    'sessions:update',
    async (
      _,
      sessionId: string,
      opts: {
        mode?: AppSessionMode
        conversationKind?: ConversationKind
        workMode?: AppSessionMode
        planMode?: boolean
        modelId?: string
        runtimeId?: string
        selectedSkillIds?: string[]
        selectedToolIds?: string[]
        workingDirectory?: string
      },
    ) => {
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'sessions.update.request',
        summary: `Update session ${sessionId}`,
        data: {
          sessionId,
          ...opts,
        },
      })

      if (isSessionExecutionBusy(sessionId)) {
        throw new Error(
          'Cannot change the active model or session configuration while this session is busy.',
        )
      }

      const persisted = await getPersistedSession(sessionId)
      const liveSession = liveSessions.get(sessionId)
      const currentSnapshot = liveSession?.snapshot() ?? persisted?.snapshot

      if (!currentSnapshot || !persisted?.meta) {
        throw new Error(`Session not found: ${sessionId}`)
      }

      const currentSnapshotIsTalk = isTalkSessionSnapshot(currentSnapshot)
      const currentConfig = currentSnapshotIsTalk
        ? buildTalkSessionConfig()
        : getSessionConfig(currentSnapshot)
      const nextWorkingDirectory = currentSnapshotIsTalk
        ? await ensureDirectoryExists(getTalkSessionWorkspaceDirectory(app.getPath('userData')))
        : opts.workingDirectory
          ? await ensureDirectoryExists(opts.workingDirectory)
          : currentSnapshot.workingDirectory

      if (currentSnapshotIsTalk) {
        const attemptedFixedChange =
          opts.mode !== undefined
          || opts.workMode !== undefined
          || opts.conversationKind !== undefined
          || opts.planMode !== undefined
          || opts.workingDirectory !== undefined

        if (attemptedFixedChange) {
          throw new Error('Assistant Chat configuration is fixed.')
        }
      }

      const currentMode = resolveAppSessionMode(currentConfig)
      const requestedConversationKind = opts.conversationKind == null
        ? currentConfig.conversationKind
        : normalizeConversationKind(opts.conversationKind)

      if (requestedConversationKind !== currentConfig.conversationKind) {
        throw new Error(
          'Conversation kind cannot be changed. Create a new conversation instead.',
        )
      }

      if (
        currentConfig.conversationKind === 'research'
        && opts.workMode != null
      ) {
        throw new Error(
          'Research conversations are separate from Explore and Build. Create a normal conversation to switch modes.',
        )
      }

      const sessionMode = opts.workMode != null || opts.mode != null
        ? normalizeAppSessionMode(opts.workMode ?? opts.mode, currentMode)
        : currentMode
      const requestedPlanMode =
        typeof opts.planMode === 'boolean'
          ? opts.planMode
          : currentConfig.planMode
      const nextSessionConfig = normalizeSessionConfig({
        ...currentConfig,
        baseMode: sessionMode,
        planMode: requestedPlanMode,
      })
      if (opts.planMode === true && !nextSessionConfig.planMode) {
        throw new Error('Plan mode is only available in Build conversations.')
      }
      const requestedTarget =
        opts.modelId && opts.runtimeId
          ? {
              modelId: opts.modelId,
              runtimeId: opts.runtimeId,
            }
          : null
      const currentSettings = await getSettingsState()
      const snapshotTarget = {
        modelId: currentSnapshot.modelId,
        runtimeId: currentSnapshot.runtimeId,
      }
      const nextTarget = requestedTarget ?? snapshotTarget

      const selectedSkillIds = Array.isArray(opts.selectedSkillIds)
        ? opts.selectedSkillIds
        : currentConfig.selectedSkillIds
      const selectedToolIds =
        nextSessionConfig.conversationKind === 'research'
          ? []
          : Array.isArray(opts.selectedToolIds)
            ? normalizeSelectedToolIds(opts.selectedToolIds, currentSettings)
            : currentConfig.selectedToolIds
      const runtimeSelection = normalizeRuntimeForSessionMode(
        nextTarget.runtimeId,
        nextSessionConfig.baseMode,
      )
      const composition = await resolveSessionComposition({
        snapshot: currentSnapshot,
        conversationKind: nextSessionConfig.conversationKind,
        sessionMode: nextSessionConfig.baseMode,
        planMode: nextSessionConfig.planMode,
        modelId: nextTarget.modelId,
        runtimeId: runtimeSelection.runtimeId,
        preferredRuntimeId: nextTarget.runtimeId,
        selectedSkillIds,
        selectedToolIds,
        surface: nextSessionConfig.surface,
        visibility: nextSessionConfig.visibility,
        storageScope: nextSessionConfig.storageScope,
      })

      const nextSnapshot: SessionSnapshot = {
        ...currentSnapshot,
        runtimeId: runtimeSelection.runtimeId,
        modelId: nextTarget.modelId,
        mode: composition.mode,
        workingDirectory: nextWorkingDirectory,
        systemInstructions: composition.systemInstructions,
        metadata: composition.metadata,
        savedAt: new Date().toISOString(),
      }

      const nextSession = await gemmaDesktop.sessions.resume({
        snapshot: nextSnapshot,
      })

      liveSessions.set(sessionId, nextSession)
      await store.save(sessionId, nextSnapshot)
      if (!nextSessionConfig.planMode) {
        setPendingPlanExitState(sessionId, null)
      }
      await broadcastSessionsChanged()
      scheduleSelectedSessionPrimaryWarmup(sessionId)
      const currentMeta = store.getMeta(sessionId) ?? persisted.meta

      const detail = snapshotToDetail(
        nextSnapshot,
        currentMeta,
        store.getDraftText(sessionId),
        store.getAppMessages(sessionId),
        store.getPendingTurn(sessionId),
        store.getPendingCompaction(sessionId),
        store.getPendingPlanQuestion(sessionId),
        store.getPendingPlanExit(sessionId),
        store.getPendingToolApproval(sessionId),
        getSessionExecutionTask(sessionId) === 'generation',
        getSessionExecutionTask(sessionId) === 'compaction',
      )
      const debugSnapshot = gemmaDesktop.describeSession(nextSnapshot)

      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'main->renderer',
        event: 'sessions.update.response',
        summary: `Session reconfigured to ${nextSnapshot.runtimeId}/${nextSnapshot.modelId} (${summarizeMode(nextSnapshot.mode)})`,
        data: {
          detail,
          debugSnapshot,
        },
      })

      return detail
    },
  )

  ipcMain.handle('sessions:delete', async (_, sessionId: string) => {
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'renderer->main',
      event: 'sessions.delete.request',
      summary: `Delete session ${sessionId}`,
      data: { sessionId },
    })
    const snapshot =
      liveSessions.get(sessionId)?.snapshot()
      ?? store.getSnapshot(sessionId)
      ?? (await getPersistedSession(sessionId))?.snapshot
    if (snapshot && isTalkSessionSnapshot(snapshot)) {
      throw new Error('Assistant Chat cannot be deleted.')
    }
    if (isSessionExecutionBusy(sessionId)) {
      throw new Error('Cannot delete a session while it is running.')
    }
    const globalChatCleared = globalChatController.clearIfAssignedSession(sessionId)
    shellSessionManager.closeAllForSession(sessionId)
    clearScheduledShellFlush(sessionId)
    liveSessions.delete(sessionId)
    await browserToolManager?.disconnectSession(sessionId)
    await chromeDevtoolsToolManager?.disconnectSession(sessionId)
    await store.remove(sessionId)
    await broadcastSessionsChanged()
    if (globalChatCleared) {
      await broadcastGlobalChatChanged()
    }
  })

  ipcMain.handle(
    'sessions:rename',
    async (_, sessionId: string, title: string) => {
      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'sessions.rename.request',
        summary: `Rename session to ${title}`,
        data: { sessionId, title },
      })
      const snapshot =
        liveSessions.get(sessionId)?.snapshot()
        ?? store.getSnapshot(sessionId)
        ?? (await getPersistedSession(sessionId))?.snapshot
      if (snapshot && isTalkSessionSnapshot(snapshot)) {
        throw new Error('Assistant Chat title is fixed.')
      }
      store.setMeta(sessionId, { title, titleSource: 'user' })
      const live = liveSessions.get(sessionId)
      if (live) {
        await store.save(
          sessionId,
          live.snapshot(),
          { title, titleSource: 'user' },
          undefined,
          { preserveUpdatedAt: true },
        )
      } else {
        const persisted = await getPersistedSession(sessionId)
        if (!persisted) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        await store.save(
          sessionId,
          persisted.snapshot,
          { title, titleSource: 'user' },
          undefined,
          { preserveUpdatedAt: true },
        )
      }
      await broadcastSessionsChanged()
    },
  )

  ipcMain.handle(
    'sessions:set-tags',
    async (_, sessionId: string, rawTags: unknown) => {
      const nextTags = normalizeSessionTags(rawTags)
      const previousMeta =
        store.getMeta(sessionId)
        ?? (await getPersistedSession(sessionId))?.meta
      const previousTags = previousMeta?.sessionTags ?? []
      if (sessionTagsEqual(previousTags, nextTags)) {
        return
      }

      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'sessions.set-tags.request',
        summary: `Set session tags (${nextTags.length})`,
        data: { sessionId, sessionTags: nextTags },
      })

      store.setMeta(sessionId, { sessionTags: nextTags })
      const live = liveSessions.get(sessionId)
      if (live) {
        await store.save(
          sessionId,
          live.snapshot(),
          { sessionTags: nextTags },
          undefined,
          { preserveUpdatedAt: true },
        )
      } else {
        const persisted = await getPersistedSession(sessionId)
        if (!persisted) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        await store.save(
          sessionId,
          persisted.snapshot,
          { sessionTags: nextTags },
          undefined,
          { preserveUpdatedAt: true },
        )
      }
      await broadcastSessionsChanged()
    },
  )

  ipcMain.handle(
    'sessions:suggest-tag-emoji',
    async (
      _,
      rawTagName: unknown,
      rawExcludeEmojis: unknown,
    ): Promise<{ emoji: string | null }> => {
      const tagName = typeof rawTagName === 'string' ? rawTagName.trim() : ''
      if (!tagName) {
        return { emoji: null }
      }
      const excludeEmojis = Array.isArray(rawExcludeEmojis)
        ? rawExcludeEmojis.filter(
            (entry): entry is string =>
              typeof entry === 'string' && entry.trim().length > 0,
          )
        : []

      try {
        const excludeLine = excludeEmojis.length > 0
          ? `Do not suggest any of these emojis already in use: ${excludeEmojis.join(' ')}`
          : ''
        const userText = [
          `Tag name: "${tagName}"`,
          excludeLine,
          'Respond with JSON: {"emoji":"<single emoji>"}. The "emoji" value must be exactly one emoji character.',
        ]
          .filter((line) => line.length > 0)
          .join('\n')

        const result = await runHelperStructuredTask({
          ownerId: `tag-emoji-${Date.now()}`,
          sessionRole: 'tag_emoji_suggestion',
          workingDirectory: app.getPath('userData'),
          systemInstructions: [
            'You pick a single emoji that best represents a conversation tag.',
            'Return only one emoji character in the "emoji" field.',
            'Prefer common, visually distinct emoji.',
            'Never return words, punctuation, or multiple emojis.',
          ].join('\n'),
          responseFormat: SESSION_TAG_EMOJI_RESPONSE_FORMAT,
          sessionInput: [{ type: 'text', text: userText }],
        })

        const candidate =
          extractFirstEmojiGrapheme(result.structuredOutput.emoji)
          ?? extractFirstEmojiGrapheme(result.outputText)

        if (!candidate || excludeEmojis.includes(candidate)) {
          return { emoji: null }
        }
        return { emoji: candidate }
      } catch (error) {
        console.warn('[gemma-desktop] helper tag emoji suggestion failed:', error)
        return { emoji: null }
      }
    },
  )

  ipcMain.handle(
    'sessions:send-message',
    async (
      _,
      sessionId: string,
      message: {
        text: string
        attachments?: IncomingAttachment[]
        coBrowse?: boolean
      },
    ) => {
      const coBrowse = message.coBrowse === true
      const persisted = await getPersistedSession(sessionId)
      const snapshot = liveSessions.get(sessionId)?.snapshot() ?? persisted?.snapshot
      if (!snapshot) {
        throw new Error(`Session not found: ${sessionId}`)
      }

      const config = getSessionConfig(snapshot)
      if (isTalkSessionConfig(config)) {
        return await sendTalkMessageInternal(sessionId, message, { coBrowse })
      }

      if (config.conversationKind === 'research' && !coBrowse) {
        if ((message.attachments?.length ?? 0) > 0) {
          throw new Error(
            'Research conversations currently support text prompts only.',
          )
        }

        return await runSessionResearchInternal(sessionId, {
          text: message.text,
        })
      }

      return await sendSessionMessageInternal(
        sessionId,
        message,
        'renderer',
        { coBrowse },
      )
    },
  )

  ipcMain.handle(
    'sessions:send-hidden-instruction',
    async (
      _,
      sessionId: string,
      text: string,
    ) => {
      const instruction = typeof text === 'string' ? text.trim() : ''
      if (!instruction) {
        throw new Error('Hidden instruction cannot be empty.')
      }

      return await sendSessionMessageInternal(
        sessionId,
        { text: instruction },
        'renderer',
        { hiddenUserMessage: true, coBrowse: true },
      )
    },
  )

  ipcMain.handle(
    'sessions:run-shell-command',
    async (
      _,
      sessionId: string,
      input: { command: string },
    ) => {
      await runShellCommandInternal(sessionId, input)
    },
  )

  ipcMain.handle(
    'sessions:write-shell-input',
    async (
      _,
      sessionId: string,
      terminalId: string,
      data: string,
    ) => {
      shellSessionManager.write(sessionId, terminalId, data)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    'sessions:resize-shell',
    async (
      _,
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ) => {
      shellSessionManager.resize(sessionId, terminalId, cols, rows)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    'sessions:close-shell',
    async (
      _,
      sessionId: string,
      terminalId: string,
    ) => {
      await closeShellCardInternal(sessionId, terminalId)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    'sessions:run-research',
    async (
      _,
      sessionId: string,
      message: { text: string },
    ) =>
      await runSessionResearchInternal(sessionId, message),
  )

  ipcMain.handle('sessions:compact', async (_, sessionId: string) => {
    const result = await runSessionCompactionInternal(sessionId, {
      trigger: 'manual',
      reason: 'Manual compact requested by the user.',
      keepRequiredOnFailure: false,
    })

    if (result.status === 'error') {
      throw new Error(
        result.error ?? 'Compaction failed before it could complete.',
      )
    }

    return {
      ok: result.status === 'completed',
      cancelled: result.status === 'cancelled',
    }
  })

  ipcMain.handle('sessions:clear-history', async (_, sessionId: string) => {
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'renderer->main',
      event: 'sessions.clear.request',
      summary: `Clear session history ${sessionId}`,
      data: { sessionId },
    })
    const snapshot =
      liveSessions.get(sessionId)?.snapshot()
      ?? store.getSnapshot(sessionId)
      ?? (await getPersistedSession(sessionId))?.snapshot
    if (snapshot && isTalkSessionSnapshot(snapshot)) {
      throw new Error('Assistant Chat history cannot be cleared.')
    }
    await runSessionClearInternal(sessionId)
  })

  ipcMain.handle('sessions:cancel', (_, sessionId: string) => {
    appendDebugLog(sessionId, {
      layer: 'ipc',
      direction: 'renderer->main',
      event: 'sessions.cancel.request',
      summary: 'Cancel generation request',
      data: { sessionId },
    })
    const controller = activeAbortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      if (getSessionExecutionTask(sessionId) === 'generation') {
        sendToSession(sessionId, { type: 'generation_stopping' })
      }
    }
  })

  ipcMain.handle(
    'sessions:resolve-tool-approval',
    async (
      _,
      sessionId: string,
      approvalId: string,
      approved: boolean,
    ) => {
      const pending = store.getPendingToolApproval(sessionId)
      if (pending?.id !== approvalId) {
        return { ok: true }
      }

      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'tool.approval.response',
        summary: approved
          ? `Approved ${pending.toolName}`
          : `Denied ${pending.toolName}`,
        data: {
          approvalId,
          approved,
          toolName: pending.toolName,
        },
      })

      const resolver = pendingToolApprovalResolvers.get(approvalId)
      pendingToolApprovalResolvers.delete(approvalId)
      setPendingToolApprovalState(sessionId, null)
      resolver?.resolve(Boolean(approved))
      return { ok: true }
    },
  )

  // ── User Memory ──

  ipcMain.handle('memory:read', async () => {
    return await readUserMemory(app.getPath('userData'))
  })

  ipcMain.handle('memory:write', async (_, content: string) => {
    const safe = typeof content === 'string' ? content : ''
    return await writeUserMemory(app.getPath('userData'), safe)
  })

  ipcMain.handle(
    'memory:append-note',
    async (
      _,
      input: { sessionId?: string; rawInput: string },
    ) => {
      const rawInput = typeof input?.rawInput === 'string' ? input.rawInput : ''
      if (rawInput.trim().length === 0) {
        throw new Error('Memory notes cannot be empty.')
      }

      let note = ''
      try {
        note = await distillMemoryNote({
          rawInput,
          sessionId: input?.sessionId,
        })
      } catch (error) {
        console.warn('[gemma-desktop] memory distillation failed, using sanitized raw input:', error)
      }
      if (!note) {
        note = sanitizeMemoryNote(rawInput)
      }
      if (!note) {
        throw new Error('Memory notes cannot be empty after cleanup.')
      }

      const result = await appendUserMemoryNote(app.getPath('userData'), note)
      return {
        memory: result.memory,
        appendedNote: result.appendedNote,
      }
    },
  )

  // ── Skills ──

  ipcMain.handle('skills:list-installed', async () => {
    return await listInstalledSkills()
  })

  ipcMain.handle('skills:search-catalog', async (_, query: string) => {
    return await searchSkillsCatalog(query)
  })

  ipcMain.handle(
    'skills:install',
    async (
      _,
      input: {
        repo: string
        skillName: string
      },
    ) => {
      await installSkillFromCatalog({
        repo: input.repo,
        skillName: input.skillName,
        targetRoot: getGemmaDesktopSkillRoot(app.getPath('userData')),
      })
      const installed = await listInstalledSkills()
      broadcastToWindows(
        BrowserWindow.getAllWindows(),
        'skills:changed',
        installed,
        'skills:changed',
      )
      return installed
    },
  )

  ipcMain.handle(
    'skills:remove',
    async (_, skillId: string) => {
      const installed = await listInstalledSkills()
      const target = installed.find((skill) => skill.id === skillId)
      if (!target) {
        return installed
      }

      if (
        target.rootLabel !== 'Gemma Desktop'
      ) {
        throw new Error(
          `Removal is only supported for app-managed installs. ${target.name} lives in ${target.rootLabel}.`,
        )
      }

      await removeInstalledSkill({
        skillName: target.slug,
        directory: target.directory,
        root: target.root,
      })
      const nextInstalled = await listInstalledSkills()
      broadcastToWindows(
        BrowserWindow.getAllWindows(),
        'skills:changed',
        nextInstalled,
        'skills:changed',
      )
      return nextInstalled
    },
  )

  // ── Planning ──

  ipcMain.handle(
    'plan:answer-question',
    async (_, sessionId: string, questionId: string, answer: string) => {
      const pending = store.getPendingPlanQuestion(sessionId)
      if (!pending || pending.id !== questionId) {
        throw new Error('Plan question not found for this session.')
      }

      const resolver = pendingPlanQuestionResolvers.get(questionId)
      pendingPlanQuestionResolvers.delete(questionId)
      setPendingPlanQuestionState(sessionId, null)

      const normalizedAnswer = answer.trim()
      if (resolver) {
        resolver.resolve(normalizedAnswer)
      }
      return {
        ok: true,
      }
    },
  )

  ipcMain.handle(
    'plan:dismiss-exit',
    async (_, sessionId: string) => {
      setPendingPlanExitState(sessionId, null)
      return { ok: true }
    },
  )

  ipcMain.handle(
    'plan:exit',
    async (
      _,
      sessionId: string,
      options?: { target?: PlanExitTarget },
    ) => {
      if (isSessionExecutionBusy(sessionId)) {
        throw new Error(
          'Wait for the current turn to finish before switching back to work mode.',
        )
      }

      const persisted = await getPersistedSession(sessionId)
      const liveSession = liveSessions.get(sessionId)
      const currentSnapshot = liveSession?.snapshot() ?? persisted?.snapshot
      if (!currentSnapshot || !persisted?.meta) {
        throw new Error(`Session not found: ${sessionId}`)
      }

      const config = getSessionConfig(currentSnapshot)
      const pending = store.getPendingPlanExit(sessionId)
      const workMode = pending?.workMode ?? config.baseMode
      const extractedPlanDetails =
        extractPlannerDetailsFromAppMessages(store.getAppMessages(sessionId))
        ?? extractPlannerDetailsFromSnapshot(currentSnapshot)
      const resolvedSummary =
        pending?.summary
        ?? extractPlannerSummaryFromAppMessages(store.getAppMessages(sessionId))
        ?? extractPlannerSummaryFromSnapshot(currentSnapshot)
        ?? 'Implementation handoff from plan mode.'
      const resolvedDetails = mergePlanExitDetails(
        pending?.details,
        extractedPlanDetails,
      )
      const kickoffText = buildPlanExitKickoffMessage({
        summary: resolvedSummary,
        details: resolvedDetails,
        workMode,
      })
      const target: PlanExitTarget =
        options?.target === 'fresh_summary' ? 'fresh_summary' : 'current'
      const executionTarget = resolveSessionPrimaryTarget(sessionId, {
        conversationKind: config.conversationKind,
        baseMode: workMode,
        surface: config.surface,
      }, currentSnapshot)
      const runtimeSelection = normalizeRuntimeForSessionMode(
        executionTarget.runtimeId,
        workMode,
      )
      const composition = await resolveSessionComposition({
        snapshot: currentSnapshot,
        conversationKind: config.conversationKind,
        sessionMode: workMode,
        planMode: false,
        modelId: executionTarget.modelId,
        runtimeId: runtimeSelection.runtimeId,
        preferredRuntimeId: executionTarget.runtimeId,
        selectedSkillIds: config.selectedSkillIds,
        selectedToolIds: config.selectedToolIds,
        surface: config.surface,
        visibility: config.visibility,
        storageScope: config.storageScope,
      })

      if (target === 'fresh_summary') {
        const freshSession = await gemmaDesktop.sessions.create({
          runtime: runtimeSelection.runtimeId,
          model: executionTarget.modelId,
          mode: composition.mode,
          workingDirectory: currentSnapshot.workingDirectory,
          systemInstructions: composition.systemInstructions,
          metadata: composition.metadata,
        })

        const handoffMessage = buildPlanExitHandoffMessage({
          sourceSessionId: sessionId,
          sourceTitle: persisted.meta.title,
          sourceLastMessage: persisted.meta.lastMessage,
          workingDirectory: currentSnapshot.workingDirectory,
          conversationKind: config.conversationKind,
          workMode,
          selectedSkillNames: config.selectedSkillNames,
          selectedToolNames: config.selectedToolNames,
          summary: resolvedSummary,
          details: resolvedDetails,
        })

        const seededSnapshot: SessionSnapshot = {
          ...freshSession.snapshot(),
          history: [handoffMessage],
          started: true,
          savedAt: new Date().toISOString(),
        }
        const seededSession = await gemmaDesktop.sessions.resume({
          snapshot: seededSnapshot,
        })
        liveSessions.set(seededSession.id, seededSession)

        const nextMeta: SessionMeta = {
          id: seededSession.id,
          title: buildPlanExitSessionTitle(persisted.meta.title),
          titleSource: 'auto',
          lastMessage: handoffMessage.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(' ')
            .trim()
            .slice(0, 120),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sessionTags: [],
        }

        await store.save(seededSession.id, seededSnapshot, nextMeta)
        setPendingPlanExitState(sessionId, null)
        await broadcastSessionsChanged()

        const detail = snapshotToDetail(
          seededSnapshot,
          nextMeta,
          '',
          [],
          null,
          null,
          null,
          null,
          null,
          false,
          false,
        )

        appendDebugLog(sessionId, {
          layer: 'ipc',
          direction: 'renderer->main',
          event: 'plan.exit.completed',
          summary: `Started fresh ${workMode} handoff session`,
          data: {
            sessionId,
            target,
            freshSessionId: seededSession.id,
            workMode,
            runtimeId: runtimeSelection.runtimeId,
            modelId: executionTarget.modelId,
          },
        })

        return {
          ok: true,
          session: detail,
          kickoffText,
        }
      }

      const nextSnapshot: SessionSnapshot = {
        ...currentSnapshot,
        runtimeId: runtimeSelection.runtimeId,
        modelId: executionTarget.modelId,
        mode: composition.mode,
        systemInstructions: composition.systemInstructions,
        metadata: composition.metadata,
        savedAt: new Date().toISOString(),
      }

      const nextSession = await gemmaDesktop.sessions.resume({
        snapshot: nextSnapshot,
      })
      liveSessions.set(sessionId, nextSession)
      setPendingPlanExitState(sessionId, null)
      await store.save(sessionId, nextSnapshot)

      const detail = snapshotToDetail(
        nextSnapshot,
        persisted.meta,
        store.getDraftText(sessionId),
        store.getAppMessages(sessionId),
        store.getPendingTurn(sessionId),
        store.getPendingCompaction(sessionId),
        store.getPendingPlanQuestion(sessionId),
        null,
        store.getPendingToolApproval(sessionId),
        getSessionExecutionTask(sessionId) === 'generation',
        getSessionExecutionTask(sessionId) === 'compaction',
      )
      sendToSession(sessionId, {
        type: 'session_reset',
        session: detail,
      })
      await broadcastSessionsChanged()

      appendDebugLog(sessionId, {
        layer: 'ipc',
        direction: 'renderer->main',
        event: 'plan.exit.completed',
        summary: `Switched session back to ${workMode} work mode`,
        data: {
          sessionId,
          target,
          workMode,
          runtimeId: runtimeSelection.runtimeId,
          modelId: executionTarget.modelId,
        },
      })

      return {
        ok: true,
        session: detail,
        kickoffText,
      }
    },
  )

  // ── Automations ──

  ipcMain.handle('automations:list', async () => {
    return automationStore.list().map((record) => automationToSummary(record))
  })

  ipcMain.handle('automations:get', async (_, automationId: string) => {
    const record = automationStore.get(automationId)
    return record ? automationToDetail(record) : null
  })

  ipcMain.handle(
    'automations:create',
    async (
      _,
      input: {
        name: string
        prompt: string
        runtimeId: string
        modelId: string
        mode: AppSessionMode
        selectedSkillIds?: string[]
        workingDirectory: string
        enabled: boolean
        schedule: AutomationSchedule
      },
    ) => {
      const modeConfig = sessionModeToConfig('build')
      const selectedSkillIds = Array.isArray(input.selectedSkillIds)
        ? input.selectedSkillIds
        : []
      const schedule = normalizeAutomationSchedule(input.schedule)
      const record = await automationStore.create({
        name: input.name.trim() || 'Untitled Automation',
        prompt: input.prompt,
        runtimeId: input.runtimeId,
        modelId: input.modelId,
        mode: modeConfig.baseMode,
        selectedSkillIds,
        selectedSkillNames: await resolveSelectedSkillNames(selectedSkillIds),
        workingDirectory: await ensureDirectoryExists(input.workingDirectory),
        enabled: input.enabled,
        schedule,
        nextRunAt: input.enabled ? computeInitialNextRunAt(schedule) : null,
      })
      broadcastAutomationsChanged()
      return automationToDetail(record)
    },
  )

  ipcMain.handle(
    'automations:update',
    async (
      _,
      automationId: string,
      input: Partial<{
        name: string
        prompt: string
        runtimeId: string
        modelId: string
        mode: AppSessionMode
        selectedSkillIds: string[]
        workingDirectory: string
        enabled: boolean
        schedule: AutomationSchedule
      }>,
    ) => {
      const current = automationStore.get(automationId)
      if (!current) {
        throw new Error(`Automation not found: ${automationId}`)
      }

      const nextModeConfig = sessionModeToConfig('build')

      const nextSelectedSkillIds = Array.isArray(input.selectedSkillIds)
        ? input.selectedSkillIds
        : current.selectedSkillIds
      const nextSchedule = input.schedule
        ? normalizeAutomationSchedule(input.schedule)
        : current.schedule
      const nextEnabled = input.enabled ?? current.enabled
      const nextRecord = await automationStore.update(automationId, {
        name: input.name?.trim() || current.name,
        prompt: input.prompt ?? current.prompt,
        runtimeId: input.runtimeId ?? current.runtimeId,
        modelId: input.modelId ?? current.modelId,
        mode: nextModeConfig.baseMode,
        selectedSkillIds: nextSelectedSkillIds,
        selectedSkillNames: await resolveSelectedSkillNames(nextSelectedSkillIds),
        workingDirectory: input.workingDirectory
          ? await ensureDirectoryExists(input.workingDirectory)
          : current.workingDirectory,
        enabled: nextEnabled,
        schedule: nextSchedule,
        nextRunAt: nextEnabled
          ? input.schedule || input.enabled !== undefined
            ? computeInitialNextRunAt(nextSchedule)
            : current.nextRunAt
          : null,
      })
      broadcastAutomationsChanged()
      return automationToDetail(nextRecord)
    },
  )

  ipcMain.handle('automations:delete', async (_, automationId: string) => {
    activeAutomationAbortControllers.get(automationId)?.abort()
    await automationStore.remove(automationId)
    activeAutomationRuns.delete(automationId)
    activeAutomationAbortControllers.delete(automationId)
    await refreshKeepAwakeState()
    broadcastAutomationsChanged()
  })

  ipcMain.handle('automations:run-now', async (_, automationId: string) => {
    void runAutomation(automationId, 'manual')
    return { ok: true }
  })

  ipcMain.handle('automations:cancel-run', async (_, automationId: string) => {
    activeAutomationAbortControllers.get(automationId)?.abort()
    return { ok: true }
  })

  // ── Debug ──

  ipcMain.handle('debug:get-session-logs', async (_, sessionId: string) => {
    if (store.getDebugLogs(sessionId).length === 0) {
      await store.load(sessionId).catch(() => null)
    }
    return store.getDebugLogs(sessionId)
  })

  ipcMain.handle('debug:get-session-config', async (_, sessionId: string) => {
    return await getSessionDebugSnapshot(sessionId)
  })

  ipcMain.handle('debug:clear-session-logs', async (_, sessionId: string) => {
    store.clearDebugLogs(sessionId)
    await store.flush(sessionId).catch(() => {})
  })

  // ── Environment ──

  ipcMain.handle('environment:inspect', async () => {
    try {
      const env = await gemmaDesktop.inspectEnvironment()
      const currentSettings = await getSettingsState()
      return {
        runtimes: mapRuntimes(env.runtimes),
        models: mapModels(env.runtimes, currentSettings),
        bootstrap: bootstrapState,
      }
    } catch (err) {
      console.error('[gemma-desktop] inspectEnvironment failed:', err)
      return {
        runtimes: [],
        models: [],
        bootstrap: bootstrapState,
      }
    }
  })

  ipcMain.handle('environment:models', async () => {
    try {
      const env = await gemmaDesktop.inspectEnvironment()
      const currentSettings = await getSettingsState()
      return mapModels(env.runtimes, currentSettings)
    } catch (err) {
      console.error('[gemma-desktop] listModels failed:', err)
      return []
    }
  })

  ipcMain.handle('environment:runtimes', async () => {
    try {
      const runtimes = await gemmaDesktop.listAvailableRuntimes()
      return mapRuntimes(runtimes)
    } catch (err) {
      console.error('[gemma-desktop] listRuntimes failed:', err)
      return []
    }
  })

  ipcMain.handle('environment:bootstrap-state', async () => {
    return bootstrapState
  })

  ipcMain.handle('environment:retry-bootstrap', async () => {
    return await ensureBootstrapReady(true)
  })

  ipcMain.handle(
    'environment:ensure-gemma-model',
    async (_, tag: string): Promise<EnsureGemmaModelResult> => {
      const entry = findGemmaCatalogEntryByTag(tag)
      if (!entry) {
        return {
          ok: false,
          tag,
          installed: false,
          error: `Unknown guided Gemma model: ${tag}`,
        }
      }

      if (!gemmaInstallManager) {
        return {
          ok: false,
          tag,
          installed: false,
          error: 'Gemma install manager is not ready yet.',
        }
      }

      const result = await gemmaInstallManager.ensureModel(entry)

      if (!result.ok && !result.cancelled && result.error) {
        dialog.showErrorBox(
          `Failed to download ${entry.label}`,
          result.error,
        )
      }

      return result
    },
  )

  ipcMain.handle('doctor:inspect', async () => {
    let environment = null
    let environmentError: string | undefined

    try {
      environment = await gemmaDesktop.inspectEnvironment()
    } catch (err) {
      console.error('[gemma-desktop] doctor inspectEnvironment failed:', err)
      environmentError = err instanceof Error
        ? err.message
        : 'Gemma Desktop could not inspect the local runtime environment.'
    }

    const shellEscape = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

    const runDoctorCommand = async (command: string, args: string[]) => {
      const baseEnv = {
        ...process.env,
        FORCE_COLOR: '0',
      }

      const runExecFile = async (
        file: string,
        fileArgs: string[],
      ): Promise<string> =>
        await new Promise<string>((resolve, reject) => {
          execFile(
            file,
            fileArgs,
            {
              env: baseEnv,
              maxBuffer: 1024 * 1024,
            },
            (error, stdout, stderr) => {
              const output = `${stdout}\n${stderr}`.trim()

              if (error) {
                const nextError = error as Error & { code?: string }
                if (output) {
                  nextError.message = output
                }
                reject(nextError)
                return
              }

              resolve(output)
            },
          )
        })

      try {
        return await runExecFile(command, args)
      } catch (error) {
        const missing =
          error
          && typeof error === 'object'
          && 'code' in error
          && error.code === 'ENOENT'

        if (!missing) {
          throw error
        }

        const shellPath = process.env.SHELL || '/bin/zsh'
        const shellCommand = `exec ${[command, ...args].map(shellEscape).join(' ')}`
        return await runExecFile(shellPath, ['-lic', shellCommand])
      }
    }

    const commands = await collectDoctorCommandChecks(runDoctorCommand)
    const currentSettings = await getSettingsState()
    const browserDoctor = await inspectAgentBrowserDoctor()
    const doctorSettings = browserDoctor
      ? {
          ...currentSettings,
          tools: {
            ...currentSettings.tools,
            chromeMcp: {
              ...currentSettings.tools.chromeMcp,
              lastStatus: browserDoctor.status,
            },
          },
        }
      : currentSettings

    const cpus = os.cpus()

    return buildDoctorReport({
      generatedAt: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron ?? '',
        node: process.versions.node ?? '',
        chrome: process.versions.chrome ?? '',
      },
      machine: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpuModel: cpus[0]?.model,
        cpuCount: cpus.length,
        totalMemoryBytes: os.totalmem(),
      },
      environment,
      environmentError,
      ollamaServerConfig: await inspectOllamaServerConfig(),
      commands,
      settings: doctorSettings,
      permissionStatuses:
        process.platform === 'darwin'
          ? {
              screen: systemPreferences.getMediaAccessStatus('screen'),
              camera: systemPreferences.getMediaAccessStatus('camera'),
              microphone: systemPreferences.getMediaAccessStatus('microphone'),
            }
          : {},
      speech: await inspectSpeechStatus(),
      readAloud: await inspectReadAloudStatus(),
      platform: process.platform,
    })
  })

  ipcMain.handle(
    'doctor:open-privacy-settings',
    async (_event, permissionId: 'screen' | 'camera' | 'microphone') => {
      if (process.platform !== 'darwin') {
        return false
      }

      const paneByPermission: Record<'screen' | 'camera' | 'microphone', string> = {
        screen: 'Privacy_ScreenCapture',
        camera: 'Privacy_Camera',
        microphone: 'Privacy_Microphone',
      }

      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${paneByPermission[permissionId]}`,
      )
      return true
    },
  )

  // ── System Stats ──

  ipcMain.handle('system:stats', () => getSystemStats())

  ipcMain.handle('system:model-token-usage', () => getModelTokenUsageReport())

  setInterval(() => {
    void getSystemStats().then((stats) => {
      broadcastToWindows(
        BrowserWindow.getAllWindows(),
        'system:stats-update',
        stats,
        'system:stats-update',
      )
    }).catch((error) => {
      console.error('Failed to refresh system stats:', error)
    })
    broadcastModelTokenUsage()
  }, 2000)

  // ── Folders ──

  ipcMain.handle('browser:get-state', async () => {
    return projectBrowserManager.getState()
  })

  ipcMain.handle('browser:navigate', async (
    event,
    url: string,
    options?: { sessionId?: string | null; coBrowseActive?: boolean },
  ) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.navigate({
      url: typeof url === 'string' ? url : '',
      sessionId:
        typeof options?.sessionId === 'string'
          ? options.sessionId
          : undefined,
      coBrowseActive:
        typeof options?.coBrowseActive === 'boolean'
          ? options.coBrowseActive
          : undefined,
    })
  })

  ipcMain.handle('browser:reload', async (event) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.reload()
  })

  ipcMain.handle('browser:stop-loading', async (event) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.stopLoading()
  })

  ipcMain.handle('browser:go-back', async (event) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.goBack()
  })

  ipcMain.handle('browser:go-forward', async (event) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.goForward()
  })

  ipcMain.handle('browser:take-control', async (
    event,
    reason?: string,
  ) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.releaseControlToUser({
      reason: typeof reason === 'string' ? reason : undefined,
    })
  })

  ipcMain.handle('browser:release-control', async (event) => {
    projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
    return projectBrowserManager.releaseControlToAgent()
  })

  ipcMain.handle(
    'browser:set-panel-bounds',
    async (event, bounds: ProjectBrowserPanelBounds | null) => {
      projectBrowserManager.setHostWindow(BrowserWindow.fromWebContents(event.sender))
      projectBrowserManager.setBounds(bounds)
      return { ok: true as const }
    },
  )

  ipcMain.handle('browser:close', async () => {
    projectBrowserManager.close()
    return { ok: true as const }
  })

  ipcMain.handle('folders:pick-directory', async (_, defaultPath?: string) => {
    const callerHint = defaultPath && defaultPath.trim().length > 0 ? defaultPath : null
    const rememberedHint = await readLastPickedDirectory()
    const settingsDefault = (await getSettingsState()).defaultProjectDirectory

    const candidates = [callerHint, rememberedHint, settingsDefault]
    let resolvedDefault = settingsDefault
    for (const candidate of candidates) {
      if (candidate && (await directoryExists(candidate))) {
        resolvedDefault = candidate
        break
      }
    }

    const options: Electron.OpenDialogOptions = {
      title: 'Select Project Folder',
      defaultPath: resolvedDefault,
      properties: ['openDirectory', 'createDirectory'],
    }
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    if (!selectedPath) {
      return null
    }

    const ensuredPath = await ensureDirectoryExists(selectedPath)
    await writeLastPickedDirectory(ensuredPath)
    return ensuredPath
  })

  ipcMain.handle('folders:open-path', async (_, targetPath: string) => {
    const resolvedPath = path.resolve(targetPath)
    await fs.access(resolvedPath)
    const error = await shell.openPath(resolvedPath)
    if (error) {
      throw new Error(error)
    }
  })

  ipcMain.handle('links:open-target', async (_, target: string) => {
    return await openLinkTarget(target)
  })

  ipcMain.handle(
    'attachments:plan-pdf-processing',
    async (
      _,
      input: Pick<IncomingAttachment, 'path' | 'dataUrl' | 'name' | 'size'> & {
        processedRange?: {
          startPage: number
          endPage: number
        }
        workerModelId?: string
      },
    ) => {
      return await planPdfAttachmentProcessing({
        ...input,
        workerModelId: input.workerModelId,
      })
    },
  )

  ipcMain.handle(
    'attachments:discard-pending',
    async (
      _,
      input: {
        sessionId: string
        path?: string
      },
    ) => {
      const targetPath = input.path?.trim()
      if (!targetPath) {
        return { ok: true as const, deleted: false }
      }

      const persisted = await getPersistedSession(input.sessionId)
      const snapshot = liveSessions.get(input.sessionId)?.snapshot() ?? persisted?.snapshot
      if (!snapshot) {
        return { ok: true as const, deleted: false }
      }

      const assetDirectory = await ensureSessionAssetDirectory(
        input.sessionId,
        snapshot.workingDirectory,
      )
      if (!isManagedPendingAttachmentPath(assetDirectory, targetPath)) {
        return { ok: true as const, deleted: false }
      }

      await fs.rm(path.resolve(targetPath), { force: true }).catch(() => {})
      return { ok: true as const, deleted: true }
    },
  )

  ipcMain.handle(
    'files:save-text',
    async (
      _,
      input: {
        title?: string
        defaultPath?: string
        content: string
      },
    ) => {
      const fallbackName = sanitizeExportFilename(
        input.defaultPath || 'session-history.md',
      )
      const options = {
        title: input.title ?? 'Save File',
        defaultPath:
          fallbackName.length > 0 ? fallbackName : 'session-history.md',
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }
      const focusedWindow = BrowserWindow.getFocusedWindow()
      const result = focusedWindow
        ? await dialog.showSaveDialog(focusedWindow, options)
        : await dialog.showSaveDialog(options)

      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      await fs.writeFile(result.filePath, input.content, 'utf-8')
      return { canceled: false, filePath: result.filePath }
    },
  )

  ipcMain.handle('workspace:inspect', async (_, workingDirectory: string) => {
    if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
      throw new Error('Workspace inspection requires a directory path.')
    }

    return await inspectWorkspace(workingDirectory)
  })

  ipcMain.handle('workspace:start-watch', async (_, workingDirectory: string) => {
    if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
      throw new Error('Workspace watch requires a directory path.')
    }

    const result = startWorkspaceWatch(workingDirectory)
    if (!result) {
      throw new Error('Unable to start workspace watcher.')
    }
    return result
  })

  ipcMain.handle('workspace:stop-watch', async (_, subscriptionId: string) => {
    if (typeof subscriptionId !== 'string' || subscriptionId.trim().length === 0) {
      return { ok: true }
    }

    stopWorkspaceWatch(subscriptionId)
    return { ok: true }
  })

  ipcMain.handle('terminals:list-installed', async () => {
    return await listInstalledTerminalApps()
  })

  ipcMain.handle('terminalDrawer:get-state', async () => {
    return appTerminalManager.getState()
  })

  ipcMain.handle(
    'terminalDrawer:start',
    async (
      _,
      input?: {
        workingDirectory?: string
      },
    ) => {
      const workingDirectory = await resolveAppTerminalWorkingDirectory(
        typeof input?.workingDirectory === 'string'
          ? input.workingDirectory
          : undefined,
      )

      return appTerminalManager.start({
        workingDirectory,
      })
    },
  )

  ipcMain.handle(
    'terminalDrawer:write-input',
    async (_event, data: string) => {
      appTerminalManager.write(data)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    'terminalDrawer:resize',
    async (_event, cols: number, rows: number) => {
      appTerminalManager.resize(cols, rows)
      return { ok: true as const }
    },
  )

  ipcMain.handle('terminalDrawer:terminate', async () => {
    appTerminalManager.terminate()
    return { ok: true as const }
  })

  ipcMain.handle(
    'terminals:open-directory',
    async (
      _,
      input: {
        directoryPath: string
        terminalId?: string
      },
    ) => {
      if (!input || typeof input.directoryPath !== 'string') {
        throw new Error('Terminal launch requires a directory path.')
      }

      return await openDirectoryInTerminal({
        directoryPath: input.directoryPath,
        terminalId: typeof input.terminalId === 'string' ? input.terminalId : undefined,
      })
    },
  )

  ipcMain.handle('media:request-camera-access', async () => {
    if (process.platform !== 'darwin') {
      return {
        granted: true,
        status: 'granted',
      }
    }

    const currentStatus = systemPreferences.getMediaAccessStatus('camera')
    if (currentStatus === 'granted') {
      return {
        granted: true,
        status: currentStatus,
      }
    }

    const granted = await systemPreferences.askForMediaAccess('camera')
    return {
      granted,
      status: systemPreferences.getMediaAccessStatus('camera'),
    }
  })

  ipcMain.handle('media:request-microphone-access', async () => {
    if (process.platform !== 'darwin') {
      return {
        granted: true,
        status: 'granted',
      }
    }

    const currentStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (currentStatus === 'granted') {
      return {
        granted: true,
        status: currentStatus,
      }
    }

    const granted = await systemPreferences.askForMediaAccess('microphone')
    return {
      granted,
      status: systemPreferences.getMediaAccessStatus('microphone'),
    }
  })

  // ── Speech ──

  ipcMain.handle('speech:inspect', async () => {
    return await inspectSpeechStatus()
  })

  ipcMain.handle('speech:install', async () => {
    return await speechRuntimeManager.install({
      enabled: (await getSettingsState()).speech.enabled,
    })
  })

  ipcMain.handle('speech:repair', async () => {
    return await speechRuntimeManager.repair({
      enabled: (await getSettingsState()).speech.enabled,
    })
  })

  ipcMain.handle('speech:remove', async () => {
    return await speechRuntimeManager.remove({
      enabled: (await getSettingsState()).speech.enabled,
    })
  })

  ipcMain.handle('speech:start-session', async (_, input: Record<string, unknown>) => {
    return await speechService.startSession({
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : randomUUID(),
      baseText: typeof input.baseText === 'string' ? input.baseText : '',
      selectionStart:
        typeof input.selectionStart === 'number' && Number.isFinite(input.selectionStart)
          ? Math.max(0, Math.floor(input.selectionStart))
          : 0,
      selectionEnd:
        typeof input.selectionEnd === 'number' && Number.isFinite(input.selectionEnd)
          ? Math.max(0, Math.floor(input.selectionEnd))
          : 0,
    })
  })

  ipcMain.handle('speech:send-chunk', async (_, input: Record<string, unknown>) => {
    const rawSignalMetrics = typeof input.signalMetrics === 'object' && input.signalMetrics
      ? input.signalMetrics as Record<string, unknown>
      : null

    return await speechService.enqueueChunk({
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sequence:
        typeof input.sequence === 'number' && Number.isFinite(input.sequence)
          ? Math.max(1, Math.floor(input.sequence))
          : 1,
      audioBase64: typeof input.audioBase64 === 'string' ? input.audioBase64 : '',
      mimeType: typeof input.mimeType === 'string' ? input.mimeType : 'audio/wav',
      durationMs:
        typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.floor(input.durationMs))
          : 0,
      final: input.final === true,
      signalMetrics: rawSignalMetrics
        ? {
            rms:
              typeof rawSignalMetrics.rms === 'number' && Number.isFinite(rawSignalMetrics.rms)
                ? Math.max(0, rawSignalMetrics.rms)
                : 0,
            peak:
              typeof rawSignalMetrics.peak === 'number' && Number.isFinite(rawSignalMetrics.peak)
                ? Math.max(0, rawSignalMetrics.peak)
                : 0,
            activeRatio:
              typeof rawSignalMetrics.activeRatio === 'number'
              && Number.isFinite(rawSignalMetrics.activeRatio)
                ? Math.min(1, Math.max(0, rawSignalMetrics.activeRatio))
                : 0,
          }
        : null,
    })
  })

  ipcMain.handle('speech:stop-session', async (_, sessionId: string) => {
    return await speechService.stopSession(sessionId)
  })

  ipcMain.handle('speech:finish-session', async (_, sessionId: string) => {
    return await speechService.finishSession(sessionId)
  })

  ipcMain.handle('read-aloud:inspect', async () => {
    return await inspectReadAloudStatus()
  })

  ipcMain.handle('read-aloud:list-voices', async () => {
    return [...READ_ALOUD_VOICE_OPTIONS]
  })

  ipcMain.handle('read-aloud:cancel-current', async () => {
    return await readAloudService.cancelCurrent()
  })

  ipcMain.handle('assistant-narration:generate', async (_, input: Record<string, unknown>) => {
    const phase = normalizeAssistantNarrationPhase(input.phase)
    const attachments = normalizeAssistantNarrationAttachments(input.attachments)
    const task = buildAssistantNarrationTask({
      phase,
      attachments,
      userText: typeof input.userText === 'string' ? input.userText : '',
      assistantText: typeof input.assistantText === 'string' ? input.assistantText : '',
      conversationTitle:
        typeof input.conversationTitle === 'string' ? input.conversationTitle : '',
    })

    try {
      const result = await runHelperStructuredTask({
        ownerId: `assistant-narration-${Date.now()}`,
        sessionRole: `assistant_narration_${phase}`,
        workingDirectory:
          typeof input.workingDirectory === 'string' && input.workingDirectory.trim()
            ? input.workingDirectory.trim()
            : app.getPath('userData'),
        systemInstructions: task.systemInstructions,
        responseFormat: ASSISTANT_NARRATION_RESPONSE_FORMAT,
        sessionInput: task.sessionInput,
      })

      return {
        text:
          normalizeAssistantNarrationText(result.structuredOutput, { phase })
          ?? normalizeAssistantNarrationText(result.outputText, { phase })
          ?? task.fallbackText,
        helperModelId: result.helperModelId,
        helperRuntimeId: result.helperRuntimeId,
      }
    } catch (error) {
      console.warn('[gemma-desktop] helper narration generation failed:', error)
      return {
        text: task.fallbackText,
        helperModelId: null,
        helperRuntimeId: null,
      }
    }
  })

  ipcMain.handle('thinking-summary:generate', async (_, input: Record<string, unknown>) => {
    const thinkingText = typeof input.thinkingText === 'string' ? input.thinkingText : ''
    if (!shouldSummarizeThinking(thinkingText)) {
      return { summary: null, helperModelId: null, helperRuntimeId: null }
    }

    const task = buildThinkingSummaryTask({
      thinkingText,
      userText: typeof input.userText === 'string' ? input.userText : '',
      conversationTitle:
        typeof input.conversationTitle === 'string' ? input.conversationTitle : '',
      turnContext: typeof input.turnContext === 'string' ? input.turnContext : '',
    })

    try {
      const result = await runHelperStructuredTask({
        ownerId: `thinking-summary-${Date.now()}`,
        sessionRole: 'thinking_summary',
        workingDirectory:
          typeof input.workingDirectory === 'string' && input.workingDirectory.trim()
            ? input.workingDirectory.trim()
            : app.getPath('userData'),
        systemInstructions: task.systemInstructions,
        responseFormat: THINKING_SUMMARY_RESPONSE_FORMAT,
        sessionInput: task.sessionInput,
      })

      const summary =
        normalizeThinkingSummary(result.structuredOutput)
        ?? normalizeThinkingSummary(result.outputText)

      return {
        summary,
        helperModelId: result.helperModelId,
        helperRuntimeId: result.helperRuntimeId,
      }
    } catch (error) {
      console.warn('[gemma-desktop] helper thinking summary failed:', error)
      return {
        summary: null,
        helperModelId: null,
        helperRuntimeId: null,
      }
    }
  })

  ipcMain.handle('read-aloud:synthesize', async (_, input: Record<string, unknown>) => {
    const currentSettings = await getSettingsState()
    return await readAloudService.synthesize(
      {
        messageId:
          typeof input.messageId === 'string' && input.messageId.trim().length > 0
            ? input.messageId
            : randomUUID(),
        text: typeof input.text === 'string' ? input.text : '',
        voice: normalizeReadAloudVoice(input.voice),
        speed: clampReadAloudSpeed(input.speed),
        purpose: input.purpose === 'preview' ? 'preview' : 'message',
        useCache: input.useCache !== false,
      },
      {
        enabled: currentSettings.readAloud.enabled,
      },
    )
  })

  ipcMain.handle('read-aloud:test', async (_, input?: ReadAloudTestInput) => {
    const currentSettings = await getSettingsState()
    return await readAloudService.test(input, {
      enabled: currentSettings.readAloud.enabled,
      defaultVoice: currentSettings.readAloud.defaultVoice,
      defaultSpeed: currentSettings.readAloud.speed,
    })
  })

  // ── Notifications ──

  ipcMain.handle(
    'notifications:update-attention-context',
    async (_, context: NotificationAttentionContext) => {
      currentAttentionContext = {
        currentView:
          context?.currentView === 'automations' ? 'automations' : 'chat',
        activeSessionId:
          typeof context?.activeSessionId === 'string'
            ? context.activeSessionId
            : null,
      }

      notificationManager.updateAttentionContext(currentAttentionContext)

      return { ok: true }
    },
  )

  ipcMain.handle(
    'notifications:get-permission-state',
    async (_, permissionStatus?: string) => {
      return notificationManager.setPermissionStatus(permissionStatus)
    },
  )

  ipcMain.handle('notifications:dismiss-permission-prompt', async () => {
    return notificationManager.dismissPermissionPrompt()
  })

  ipcMain.handle('notifications:send-test', async () => {
    return notificationManager.sendTestNotification()
  })

  // ── Settings ──

  ipcMain.handle('settings:get', async () => await getSettingsState())

  ipcMain.handle(
    'settings:update',
    async (_, patch: Record<string, unknown>) => {
      const nextSettings = await saveSettings(patch as Partial<AppSettingsRecord>)
      await refreshBootstrapModelSelection(nextSettings, patch)
      if (
        Object.prototype.hasOwnProperty.call(patch, 'toolPolicy')
        || Object.prototype.hasOwnProperty.call(patch, 'skills')
        || Object.prototype.hasOwnProperty.call(patch, 'tools')
      ) {
        await refreshSessionPolicies()
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'tools')) {
        await reconfigureBrowserToolManager(nextSettings)
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'integrations')) {
        gemmaDesktop?.updateIntegrations({
          geminiApiKey: nextSettings.integrations.geminiApi.apiKey,
          geminiApiModel: nextSettings.integrations.geminiApi.model,
        })
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'runtimes')) {
        gemmaDesktop?.updateAdapters(createConfiguredRuntimeAdapters(nextSettings))
        broadcastEnvironmentModelsChanged()
      }
      await refreshKeepAwakeState()
      broadcastSettingsChanged(nextSettings)
      broadcastSpeechStatusChanged(await inspectSpeechStatus())
      broadcastReadAloudStatusChanged(await inspectReadAloudStatus())
      return nextSettings
    },
  )
}
