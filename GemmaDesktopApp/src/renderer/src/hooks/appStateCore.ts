import {
  DEFAULT_CONVERSATION_APPROVAL_MODE,
  normalizeConversationApprovalMode,
} from '@gemma-desktop/sdk-core/approvalMode'
import {
  appendChatMessage,
  updateChatMessage,
} from '@/lib/messageState'
import {
  sanitizeRenderableContentBlocks,
  stripAssistantTransportArtifacts,
} from '@shared/assistantTextArtifacts'
import { DEFAULT_HELPER_GEMMA_TAG } from '@shared/gemmaCatalog'
import { getDefaultOllamaSettings } from '@shared/ollamaRuntimeConfig'
import { getDefaultLmStudioSettings } from '@shared/lmstudioRuntimeConfig'
import { getDefaultOmlxSettings } from '@shared/omlxRuntimeConfig'
import { getDefaultReasoningSettings } from '@shared/reasoningSettings'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '@shared/sessionModelDefaults'
import { ASK_GEMINI_DEFAULT_MODEL } from '@shared/geminiModels'
import { getStoredTheme } from '@/hooks/useTheme'
import type { PinnedQuote } from '@/lib/composeQuotedMessage'
import type {
  SessionSummary,
  SessionDetail,
  ModelSummary,
  RuntimeSummary,
  SystemStats,
  ModelTokenUsageReport,
  AppSettings,
  ChatMessage,
  MessageContent,
  CreateSessionOpts,
  DebugLogEntry,
  DebugSessionSnapshot,
  InstalledSkillRecord,
  PendingCompaction,
  PendingPlanExit,
  PendingPlanQuestion,
  PendingToolApproval,
  AutomationSummary,
  AutomationDetail,
  AppView,
  LiveActivitySnapshot,
  ResearchPanelStepStatus,
  GemmaInstallState,
  QueuedUserMessage,
  SpeechInspection,
  SidebarState,
  ReadAloudInspection,
  BootstrapState,
} from '@/types'

/**
 * Per-session selection state for sentence-level highlight-to-quote.
 * `selectionModeMessageId` = which assistant message is currently in "click to
 * pin sentences" mode (null = selection mode is off entirely). `pinnedQuotes`
 * accumulates across multiple source messages until the next user turn is
 * committed.
 */
export interface SelectionState {
  selectionModeMessageId: string | null
  pinnedQuotes: PinnedQuote[]
}

function compactThinkingContext(value: string | undefined, maxLength = 240): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized
}

function previewThinkingContextValue(value: unknown, maxLength = 180): string | undefined {
  if (typeof value === 'string') {
    return compactThinkingContext(value, maxLength)
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const preview = previewThinkingContextValue(entry, maxLength)
      if (preview) return preview
    }
    return undefined
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['query', 'url', 'path', 'pattern', 'command', 'goal', 'summary', 'output', 'error']) {
      const preview = previewThinkingContextValue(record[key], maxLength)
      if (preview) return preview
    }
  }

  return undefined
}

export function buildThinkingTurnContext(message: ChatMessage): string {
  const lines: string[] = []

  for (const block of message.content) {
    if (lines.length >= 12) break

    switch (block.type) {
      case 'tool_call': {
        const parts = [
          `${block.toolName} ${block.status}`,
          compactThinkingContext(block.summary),
          compactThinkingContext(block.worker?.currentAction),
          compactThinkingContext(block.worker?.timeline?.[block.worker.timeline.length - 1]?.detail),
          previewThinkingContextValue(block.input),
          compactThinkingContext(block.worker?.resultSummary),
          previewThinkingContextValue(block.output),
        ].filter((part): part is string => Boolean(part))
        if (parts.length > 0) {
          lines.push(`Tool: ${parts.join(' | ')}`)
        }

        const filesChanged = block.worker?.resultData?.filesChanged ?? []
        if (filesChanged.length > 0 && lines.length < 12) {
          lines.push(`Files changed: ${filesChanged.slice(0, 5).join(', ')}`)
        }

        const commands = block.worker?.resultData?.commands ?? []
        if (commands.length > 0 && lines.length < 12) {
          lines.push(`Commands: ${commands.slice(0, 3).map((command) => command.command).join('; ')}`)
        }

        const sources = block.worker?.resultData?.sources ?? []
        if (sources.length > 0 && lines.length < 12) {
          lines.push(`Sources: ${sources.slice(0, 3).join(', ')}`)
        }
        break
      }
      case 'file_edit':
        lines.push(`File edit: ${block.path} ${block.changeType} (+${block.addedLines}/-${block.removedLines})`)
        break
      case 'text': {
        const preview = compactThinkingContext(block.text, 320)
        if (preview) lines.push(`Assistant output: ${preview}`)
        break
      }
      case 'error':
        lines.push(`Error: ${compactThinkingContext(block.message) ?? 'Unknown error'}`)
        break
      case 'warning':
        lines.push(`Warning: ${compactThinkingContext(block.message) ?? 'Warning'}`)
        break
      case 'research_panel':
        lines.push(`Research: ${block.panel.stage} ${block.panel.runStatus}${block.panel.title ? ` | ${block.panel.title}` : ''}`)
        break
      case 'image':
      case 'pdf':
      case 'audio':
      case 'video':
      case 'thinking':
      case 'code':
      case 'diff':
      case 'file_excerpt':
      case 'shell_session':
      case 'folder_link':
        break
    }
  }

  return lines.join('\n').slice(0, 4000).trim()
}

export const EMPTY_SELECTION: SelectionState = {
  selectionModeMessageId: null,
  pinnedQuotes: [],
}

export interface AppState {
  sidebar: SidebarState
  sessions: SessionSummary[]
  activeSessionId: string | null
  activeSession: SessionDetail | null
  models: ModelSummary[]
  runtimes: RuntimeSummary[]
  bootstrapState: BootstrapState
  systemStats: SystemStats
  modelTokenUsage: ModelTokenUsageReport
  settings: AppSettings
  sidebarOpen: boolean
  isGenerating: boolean
  isCompacting: boolean
  settingsOpen: boolean
  streamingContent: MessageContent[] | null
  debugOpen: boolean
  debugLogs: DebugLogEntry[]
  debugSession: DebugSessionSnapshot | null
  skillsOpen: boolean
  installedSkills: InstalledSkillRecord[]
  pendingCompaction: PendingCompaction | null
  pendingPlanQuestion: PendingPlanQuestion | null
  pendingPlanExit: PendingPlanExit | null
  pendingToolApproval: PendingToolApproval | null
  currentView: AppView
  automations: AutomationSummary[]
  activeAutomationId: string | null
  activeAutomation: AutomationDetail | null
  liveActivity: LiveActivitySnapshot | null
  liveActivityBySessionId: Record<string, LiveActivitySnapshot | null>
  queuedMessagesBySession: Record<string, QueuedUserMessage[]>
  gemmaInstallStates: GemmaInstallState[]
  speechStatus: SpeechInspection | null
  readAloudStatus: ReadAloudInspection | null
  selectionBySession: Record<string, SelectionState>
}

export type AppStateAction =
  | { type: 'SET_SIDEBAR_STATE'; sidebar: SidebarState }
  | { type: 'SET_SESSIONS'; sessions: SessionSummary[] }
  | { type: 'SET_ACTIVE_SESSION'; session: SessionDetail | null; id: string | null }
  | { type: 'ADD_MESSAGE'; message: ChatMessage; clearStreaming?: boolean }
  | { type: 'UPDATE_MESSAGE'; message: ChatMessage }
  | { type: 'SET_STREAMING_CONTENT'; content: MessageContent[] | null }
  | { type: 'MARK_STREAMING_CONTENT_STOPPING' }
  | {
      type: 'APPEND_STREAMING_DELTA'
      blockType: 'text' | 'thinking'
      delta: string
    }
  | { type: 'SET_MODELS'; models: ModelSummary[] }
  | { type: 'SET_RUNTIMES'; runtimes: RuntimeSummary[] }
  | { type: 'SET_BOOTSTRAP_STATE'; bootstrapState: BootstrapState }
  | { type: 'SET_SYSTEM_STATS'; stats: SystemStats }
  | { type: 'SET_MODEL_TOKEN_USAGE'; usage: ModelTokenUsageReport }
  | { type: 'SET_SETTINGS'; settings: AppSettings }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_GENERATING'; generating: boolean }
  | { type: 'SET_COMPACTING'; compacting: boolean }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'SET_SETTINGS_OPEN'; open: boolean }
  | { type: 'TOGGLE_DEBUG' }
  | { type: 'TOGGLE_SKILLS' }
  | { type: 'SET_DEBUG_LOGS'; logs: DebugLogEntry[] }
  | { type: 'ADD_DEBUG_LOG'; log: DebugLogEntry }
  | { type: 'SET_DEBUG_SESSION'; session: DebugSessionSnapshot | null }
  | { type: 'SET_INSTALLED_SKILLS'; skills: InstalledSkillRecord[] }
  | {
      type: 'SET_PENDING_COMPACTION'
      pendingCompaction: PendingCompaction | null
    }
  | { type: 'SET_PENDING_PLAN_QUESTION'; question: PendingPlanQuestion | null }
  | { type: 'SET_PENDING_PLAN_EXIT'; planExit: PendingPlanExit | null }
  | { type: 'SET_PENDING_TOOL_APPROVAL'; approval: PendingToolApproval | null }
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_AUTOMATIONS'; automations: AutomationSummary[] }
  | { type: 'SET_ACTIVE_AUTOMATION'; automation: AutomationDetail | null; id: string | null }
  | {
      type: 'SET_LIVE_ACTIVITY'
      sessionId: string
      activity: LiveActivitySnapshot | null
    }
  | { type: 'SET_GEMMA_INSTALL_STATES'; states: GemmaInstallState[] }
  | { type: 'SET_SPEECH_STATUS'; speechStatus: SpeechInspection | null }
  | { type: 'SET_READ_ALOUD_STATUS'; readAloudStatus: ReadAloudInspection | null }
  | { type: 'UPDATE_SESSION_IN_LIST'; session: SessionSummary }
  | { type: 'REMOVE_SESSION'; sessionId: string }
  | { type: 'QUEUE_MESSAGE'; sessionId: string; message: QueuedUserMessage }
  | {
      type: 'UPDATE_QUEUED_MESSAGE'
      sessionId: string
      messageId: string
      patch: Partial<QueuedUserMessage>
    }
  | { type: 'REMOVE_QUEUED_MESSAGE'; sessionId: string; messageId: string }
  | { type: 'ENTER_SELECTION_MODE'; sessionId: string; messageId: string }
  | { type: 'EXIT_SELECTION_MODE'; sessionId: string }
  | { type: 'TOGGLE_PINNED_QUOTE'; sessionId: string; quote: PinnedQuote }
  | { type: 'REMOVE_PINNED_QUOTE'; sessionId: string; quoteId: string }
  | { type: 'CLEAR_PINNED_QUOTES'; sessionId: string }
  | {
      type: 'PRUNE_PINNED_QUOTES'
      sessionId: string
      validMessageIds: Set<string>
    }
  | {
      type: 'RESTORE_PINNED_QUOTES'
      sessionId: string
      selection: SelectionState
    }

const defaultStats: SystemStats = {
  memoryUsedGB: 0,
  memoryTotalGB: 0,
  gpuUsagePercent: 0,
  cpuUsagePercent: 0,
}

const defaultModelTokenUsage: ModelTokenUsageReport = {
  startedAtMs: Date.now(),
  usage: [],
}

const defaultSettings: AppSettings = {
  theme: getStoredTheme(),
  enterToSend: true,
  defaultMode: 'explore',
  defaultProjectDirectory: '',
  terminal: {
    preferredAppId: null,
  },
  modelSelection: {
    mainModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.mainModel },
    helperModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.helperModel },
  },
  compaction: {
    autoCompactEnabled: true,
    autoCompactThresholdPercent: 45,
  },
  skills: {
    scanRoots: [],
  },
  automations: {
    keepAwakeWhileRunning: false,
  },
  reasoning: getDefaultReasoningSettings(),
  notifications: {
    enabled: true,
    automationFinished: true,
    actionRequired: true,
    sessionCompleted: true,
  },
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
    defaultVoice: 'af_heart',
    speed: 1,
  },
  ollama: getDefaultOllamaSettings(),
  lmstudio: getDefaultLmStudioSettings(),
  omlx: getDefaultOmlxSettings(),
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
  toolPolicy: {
    explore: {
      allowedTools: [
        'list_tree',
        'search_paths',
        'search_text',
        'inspect_file',
        'read_file',
        'read_files',
        'fetch_url',
        'search_web',
        'workspace_inspector_agent',
        'workspace_search_agent',
        'web_research_agent',
        'activate_skill',
      ],
    },
    build: {
      allowedTools: [
        'list_tree',
        'search_paths',
        'search_text',
        'inspect_file',
        'read_file',
        'read_files',
        'write_file',
        'edit_file',
        'exec_command',
        'fetch_url',
        'search_web',
        'workspace_inspector_agent',
        'workspace_search_agent',
        'workspace_editor_agent',
        'workspace_command_agent',
        'web_research_agent',
        'activate_skill',
      ],
    },
  },
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

export const initialState: AppState = {
  sidebar: {
    pinnedSessionIds: [],
    followUpSessionIds: [],
    closedProjectPaths: [],
    projectPaths: [],
    sessionOrderOverrides: {},
    projectOrderOverrides: {},
    lastActiveSessionId: null,
  },
  sessions: [],
  activeSessionId: null,
  activeSession: null,
  models: [],
  runtimes: [],
  bootstrapState: {
    status: 'idle',
    ready: false,
    message: 'Preparing local models…',
    helperModelId: DEFAULT_HELPER_GEMMA_TAG,
    helperRuntimeId: 'ollama-native',
    requiredPrimaryModelIds: [DEFAULT_MODEL_SELECTION_SETTINGS.mainModel.modelId],
    modelAvailabilityIssues: [],
    updatedAt: 0,
  },
  systemStats: defaultStats,
  modelTokenUsage: defaultModelTokenUsage,
  settings: defaultSettings,
  sidebarOpen: true,
  isGenerating: false,
  isCompacting: false,
  settingsOpen: false,
  streamingContent: null,
  debugOpen: false,
  debugLogs: [],
  debugSession: null,
  skillsOpen: false,
  installedSkills: [],
  pendingCompaction: null,
  pendingPlanQuestion: null,
  pendingPlanExit: null,
  pendingToolApproval: null,
  currentView: 'chat',
  automations: [],
  activeAutomationId: null,
  activeAutomation: null,
  liveActivity: null,
  liveActivityBySessionId: {},
  queuedMessagesBySession: {},
  gemmaInstallStates: [],
  speechStatus: null,
  readAloudStatus: null,
  selectionBySession: {},
}

function sanitizeStreamingContent(
  content: MessageContent[] | null | undefined,
): MessageContent[] | null {
  if (!content) {
    return null
  }

  return sanitizeRenderableContentBlocks(
    content as unknown as Array<Record<string, unknown>>,
  ) as MessageContent[]
}

function sanitizeAssistantMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'assistant') {
    return message
  }

  const content = sanitizeStreamingContent(message.content) ?? []
  return content === message.content
    ? message
    : {
        ...message,
        content,
      }
}

function sanitizeSessionDetail(
  session: SessionDetail | null,
): SessionDetail | null {
  if (!session) {
    return null
  }

  let changed = false
  const messages = session.messages.map((message) => {
    const sanitizedMessage = sanitizeAssistantMessage(message)
    if (sanitizedMessage !== message) {
      changed = true
    }
    return sanitizedMessage
  })
  const streamingContent = sanitizeStreamingContent(session.streamingContent)
  if (streamingContent !== (session.streamingContent ?? null)) {
    changed = true
  }
  const approvalMode = normalizeConversationApprovalMode(session.approvalMode)
  if (approvalMode !== session.approvalMode) {
    changed = true
  }

  return changed
    ? {
        ...session,
        approvalMode,
        messages,
        streamingContent,
      }
    : session
}

export function appStateReducer(state: AppState, action: AppStateAction): AppState {
  switch (action.type) {
    case 'SET_SIDEBAR_STATE':
      return { ...state, sidebar: action.sidebar }
    case 'SET_SESSIONS':
      return { ...state, sessions: action.sessions }
    case 'SET_ACTIVE_SESSION':
      {
        const session = sanitizeSessionDetail(action.session)
        const sessionId = action.id
        const sessionBusy = Boolean(
          session?.isGenerating || session?.isCompacting,
        )
        const nextLiveActivityBySessionId =
          sessionId && !sessionBusy
            ? {
                ...state.liveActivityBySessionId,
                [sessionId]: null,
              }
            : state.liveActivityBySessionId

        const isSameSessionRefresh =
          action.id !== null && action.id === state.activeSessionId
        return {
          ...state,
          activeSessionId: action.id,
          activeSession: session,
          streamingContent:
            isSameSessionRefresh && state.streamingContent
              ? state.streamingContent
              : session?.streamingContent ?? null,
          isGenerating: session?.isGenerating ?? false,
          isCompacting: session?.isCompacting ?? false,
          pendingPlanQuestion: session?.pendingPlanQuestion ?? null,
          pendingCompaction: session?.pendingCompaction ?? null,
          pendingPlanExit: session?.pendingPlanExit ?? null,
          pendingToolApproval: session?.pendingToolApproval ?? null,
          liveActivity:
            sessionId && sessionBusy
              ? nextLiveActivityBySessionId[sessionId] ?? null
              : null,
          liveActivityBySessionId: nextLiveActivityBySessionId,
          debugSession:
            action.id === state.activeSessionId ? state.debugSession : null,
        }
      }
    case 'ADD_MESSAGE': {
      if (!state.activeSession) return state

      const message = sanitizeAssistantMessage(action.message)
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          messages: appendChatMessage(state.activeSession.messages, message),
        },
        streamingContent: action.clearStreaming ? null : state.streamingContent,
      }
    }
    case 'UPDATE_MESSAGE': {
      if (!state.activeSession) {
        return state
      }

      const message = sanitizeAssistantMessage(action.message)
      return {
        ...state,
        activeSession: {
          ...state.activeSession,
          messages: updateChatMessage(state.activeSession.messages, message),
        },
      }
    }
    case 'SET_STREAMING_CONTENT':
      return {
        ...state,
        streamingContent: sanitizeStreamingContent(action.content),
      }
    case 'MARK_STREAMING_CONTENT_STOPPING':
      return {
        ...state,
        streamingContent: finalizeStreamingContentForStopping(state.streamingContent),
      }
    case 'APPEND_STREAMING_DELTA': {
      const delta = stripAssistantTransportArtifacts(action.delta)
      if (!delta) {
        return state
      }

      const current = state.streamingContent ?? []
      const last = current[current.length - 1]

      if (last?.type === action.blockType) {
        return {
          ...state,
          streamingContent: [
            ...current.slice(0, -1),
            {
              ...last,
              text: last.text + delta,
            },
          ],
        }
      }

      return {
        ...state,
        streamingContent: [
          ...current,
          {
            type: action.blockType,
            text: delta,
          },
        ],
      }
    }
    case 'SET_MODELS':
      return { ...state, models: action.models }
    case 'SET_RUNTIMES':
      return { ...state, runtimes: action.runtimes }
    case 'SET_BOOTSTRAP_STATE':
      return { ...state, bootstrapState: action.bootstrapState }
    case 'SET_SYSTEM_STATS':
      return { ...state, systemStats: action.stats }
    case 'SET_MODEL_TOKEN_USAGE':
      return { ...state, modelTokenUsage: action.usage }
    case 'SET_SETTINGS':
      return { ...state, settings: action.settings }
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen }
    case 'SET_GENERATING':
      return {
        ...state,
        isGenerating: action.generating,
        activeSession: state.activeSession
          ? { ...state.activeSession, isGenerating: action.generating }
          : state.activeSession,
      }
    case 'SET_COMPACTING':
      return {
        ...state,
        isCompacting: action.compacting,
        activeSession: state.activeSession
          ? { ...state.activeSession, isCompacting: action.compacting }
          : state.activeSession,
      }
    case 'TOGGLE_SETTINGS':
      return { ...state, settingsOpen: !state.settingsOpen }
    case 'SET_SETTINGS_OPEN':
      return { ...state, settingsOpen: action.open }
    case 'TOGGLE_DEBUG':
      return { ...state, debugOpen: !state.debugOpen }
    case 'TOGGLE_SKILLS':
      return { ...state, skillsOpen: !state.skillsOpen }
    case 'SET_DEBUG_LOGS':
      return { ...state, debugLogs: action.logs }
    case 'ADD_DEBUG_LOG':
      return {
        ...state,
        debugLogs: [...state.debugLogs, action.log].slice(-1200),
      }
    case 'SET_DEBUG_SESSION':
      return { ...state, debugSession: action.session }
    case 'SET_INSTALLED_SKILLS':
      return { ...state, installedSkills: action.skills }
    case 'SET_PENDING_PLAN_QUESTION':
      return {
        ...state,
        pendingPlanQuestion: action.question,
        activeSession: state.activeSession
          ? { ...state.activeSession, pendingPlanQuestion: action.question }
          : state.activeSession,
      }
    case 'SET_PENDING_COMPACTION':
      return {
        ...state,
        pendingCompaction: action.pendingCompaction,
        activeSession: state.activeSession
          ? {
              ...state.activeSession,
              pendingCompaction: action.pendingCompaction,
            }
          : state.activeSession,
      }
    case 'SET_PENDING_PLAN_EXIT':
      return {
        ...state,
        pendingPlanExit: action.planExit,
        activeSession: state.activeSession
          ? { ...state.activeSession, pendingPlanExit: action.planExit }
          : state.activeSession,
      }
    case 'SET_PENDING_TOOL_APPROVAL':
      return {
        ...state,
        pendingToolApproval: action.approval,
        activeSession: state.activeSession
          ? { ...state.activeSession, pendingToolApproval: action.approval }
          : state.activeSession,
      }
    case 'SET_VIEW':
      return { ...state, currentView: action.view }
    case 'SET_AUTOMATIONS':
      return { ...state, automations: action.automations }
    case 'SET_ACTIVE_AUTOMATION':
      return {
        ...state,
        activeAutomationId: action.id,
        activeAutomation: action.automation,
      }
    case 'SET_LIVE_ACTIVITY':
      return {
        ...state,
        liveActivityBySessionId: {
          ...state.liveActivityBySessionId,
          [action.sessionId]: action.activity,
        },
        liveActivity:
          state.activeSessionId === action.sessionId ? action.activity : state.liveActivity,
      }
    case 'SET_GEMMA_INSTALL_STATES':
      return { ...state, gemmaInstallStates: action.states }
    case 'SET_SPEECH_STATUS':
      return { ...state, speechStatus: action.speechStatus }
    case 'SET_READ_ALOUD_STATUS':
      return { ...state, readAloudStatus: action.readAloudStatus }
    case 'UPDATE_SESSION_IN_LIST':
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.session.id ? action.session : s,
        ),
      }
    case 'REMOVE_SESSION':
      {
        const nextQueuedMessagesBySession = { ...state.queuedMessagesBySession }
        delete nextQueuedMessagesBySession[action.sessionId]
        const nextLiveActivityBySessionId = { ...state.liveActivityBySessionId }
        delete nextLiveActivityBySessionId[action.sessionId]
        const nextSelectionBySession = { ...state.selectionBySession }
        delete nextSelectionBySession[action.sessionId]

        return {
          ...state,
          sessions: state.sessions.filter((s) => s.id !== action.sessionId),
          activeSessionId:
            state.activeSessionId === action.sessionId
              ? null
              : state.activeSessionId,
          activeSession:
            state.activeSessionId === action.sessionId
              ? null
              : state.activeSession,
          debugLogs:
            state.activeSessionId === action.sessionId
              ? []
              : state.debugLogs,
          debugSession:
            state.activeSessionId === action.sessionId
              ? null
              : state.debugSession,
          pendingPlanQuestion:
            state.activeSessionId === action.sessionId
              ? null
              : state.pendingPlanQuestion,
          pendingCompaction:
            state.activeSessionId === action.sessionId
              ? null
              : state.pendingCompaction,
          pendingPlanExit:
            state.activeSessionId === action.sessionId
              ? null
              : state.pendingPlanExit,
          pendingToolApproval:
            state.activeSessionId === action.sessionId
              ? null
              : state.pendingToolApproval,
          liveActivity:
            state.activeSessionId === action.sessionId
              ? null
              : state.liveActivity,
          liveActivityBySessionId: nextLiveActivityBySessionId,
          queuedMessagesBySession: nextQueuedMessagesBySession,
          selectionBySession: nextSelectionBySession,
        }
      }
    case 'QUEUE_MESSAGE':
      return {
        ...state,
        queuedMessagesBySession: {
          ...state.queuedMessagesBySession,
          [action.sessionId]: [
            ...(state.queuedMessagesBySession[action.sessionId] ?? []),
            action.message,
          ],
        },
      }
    case 'UPDATE_QUEUED_MESSAGE':
      return {
        ...state,
        queuedMessagesBySession: {
          ...state.queuedMessagesBySession,
          [action.sessionId]: (state.queuedMessagesBySession[action.sessionId] ?? []).map(
            (message) =>
              message.id === action.messageId
                ? { ...message, ...action.patch }
                : message,
          ),
        },
      }
    case 'REMOVE_QUEUED_MESSAGE':
      return {
        ...state,
        queuedMessagesBySession: {
          ...state.queuedMessagesBySession,
          [action.sessionId]: (state.queuedMessagesBySession[action.sessionId] ?? []).filter(
            (message) => message.id !== action.messageId,
          ),
        },
      }
    case 'ENTER_SELECTION_MODE': {
      const current = state.selectionBySession[action.sessionId] ?? EMPTY_SELECTION
      if (current.selectionModeMessageId === action.messageId) {
        return state
      }
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: {
            ...current,
            selectionModeMessageId: action.messageId,
          },
        },
      }
    }
    case 'EXIT_SELECTION_MODE': {
      const current = state.selectionBySession[action.sessionId]
      if (!current || current.selectionModeMessageId === null) {
        return state
      }
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: {
            ...current,
            selectionModeMessageId: null,
          },
        },
      }
    }
    case 'TOGGLE_PINNED_QUOTE': {
      const current = state.selectionBySession[action.sessionId] ?? EMPTY_SELECTION
      const exists = current.pinnedQuotes.some((q) => q.id === action.quote.id)
      const nextQuotes = exists
        ? current.pinnedQuotes.filter((q) => q.id !== action.quote.id)
        : [...current.pinnedQuotes, action.quote]
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: {
            ...current,
            pinnedQuotes: nextQuotes,
          },
        },
      }
    }
    case 'REMOVE_PINNED_QUOTE': {
      const current = state.selectionBySession[action.sessionId]
      if (!current || current.pinnedQuotes.length === 0) {
        return state
      }
      const nextQuotes = current.pinnedQuotes.filter((q) => q.id !== action.quoteId)
      if (nextQuotes.length === current.pinnedQuotes.length) {
        return state
      }
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: {
            ...current,
            pinnedQuotes: nextQuotes,
          },
        },
      }
    }
    case 'CLEAR_PINNED_QUOTES': {
      const current = state.selectionBySession[action.sessionId]
      if (!current) {
        return state
      }
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: EMPTY_SELECTION,
        },
      }
    }
    case 'PRUNE_PINNED_QUOTES': {
      const current = state.selectionBySession[action.sessionId]
      if (!current || current.pinnedQuotes.length === 0) {
        return state
      }
      const nextQuotes = current.pinnedQuotes.filter((q) =>
        action.validMessageIds.has(q.sourceMessageId),
      )
      if (nextQuotes.length === current.pinnedQuotes.length) {
        return state
      }
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: {
            ...current,
            pinnedQuotes: nextQuotes,
          },
        },
      }
    }
    case 'RESTORE_PINNED_QUOTES': {
      return {
        ...state,
        selectionBySession: {
          ...state.selectionBySession,
          [action.sessionId]: action.selection,
        },
      }
    }
    default:
      return state
  }
}

function normalizeCancelledStepStatus(status: ResearchPanelStepStatus): ResearchPanelStepStatus {
  return status === 'running' ? 'cancelled' : status
}

export function finalizeStreamingContentForStopping(
  content: MessageContent[] | null,
): MessageContent[] | null {
  return content?.map((block) => {
    if (
      block.type === 'tool_call'
      && (block.status === 'running' || block.status === 'pending')
    ) {
      return { ...block, status: 'error' as const }
    }
    if (block.type === 'research_panel' && block.panel.runStatus === 'running') {
      return {
        ...block,
        panel: {
          ...block.panel,
          runStatus: 'cancelled' as const,
          plan: {
            ...block.panel.plan,
            status: normalizeCancelledStepStatus(block.panel.plan.status),
          },
          sources: {
            ...block.panel.sources,
            status: normalizeCancelledStepStatus(block.panel.sources.status),
          },
          depth: {
            ...block.panel.depth,
            status: normalizeCancelledStepStatus(block.panel.depth.status),
          },
          topics: block.panel.topics.map((topic) => ({
            ...topic,
            status: normalizeCancelledStepStatus(topic.status),
          })),
          synthesis: {
            ...block.panel.synthesis,
            status: normalizeCancelledStepStatus(block.panel.synthesis.status),
          },
          liveHint: undefined,
        },
      }
    }
    return block
  }) ?? null
}

export function buildCreateSessionBridgeOptions(input: CreateSessionOpts): CreateSessionOpts {
  return {
    modelId: input.modelId,
    runtimeId: input.runtimeId,
    conversationKind: input.conversationKind,
    workMode: input.workMode,
    planMode: input.planMode,
    approvalMode: input.approvalMode ?? DEFAULT_CONVERSATION_APPROVAL_MODE,
    selectedSkillIds: input.selectedSkillIds,
    selectedToolIds: input.selectedToolIds,
    workingDirectory: input.workingDirectory,
    title: input.title,
  }
}

export const __testOnly = {
  buildCreateSessionBridgeOptions,
  finalizeStreamingContentForStopping,
}
