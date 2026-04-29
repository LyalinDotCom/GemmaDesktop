import type {
  GemmaInstallState,
  GemmaSizeId,
  GuidedModelFamily,
} from '@shared/gemmaCatalog'
import type {
  AttachmentKind,
  AttachmentSupport,
} from '@shared/attachmentSupport'
import type {
  SessionToolDefinition,
  SessionToolIcon,
} from '@shared/sessionTools'
import type {
  SpeechChunkInput,
  SpeechEvent,
  SpeechInspection,
  SpeechSessionStartInput,
  SpeechSessionStartResult,
} from '@shared/speech'
import type {
  ReadAloudInstallProgress,
  ReadAloudInspection,
  ReadAloudSynthesisInput,
  ReadAloudSynthesisResult,
  ReadAloudTestInput,
  ReadAloudVoiceId,
  ReadAloudVoiceOption,
} from '@shared/readAloud'
import type {
  AssistantNarrationAttachmentSummary,
  AssistantNarrationPhase,
} from '@shared/assistantNarration'
import type { SidebarState } from '@shared/sidebar'
import type { RunningBackgroundProcessSummary } from '@shared/backgroundProcesses'
import type { SessionTag } from '@shared/sessionTags'
import type {
  AppNotificationSettings,
  NotificationActivationTarget,
  NotificationAttentionContext,
  NotificationPermissionState,
} from '@shared/notifications'
import type { AppOllamaSettings } from '@shared/ollamaRuntimeConfig'
import type { AppLmStudioSettings } from '@shared/lmstudioRuntimeConfig'
import type { AppReasoningSettings } from '@shared/reasoningSettings'
import type { ConversationApprovalMode } from '@gemma-desktop/sdk-core'
import type {
  GlobalChatOpenInAppRequest,
  GlobalChatState,
} from '@shared/globalChat'
import type {
  SessionSearchRequest,
  SessionSearchResult,
} from '@shared/sessionSearch'
import type { AppModelSelectionSettings } from '@shared/sessionModelDefaults'
import type {
  AppTerminalState,
  AppTerminalStatus,
} from '@shared/appTerminal'
import type {
  ShellSessionContentBlock,
  ShellSessionStatus,
} from '@shared/shellSession'
import type { TerminalAppInfo } from '@shared/terminal'
import type { WorkspaceInspection } from '@shared/workspace'
import type {
  ProjectBrowserPanelBounds,
  ProjectBrowserState,
} from '@shared/projectBrowser'
import type { FileEditContentBlock } from '@shared/fileEdits'

// ── Session Types ──

export type WorkMode = 'explore' | 'build'
export type ConversationKind = 'normal' | 'research'
export type SessionMode = WorkMode
export type AppView = NotificationAttentionContext['currentView']
export type SessionTitleSource = 'auto' | 'user'

export interface PrimaryModelAvailabilityIssue {
  modelId: string
  runtimeId: string
  message: string
  detectedAt: number
  source: 'startup' | 'selected-session' | 'send' | 'global-default'
  fallbackModelId?: string
  fallbackRuntimeId?: string
}

export interface BootstrapState {
  status: 'idle' | 'checking' | 'starting_ollama' | 'pulling_models' | 'loading_helper' | 'ready' | 'warning' | 'error'
  ready: boolean
  message: string
  helperModelId: string
  helperRuntimeId: string
  requiredPrimaryModelIds: string[]
  modelAvailabilityIssues: PrimaryModelAvailabilityIssue[]
  error?: string
  updatedAt: number
}

export interface SessionSummary {
  id: string
  title: string
  titleSource: SessionTitleSource
  modelId: string
  runtimeId: string
  usesTemporaryModelOverride: boolean
  conversationKind: ConversationKind
  workMode: WorkMode
  planMode: boolean
  approvalMode?: ConversationApprovalMode
  selectedSkillIds: string[]
  selectedSkillNames: string[]
  selectedToolIds: string[]
  selectedToolNames: string[]
  workingDirectory: string
  lastMessage: string
  createdAt: number
  updatedAt: number
  isGenerating: boolean
  isCompacting: boolean
  runningProcesses?: RunningBackgroundProcessSummary[]
  sessionTags?: SessionTag[]
}

export type { SessionTag } from '@shared/sessionTags'

export interface SessionDetail extends SessionSummary {
  draftText: string
  messages: ChatMessage[]
  streamingContent?: MessageContent[] | null
  pendingCompaction?: PendingCompaction | null
  pendingPlanQuestion?: PendingPlanQuestion | null
  pendingPlanExit?: PendingPlanExit | null
  pendingToolApproval?: PendingToolApproval | null
}

export interface LiveActivitySnapshot {
  source: 'session' | 'research'
  state: 'waiting' | 'thinking' | 'streaming' | 'working'
  stage?: 'planning' | 'discovery' | 'workers' | 'synthesis'
  topicTitle?: string
  attempt?: number
  startedAt: number
  lastEventAt?: number
  firstTokenAt?: number
  lastChannel?: 'assistant' | 'reasoning'
  assistantUpdates: number
  reasoningUpdates: number
  lifecycleEvents: number
  activeToolName?: string
  activeToolLabel?: string
  activeToolContext?: string
  runningToolCount: number
  completedToolCount: number
  recentProgressCount: number
  lastProgressAt?: number
}

export interface ToolProgressEntry {
  id: string
  label: string
  timestamp: number
  tone?: 'info' | 'success' | 'warning'
}

export interface ToolWorkerTimelineEntry {
  id: string
  label: string
  detail?: string
  timestamp: number
  tone?: 'info' | 'success' | 'warning'
}

export interface ToolWorkerCommand {
  command: string
  cwd?: string
}

export interface ToolWorkerResultData {
  sources?: string[]
  evidence?: string[]
  filesChanged?: string[]
  commands?: ToolWorkerCommand[]
}

export interface ToolWorkerDetail {
  kind: string
  label: string
  goal?: string
  childSessionId?: string
  childTurnId?: string
  currentAction?: string
  counters?: Record<string, number>
  timeline?: ToolWorkerTimelineEntry[]
  traceText?: string
  resultSummary?: string
  resultData?: ToolWorkerResultData
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContent[]
  timestamp: number
  durationMs?: number
}

export interface QueuedUserMessage {
  id: string
  text: string
  attachments: FileAttachment[]
  coBrowse?: boolean
  content: MessageContent[]
  timestamp: number
  status: 'queued' | 'failed'
  error?: string
}

export type MessageContent =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      url: string
      alt?: string
      filename?: string
      mediaType?: string
      source?: 'camera' | 'file'
    }
  | {
      type: 'pdf'
      url: string
      filename: string
      mediaType?: 'application/pdf'
      pageCount: number
      processingMode: PdfProcessingMode
      processedRange: PdfPageRange
      batchCount: number
      workerModelId?: string
      fitStatus: PdfFitStatus
      previewThumbnails: string[]
      derivedSummary?: string
      derivedTextPath?: string
    }
  | {
      type: 'audio'
      url: string
      filename: string
      mediaType?: string
      durationMs?: number
      normalizedMediaType?: string
    }
  | {
      type: 'video'
      url: string
      filename: string
      mediaType?: string
      durationMs?: number
      sampledFrameCount: number
      thumbnails: string[]
      sampledFrameTimestampsMs?: number[]
    }
  | { type: 'thinking'; text: string; summary?: string }
  | { type: 'code'; language: string; code: string; filename?: string }
  | FileEditContentBlock
  | {
      type: 'diff'
      filename: string
      diff: string
    }
  | {
      type: 'file_excerpt'
      filename: string
      startLine: number
      content: string
      language: string
    }
  | {
      type: 'tool_call'
      toolName: string
      input: Record<string, unknown>
      output?: string
      status: 'pending' | 'running' | 'success' | 'error'
      summary?: string
      startedAt?: number
      completedAt?: number
      progressEntries?: ToolProgressEntry[]
      progressCounts?: Record<string, number>
      worker?: ToolWorkerDetail
    }
  | { type: 'error'; message: string; details?: string }
  | { type: 'warning'; message: string }
  | ShellSessionContentBlock
  | { type: 'folder_link'; path: string; label: string }
  | { type: 'research_panel'; panel: ResearchPanelViewModel }

export type ResearchPanelStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ResearchPanelDomain {
  domain: string
  count: number
}

export interface ResearchPanelTopicStep {
  id: string
  title: string
  goal?: string
  summary?: string
  status: ResearchPanelStepStatus
  sourceCount: number
  searchCount: number
  fetchCount: number
  label: string
  startedAt?: number
  completedAt?: number
  lastError?: string
}

export interface ResearchPanelViewModel {
  runId: string
  runStatus: 'running' | 'completed' | 'failed' | 'cancelled'
  stage: 'planning' | 'discovery' | 'workers' | 'synthesis' | 'completed' | 'failed' | 'cancelled'
  title?: string
  startedAt?: number
  completedAt?: number
  elapsedLabel?: string
  plan: {
    status: ResearchPanelStepStatus
    label: string
    topicCount: number
  }
  sources: {
    status: ResearchPanelStepStatus
    label: string
    totalSources: number
    targetSources: number
    distinctDomains: number
    targetDomains: number
    topDomains: ResearchPanelDomain[]
    otherDomainCount: number
    otherDomainSourceCount: number
    currentPass?: number
    passCount?: number
  }
  topics: ResearchPanelTopicStep[]
  synthesis: {
    status: ResearchPanelStepStatus
    label: string
  }
  liveHint?: string
  errorMessage?: string
  artifactDirectory?: string
}

// ── Model and Runtime Types ──

export interface ModelSummary {
  id: string
  name: string
  runtimeId: string
  runtimeName: string
  parameterCount?: string
  quantization?: string
  contextLength?: number
  status: 'loaded' | 'available' | 'loading'
  attachmentSupport?: AttachmentSupport
  runtimeConfig?: {
    provider: 'ollama' | 'lmstudio' | 'omlx'
    baseParameters?: Record<string, unknown>
    baseParametersText?: string
    requestedOptions?: Record<string, number>
    loadedOptions?: Record<string, unknown>
    nominalContextLength?: number
    loadedContextLength?: number
    approxGpuResidencyPercent?: number
  }
}

export type { GemmaInstallState, GemmaSizeId, GuidedModelFamily }

export interface RuntimeSummary {
  id: string
  name: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
}

export interface DoctorCommandCheck {
  id: 'node' | 'npm' | 'npx'
  label: string
  command: string
  status: 'available' | 'missing' | 'error'
  version?: string
  detail: string
  hint?: string
}

export interface DoctorModelSummary {
  id: string
  label: string
  status: 'loaded' | 'loading' | 'available'
  parameterCount?: string
  quantization?: string
  contextLength?: number
  runtimeConfig?: ModelSummary['runtimeConfig']
}

export interface DoctorRuntimeVariant {
  id: string
  label: string
  endpoint: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
}

export interface DoctorRuntimeCheck {
  id: string
  label: string
  status: 'running' | 'stopped' | 'not_installed'
  version?: string
  modelCount: number
  loadedModelCount: number
  summary: string
  variants: DoctorRuntimeVariant[]
  models: DoctorModelSummary[]
  warnings: string[]
  diagnosis: string[]
}

export type DoctorPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'unsupported'

export interface DoctorPermissionCheck {
  id: 'screen' | 'camera' | 'microphone'
  label: string
  status: DoctorPermissionStatus
  severity: 'success' | 'warning' | 'info'
  summary: string
  hint?: string
  requestableInApp: boolean
}

export interface DoctorIssue {
  severity: 'error' | 'warning' | 'info'
  title: string
  detail: string
}

export interface DoctorIntegrationCheck {
  id: 'chromeMcp'
  label: string
  status: 'ready' | 'disabled' | 'missing_dependency' | 'attention'
  summary: string
  detail?: string
  hint?: string
}

export interface DoctorSpeechCheck {
  providerLabel: string
  modelLabel: string
  enabled: boolean
  installState: string
  healthy: boolean
  detail: string
  lastError: string | null
  recommendedAction: 'request_microphone' | 'install' | 'repair' | 'open_settings' | null
}

export interface DoctorReadAloudCheck {
  providerLabel: string
  modelLabel: string
  dtype: string
  backend: string
  enabled: boolean
  state: string
  healthy: boolean
  detail: string
  lastError: string | null
  recommendedAction: 'open_voice_settings' | null
}

export interface DoctorReport {
  generatedAt: string
  summary: {
    ready: boolean
    headline: string
    errorCount: number
    warningCount: number
  }
  app: {
    version: string
    electron: string
    node: string
    chrome: string
  }
  machine: {
    platform: string
    release: string
    arch: string
    cpuModel?: string
    cpuCount: number
    totalMemoryGB: number
  }
  commands: DoctorCommandCheck[]
  runtimes: DoctorRuntimeCheck[]
  speech: DoctorSpeechCheck
  readAloud: DoctorReadAloudCheck
  permissions: DoctorPermissionCheck[]
  integrations: DoctorIntegrationCheck[]
  issues: DoctorIssue[]
}

// ── System Types ──

export interface SystemStats {
  memoryUsedGB: number
  memoryTotalGB: number
  gpuUsagePercent: number
  cpuUsagePercent: number
}

export interface ModelTokenUsageSnapshot {
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

export interface ModelTokenUsageReport {
  startedAtMs: number
  usage: ModelTokenUsageSnapshot[]
}

export interface SessionContext {
  tokensUsed: number
  contextLength: number
  speed: SessionSpeedStats
  source: 'request-preview' | 'visible-chat'
}

export interface SessionSpeedStats {
  recentTps: number | null
  averageTps: number | null
  slowestTps: number | null
  fastestTps: number | null
  sampleCount: number
  recentSampleCount: number
  hasEstimatedSamples: boolean
}

// ── Settings ──

export type AppToolPolicyMode = WorkMode

export interface AppToolPolicyBucket {
  allowedTools: string[]
}

export interface AppToolPolicySettings {
  explore: AppToolPolicyBucket
  build: AppToolPolicyBucket
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  enterToSend: boolean
  defaultMode: WorkMode
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
  notifications: AppNotificationSettings
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
      lastStatus?: {
        state: 'idle' | 'ready' | 'error'
        message: string
        checkedAt: number
      }
    }
  }
  toolPolicy: AppToolPolicySettings
  runtimes: {
    ollama: {
      endpoint: string
      numParallel: number
      maxLoadedModels: number
      keepAliveEnabled: boolean
    }
    lmstudio: {
      endpoint: string
      maxConcurrentPredictions: number
    }
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

// ── IPC Bridge ──

export interface UserMessage {
  text: string
  attachments?: FileAttachment[]
  coBrowse?: boolean
}

export interface PendingAttachmentPayload {
  sessionId: string
  attachment: FileAttachment
}

export interface PdfPageRange {
  startPage: number
  endPage: number
}

export type PdfProcessingMode = 'full_document' | 'custom_range'

export type PdfFitStatus =
  | 'ready'
  | 'too_large'
  | 'worker_unavailable'
  | 'planning_failed'

export interface PdfProcessingPlan {
  pageCount: number
  defaultRange: PdfPageRange
  workerModelId?: string
  estimatedBatchCount: number
  fitStatus: PdfFitStatus
  reason?: string
}

interface BaseAttachment {
  name: string
  size: number
  mediaType?: string
  path?: string
  dataUrl?: string
  previewUrl?: string
  timestampMs?: number
}

export interface ImageAttachment extends BaseAttachment {
  kind: 'image'
  source?: 'camera' | 'file'
}

export interface AudioAttachment extends BaseAttachment {
  kind: 'audio'
  source?: 'file'
  durationMs?: number
  normalizedDataUrl?: string
  normalizedMediaType?: string
}

export interface VideoAttachment extends BaseAttachment {
  kind: 'video'
  source?: 'file'
  durationMs?: number
  sampledFrames?: ImageAttachment[]
}

export interface PdfAttachment extends BaseAttachment {
  kind: 'pdf'
  mediaType: 'application/pdf'
  source?: 'file'
  pageCount?: number
  processingMode?: PdfProcessingMode
  processedRange?: PdfPageRange
  workerModelId?: string
  batchCount?: number
  fitStatus?: PdfFitStatus
  previewThumbnails?: string[]
  planningReason?: string
}

export type FileAttachment =
  | ImageAttachment
  | AudioAttachment
  | VideoAttachment
  | PdfAttachment

export type { AttachmentKind, AttachmentSupport }

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

export interface InstalledSkillRecord {
  id: string
  slug: string
  name: string
  description: string
  location: string
  directory: string
  root: string
  rootLabel: string
  tokenEstimate: number
}

export interface SkillCatalogEntry {
  id: string
  repo: string
  skillName: string
  installsText?: string
  url?: string
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

export interface PendingPlanExit {
  id: string
  turnId?: string
  createdAt: number
  workMode: WorkMode
  summary: string
  details?: string
  source?: 'model' | 'synthetic'
  trigger?: 'exit_plan_mode' | 'legacy_prepare_plan_execution' | 'blocked_build_tool'
  attentionToken?: number
}

export interface PlanExitResult {
  ok: true
  session: SessionDetail
  kickoffText?: string
}

export interface PendingToolApproval {
  id: string
  turnId?: string
  toolName: string
  argumentsSummary: string
  reason: string
  requestedAt: number
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

export type AutomationSchedule =
  | {
      kind: 'once'
      runAt: number
    }
  | {
      kind: 'interval'
      every: number
      unit: 'minutes' | 'hours' | 'days'
      startAt: number
    }

export interface AutomationLogEntry {
  id: string
  timestamp: number
  layer: 'automation' | 'sdk' | 'runtime'
  event: string
  summary: string
  data: unknown
}

export interface AutomationRunRecord {
  id: string
  trigger: 'manual' | 'schedule'
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error' | 'cancelled'
  summary: string
  outputText?: string
  errorMessage?: string
  generatedTokens?: number
  tokensPerSecond?: number
  logs: AutomationLogEntry[]
}

export interface AutomationSummary {
  id: string
  name: string
  prompt: string
  runtimeId: string
  modelId: string
  mode: WorkMode
  selectedSkillIds: string[]
  selectedSkillNames: string[]
  workingDirectory: string
  enabled: boolean
  schedule: AutomationSchedule
  scheduleText: string
  nextRunAt: number | null
  lastRunAt?: number
  lastRunStatus?: 'running' | 'success' | 'error' | 'cancelled'
  createdAt: number
  updatedAt: number
  runCount: number
}

export interface AutomationDetail extends AutomationSummary {
  runs: AutomationRunRecord[]
}

export interface CreateSessionOpts {
  modelId: string
  runtimeId: string
  conversationKind: ConversationKind
  workMode?: WorkMode
  planMode?: boolean
  approvalMode?: ConversationApprovalMode
  selectedSkillIds?: string[]
  selectedToolIds?: string[]
  workingDirectory?: string
  title?: string
}

export interface UpdateSessionOpts {
  workMode?: WorkMode
  planMode?: boolean
  approvalMode?: ConversationApprovalMode
  modelId?: string
  runtimeId?: string
  selectedSkillIds?: string[]
  selectedToolIds?: string[]
  workingDirectory?: string
}

export interface DebugSessionSnapshot {
  sessionId: string
  runtimeId: string
  modelId: string
  mode: WorkMode | string | Record<string, unknown>
  workingDirectory: string
  savedAt: string
  started: boolean
  maxSteps: number
  compaction?: {
    count: number
    lastCompactedAt?: string
  }
  metadata?: Record<string, unknown>
  historyMessageCount: number
  toolNames: string[]
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    strict?: boolean
    metadata?: Record<string, unknown>
  }>
  systemPromptSections: Array<{
    source:
      | 'fallback'
      | 'family'
      | 'model'
      | 'environment'
      | 'tool_context'
      | 'mode'
      | 'exact_paths'
      | 'capabilities'
      | 'custom'
    text: string
    id?: string
  }>
  systemPrompt: string
  requestPreview: {
    model: string
    messages: Array<Record<string, unknown>>
    tools: Array<Record<string, unknown>>
    settings: Record<string, unknown>
  }
}

export type MenuBarScreenshotTarget = 'full_screen' | 'window'

export interface MenuBarPopupState {
  captureBusy: boolean
}

export interface GemmaDesktopBridge {
  sidebar: {
    get(): Promise<SidebarState>
    pinSession(sessionId: string, areaId: string): Promise<SidebarState>
    unpinSession(sessionId: string): Promise<SidebarState>
    flagFollowUp(sessionId: string): Promise<SidebarState>
    unflagFollowUp(sessionId: string): Promise<SidebarState>
    rememberActiveSession(sessionId: string | null): Promise<SidebarState>
    movePinnedSession(sessionId: string, toIndex: number): Promise<SidebarState>
    createPinnedArea(icon: string, sessionId: string | null): Promise<SidebarState>
    deletePinnedArea(areaId: string): Promise<SidebarState>
    updatePinnedAreaIcon(areaId: string, icon: string): Promise<SidebarState>
    setPinnedAreaCollapsed(areaId: string, collapsed: boolean): Promise<SidebarState>
    movePinnedArea(areaId: string, direction: 'up' | 'down'): Promise<SidebarState>
    setSessionOrder(sessionId: string, toIndex: number): Promise<SidebarState>
    clearSessionOrder(sessionId: string): Promise<SidebarState>
    setProjectOrder(projectPath: string, toIndex: number): Promise<SidebarState>
    clearProjectOrder(projectPath: string): Promise<SidebarState>
    closeProject(projectPath: string): Promise<SidebarState>
    reopenProject(projectPath: string): Promise<SidebarState>
    onChanged(callback: (state: SidebarState) => void): () => void
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    create(opts: CreateSessionOpts): Promise<SessionSummary>
    get(sessionId: string): Promise<SessionDetail>
    search(input: SessionSearchRequest): Promise<SessionSearchResult[]>
    saveDraft(sessionId: string, draftText: string): Promise<{ ok: true }>
    update(sessionId: string, opts: UpdateSessionOpts): Promise<SessionDetail>
    delete(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    setTags(sessionId: string, tags: SessionTag[]): Promise<void>
    suggestTagEmoji(tagName: string, excludeEmojis: string[]): Promise<{ emoji: string | null }>
    sendMessage(sessionId: string, message: UserMessage): Promise<void>
    sendHiddenInstruction(sessionId: string, text: string): Promise<void>
    runShellCommand(sessionId: string, input: { command: string }): Promise<void>
    writeShellInput(sessionId: string, terminalId: string, data: string): Promise<{ ok: true }>
    resizeShell(
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): Promise<{ ok: true }>
    closeShell(sessionId: string, terminalId: string): Promise<{ ok: true }>
    runResearch(sessionId: string, message: { text: string }): Promise<void>
    compact(sessionId: string): Promise<{ ok: boolean; cancelled: boolean }>
    clearHistory(sessionId: string): Promise<void>
    cancelGeneration(sessionId: string): Promise<void>
    resolveToolApproval(
      sessionId: string,
      approvalId: string,
      approved: boolean,
    ): Promise<{ ok: true }>
    onChanged(callback: (sessions: SessionSummary[]) => void): () => void
  }
  environment: {
    inspect(): Promise<{
      runtimes: RuntimeSummary[]
      models: ModelSummary[]
      bootstrap: BootstrapState
    }>
    listModels(): Promise<ModelSummary[]>
    listRuntimes(): Promise<RuntimeSummary[]>
    getBootstrapState(): Promise<BootstrapState>
    retryBootstrap(): Promise<BootstrapState>
    ensureGemmaModel(tag: string): Promise<{
      ok: boolean
      tag: string
      installed: boolean
      cancelled?: boolean
      error?: string
    }>
    onBootstrapChanged(
      callback: (state: BootstrapState) => void,
    ): () => void
    onModelsChanged(callback: () => void): () => void
    onGemmaInstallChanged(
      callback: (states: GemmaInstallState[]) => void,
    ): () => void
  }
  doctor: {
    inspect(): Promise<DoctorReport>
    openPrivacySettings(permissionId: 'screen' | 'camera' | 'microphone'): Promise<boolean>
  }
  system: {
    getStats(): Promise<SystemStats>
    openEmojiPanel(): Promise<{ ok: true }>
    onStatsUpdate(callback: (stats: SystemStats) => void): () => void
    getModelTokenUsage(): Promise<ModelTokenUsageReport>
    onModelTokenUsageUpdate(
      callback: (report: ModelTokenUsageReport) => void,
    ): () => void
  }
  events: {
    onSessionEvent(
      sessionId: string,
      callback: (event: SessionStreamEvent) => void,
    ): () => void
  }
  browser: {
    getState(): Promise<ProjectBrowserState>
    navigate(
      url: string,
      options?: { sessionId?: string | null; coBrowseActive?: boolean },
    ): Promise<ProjectBrowserState>
    reload(): Promise<ProjectBrowserState>
    stopLoading(): Promise<ProjectBrowserState>
    goBack(): Promise<ProjectBrowserState>
    goForward(): Promise<ProjectBrowserState>
    takeControl(reason?: string): Promise<ProjectBrowserState>
    releaseControl(): Promise<ProjectBrowserState>
    setPanelBounds(bounds: ProjectBrowserPanelBounds | null): Promise<{ ok: true }>
    close(): Promise<{ ok: true }>
    onStateChanged(callback: (state: ProjectBrowserState) => void): () => void
  }
  talk: {
    ensureSession(): Promise<SessionDetail>
    clearSession(): Promise<SessionDetail>
  }
  globalChat: {
    getState(): Promise<GlobalChatState>
    getSession(): Promise<SessionDetail>
    assignSession(sessionId: string): Promise<GlobalChatState>
    clearAssignment(): Promise<GlobalChatState>
    onChanged(callback: (state: GlobalChatState) => void): () => void
    onOpenInAppRequested(
      callback: (request: GlobalChatOpenInAppRequest) => void,
    ): () => void
  }
  menuBarPopup: {
    getState(): Promise<MenuBarPopupState>
    close(): Promise<{ ok: true }>
    openApp(): Promise<{ ok: true }>
    captureScreenshot(target: MenuBarScreenshotTarget): Promise<{ ok: true }>
    onStateChanged(callback: (state: MenuBarPopupState) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    onChanged(callback: (settings: AppSettings) => void): () => void
  }
  notifications: {
    updateAttentionContext(
      context: NotificationAttentionContext,
    ): Promise<{ ok: true }>
    getPermissionState(): Promise<NotificationPermissionState>
    requestPermission(): Promise<NotificationPermissionState>
    dismissPermissionPrompt(): Promise<NotificationPermissionState>
    sendTest(): Promise<{ ok: boolean; delivered: boolean; reason?: string }>
    onActivateTarget(
      callback: (target: NotificationActivationTarget) => void,
    ): () => void
    onPermissionPrompt(callback: () => void): () => void
  }
  skills: {
    listInstalled(): Promise<InstalledSkillRecord[]>
    searchCatalog(query: string): Promise<SkillCatalogEntry[]>
    install(input: { repo: string; skillName: string }): Promise<InstalledSkillRecord[]>
    remove(skillId: string): Promise<InstalledSkillRecord[]>
    onChanged(callback: (skills: InstalledSkillRecord[]) => void): () => void
  }
  folders: {
    pickDirectory(defaultPath?: string): Promise<string | null>
    openPath(targetPath: string): Promise<void>
  }
  terminalDrawer: {
    getState(): Promise<AppTerminalState>
    start(input?: {
      workingDirectory?: string
    }): Promise<AppTerminalState>
    writeInput(data: string): Promise<{ ok: true }>
    resize(cols: number, rows: number): Promise<{ ok: true }>
    terminate(): Promise<{ ok: true }>
    onStateChanged(callback: (state: AppTerminalState) => void): () => void
  }
  terminals: {
    listInstalled(): Promise<TerminalAppInfo[]>
    openDirectory(input: {
      directoryPath: string
      terminalId?: string
    }): Promise<{ ok: true; terminal: TerminalAppInfo }>
  }
  attachments: {
    planPdfProcessing(input: {
      path?: string
      dataUrl?: string
      name?: string
      size?: number
      processedRange?: PdfPageRange
      workerModelId?: string
    }): Promise<PdfProcessingPlan>
    discardPending(input: {
      sessionId: string
      path?: string
    }): Promise<{ ok: true; deleted: boolean }>
    onPendingAttachment(
      callback: (payload: PendingAttachmentPayload) => void,
    ): () => void
  }
  workspace: {
    inspect(workingDirectory: string): Promise<WorkspaceInspection>
    subscribe(
      workingDirectory: string,
      callback: (event: { rootPath: string }) => void,
    ): Promise<() => void>
  }
  files: {
    saveText(input: {
      title?: string
      defaultPath?: string
      content: string
    }): Promise<{ canceled: boolean; filePath?: string }>
  }
  links: {
    openTarget(target: string): Promise<boolean>
  }
  clipboard: {
    writeText(text: string): Promise<void>
  }
  media: {
    requestCameraAccess(): Promise<{ granted: boolean; status: string }>
    requestMicrophoneAccess(): Promise<{ granted: boolean; status: string }>
  }
  speech: {
    inspect(): Promise<SpeechInspection>
    install(): Promise<SpeechInspection>
    repair(): Promise<SpeechInspection>
    remove(): Promise<SpeechInspection>
    startSession(input: SpeechSessionStartInput): Promise<SpeechSessionStartResult>
    sendChunk(input: SpeechChunkInput): Promise<{ ok: true }>
    finishSession(sessionId: string): Promise<{ ok: true }>
    stopSession(sessionId: string): Promise<{ ok: true }>
    onEvent(
      sessionId: string,
      callback: (event: SpeechEvent) => void,
    ): () => void
    onStatusChanged(callback: (status: SpeechInspection) => void): () => void
  }
  readAloud: {
    inspect(): Promise<ReadAloudInspection>
    synthesize(input: ReadAloudSynthesisInput): Promise<ReadAloudSynthesisResult>
    cancelCurrent(): Promise<{ ok: true }>
    test(input?: ReadAloudTestInput): Promise<ReadAloudSynthesisResult>
    listVoices(): Promise<ReadAloudVoiceOption[]>
    onStatusChanged(callback: (status: ReadAloudInspection) => void): () => void
  }
  assistantNarration: {
    generate(input: {
      phase: AssistantNarrationPhase
      userText: string
      attachments?: AssistantNarrationAttachmentSummary[]
      assistantText?: string
      conversationTitle?: string
      workingDirectory?: string
    }): Promise<{
      text: string | null
      helperModelId: string | null
      helperRuntimeId: string | null
    }>
  }
  thinkingSummary: {
    generate(input: {
      thinkingText: string
      userText?: string
      conversationTitle?: string
      workingDirectory?: string
      turnContext?: string
    }): Promise<{
      summary: string | null
      helperModelId: string | null
      helperRuntimeId: string | null
    }>
  }
  plan: {
    answerQuestion(sessionId: string, questionId: string, answer: string): Promise<{ ok: true }>
    exit(
      sessionId: string,
      options?: { target?: 'current' | 'fresh_summary' },
    ): Promise<PlanExitResult>
    dismissExit(sessionId: string): Promise<{ ok: true }>
  }
  automations: {
    list(): Promise<AutomationSummary[]>
    get(automationId: string): Promise<AutomationDetail | null>
    create(input: {
      name: string
      prompt: string
      runtimeId: string
      modelId: string
      mode: WorkMode
      selectedSkillIds?: string[]
      workingDirectory: string
      enabled: boolean
      schedule: AutomationSchedule
    }): Promise<AutomationDetail>
    update(
      automationId: string,
      patch: Partial<{
        name: string
        prompt: string
        runtimeId: string
        modelId: string
        mode: WorkMode
        selectedSkillIds: string[]
        workingDirectory: string
        enabled: boolean
        schedule: AutomationSchedule
      }>,
    ): Promise<AutomationDetail>
    delete(automationId: string): Promise<void>
    runNow(automationId: string): Promise<{ ok: true }>
    cancelRun(automationId: string): Promise<{ ok: true }>
    onChanged(callback: (automations: AutomationSummary[]) => void): () => void
  }
  debug: {
    getSessionLogs(sessionId: string): Promise<DebugLogEntry[]>
    getSessionConfig(sessionId: string): Promise<DebugSessionSnapshot | null>
    clearSessionLogs(sessionId: string): Promise<void>
    onSessionLog(
      sessionId: string,
      callback: (entry: DebugLogEntry) => void,
    ): () => void
  }
  memory: {
    read(): Promise<string>
    write(content: string): Promise<string>
    appendNote(input: {
      sessionId?: string
      rawInput: string
    }): Promise<{ memory: string; appendedNote: string }>
  }
}

export type {
  SessionSearchRequest,
  SessionSearchResult,
} from '@shared/sessionSearch'

export type SessionStreamEvent =
  | { type: 'session_reset'; session: SessionDetail }
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'message_appended'; message: ChatMessage }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'content_delta'; blocks: MessageContent[] }
  | {
      type: 'content_delta_append'
      blockType: 'text' | 'thinking'
      delta: string
    }
  | { type: 'live_activity'; activity: LiveActivitySnapshot | null }
  | { type: 'turn_complete'; message: ChatMessage }
  | { type: 'generation_started' }
  | { type: 'generation_stopping' }
  | { type: 'generation_cancelled' }
  | {
      type: 'compaction_state'
      pendingCompaction: PendingCompaction | null
      isCompacting: boolean
    }
  | { type: 'plan_question'; question: PendingPlanQuestion | null }
  | { type: 'plan_question_cleared'; question: null }
  | { type: 'plan_exit_ready'; exit: PendingPlanExit | null }
  | { type: 'plan_exit_cleared'; exit: null }
  | { type: 'tool_approval'; approval: PendingToolApproval | null }
  | { type: 'tool_approval_cleared'; approval: null }

export type { SessionToolDefinition, SessionToolIcon }
export type { SidebarState }
export type { AppTerminalState, AppTerminalStatus }
export type { ShellSessionContentBlock, ShellSessionStatus }
export type { TerminalAppInfo }
export type { WorkspaceInspection }
export type { ProjectBrowserPanelBounds, ProjectBrowserState }

declare global {
  interface Window {
    gemmaDesktopBridge: GemmaDesktopBridge
  }
}

export type {
  ReadAloudInstallProgress,
  ReadAloudInspection,
  ReadAloudSynthesisInput,
  ReadAloudSynthesisResult,
  ReadAloudTestInput,
  ReadAloudVoiceId,
  ReadAloudVoiceOption,
  SpeechChunkInput,
  SpeechEvent,
  SpeechInspection,
  SpeechSessionStartInput,
  SpeechSessionStartResult,
}
