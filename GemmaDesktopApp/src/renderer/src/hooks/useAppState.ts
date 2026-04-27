import { useReducer, useEffect, useCallback, useRef, useMemo } from 'react'
import { resolveAttachmentPreviewUrl } from '@/lib/inputAttachments'
import {
  appendChatMessage,
  updateChatMessage,
} from '@/lib/messageState'
import { buildSidebarModel } from '@/lib/sidebarModel'
import {
  buildComposedMessageText,
  type PinnedQuote,
} from '@/lib/composeQuotedMessage'
import {
  canQueueMessageWhileBusy,
  getBusyQueueBlockedReason,
} from '@/lib/sessionQueuePolicy'
import {
  sanitizeRenderableContentBlocks,
  stripAssistantTransportArtifacts,
} from '@shared/assistantTextArtifacts'
import { DEFAULT_HELPER_GEMMA_TAG } from '@shared/gemmaCatalog'
import { getDefaultOllamaSettings } from '@shared/ollamaRuntimeConfig'
import { getDefaultLmStudioSettings } from '@shared/lmstudioRuntimeConfig'
import { getDefaultReasoningSettings } from '@shared/reasoningSettings'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '@shared/sessionModelDefaults'
import { ASK_GEMINI_DEFAULT_MODEL } from '@shared/geminiModels'
import { shouldSummarizeThinking } from '@shared/thinkingSummary'
import {
  isConversationExecutionBlockedError,
  stripConversationExecutionBlockedErrorCode,
} from '@shared/conversationExecutionPolicy'
import { getStoredTheme } from '@/hooks/useTheme'
import type {
  SessionSummary,
  SessionDetail,
  ModelSummary,
  RuntimeSummary,
  SystemStats,
  ModelTokenUsageReport,
  AppSettings,
  ChatMessage,
  SessionStreamEvent,
  MessageContent,
  SessionMode,
  CreateSessionOpts,
  DebugLogEntry,
  DebugSessionSnapshot,
  UpdateSessionOpts,
  InstalledSkillRecord,
  PendingCompaction,
  PendingPlanExit,
  PendingPlanQuestion,
  PendingToolApproval,
  AutomationSummary,
  AutomationDetail,
  AutomationSchedule,
  FileAttachment,
  AppView,
  LiveActivitySnapshot,
  ResearchPanelStepStatus,
  GemmaInstallState,
  QueuedUserMessage,
  SpeechInspection,
  SidebarState,
  ReadAloudInspection,
  ReadAloudTestInput,
  BootstrapState,
  SessionTag,
} from '@/types'

/**
 * Per-session selection state for sentence-level highlight-to-quote.
 * `selectionModeMessageId` = which assistant message is currently in "click to
 * pin sentences" mode (null = selection mode is off entirely). `pinnedQuotes`
 * accumulates across multiple source messages until the next user turn is
 * committed.
 */
interface SelectionState {
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

function buildThinkingTurnContext(message: ChatMessage): string {
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

const EMPTY_SELECTION: SelectionState = {
  selectionModeMessageId: null,
  pinnedQuotes: [],
}

interface AppState {
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

type Action =
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

const initialState: AppState = {
  sidebar: {
    pinnedSessionIds: [],
    followUpSessionIds: [],
    closedProjectPaths: [],
    projectPaths: [],
    sessionOrderOverrides: {},
    projectOrderOverrides: {},
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

function buildQueuedMessageContent(
  text: string,
  attachments: FileAttachment[] = [],
): MessageContent[] {
  const content: MessageContent[] = []

  if (text.trim().length > 0) {
    content.push({
      type: 'text',
      text,
    })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        alt: attachment.name,
        filename: attachment.name,
        mediaType: attachment.mediaType,
        source: attachment.source,
      })
      continue
    }

    if (attachment.kind === 'audio') {
      content.push({
        type: 'audio',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        filename: attachment.name,
        mediaType: attachment.normalizedMediaType ?? attachment.mediaType,
        durationMs: attachment.durationMs,
        normalizedMediaType: attachment.normalizedMediaType,
      })
      continue
    }

    if (attachment.kind === 'video') {
      content.push({
        type: 'video',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        sampledFrameCount: attachment.sampledFrames?.length ?? 0,
        sampledFrameTimestampsMs: (attachment.sampledFrames ?? [])
          .map((frame) => frame.timestampMs)
          .filter((value): value is number => value != null),
        thumbnails: (attachment.sampledFrames ?? [])
          .map((frame) => resolveAttachmentPreviewUrl(frame) ?? frame.dataUrl ?? frame.path ?? '')
          .filter((value) => value.length > 0),
      })
      continue
    }

    const pageCount = attachment.pageCount ?? attachment.processedRange?.endPage ?? 1
    const processedRange = attachment.processedRange ?? {
      startPage: 1,
      endPage: Math.max(pageCount, 1),
    }

    content.push({
      type: 'pdf',
      url:
        resolveAttachmentPreviewUrl(attachment)
        ?? attachment.dataUrl
        ?? attachment.path
        ?? '',
      filename: attachment.name,
      mediaType: 'application/pdf',
      pageCount,
      processingMode: attachment.processingMode ?? 'full_document',
      processedRange,
      batchCount: attachment.batchCount ?? 0,
      workerModelId: attachment.workerModelId,
      fitStatus: attachment.fitStatus ?? 'ready',
      previewThumbnails: attachment.previewThumbnails ?? [],
    })
  }

  return content
}

function buildQueuedUserMessage(
  message: { text: string; attachments?: FileAttachment[] },
): QueuedUserMessage {
  const timestamp = Date.now()
  const attachments = [...(message.attachments ?? [])]

  return {
    id: `queued-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    text: message.text,
    attachments,
    content: buildQueuedMessageContent(message.text, attachments),
    timestamp,
    status: 'queued',
  }
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

  return changed
    ? {
        ...session,
        messages,
        streamingContent,
      }
    : session
}

function reducer(state: AppState, action: Action): AppState {
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

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const eventCleanupRef = useRef<(() => void) | null>(null)
  const debugCleanupRef = useRef<(() => void) | null>(null)
  const drainingQueuedMessagesRef = useRef(new Set<string>())
  const activeSessionRef = useRef<SessionDetail | null>(null)
  const pendingThinkingSummariesRef = useRef(new Set<string>())

  const syncActiveSessionDetail = useCallback(async (sessionId: string) => {
    const detail = await window.gemmaDesktopBridge.sessions.get(sessionId)
    dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
    return detail
  }, [])

  useEffect(() => {
    activeSessionRef.current = state.activeSession
  }, [state.activeSession])

  const summarizeMessageThinkingBlocks = useCallback((message: ChatMessage) => {
    if (message.role !== 'assistant') return

    const session = activeSessionRef.current
    const sessionId = session?.id
    if (!sessionId) return

    let userText = ''
    if (session) {
      for (let i = session.messages.length - 1; i >= 0; i -= 1) {
        const candidate = session.messages[i]
        if (!candidate || candidate.id === message.id) continue
        if (candidate.role !== 'user') continue
        userText = candidate.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
          .trim()
        break
      }
    }

    const conversationTitle = session?.title ?? ''
    const workingDirectory = session?.workingDirectory ?? ''
    const turnContext = buildThinkingTurnContext(message)

    message.content.forEach((block, blockIndex) => {
      if (block.type !== 'thinking') return
      if (block.summary && block.summary.trim()) return
      if (!shouldSummarizeThinking(block.text)) return

      const dedupKey = `${sessionId}:${message.id}:${blockIndex}`
      if (pendingThinkingSummariesRef.current.has(dedupKey)) return
      pendingThinkingSummariesRef.current.add(dedupKey)

      const thinkingText = block.text

      void window.gemmaDesktopBridge.thinkingSummary
        .generate({
          thinkingText,
          userText,
          conversationTitle,
          workingDirectory,
          turnContext,
        })
        .then((result) => {
          const summary = result?.summary?.trim()
          if (!summary) return

          const currentSession = activeSessionRef.current
          if (!currentSession || currentSession.id !== sessionId) return

          const currentMessage = currentSession.messages.find(
            (m) => m.id === message.id,
          )
          if (!currentMessage) return

          const targetBlock = currentMessage.content[blockIndex]
          if (!targetBlock || targetBlock.type !== 'thinking') return
          if (targetBlock.summary && targetBlock.summary.trim()) return

          const updated: ChatMessage = {
            ...currentMessage,
            content: currentMessage.content.map((c, i) =>
              i === blockIndex && c.type === 'thinking'
                ? { ...c, summary }
                : c,
            ),
          }
          dispatch({ type: 'UPDATE_MESSAGE', message: updated })
        })
        .catch((error) => {
          console.warn('[thinking-summary] generation failed:', error)
        })
    })
  }, [])

  const refreshEnvironment = useCallback(async () => {
    const { runtimes, models, bootstrap } = await window.gemmaDesktopBridge.environment.inspect()
    dispatch({ type: 'SET_MODELS', models })
    dispatch({ type: 'SET_RUNTIMES', runtimes })
    dispatch({ type: 'SET_BOOTSTRAP_STATE', bootstrapState: bootstrap })
  }, [])

  // Load initial data
  useEffect(() => {
    async function init() {
      try {
        const [
          sidebar,
          sessions,
          { runtimes, models, bootstrap },
          stats,
          settings,
          installedSkills,
          automations,
          speechStatus,
          readAloudStatus,
        ] =
          await Promise.all([
            window.gemmaDesktopBridge.sidebar.get(),
            window.gemmaDesktopBridge.sessions.list(),
            window.gemmaDesktopBridge.environment.inspect(),
            window.gemmaDesktopBridge.system.getStats(),
            window.gemmaDesktopBridge.settings.get(),
            window.gemmaDesktopBridge.skills.listInstalled(),
            window.gemmaDesktopBridge.automations.list(),
            window.gemmaDesktopBridge.speech.inspect(),
            window.gemmaDesktopBridge.readAloud.inspect(),
          ])

        dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
        dispatch({ type: 'SET_SESSIONS', sessions })
        dispatch({ type: 'SET_MODELS', models })
        dispatch({ type: 'SET_RUNTIMES', runtimes })
        dispatch({ type: 'SET_BOOTSTRAP_STATE', bootstrapState: bootstrap })
        dispatch({ type: 'SET_SYSTEM_STATS', stats })
        dispatch({ type: 'SET_SETTINGS', settings })
        dispatch({ type: 'SET_INSTALLED_SKILLS', skills: installedSkills })
        dispatch({ type: 'SET_AUTOMATIONS', automations })
        dispatch({ type: 'SET_SPEECH_STATUS', speechStatus })
        dispatch({ type: 'SET_READ_ALOUD_STATUS', readAloudStatus })

        // Auto-open the first session if available
        const firstVisibleSessionId = buildSidebarModel(
          sessions,
          sidebar,
        ).visibleSessionIds[0]
        if (firstVisibleSessionId) {
          try {
            const detail = await window.gemmaDesktopBridge.sessions.get(firstVisibleSessionId)
            dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
          } catch (err) {
            console.error('Failed to load session detail:', err)
          }
        }
      } catch (err) {
        console.error('Failed to initialize app state:', err)
      }
    }
    void init()
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.sidebar.onChanged((sidebar) => {
      dispatch({
        type: 'SET_SIDEBAR_STATE',
        sidebar: sidebar as SidebarState,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.environment.onBootstrapChanged((bootstrapState) => {
      dispatch({
        type: 'SET_BOOTSTRAP_STATE',
        bootstrapState: bootstrapState as BootstrapState,
      })

      void refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after bootstrap update:', err)
      })
    })

    return unsub
  }, [refreshEnvironment])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.environment.onModelsChanged(() => {
      void refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after model load update:', err)
      })
    })

    return unsub
  }, [refreshEnvironment])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.environment.onGemmaInstallChanged((states) => {
      const nextStates = states as GemmaInstallState[]
      dispatch({ type: 'SET_GEMMA_INSTALL_STATES', states: nextStates })

      if (nextStates.some((state) => state.status !== 'running')) {
        void refreshEnvironment().catch((err) => {
          console.error('Failed to refresh environment after Gemma install update:', err)
        })
      }
    })

    return unsub
  }, [refreshEnvironment])

  useEffect(() => {
    let cancelled = false

    const unsub = window.gemmaDesktopBridge.sessions.onChanged((sessions) => {
      const nextSessions = sessions as SessionSummary[]
      dispatch({ type: 'SET_SESSIONS', sessions: nextSessions })

      const activeSessionId = state.activeSessionId
      if (!activeSessionId) {
        return
      }

      const activeSessionStillExists = nextSessions.some(
        (session) => session.id === activeSessionId,
      )

      if (!activeSessionStillExists) {
        dispatch({ type: 'SET_ACTIVE_SESSION', session: null, id: null })
        return
      }

      void syncActiveSessionDetail(activeSessionId).catch((err) => {
        if (!cancelled) {
          console.error('Failed to refresh active session after session list change:', err)
        }
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [state.activeSessionId, syncActiveSessionDetail])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.skills.onChanged((skills) => {
      dispatch({
        type: 'SET_INSTALLED_SKILLS',
        skills: skills as InstalledSkillRecord[],
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.settings.onChanged((settings) => {
      dispatch({
        type: 'SET_SETTINGS',
        settings: settings as AppSettings,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.speech.onStatusChanged((status) => {
      dispatch({
        type: 'SET_SPEECH_STATUS',
        speechStatus: status as SpeechInspection,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.readAloud.onStatusChanged((status) => {
      dispatch({
        type: 'SET_READ_ALOUD_STATUS',
        readAloudStatus: status as ReadAloudInspection,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.automations.onChanged((automations) => {
      const nextAutomations = automations as AutomationSummary[]
      dispatch({
        type: 'SET_AUTOMATIONS',
        automations: nextAutomations,
      })

      const selectedId = state.activeAutomationId
      if (selectedId && nextAutomations.some((item) => item.id === selectedId)) {
        window.gemmaDesktopBridge.automations
          .get(selectedId)
          .then((automation) => {
            dispatch({
              type: 'SET_ACTIVE_AUTOMATION',
              automation,
              id: selectedId,
            })
          })
          .catch((err) => {
            console.error('Failed to refresh active automation:', err)
          })
      }
    })
    return unsub
  }, [state.activeAutomationId])

  useEffect(() => {
    const interval = window.setInterval(() => {
      refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment:', err)
      })
    }, 10000)

    return () => window.clearInterval(interval)
  }, [refreshEnvironment])

  // Subscribe to system stats
  useEffect(() => {
    const unsub = window.gemmaDesktopBridge.system.onStatsUpdate((stats) => {
      dispatch({ type: 'SET_SYSTEM_STATS', stats: stats as SystemStats })
    })
    return unsub
  }, [])

  // Subscribe to per-model session token usage
  useEffect(() => {
    let cancelled = false
    window.gemmaDesktopBridge.system
      .getModelTokenUsage()
      .then((report) => {
        if (!cancelled) {
          dispatch({
            type: 'SET_MODEL_TOKEN_USAGE',
            usage: report as ModelTokenUsageReport,
          })
        }
      })
      .catch((err) => {
        console.error('Failed to fetch model token usage:', err)
      })
    const unsub = window.gemmaDesktopBridge.system.onModelTokenUsageUpdate(
      (report) => {
        dispatch({
          type: 'SET_MODEL_TOKEN_USAGE',
          usage: report as ModelTokenUsageReport,
        })
      },
    )
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Subscribe to session events when active session changes
  useEffect(() => {
    if (eventCleanupRef.current) {
      eventCleanupRef.current()
      eventCleanupRef.current = null
    }

    if (!state.activeSessionId) return
    const activeSessionId = state.activeSessionId

    let cancelled = false

    const unsub = window.gemmaDesktopBridge.events.onSessionEvent(
      activeSessionId,
      (event) => {
        const e = event as SessionStreamEvent
        switch (e.type) {
          case 'session_reset':
            dispatch({
              type: 'SET_ACTIVE_SESSION',
              session: e.session,
              id: e.session.id,
            })
            break
          case 'user_message':
            dispatch({
              type: 'ADD_MESSAGE',
              message: e.message,
              clearStreaming: true,
            })
            break
          case 'message_appended':
            dispatch({ type: 'ADD_MESSAGE', message: e.message })
            break
          case 'message_updated':
            dispatch({ type: 'UPDATE_MESSAGE', message: e.message })
            break
          case 'generation_started':
            dispatch({ type: 'SET_GENERATING', generating: true })
            dispatch({ type: 'SET_COMPACTING', compacting: false })
            break
          case 'content_delta':
            dispatch({
              type: 'SET_STREAMING_CONTENT',
              content: e.blocks,
            })
            break
          case 'content_delta_append':
            dispatch({
              type: 'APPEND_STREAMING_DELTA',
              blockType: e.blockType,
              delta: e.delta,
            })
            break
          case 'live_activity':
            dispatch({
              type: 'SET_LIVE_ACTIVITY',
              sessionId: activeSessionId,
              activity: e.activity,
            })
            break
          case 'turn_complete':
            dispatch({
              type: 'ADD_MESSAGE',
              message: e.message,
              clearStreaming: true,
            })
            dispatch({ type: 'SET_GENERATING', generating: false })
            dispatch({
              type: 'SET_LIVE_ACTIVITY',
              sessionId: activeSessionId,
              activity: null,
            })
            summarizeMessageThinkingBlocks(e.message)
            break
          case 'generation_stopping':
            dispatch({ type: 'SET_GENERATING', generating: false })
            dispatch({ type: 'MARK_STREAMING_CONTENT_STOPPING' })
            break
          case 'generation_cancelled':
            dispatch({ type: 'SET_GENERATING', generating: false })
            dispatch({ type: 'SET_STREAMING_CONTENT', content: null })
            dispatch({
              type: 'SET_LIVE_ACTIVITY',
              sessionId: activeSessionId,
              activity: null,
            })
            break
          case 'compaction_state':
            dispatch({
              type: 'SET_PENDING_COMPACTION',
              pendingCompaction: e.pendingCompaction,
            })
            dispatch({
              type: 'SET_COMPACTING',
              compacting: e.isCompacting,
            })
            if (!e.isCompacting) {
              void window.gemmaDesktopBridge.debug
                .getSessionConfig(activeSessionId)
                .then((session) => {
                  dispatch({ type: 'SET_DEBUG_SESSION', session })
                })
                .catch((err) => {
                  console.error('Failed to refresh debug session after compaction:', err)
                })
            }
            break
          case 'plan_question':
            dispatch({
              type: 'SET_PENDING_PLAN_QUESTION',
              question: e.question,
            })
            break
          case 'plan_question_cleared':
            dispatch({ type: 'SET_PENDING_PLAN_QUESTION', question: null })
            break
          case 'plan_exit_ready':
            dispatch({
              type: 'SET_PENDING_PLAN_EXIT',
              planExit: e.exit,
            })
            break
          case 'plan_exit_cleared':
            dispatch({ type: 'SET_PENDING_PLAN_EXIT', planExit: null })
            break
          case 'tool_approval':
            dispatch({
              type: 'SET_PENDING_TOOL_APPROVAL',
              approval: e.approval,
            })
            break
          case 'tool_approval_cleared':
            dispatch({ type: 'SET_PENDING_TOOL_APPROVAL', approval: null })
            break
        }
      },
    )

    eventCleanupRef.current = unsub

    void syncActiveSessionDetail(activeSessionId).catch((err) => {
      if (!cancelled) {
        console.error('Failed to sync active session detail:', err)
      }
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [state.activeSessionId, syncActiveSessionDetail, summarizeMessageThinkingBlocks])

  useEffect(() => {
    if (debugCleanupRef.current) {
      debugCleanupRef.current()
      debugCleanupRef.current = null
    }

    if (!state.activeSessionId) {
      dispatch({ type: 'SET_DEBUG_LOGS', logs: [] })
      return
    }

    let mounted = true

    window.gemmaDesktopBridge.debug
      .getSessionLogs(state.activeSessionId)
      .then((logs) => {
        if (mounted) {
          dispatch({ type: 'SET_DEBUG_LOGS', logs })
        }
      })
      .catch((err) => {
        console.error('Failed to load debug logs:', err)
      })

    if (!state.debugOpen) {
      return () => {
        mounted = false
      }
    }

    const unsub = window.gemmaDesktopBridge.debug.onSessionLog(
      state.activeSessionId,
      (entry) => {
        dispatch({ type: 'ADD_DEBUG_LOG', log: entry })
      },
    )

    debugCleanupRef.current = unsub
    return () => {
      mounted = false
      unsub()
    }
  }, [state.activeSessionId, state.debugOpen])

  useEffect(() => {
    if (!state.activeSessionId) {
      dispatch({ type: 'SET_DEBUG_SESSION', session: null })
      return
    }

    let cancelled = false

    window.gemmaDesktopBridge.debug
      .getSessionConfig(state.activeSessionId)
      .then((session) => {
        if (!cancelled) {
          dispatch({ type: 'SET_DEBUG_SESSION', session })
        }
      })
      .catch((err) => {
        console.error('Failed to load session debug config:', err)
      })

    return () => {
      cancelled = true
    }
  }, [
    state.activeSessionId,
    state.activeSession?.workMode,
    state.activeSession?.modelId,
    state.activeSession?.runtimeId,
    state.activeSession?.workingDirectory,
    state.activeSession?.selectedSkillIds.join(','),
    state.activeSession?.selectedToolIds.join(','),
    state.activeSession?.messages.length,
    state.isGenerating,
    state.isCompacting,
    state.pendingCompaction?.status,
  ])

  const selectSession = useCallback(async (sessionId: string) => {
    await syncActiveSessionDetail(sessionId)
  }, [syncActiveSessionDetail])

  const createSession = useCallback(
    async (input: CreateSessionOpts) => {
      const summary = await window.gemmaDesktopBridge.sessions.create(
        buildCreateSessionBridgeOptions(input),
      )
      const detail = await window.gemmaDesktopBridge.sessions.get(summary.id)
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      await refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after session creation:', err)
      })
      dispatch({ type: 'SET_SESSIONS', sessions })
      dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
      return detail
    },
    [refreshEnvironment],
  )

  const ensureGemmaModel = useCallback(
    async (tag: string) => {
      const result = await window.gemmaDesktopBridge.environment.ensureGemmaModel(tag)
      if (result.ok) {
        await refreshEnvironment().catch((err) => {
          console.error('Failed to refresh environment after Gemma install:', err)
        })
      }
      return result
    },
    [refreshEnvironment],
  )

  const updateSession = useCallback(
    async (sessionId: string, opts: UpdateSessionOpts) => {
      const detail = await window.gemmaDesktopBridge.sessions.update(sessionId, opts)
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      await refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after session update:', err)
      })
      dispatch({ type: 'SET_SESSIONS', sessions })
      dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
    },
    [refreshEnvironment],
  )

  const sendMessage = useCallback(
    async (message: { text: string; attachments?: FileAttachment[] }) => {
      if (!state.activeSessionId || !state.activeSession) return
      const sessionId = state.activeSessionId
      const queueWhileBusy = canQueueMessageWhileBusy({
        conversationKind: state.activeSession.conversationKind,
        planMode: state.activeSession.planMode,
      })
      const selectionSnapshot =
        state.selectionBySession[sessionId] ?? EMPTY_SELECTION
      const composedText = buildComposedMessageText(
        selectionSnapshot.pinnedQuotes,
        message.text,
      )
      const shouldClearSelection =
        selectionSnapshot.pinnedQuotes.length > 0
        || selectionSnapshot.selectionModeMessageId !== null

      // Optimistically clear pinned quotes so the composer preview empties
      // immediately. If the send fails below, we restore the full snapshot.
      if (state.isGenerating || state.isCompacting) {
        if (!queueWhileBusy) {
          throw new Error(getBusyQueueBlockedReason({
            conversationKind: state.activeSession.conversationKind,
            planMode: state.activeSession.planMode,
          }))
        }

        if (shouldClearSelection) {
          dispatch({ type: 'CLEAR_PINNED_QUOTES', sessionId })
        }
        dispatch({
          type: 'QUEUE_MESSAGE',
          sessionId,
          message: buildQueuedUserMessage({
            text: composedText,
            attachments: message.attachments,
          }),
        })
        return
      }

      if (shouldClearSelection) {
        dispatch({ type: 'CLEAR_PINNED_QUOTES', sessionId })
      }

      try {
        dispatch({ type: 'SET_GENERATING', generating: true })
        dispatch({ type: 'SET_COMPACTING', compacting: false })
        await window.gemmaDesktopBridge.sessions.sendMessage(sessionId, {
          text: composedText,
          attachments: message.attachments,
        })
      } catch (error) {
        dispatch({ type: 'SET_GENERATING', generating: false })
        if (shouldClearSelection) {
          dispatch({
            type: 'RESTORE_PINNED_QUOTES',
            sessionId,
            selection: selectionSnapshot,
          })
        }
        if (error instanceof Error && isConversationExecutionBlockedError(error.message)) {
          throw new Error(stripConversationExecutionBlockedErrorCode(error.message))
        }
        throw error
      }

      // Refresh session list for updated timestamps
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      await refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after sending message:', err)
      })
      dispatch({ type: 'SET_SESSIONS', sessions })
    },
    [
      refreshEnvironment,
      state.activeSession,
      state.activeSessionId,
      state.isCompacting,
      state.isGenerating,
      state.selectionBySession,
    ],
  )

  const runResearch = useCallback(
    async (message: { text: string }) => {
      if (!state.activeSessionId || !state.activeSession) return
      const sessionId = state.activeSessionId
      const selectionSnapshot =
        state.selectionBySession[sessionId] ?? EMPTY_SELECTION
      const composedText = buildComposedMessageText(
        selectionSnapshot.pinnedQuotes,
        message.text,
      )

      if (
        selectionSnapshot.pinnedQuotes.length > 0
        || selectionSnapshot.selectionModeMessageId !== null
      ) {
        dispatch({ type: 'CLEAR_PINNED_QUOTES', sessionId })
      }

      try {
        await window.gemmaDesktopBridge.sessions.runResearch(sessionId, {
          text: composedText,
        })
      } catch (error) {
        if (selectionSnapshot.pinnedQuotes.length > 0) {
          dispatch({
            type: 'RESTORE_PINNED_QUOTES',
            sessionId,
            selection: selectionSnapshot,
          })
        }
        if (error instanceof Error && isConversationExecutionBlockedError(error.message)) {
          throw new Error(stripConversationExecutionBlockedErrorCode(error.message))
        }
        throw error
      }

      const sessions = await window.gemmaDesktopBridge.sessions.list()
      await refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after starting research:', err)
      })
      dispatch({ type: 'SET_SESSIONS', sessions })
    },
    [
      refreshEnvironment,
      state.activeSessionId,
      state.activeSession,
      state.selectionBySession,
    ],
  )

  const runShellCommand = useCallback(
    async (command: string) => {
      if (!state.activeSessionId || !state.activeSession) {
        return
      }

      await window.gemmaDesktopBridge.sessions.runShellCommand(
        state.activeSessionId,
        { command },
      )

      const sessions = await window.gemmaDesktopBridge.sessions.list()
      dispatch({ type: 'SET_SESSIONS', sessions })
    },
    [state.activeSession, state.activeSessionId],
  )

  const compactSession = useCallback(async () => {
    if (!state.activeSessionId) return
    await window.gemmaDesktopBridge.sessions.compact(state.activeSessionId)
    const sessions = await window.gemmaDesktopBridge.sessions.list()
    dispatch({ type: 'SET_SESSIONS', sessions })
  }, [state.activeSessionId])

  const clearActiveSessionHistory = useCallback(async () => {
    const sessionId = state.activeSessionId
    if (!sessionId) return
    if (state.isGenerating || state.isCompacting) return
    await window.gemmaDesktopBridge.sessions.clearHistory(sessionId)
    const detail = await window.gemmaDesktopBridge.sessions.get(sessionId)
    const sessions = await window.gemmaDesktopBridge.sessions.list()
    dispatch({ type: 'SET_SESSIONS', sessions })
    dispatch({
      type: 'SET_ACTIVE_SESSION',
      session: detail,
      id: sessionId,
    })
    dispatch({ type: 'CLEAR_PINNED_QUOTES', sessionId })
  }, [state.activeSessionId, state.isCompacting, state.isGenerating])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (
        sessionId === state.activeSessionId
        && (state.isGenerating || state.isCompacting)
      ) {
        return
      }
      await window.gemmaDesktopBridge.sessions.delete(sessionId)
      dispatch({ type: 'REMOVE_SESSION', sessionId })
    },
    [state.activeSessionId, state.isCompacting, state.isGenerating],
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await window.gemmaDesktopBridge.sessions.rename(sessionId, title)
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      dispatch({ type: 'SET_SESSIONS', sessions })
      if (state.activeSession && state.activeSession.id === sessionId) {
        dispatch({
          type: 'SET_ACTIVE_SESSION',
          session: { ...state.activeSession, title },
          id: sessionId,
        })
      }
    },
    [state.activeSession],
  )

  const setSessionTags = useCallback(
    async (sessionId: string, tags: SessionTag[]) => {
      await window.gemmaDesktopBridge.sessions.setTags(sessionId, tags)
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      dispatch({ type: 'SET_SESSIONS', sessions })
      if (state.activeSession && state.activeSession.id === sessionId) {
        dispatch({
          type: 'SET_ACTIVE_SESSION',
          session: { ...state.activeSession, sessionTags: tags },
          id: sessionId,
        })
      }
    },
    [state.activeSession],
  )

  const cancelGeneration = useCallback(async () => {
    if (state.activeSessionId) {
      await window.gemmaDesktopBridge.sessions.cancelGeneration(state.activeSessionId)
    }
  }, [state.activeSessionId])

  const resolveToolApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      if (!state.activeSessionId) return
      await window.gemmaDesktopBridge.sessions.resolveToolApproval(
        state.activeSessionId,
        approvalId,
        approved,
      )
      dispatch({ type: 'SET_PENDING_TOOL_APPROVAL', approval: null })
    },
    [state.activeSessionId],
  )

  const clearDebugLogs = useCallback(async () => {
    if (!state.activeSessionId) return
    await window.gemmaDesktopBridge.debug.clearSessionLogs(state.activeSessionId)
    dispatch({ type: 'SET_DEBUG_LOGS', logs: [] })
  }, [state.activeSessionId])

  const refreshInstalledSkills = useCallback(async () => {
    const skills = await window.gemmaDesktopBridge.skills.listInstalled()
    dispatch({ type: 'SET_INSTALLED_SKILLS', skills })
    return skills
  }, [])

  const installSkill = useCallback(
    async (input: { repo: string; skillName: string }) => {
      const skills = await window.gemmaDesktopBridge.skills.install(input)
      dispatch({ type: 'SET_INSTALLED_SKILLS', skills })
      return skills
    },
    [],
  )

  const removeSkill = useCallback(async (skillId: string) => {
    const skills = await window.gemmaDesktopBridge.skills.remove(skillId)
    dispatch({ type: 'SET_INSTALLED_SKILLS', skills })
    return skills
  }, [])

  const pinSession = useCallback(async (sessionId: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.pinSession(sessionId)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const unpinSession = useCallback(async (sessionId: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.unpinSession(sessionId)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const flagFollowUp = useCallback(async (sessionId: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.flagFollowUp(sessionId)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const unflagFollowUp = useCallback(async (sessionId: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.unflagFollowUp(sessionId)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const movePinnedSession = useCallback(
    async (sessionId: string, toIndex: number) => {
      const sidebar = await window.gemmaDesktopBridge.sidebar.movePinnedSession(
        sessionId,
        toIndex,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
      return sidebar
    },
    [],
  )

  const setSessionOrder = useCallback(
    async (sessionId: string, toIndex: number) => {
      const sidebar = await window.gemmaDesktopBridge.sidebar.setSessionOrder(
        sessionId,
        toIndex,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
      return sidebar
    },
    [],
  )

  const clearSessionOrder = useCallback(
    async (sessionId: string) => {
      const sidebar = await window.gemmaDesktopBridge.sidebar.clearSessionOrder(
        sessionId,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
      return sidebar
    },
    [],
  )

  const setProjectOrder = useCallback(
    async (projectPath: string, toIndex: number) => {
      const sidebar = await window.gemmaDesktopBridge.sidebar.setProjectOrder(
        projectPath,
        toIndex,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
      return sidebar
    },
    [],
  )

  const clearProjectOrder = useCallback(
    async (projectPath: string) => {
      const sidebar = await window.gemmaDesktopBridge.sidebar.clearProjectOrder(
        projectPath,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
      return sidebar
    },
    [],
  )

  const closeProject = useCallback(async (projectPath: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.closeProject(projectPath)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const reopenProject = useCallback(async (projectPath: string) => {
    const sidebar = await window.gemmaDesktopBridge.sidebar.reopenProject(projectPath)
    dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    return sidebar
  }, [])

  const answerPlanQuestion = useCallback(
    async (questionId: string, answer: string) => {
      if (!state.activeSessionId) return
      await window.gemmaDesktopBridge.plan.answerQuestion(
        state.activeSessionId,
        questionId,
        answer,
      )
      dispatch({ type: 'SET_PENDING_PLAN_QUESTION', question: null })
    },
    [state.activeSessionId],
  )

  const queueMessageForSession = useCallback(
    (sessionId: string, message: { text: string; attachments?: FileAttachment[] }) => {
      dispatch({
        type: 'QUEUE_MESSAGE',
        sessionId,
        message: buildQueuedUserMessage(message),
      })
    },
    [],
  )

  const exitPlanMode = useCallback(
    async (target: 'current' | 'fresh_summary' = 'current') => {
      if (!state.activeSessionId) return null
      const result = await window.gemmaDesktopBridge.plan.exit(state.activeSessionId, {
        target,
      })
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      dispatch({ type: 'SET_SESSIONS', sessions })
      dispatch({
        type: 'SET_ACTIVE_SESSION',
        session: result.session,
        id: result.session.id,
      })
      dispatch({ type: 'SET_PENDING_PLAN_EXIT', planExit: null })
      if (result.kickoffText?.trim()) {
        queueMessageForSession(result.session.id, {
          text: result.kickoffText.trim(),
        })
      }
      return result
    },
    [queueMessageForSession, state.activeSessionId],
  )

  const dismissPlanExit = useCallback(async () => {
    if (!state.activeSessionId) return
    await window.gemmaDesktopBridge.plan.dismissExit(state.activeSessionId)
    dispatch({ type: 'SET_PENDING_PLAN_EXIT', planExit: null })
  }, [state.activeSessionId])

  const revisePlanExit = useCallback(
    async (instructions: string) => {
      const sessionId = state.activeSessionId
      const trimmed = instructions.trim()
      if (!sessionId || trimmed.length === 0) {
        return
      }

      await window.gemmaDesktopBridge.plan.dismissExit(sessionId)
      dispatch({ type: 'SET_PENDING_PLAN_EXIT', planExit: null })
      queueMessageForSession(sessionId, { text: trimmed })
    },
    [queueMessageForSession, state.activeSessionId],
  )

  useEffect(() => {
    const sessionId = state.activeSessionId
    if (!sessionId || state.isGenerating || state.isCompacting) {
      return
    }

    const nextQueuedMessage = (state.queuedMessagesBySession[sessionId] ?? []).find(
      (message) =>
        message.status === 'queued'
        && !drainingQueuedMessagesRef.current.has(message.id),
    )

    if (!nextQueuedMessage) {
      return
    }

    drainingQueuedMessagesRef.current.add(nextQueuedMessage.id)
    dispatch({
      type: 'REMOVE_QUEUED_MESSAGE',
      sessionId,
      messageId: nextQueuedMessage.id,
    })

    void window.gemmaDesktopBridge.sessions
      .sendMessage(sessionId, {
        text: nextQueuedMessage.text,
        attachments: nextQueuedMessage.attachments,
      })
      .then(async () => {
        const sessions = await window.gemmaDesktopBridge.sessions.list()
        await refreshEnvironment().catch((err) => {
          console.error('Failed to refresh environment after draining queued message:', err)
        })
        dispatch({ type: 'SET_SESSIONS', sessions })
        dispatch({
          type: 'REMOVE_QUEUED_MESSAGE',
          sessionId,
          messageId: nextQueuedMessage.id,
        })
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error)

        if (
          errorMessage.includes('already generating a response')
          || isConversationExecutionBlockedError(errorMessage)
        ) {
          dispatch({
            type: 'QUEUE_MESSAGE',
            sessionId,
            message: nextQueuedMessage,
          })
          return
        }

        console.error('Failed to drain queued message:', error)
        dispatch({
          type: 'QUEUE_MESSAGE',
          sessionId,
          message: {
            ...nextQueuedMessage,
            status: 'failed',
            error: errorMessage,
          },
        })
      })
      .finally(() => {
        drainingQueuedMessagesRef.current.delete(nextQueuedMessage.id)
      })
  }, [
    refreshEnvironment,
    state.activeSessionId,
    state.isCompacting,
    state.isGenerating,
    state.queuedMessagesBySession,
  ])

  const removeQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      dispatch({
        type: 'REMOVE_QUEUED_MESSAGE',
        sessionId,
        messageId,
      })
    },
    [],
  )

  // === Sentence-level selection (highlight-to-quote) ===
  const activeSelection = useMemo<SelectionState>(() => {
    if (!state.activeSessionId) return EMPTY_SELECTION
    return state.selectionBySession[state.activeSessionId] ?? EMPTY_SELECTION
  }, [state.activeSessionId, state.selectionBySession])

  const enterSelectionMode = useCallback(
    (messageId: string) => {
      if (!state.activeSessionId) return
      dispatch({
        type: 'ENTER_SELECTION_MODE',
        sessionId: state.activeSessionId,
        messageId,
      })
    },
    [state.activeSessionId],
  )

  const exitSelectionMode = useCallback(() => {
    if (!state.activeSessionId) return
    dispatch({
      type: 'EXIT_SELECTION_MODE',
      sessionId: state.activeSessionId,
    })
  }, [state.activeSessionId])

  const togglePinnedQuote = useCallback(
    (quote: PinnedQuote) => {
      if (!state.activeSessionId) return
      dispatch({
        type: 'TOGGLE_PINNED_QUOTE',
        sessionId: state.activeSessionId,
        quote,
      })
    },
    [state.activeSessionId],
  )

  const removePinnedQuote = useCallback(
    (quoteId: string) => {
      if (!state.activeSessionId) return
      dispatch({
        type: 'REMOVE_PINNED_QUOTE',
        sessionId: state.activeSessionId,
        quoteId,
      })
    },
    [state.activeSessionId],
  )

  const clearPinnedQuotes = useCallback(() => {
    if (!state.activeSessionId) return
    dispatch({
      type: 'CLEAR_PINNED_QUOTES',
      sessionId: state.activeSessionId,
    })
  }, [state.activeSessionId])

  // Prune pinned quotes whose source assistant message is no longer present
  // in the active session (compaction, clearHistory, etc).
  useEffect(() => {
    const sessionId = state.activeSessionId
    if (!sessionId) return
    const slot = state.selectionBySession[sessionId]
    if (!slot || slot.pinnedQuotes.length === 0) return
    const validMessageIds = new Set(
      (state.activeSession?.messages ?? []).map((m) => m.id),
    )
    const stillOrphaned = slot.pinnedQuotes.some(
      (q) => !validMessageIds.has(q.sourceMessageId),
    )
    if (!stillOrphaned) return
    dispatch({
      type: 'PRUNE_PINNED_QUOTES',
      sessionId,
      validMessageIds,
    })
  }, [
    state.activeSessionId,
    state.activeSession?.messages,
    state.selectionBySession,
  ])

  const refreshSpeech = useCallback(async () => {
    const speechStatus = await window.gemmaDesktopBridge.speech.inspect()
    dispatch({ type: 'SET_SPEECH_STATUS', speechStatus })
    return speechStatus
  }, [])

  const installSpeech = useCallback(async () => {
    const speechStatus = await window.gemmaDesktopBridge.speech.install()
    dispatch({ type: 'SET_SPEECH_STATUS', speechStatus })
    return speechStatus
  }, [])

  const repairSpeech = useCallback(async () => {
    const speechStatus = await window.gemmaDesktopBridge.speech.repair()
    dispatch({ type: 'SET_SPEECH_STATUS', speechStatus })
    return speechStatus
  }, [])

  const removeSpeech = useCallback(async () => {
    const speechStatus = await window.gemmaDesktopBridge.speech.remove()
    dispatch({ type: 'SET_SPEECH_STATUS', speechStatus })
    return speechStatus
  }, [])

  const refreshReadAloud = useCallback(async () => {
    const readAloudStatus = await window.gemmaDesktopBridge.readAloud.inspect()
    dispatch({ type: 'SET_READ_ALOUD_STATUS', readAloudStatus })
    return readAloudStatus
  }, [])

  useEffect(() => {
    const shouldPoll =
      !state.readAloudStatus
      || state.readAloudStatus.state === 'missing_assets'
      || state.readAloudStatus.state === 'installing'
      || state.readAloudStatus.state === 'loading'
      || !state.readAloudStatus.healthy

    if (!shouldPoll) {
      return
    }

    const refreshIfVisible = () => {
      if (document.visibilityState !== 'visible') {
        return
      }

      refreshReadAloud().catch((error) => {
        console.error('Failed to refresh read aloud status:', error)
      })
    }

    const interval = window.setInterval(refreshIfVisible, 5000)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [
    refreshReadAloud,
    state.readAloudStatus,
  ])

  const testReadAloud = useCallback(async (input?: ReadAloudTestInput) => {
    return await window.gemmaDesktopBridge.readAloud.test(input)
  }, [])

  const selectAutomation = useCallback(async (automationId: string) => {
    const automation = await window.gemmaDesktopBridge.automations.get(automationId)
    dispatch({ type: 'SET_ACTIVE_AUTOMATION', automation, id: automationId })
  }, [])

  const createAutomation = useCallback(
    async (input: {
      name: string
      prompt: string
      runtimeId: string
      modelId: string
      mode: SessionMode
      selectedSkillIds?: string[]
      workingDirectory: string
      enabled: boolean
      schedule: AutomationSchedule
    }) => {
      const automation = await window.gemmaDesktopBridge.automations.create(input)
      const automations = await window.gemmaDesktopBridge.automations.list()
      dispatch({ type: 'SET_AUTOMATIONS', automations })
      dispatch({
        type: 'SET_ACTIVE_AUTOMATION',
        automation,
        id: automation.id,
      })
      return automation
    },
    [],
  )

  const updateAutomation = useCallback(
    async (
      automationId: string,
      patch: Partial<{
        name: string
        prompt: string
        runtimeId: string
        modelId: string
        mode: SessionMode
        selectedSkillIds: string[]
        workingDirectory: string
        enabled: boolean
        schedule: AutomationSchedule
      }>,
    ) => {
      const automation = await window.gemmaDesktopBridge.automations.update(
        automationId,
        patch,
      )
      const automations = await window.gemmaDesktopBridge.automations.list()
      dispatch({ type: 'SET_AUTOMATIONS', automations })
      dispatch({
        type: 'SET_ACTIVE_AUTOMATION',
        automation,
        id: automation.id,
      })
      return automation
    },
    [],
  )

  const deleteAutomation = useCallback(async (automationId: string) => {
    await window.gemmaDesktopBridge.automations.delete(automationId)
    const automations = await window.gemmaDesktopBridge.automations.list()
    dispatch({ type: 'SET_AUTOMATIONS', automations })
    dispatch({
      type: 'SET_ACTIVE_AUTOMATION',
      automation: null,
      id:
        state.activeAutomationId === automationId
          ? null
          : state.activeAutomationId,
    })
  }, [state.activeAutomationId])

  const runAutomationNow = useCallback(
    async (automationId: string) => {
      await window.gemmaDesktopBridge.automations.runNow(automationId)
      const automation = await window.gemmaDesktopBridge.automations.get(automationId)
      dispatch({
        type: 'SET_ACTIVE_AUTOMATION',
        automation,
        id: automationId,
      })
    },
    [],
  )

  const cancelAutomationRun = useCallback(
    async (automationId: string) => {
      await window.gemmaDesktopBridge.automations.cancelRun(automationId)
      const automation = await window.gemmaDesktopBridge.automations.get(automationId)
      dispatch({
        type: 'SET_ACTIVE_AUTOMATION',
        automation,
        id: automationId,
      })
    },
    [],
  )

  return {
    state,
    dispatch,
    selectSession,
    createSession,
    updateSession,
    ensureGemmaModel,
    sendMessage,
    runShellCommand,
    runResearch,
    compactSession,
    clearActiveSessionHistory,
    deleteSession,
    renameSession,
    cancelGeneration,
    clearDebugLogs,
    refreshInstalledSkills,
    installSkill,
    removeSkill,
    pinSession,
    unpinSession,
    flagFollowUp,
    unflagFollowUp,
    setSessionTags,
    movePinnedSession,
    setSessionOrder,
    clearSessionOrder,
    setProjectOrder,
    clearProjectOrder,
    closeProject,
    reopenProject,
    resolveToolApproval,
    answerPlanQuestion,
    exitPlanMode,
    dismissPlanExit,
    revisePlanExit,
    removeQueuedMessage,
    refreshSpeech,
    installSpeech,
    repairSpeech,
    removeSpeech,
    refreshReadAloud,
    testReadAloud,
    selectAutomation,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomationNow,
    cancelAutomationRun,
    activeSelection,
    enterSelectionMode,
    exitSelectionMode,
    togglePinnedQuote,
    removePinnedQuote,
    clearPinnedQuotes,
  }
}

function normalizeCancelledStepStatus(status: ResearchPanelStepStatus): ResearchPanelStepStatus {
  return status === 'running' ? 'cancelled' : status
}

function finalizeStreamingContentForStopping(
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

function buildCreateSessionBridgeOptions(input: CreateSessionOpts): CreateSessionOpts {
  return {
    modelId: input.modelId,
    runtimeId: input.runtimeId,
    conversationKind: input.conversationKind,
    workMode: input.workMode,
    planMode: input.planMode,
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
