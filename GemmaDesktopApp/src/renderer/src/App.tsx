import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, PanelLeftOpen } from 'lucide-react'
import { useAppState } from '@/hooks/useAppState'
import { useReadAloudPlayer } from '@/hooks/useReadAloudPlayer'
import { useResizeHandle } from '@/hooks/useResizeHandle'
import { useTheme } from '@/hooks/useTheme'
import { Sidebar } from '@/components/Sidebar'
import { ChatCanvas } from '@/components/ChatCanvas'
import { StreamingStatus } from '@/components/Message'
import { AssistantHome } from '@/components/AssistantHome'
import { GlobalChatSwitchBar } from '@/components/GlobalChatSwitchBar'
import { InputBar } from '@/components/InputBar'
import { ReadAloudPlaybackOverlay } from '@/components/ReadAloudPlaybackOverlay'
import { RightDockRail, type RightDockView } from '@/components/RightDockRail'
import { TalkPanel } from '@/components/TalkPanel'
import { GitWorkspacePanel } from '@/components/GitWorkspacePanel'
import { FilesWorkspacePanel } from '@/components/FilesWorkspacePanel'
import { MemoryPanel } from '@/components/MemoryPanel'
import { DebugPanel } from '@/components/DebugPanel'
import { ResearchSetupPanel } from '@/components/ResearchSetupPanel'
import { TerminalDrawer } from '@/components/TerminalDrawer'
import { SettingsModal, type SettingsTab } from '@/components/SettingsModal'
import { SkillsModal } from '@/components/SkillsModal'
import { PlanQuestionCard } from '@/components/PlanQuestionCard'
import { PlanExecutionCard } from '@/components/PlanExecutionCard'
import { ToolApprovalCard } from '@/components/ToolApprovalCard'
import { AutomationsPanel } from '@/components/AutomationsPanel'
import { AmbientMood } from '@/components/AmbientMood'
import { DoctorPanel } from '@/components/DoctorPanel'
import { StartupLoadingOverlay } from '@/components/StartupLoadingOverlay'
import { StartupRiskDialog } from '@/components/StartupRiskDialog'
import { ProjectBrowserPanel } from '@/components/ProjectBrowserPanel'
import { useGlobalChatSession } from '@/hooks/useGlobalChatSession'
import { useWorkspaceDockBadges } from '@/hooks/useWorkspaceDockBadges'
import type {
  FileAttachment,
  MessageContent,
  ProjectBrowserState,
  QueuedUserMessage,
  SessionMode,
} from '@/types'
import type { ConversationRunMode } from '@/components/ConversationModeToolbar'
import { buildIdleAppTerminalState } from '@shared/appTerminal'
import {
  isGuidedGemmaMissing,
  resolveDefaultAutomationModelTarget,
  resolveDefaultResearchModelTarget,
  resolveDefaultSessionModelTarget,
} from '@/lib/guidedModels'
import { findGemmaCatalogEntryByTag } from '@shared/gemmaCatalog'
import { buildEmptyStateSubheading } from '@/lib/emptyStateSubheading'
import {
  buildComposedMessageText,
  type PinnedQuote,
} from '@/lib/composeQuotedMessage'
import { extractSpeakableTextFromContent } from '@/lib/readAloudText'
import { formatElapsedClock } from '@/lib/turnStatus'
import {
  getNextAssistantNarrationMode,
  type AssistantNarrationMode,
} from '@/lib/assistantNarrationMode'
import { resolveAttachmentPreviewUrl } from '@/lib/inputAttachments'
import {
  getRightDockLayoutClasses,
  type ChatContentLayout,
} from '@/lib/rightDockLayout'
import { buildSessionContextEstimate } from '@/lib/sessionContext'
import { resolveSessionModelContextLength } from '@/lib/sessionModels'
import { buildSessionSpeedStats } from '@/lib/sessionSpeed'
import {
  canQueueMessageWhileBusy,
  getBusyQueueBlockedReason,
} from '@/lib/sessionQueuePolicy'
import {
  getCoBrowseTakeControlDisabledReason,
  getCoBrowseUserControlComposerLockReason,
  isProjectBrowserCoBrowseState,
  shouldCloseProjectBrowserForConversationSwitch,
} from '@/lib/projectBrowserPolicy'
import {
  getDefaultSelectedSessionToolIds,
  getScopedSessionToolDefinitions,
} from '@shared/sessionTools'
import { normalizeSidebarProjectPath } from '@shared/sidebar'
import {
  buildSidebarModel,
  findReopenSessionForProject,
} from '@/lib/sidebarModel'
import type {
  NotificationActivationTarget,
  NotificationPermissionState,
} from '@shared/notifications'
import {
  findBlockingConversationExecution,
  formatConversationExecutionBlockedReason,
  isConversationExecutionBlockedError,
  stripConversationExecutionBlockedErrorCode,
  type ConversationExecutionRun,
} from '@shared/conversationExecutionPolicy'
import { createDefaultModelSelectionSettings } from '@shared/sessionModelDefaults'

const DEFAULT_NOTIFICATION_PERMISSION_STATE: NotificationPermissionState = {
  status: 'default',
  promptPending: false,
}

const SIDEBAR_DEFAULT_WIDTH = 320
const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 480
const RIGHT_DOCK_DEFAULT_WIDTH = 520
const RIGHT_DOCK_MIN_WIDTH = 340
const RIGHT_DOCK_MAX_WIDTH = 2_000

const EMPTY_PINNED_QUOTES: PinnedQuote[] = []
const COBROWSE_BUSY_QUEUE_DISABLED_REASON =
  'Wait for the current CoBrowse turn to finish before sending another request.'
const COBROWSE_STALE_QUEUE_DISABLED_REASON =
  'CoBrowse queued turns do not run automatically. Send a fresh request after the current turn finishes.'

function buildPinnedSentenceKeysMap(
  pinnedQuotes: PinnedQuote[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const quote of pinnedQuotes) {
    const existing = map.get(quote.sourceMessageId) ?? new Set<string>()
    existing.add(quote.id)
    map.set(quote.sourceMessageId, existing)
  }
  return map
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
  message: { text: string; attachments?: FileAttachment[]; coBrowse?: boolean },
): QueuedUserMessage {
  const timestamp = Date.now()
  const attachments = [...(message.attachments ?? [])]

  return {
    id: `queued-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    text: message.text,
    attachments,
    coBrowse: message.coBrowse,
    content: buildQueuedMessageContent(message.text, attachments),
    timestamp,
    status: 'queued',
  }
}

function summarizeNarrationAttachments(
  attachments: FileAttachment[] = [],
): Array<{ kind: FileAttachment['kind']; name?: string }> {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
  }))
}

function collectAssistantMessageIds(
  messages: Array<{ id: string; role: string }>,
): Set<string> {
  return new Set(
    messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id),
  )
}

function findLatestNewAssistantText(
  messages: Array<{ id: string; role: string; content: MessageContent[] }>,
  previousAssistantIds: Set<string>,
): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant' || previousAssistantIds.has(message.id)) {
      continue
    }

    const text = extractSpeakableTextFromContent(message.content)
    if (text) {
      return text
    }
  }

  return null
}

export function App() {
  const [startupRiskAccepted, setStartupRiskAccepted] = useState(false)
  const [startupOverlayDismissed, setStartupOverlayDismissed] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [statusBarTarget, setStatusBarTarget] = useState<HTMLDivElement | null>(null)
  const [assistantHomeVisible, setAssistantHomeVisible] = useState(true)
  const [rightDockView, setRightDockView] = useState<RightDockView | null>(null)
  const [mainComposerFocusKey, setMainComposerFocusKey] = useState(0)
  const [creatingSession, setCreatingSession] = useState(false)
  const [researchPanelWorkingDirectory, setResearchPanelWorkingDirectory] = useState('')
  const [researchPanelDefaultTitle, setResearchPanelDefaultTitle] = useState('Research 1')
  const [researchPanelDefaultPrompt, setResearchPanelDefaultPrompt] = useState('')
  const [globalChatPinnedToDock, setGlobalChatPinnedToDock] = useState(false)
  const [assistantNarrationMode, setAssistantNarrationMode] =
    useState<AssistantNarrationMode>('off')
  const [globalChatSelectionModeMessageId, setGlobalChatSelectionModeMessageId] =
    useState<string | null>(null)
  const [globalChatPinnedQuotes, setGlobalChatPinnedQuotes] = useState<PinnedQuote[]>([])
  const [globalQueuedMessages, setGlobalQueuedMessages] = useState<QueuedUserMessage[]>([])
  const [globalComposerFocusKey, setGlobalComposerFocusKey] = useState(0)
  const [terminalDrawerVisible, setTerminalDrawerVisible] = useState(false)
  const [terminalDrawerExpanded, setTerminalDrawerExpanded] = useState(false)
  const [terminalDrawerState, setTerminalDrawerState] = useState(buildIdleAppTerminalState)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general')
  const [newAutomationSeed, setNewAutomationSeed] = useState(0)
  const [coBrowseActive, setCoBrowseActive] = useState(false)
  const [coBrowseControlBusy, setCoBrowseControlBusy] = useState(false)
  const [coBrowseControlError, setCoBrowseControlError] = useState<string | null>(null)
  const [projectBrowserState, setProjectBrowserState] = useState<ProjectBrowserState>({
    open: false,
    sessionId: null,
    coBrowseActive: false,
    controlOwner: 'agent',
    controlReason: null,
    mounted: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    url: null,
    title: 'Project Browser',
    consoleErrorCount: 0,
    lastError: null,
    lastUpdatedAt: 0,
  })
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    DEFAULT_NOTIFICATION_PERMISSION_STATE,
  )
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const previousRightDockViewRef = useRef<RightDockView | null>(null)
  const projectBrowserOpenRef = useRef(false)
  const projectBrowserCoBrowseActiveRef = useRef(false)
  const drainingGlobalQueuedMessagesRef = useRef(new Set<string>())
  const {
    state,
    dispatch,
    selectSession,
    createSession,
    updateSession,
    ensureGemmaModel,
    sendMessage,
    runShellCommand,
    compactSession,
    clearActiveSessionHistory,
    deleteSession,
    renameSession,
    cancelGeneration,
    resolveToolApproval,
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
    answerPlanQuestion,
    exitPlanMode,
    dismissPlanExit,
    revisePlanExit,
    removeQueuedMessage,
    installSpeech,
    repairSpeech,
    removeSpeech,
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
  } = useAppState()
  const globalChatSession = useGlobalChatSession()
  const globalChatBusy =
    globalChatSession.isGenerating || globalChatSession.isCompacting
  const [globalChatHomeStatusNow, setGlobalChatHomeStatusNow] = useState(() =>
    Date.now(),
  )
  const rightDockVisible = rightDockView !== null
  const rightDockLayout = getRightDockLayoutClasses(rightDockVisible)
  const mainChatContentLayout: ChatContentLayout = rightDockVisible
    ? 'expanded'
    : 'centered'
  const projectBrowserSurfaceVisible =
    !state.settingsOpen && !state.skillsOpen && !doctorOpen
  const terminalDrawerBusy = terminalDrawerState.status === 'running'
  const sidebarResize = useResizeHandle({
    initialWidth: state.sidebarOpen ? SIDEBAR_DEFAULT_WIDTH : 0,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    direction: 'right',
  })
  const rightDockResize = useResizeHandle({
    initialWidth: RIGHT_DOCK_DEFAULT_WIDTH,
    minWidth: RIGHT_DOCK_MIN_WIDTH,
    maxWidth: RIGHT_DOCK_MAX_WIDTH,
    direction: 'left',
  })

  const hasActiveSession =
    state.activeSession !== null && state.activeSession.messages.length > 0
  const isBusy = state.isGenerating || state.isCompacting
  const activeConversationKind = state.activeSession?.conversationKind ?? 'normal'
  const coBrowseTakeControlDisabledReason =
    getCoBrowseTakeControlDisabledReason({
      coBrowseActive,
      projectBrowserSessionId: projectBrowserState.sessionId,
      activeSessionId: state.activeSessionId,
      activeSessionBusy: isBusy,
      globalChatSessionId: globalChatSession.sessionId,
      globalChatBusy,
    })
  const activeMode: SessionMode = state.activeSession?.workMode ?? 'explore'
  const activePlanMode =
    activeConversationKind === 'normal' && activeMode === 'build'
      ? (state.activeSession?.planMode ?? false)
      : false
  const sessionSpeed = buildSessionSpeedStats(state.debugLogs)
  const sessionContextEstimate = buildSessionContextEstimate(
    state.debugSession,
    state.activeSession?.messages ?? [],
  )
  const availableSessionTools = getScopedSessionToolDefinitions({
    chromeMcpEnabled: state.settings.tools.chromeMcp.enabled,
    conversationKind: activeConversationKind,
    workMode: activeMode,
    planMode: activePlanMode,
    surface: 'default',
  })
  const globalChatDetail = globalChatSession.session
  const activeConversationRuns = useMemo(() => {
    const runs = new Map<string, ConversationExecutionRun>()

    for (const session of state.sessions) {
      if (!session.isGenerating && !session.isCompacting) {
        continue
      }

      runs.set(session.id, {
        sessionId: session.id,
        task: session.isCompacting ? 'compaction' : 'generation',
        title: session.title,
      })
    }

    if (state.activeSession && (state.isGenerating || state.isCompacting)) {
      runs.set(state.activeSession.id, {
        sessionId: state.activeSession.id,
        task: state.isCompacting ? 'compaction' : 'generation',
        title: state.activeSession.title,
      })
    }

    if (globalChatSession.sessionId && globalChatBusy) {
      runs.set(globalChatSession.sessionId, {
        sessionId: globalChatSession.sessionId,
        task: globalChatSession.isCompacting ? 'compaction' : 'generation',
        title: globalChatDetail?.title ?? globalChatSession.title,
      })
    }

    return [...runs.values()]
  }, [
    globalChatBusy,
    globalChatDetail?.title,
    globalChatSession.isCompacting,
    globalChatSession.sessionId,
    globalChatSession.title,
    state.activeSession,
    state.isCompacting,
    state.isGenerating,
    state.sessions,
  ])

  useEffect(() => {
    if (!globalChatBusy) {
      return
    }

    setGlobalChatHomeStatusNow(Date.now())
    const interval = window.setInterval(() => {
      setGlobalChatHomeStatusNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [globalChatBusy])

  const newConversationRunDisabledReason = activeConversationRuns[0]
    ? formatConversationExecutionBlockedReason(activeConversationRuns[0])
    : null
  const primaryConversationBlocker = state.activeSessionId
    ? findBlockingConversationExecution(
      activeConversationRuns,
      state.activeSessionId,
    )
    : null
  const globalConversationBlocker = globalChatSession.sessionId
    ? findBlockingConversationExecution(
      activeConversationRuns,
      globalChatSession.sessionId,
    )
    : null
  const primaryCoBrowseUserControlDisabledReason =
    getCoBrowseUserControlComposerLockReason({
      coBrowseActive,
      projectBrowserCoBrowseActive: projectBrowserState.coBrowseActive,
      projectBrowserControlOwner: projectBrowserState.controlOwner,
      projectBrowserSessionId: projectBrowserState.sessionId,
      targetSessionId: state.activeSessionId,
    })
  const primaryConversationRunDisabledReason = primaryCoBrowseUserControlDisabledReason
    ?? (primaryConversationBlocker
      ? formatConversationExecutionBlockedReason(primaryConversationBlocker)
      : null)
  const globalCoBrowseUserControlDisabledReason =
    getCoBrowseUserControlComposerLockReason({
      coBrowseActive,
      projectBrowserCoBrowseActive: projectBrowserState.coBrowseActive,
      projectBrowserControlOwner: projectBrowserState.controlOwner,
      projectBrowserSessionId: projectBrowserState.sessionId,
      targetSessionId: globalChatSession.sessionId,
    })
  const globalConversationRunDisabledReason = globalCoBrowseUserControlDisabledReason
    ?? (globalConversationBlocker
      ? formatConversationExecutionBlockedReason(globalConversationBlocker)
      : null)
  const primaryCoBrowseBusyQueueDisabledReason =
    coBrowseActive
    && state.activeSessionId != null
    && projectBrowserState.sessionId === state.activeSessionId
      ? COBROWSE_BUSY_QUEUE_DISABLED_REASON
      : null
  const globalCoBrowseBusyQueueDisabledReason =
    coBrowseActive
    && globalChatSession.sessionId != null
      ? COBROWSE_BUSY_QUEUE_DISABLED_REASON
      : null
  const ramAwareDefaultModelSelection = useMemo(
    () =>
      createDefaultModelSelectionSettings(
        state.systemStats.memoryTotalGB * 1024 ** 3,
      ),
    [state.systemStats.memoryTotalGB],
  )
  const globalChatConversationKind =
    globalChatDetail?.conversationKind ?? 'normal'
  const globalChatMode: SessionMode = globalChatDetail?.workMode ?? 'explore'
  const globalChatPlanMode =
    globalChatConversationKind === 'normal' && globalChatMode === 'build'
      ? (globalChatDetail?.planMode ?? false)
      : false
  const globalChatContextEstimate = buildSessionContextEstimate(
    null,
    globalChatSession.messages,
  )
  const globalChatSpeed = useMemo(
    () => buildSessionSpeedStats([]),
    [],
  )
  const globalChatSessionTools = useMemo(
    () =>
      getScopedSessionToolDefinitions({
        chromeMcpEnabled: state.settings.tools.chromeMcp.enabled,
        conversationKind: globalChatConversationKind,
        workMode: globalChatMode,
        planMode: globalChatPlanMode,
        surface: 'assistant',
      }),
    [
      globalChatConversationKind,
      globalChatMode,
      globalChatPlanMode,
      state.settings.tools.chromeMcp.enabled,
    ],
  )
  useTheme(state.settings.theme)
  const defaultAutomationModelTarget = useMemo(
    () =>
      resolveDefaultAutomationModelTarget(
        state.models,
        state.gemmaInstallStates,
        state.settings.modelSelection,
      ),
    [
      state.gemmaInstallStates,
      state.models,
      state.settings.modelSelection,
    ],
  )
  const pinnedSentenceKeysByMessageId = useMemo(
    () => buildPinnedSentenceKeysMap(activeSelection.pinnedQuotes),
    [activeSelection.pinnedQuotes],
  )
  const globalPinnedSentenceKeysByMessageId = useMemo(
    () => buildPinnedSentenceKeysMap(globalChatPinnedQuotes),
    [globalChatPinnedQuotes],
  )
  const buildNextResearchTitle = (workingDirectory: string) => {
    const normalizedTarget = normalizeSidebarProjectPath(workingDirectory)
    const usedNumbers = new Set(
      state.sessions
        .filter((session) => session.conversationKind === 'research')
        .filter(
          (session) =>
            normalizeSidebarProjectPath(session.workingDirectory) === normalizedTarget,
        )
        .flatMap((session) => {
          const match = /^Research (\d+)$/.exec(session.title.trim())
          return match?.[1] ? [Number(match[1])] : []
        }),
    )

    let nextNumber = 1
    while (usedNumbers.has(nextNumber)) {
      nextNumber += 1
    }

    return `Research ${nextNumber}`
  }
  const openResearchConversationPanel = (input?: {
    prompt?: string
    workingDirectoryHint?: string
  }) => {
    const nextWorkingDirectory =
      input?.workingDirectoryHint?.trim()
      || state.activeSession?.workingDirectory.trim()
      || state.settings.defaultProjectDirectory.trim()

    setResearchPanelWorkingDirectory(nextWorkingDirectory)
    setResearchPanelDefaultTitle(buildNextResearchTitle(nextWorkingDirectory))
    setResearchPanelDefaultPrompt(input?.prompt?.trim() ?? '')
    setAssistantHomeVisible(false)
    setRightDockView('research')
  }
  const openNewAutomationPanel = () => {
    dispatch({ type: 'SET_VIEW', view: 'automations' })
    dispatch({
      type: 'SET_ACTIVE_AUTOMATION',
      automation: null,
      id: null,
    })
    setNewAutomationSeed((current) => current + 1)
    setAssistantHomeVisible(false)
    setRightDockView('automations')
  }
  const handlePickResearchWorkingDirectory = async () => {
    const picked = await window.gemmaDesktopBridge.folders.pickDirectory(
      researchPanelWorkingDirectory || state.settings.defaultProjectDirectory,
    )
    if (!picked) {
      return
    }

    setResearchPanelWorkingDirectory(picked)
    setResearchPanelDefaultTitle(buildNextResearchTitle(picked))
  }
  const handleCreateResearchConversation = async (input: {
    title: string
    prompt: string
  }) => {
    const workingDirectory = researchPanelWorkingDirectory.trim()
    if (!workingDirectory || creatingSession || newConversationRunDisabledReason) {
      return
    }

    const target = resolveDefaultResearchModelTarget(
      state.models,
      state.gemmaInstallStates,
      state.settings.modelSelection,
    )

    setCreatingSession(true)
    try {
      const ready = await ensureTargetModelReady(target)
      if (!ready) {
        return
      }

      dispatch({ type: 'SET_VIEW', view: 'chat' })
      setAssistantHomeVisible(false)
      const detail = await createSession({
        modelId: target.modelId,
        runtimeId: target.runtimeId,
        conversationKind: 'research',
        workingDirectory,
        title: input.title.trim() || researchPanelDefaultTitle,
      })
      setRightDockView(null)
      setResearchPanelDefaultPrompt('')

      if (input.prompt.trim().length > 0) {
        await window.gemmaDesktopBridge.sessions.sendMessage(detail.id, {
          text: input.prompt.trim(),
        })
      }
    } catch (error) {
      console.error('Failed to create research conversation:', error)
    } finally {
      setCreatingSession(false)
    }
  }
  const handleToggleSelectionMode = (messageId: string) => {
    if (activeSelection.selectionModeMessageId === messageId) {
      exitSelectionMode()
    } else {
      enterSelectionMode(messageId)
    }
  }
  const readAloudPlayer = useReadAloudPlayer({
    enabled: state.settings.readAloud.enabled,
    defaultVoice: state.settings.readAloud.defaultVoice,
    speed: state.settings.readAloud.speed,
    status: state.readAloudStatus,
  })
  const assistantNarrationModeRef = useRef(assistantNarrationMode)
  useEffect(() => {
    assistantNarrationModeRef.current = assistantNarrationMode
  }, [assistantNarrationMode])
  const assistantNarrationDisabledReason =
    state.readAloudStatus?.supported === false
      ? 'Read aloud is not supported on this machine.'
      : (!state.settings.readAloud.enabled || state.readAloudStatus?.enabled === false)
          ? 'Read aloud is disabled in Voice settings.'
          : null
  const assistantNarrationAvailable = assistantNarrationDisabledReason === null
  const cycleAssistantNarrationMode = useCallback(() => {
    setAssistantNarrationMode((current) => {
      const next = getNextAssistantNarrationMode(current)
      if (next === 'off') {
        void readAloudPlayer.stopPlayback()
      }
      return next
    })
  }, [readAloudPlayer.stopPlayback])
  const playAssistantNarration = useCallback((input: {
    phase: 'submission' | 'result'
    userText: string
    attachments?: FileAttachment[]
    assistantText?: string
    conversationTitle?: string
    workingDirectory?: string
  }) => {
    const mode = assistantNarrationModeRef.current
    if (mode === 'off' || assistantNarrationDisabledReason) {
      return
    }

    if (mode === 'full') {
      if (input.phase !== 'result' || !input.assistantText) {
        return
      }

      void readAloudPlayer.playNarration({
        playbackKey: `assistant-full-response:${Date.now()}`,
        text: input.assistantText,
        label: 'Reading full response',
      })
      return
    }

    void window.gemmaDesktopBridge.assistantNarration.generate({
      phase: input.phase,
      userText: input.userText,
      attachments: summarizeNarrationAttachments(input.attachments),
      assistantText: input.assistantText,
      conversationTitle: input.conversationTitle,
      workingDirectory: input.workingDirectory,
    })
      .then((result) => {
        if (assistantNarrationModeRef.current !== 'summary' || !result.text) {
          return
        }

        void readAloudPlayer.playNarration({
          playbackKey: `assistant-narration:${input.phase}:${Date.now()}`,
          text: result.text,
          label: input.phase === 'submission'
            ? 'Gemma is starting'
            : 'Gemma finished',
        })
      })
      .catch((error) => {
        console.warn('Failed to generate spoken turn summary:', error)
      })
  }, [
    assistantNarrationDisabledReason,
    readAloudPlayer,
  ])
  const refreshSessionSummaries = useCallback(async () => {
    const sessions = await window.gemmaDesktopBridge.sessions.list()
    dispatch({ type: 'SET_SESSIONS', sessions })
  }, [dispatch])
  const handleToggleGlobalChatSelectionMode = useCallback((messageId: string) => {
    setGlobalChatSelectionModeMessageId((current) =>
      current === messageId ? null : messageId,
    )
  }, [])
  const handleToggleGlobalChatSentence = useCallback((quote: PinnedQuote) => {
    setGlobalChatPinnedQuotes((current) => {
      const existing = current.find((entry) => entry.id === quote.id)
      if (existing) {
        return current.filter((entry) => entry.id !== quote.id)
      }
      return [...current, quote]
    })
  }, [])
  const handleRemoveGlobalPinnedQuote = useCallback((quoteId: string) => {
    setGlobalChatPinnedQuotes((current) =>
      current.filter((quote) => quote.id !== quoteId),
    )
  }, [])
  const handleClearGlobalPinnedQuotes = useCallback(() => {
    setGlobalChatPinnedQuotes(EMPTY_PINNED_QUOTES)
    setGlobalChatSelectionModeMessageId(null)
  }, [])
  const handleRemoveGlobalQueuedMessage = useCallback((messageId: string) => {
    setGlobalQueuedMessages((current) =>
      current.filter((message) => message.id !== messageId),
    )
  }, [])

  useEffect(() => {
    setGlobalChatPinnedQuotes(EMPTY_PINNED_QUOTES)
    setGlobalChatSelectionModeMessageId(null)
    setGlobalQueuedMessages([])
    drainingGlobalQueuedMessagesRef.current.clear()
  }, [globalChatSession.sessionId])

  useEffect(() => {
    if (!globalChatDetail) {
      return
    }

    const validMessageIds = new Set(globalChatDetail.messages.map((message) => message.id))
    setGlobalChatPinnedQuotes((current) =>
      current.filter((quote) => validMessageIds.has(quote.sourceMessageId)),
    )
    setGlobalChatSelectionModeMessageId((current) =>
      current && validMessageIds.has(current) ? current : null,
    )
  }, [globalChatDetail])

  const handleGlobalChatSend = useCallback(async (
    message: { text: string; attachments?: FileAttachment[] },
  ) => {
    const sessionId = globalChatSession.sessionId
    if (!sessionId || !globalChatDetail) {
      return
    }
    if (globalConversationRunDisabledReason) {
      throw new Error(globalConversationRunDisabledReason)
    }

    const selectionSnapshot = {
      pinnedQuotes: globalChatPinnedQuotes,
      selectionModeMessageId: globalChatSelectionModeMessageId,
    }
    const composedText = buildComposedMessageText(
      selectionSnapshot.pinnedQuotes,
      message.text,
    )
    const shouldClearSelection =
      selectionSnapshot.pinnedQuotes.length > 0
      || selectionSnapshot.selectionModeMessageId !== null
    const queueWhileBusy = canQueueMessageWhileBusy({
      conversationKind: globalChatDetail.conversationKind,
      planMode: globalChatDetail.planMode,
    }) && !coBrowseActive

    if (globalChatBusy) {
      if (!queueWhileBusy) {
        throw new Error(
          coBrowseActive
            ? COBROWSE_BUSY_QUEUE_DISABLED_REASON
            : getBusyQueueBlockedReason({
              conversationKind: globalChatDetail.conversationKind,
              planMode: globalChatDetail.planMode,
            }),
        )
      }

      if (shouldClearSelection) {
        setGlobalChatPinnedQuotes(EMPTY_PINNED_QUOTES)
        setGlobalChatSelectionModeMessageId(null)
      }
      setGlobalQueuedMessages((current) => [
        ...current,
        buildQueuedUserMessage({
          text: composedText,
          attachments: message.attachments,
          coBrowse: coBrowseActive,
        }),
      ])
      return
    }

    if (shouldClearSelection) {
      setGlobalChatPinnedQuotes(EMPTY_PINNED_QUOTES)
      setGlobalChatSelectionModeMessageId(null)
    }

    try {
      globalChatSession.setOptimisticGenerating(true)
      await window.gemmaDesktopBridge.sessions.sendMessage(sessionId, {
        text: composedText,
        attachments: message.attachments,
        coBrowse: coBrowseActive,
      })
      await refreshSessionSummaries()
    } catch (error) {
      globalChatSession.setOptimisticGenerating(false)
      if (shouldClearSelection) {
        setGlobalChatPinnedQuotes(selectionSnapshot.pinnedQuotes)
        setGlobalChatSelectionModeMessageId(selectionSnapshot.selectionModeMessageId)
      }
      if (error instanceof Error && isConversationExecutionBlockedError(error.message)) {
        throw new Error(stripConversationExecutionBlockedErrorCode(error.message))
      }
      throw error
    }
  }, [
    globalChatBusy,
    globalChatDetail,
    globalChatPinnedQuotes,
    globalChatSelectionModeMessageId,
    globalChatSession.sessionId,
    globalChatSession.setOptimisticGenerating,
    globalConversationRunDisabledReason,
    coBrowseActive,
    refreshSessionSummaries,
  ])

  const handleCoBrowseTakeControl = useCallback(async () => {
    if (coBrowseTakeControlDisabledReason) {
      return
    }

    setCoBrowseControlBusy(true)
    setCoBrowseControlError(null)
    try {
      const nextState = await window.gemmaDesktopBridge.browser.takeControl()
      setProjectBrowserState(nextState)
      projectBrowserOpenRef.current = nextState.open
      projectBrowserCoBrowseActiveRef.current = isProjectBrowserCoBrowseState({
        projectBrowserOpen: nextState.open,
        projectBrowserCoBrowseActive: nextState.coBrowseActive,
      })
    } catch (error) {
      setCoBrowseControlError(
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      setCoBrowseControlBusy(false)
    }
  }, [coBrowseTakeControlDisabledReason])

  const handleCoBrowseReleaseControl = useCallback(async () => {
    setCoBrowseControlBusy(true)
    setCoBrowseControlError(null)
    try {
      const nextState = await window.gemmaDesktopBridge.browser.releaseControl()
      setProjectBrowserState(nextState)
      projectBrowserOpenRef.current = nextState.open
      projectBrowserCoBrowseActiveRef.current = isProjectBrowserCoBrowseState({
        projectBrowserOpen: nextState.open,
        projectBrowserCoBrowseActive: nextState.coBrowseActive,
      })
    } catch (error) {
      setCoBrowseControlError(
        error instanceof Error ? error.message : String(error),
      )
      setCoBrowseControlBusy(false)
      return
    }
    setCoBrowseControlBusy(false)
  }, [])

  const handleRunGlobalChatShellCommand = useCallback(async (command: string) => {
    const sessionId = globalChatSession.sessionId
    if (!sessionId) {
      return
    }

    await window.gemmaDesktopBridge.sessions.runShellCommand(sessionId, { command })
    await refreshSessionSummaries()
  }, [globalChatSession.sessionId, refreshSessionSummaries])

  const handleCloseBackgroundProcess = useCallback((sessionId: string, terminalId: string) => {
    if (
      !window.confirm(
        'Terminate this background process? The app, server, or watcher it started will stop.',
      )
    ) {
      return
    }

    void window.gemmaDesktopBridge.sessions.closeShell(
      sessionId,
      terminalId,
    ).catch((error) => {
      console.error('Failed to terminate background process:', error)
    })
  }, [])

  useEffect(() => {
    const sessionId = globalChatSession.sessionId
    const nextQueuedMessage = globalQueuedMessages.find((message) => message.status === 'queued')
    if (
      !sessionId
      || !nextQueuedMessage
      || globalChatBusy
      || globalConversationRunDisabledReason
      || globalCoBrowseUserControlDisabledReason
    ) {
      return
    }

    if (drainingGlobalQueuedMessagesRef.current.has(nextQueuedMessage.id)) {
      return
    }

    if (nextQueuedMessage.coBrowse) {
      setGlobalQueuedMessages((current) =>
        current.map((message) =>
          message.id === nextQueuedMessage.id
            ? {
                ...message,
                status: 'failed',
                error: COBROWSE_STALE_QUEUE_DISABLED_REASON,
              }
            : message,
        ),
      )
      return
    }

    drainingGlobalQueuedMessagesRef.current.add(nextQueuedMessage.id)
    setGlobalQueuedMessages((current) =>
      current.filter((message) => message.id !== nextQueuedMessage.id),
    )
    void window.gemmaDesktopBridge.sessions
      .sendMessage(sessionId, {
        text: nextQueuedMessage.text,
        attachments: nextQueuedMessage.attachments,
        coBrowse: nextQueuedMessage.coBrowse,
      })
      .then(async () => {
        await refreshSessionSummaries()
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error)

        if (
          errorMessage.includes('already generating a response')
          || isConversationExecutionBlockedError(errorMessage)
        ) {
          setGlobalQueuedMessages((current) => [
            nextQueuedMessage,
            ...current.filter((message) => message.id !== nextQueuedMessage.id),
          ])
          return
        }

        setGlobalQueuedMessages((current) => [
          {
            ...nextQueuedMessage,
            status: 'failed',
            error: errorMessage,
          },
          ...current.filter((message) => message.id !== nextQueuedMessage.id),
        ])
      })
      .finally(() => {
        drainingGlobalQueuedMessagesRef.current.delete(nextQueuedMessage.id)
      })
  }, [
    globalChatBusy,
    globalChatSession.sessionId,
    globalCoBrowseUserControlDisabledReason,
    globalConversationRunDisabledReason,
    globalQueuedMessages,
    refreshSessionSummaries,
  ])

  const handleSelectGlobalChatMode = useCallback((mode: ConversationRunMode) => {
    const sessionId = globalChatSession.sessionId
    if (
      globalChatBusy
      || globalConversationRunDisabledReason
      || !sessionId
      || !globalChatDetail
      || globalChatDetail.conversationKind !== 'normal'
    ) {
      return
    }

    const nextWorkMode: SessionMode = mode === 'explore' ? 'explore' : 'build'
    const nextPlanMode = mode === 'plan'
    const alreadySelected =
      globalChatMode === nextWorkMode
      && (nextWorkMode === 'explore' || globalChatPlanMode === nextPlanMode)

    if (alreadySelected) {
      return
    }

    void window.gemmaDesktopBridge.sessions
      .update(sessionId, {
        workMode: nextWorkMode,
        planMode: nextPlanMode,
      })
      .then(async () => {
        await globalChatSession.retry()
        await refreshSessionSummaries()
      })
      .catch((error) => {
        console.error('Failed to update Assistant Chat mode:', error)
      })
  }, [
    globalChatBusy,
    globalConversationRunDisabledReason,
    globalChatDetail,
    globalChatMode,
    globalChatPlanMode,
    globalChatSession,
    refreshSessionSummaries,
  ])

  const handleSelectGlobalChatModel = useCallback((selection: {
    modelId: string
    runtimeId: string
  }) => {
    const sessionId = globalChatSession.sessionId
    if (
      globalChatBusy
      || globalConversationRunDisabledReason
      || !sessionId
      || !globalChatDetail
      || globalChatDetail.conversationKind !== 'normal'
    ) {
      return
    }

    if (
      selection.modelId === globalChatDetail.modelId
      && selection.runtimeId === globalChatDetail.runtimeId
    ) {
      return
    }

    void (async () => {
      const ready = await ensureTargetModelReady(selection)
      if (!ready) {
        return
      }

      await window.gemmaDesktopBridge.sessions.update(sessionId, selection)
      await globalChatSession.retry()
      await refreshSessionSummaries()
    })().catch((error) => {
      console.error('Failed to update Assistant Chat model:', error)
    })
  }, [
    globalChatBusy,
    globalConversationRunDisabledReason,
    globalChatDetail,
    globalChatSession,
    refreshSessionSummaries,
  ])

  const handleToggleGlobalChatTool = useCallback((toolId: string, nextSelected: boolean) => {
    const sessionId = globalChatSession.sessionId
    if (!sessionId || !globalChatDetail || globalConversationRunDisabledReason) {
      return
    }

    const selectedToolIds = nextSelected
      ? Array.from(new Set([...globalChatDetail.selectedToolIds, toolId]))
      : globalChatDetail.selectedToolIds.filter((id) => id !== toolId)

    void window.gemmaDesktopBridge.sessions
      .update(sessionId, {
        selectedToolIds,
      })
      .then(async () => {
        await globalChatSession.retry()
        await refreshSessionSummaries()
      })
      .catch((error) => {
        console.error('Failed to update Assistant Chat tools:', error)
      })
  }, [
    globalChatDetail,
    globalChatSession,
    globalConversationRunDisabledReason,
    refreshSessionSummaries,
  ])
  const handleSelectConversationMode = (mode: ConversationRunMode) => {
    if (
      isBusy
      || primaryConversationRunDisabledReason
      || !state.activeSessionId
      || activeConversationKind !== 'normal'
    ) {
      return
    }

    const nextWorkMode: SessionMode = mode === 'explore' ? 'explore' : 'build'
    const nextPlanMode = mode === 'plan'
    const alreadySelected =
      activeMode === nextWorkMode
      && (nextWorkMode === 'explore' || activePlanMode === nextPlanMode)

    if (alreadySelected) {
      return
    }

    updateSession(state.activeSessionId, {
      workMode: nextWorkMode,
      planMode: nextPlanMode,
    }).catch((error) => {
      console.error('Failed to update conversation mode:', error)
    })
  }
  const handleSelectConversationModel = (selection: {
    modelId: string
    runtimeId: string
  }) => {
    const sessionId = state.activeSessionId
    const activeSession = state.activeSession

    if (
      isBusy
      || primaryConversationRunDisabledReason
      || !sessionId
      || !activeSession
      || activeConversationKind !== 'normal'
    ) {
      return
    }

    if (
      selection.modelId === activeSession.modelId
      && selection.runtimeId === activeSession.runtimeId
    ) {
      return
    }

    void (async () => {
      await switchActiveSessionModel(selection)
    })().catch((error) => {
      console.error('Failed to update conversation model:', error)
    })
  }
  const sessionContext = {
    tokensUsed: sessionContextEstimate.tokensUsed,
    contextLength: resolveSessionModelContextLength(state.models, {
      modelId: state.activeSession?.modelId,
      runtimeId: state.activeSession?.runtimeId,
    }),
    speed: sessionSpeed,
    source: sessionContextEstimate.source,
  }
  const globalChatContext = {
    tokensUsed: globalChatContextEstimate.tokensUsed,
    contextLength: resolveSessionModelContextLength(state.models, {
      modelId: globalChatDetail?.modelId,
      runtimeId: globalChatDetail?.runtimeId,
    }),
    speed: globalChatSpeed,
    source: globalChatContextEstimate.source,
  }

  const openSettings = (tab: SettingsTab = 'general') => {
    setDoctorOpen(false)
    setSettingsInitialTab(tab)
    dispatch({ type: 'SET_SETTINGS_OPEN', open: true })
  }
  const preferredTerminalWorkingDirectory =
    state.activeSession?.workingDirectory.trim()
    || state.settings.defaultProjectDirectory.trim()
    || undefined

  const startTerminalDrawer = async () => {
    try {
      const nextState = await window.gemmaDesktopBridge.terminalDrawer.start({
        workingDirectory: preferredTerminalWorkingDirectory,
      })
      setTerminalDrawerState(nextState)
    } catch (error) {
      console.error('Failed to start terminal drawer:', error)
    }
  }

  const handleToggleTerminalDrawer = () => {
    if (terminalDrawerVisible) {
      setTerminalDrawerVisible(false)
      return
    }

    if (state.currentView !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
    }

    setTerminalDrawerVisible(true)
    if (terminalDrawerState.status === 'idle') {
      void startTerminalDrawer()
    }
  }

  const handleTerminateTerminalDrawer = async () => {
    if (
      !window.confirm(
        'Hard close this terminal? This will terminate the shell and hide the drawer.',
      )
    ) {
      return
    }

    try {
      await window.gemmaDesktopBridge.terminalDrawer.terminate()
      setTerminalDrawerVisible(false)
      setTerminalDrawerExpanded(false)
    } catch (error) {
      console.error('Failed to terminate terminal drawer:', error)
    }
  }

  const rightDockWorkingDirectory = (
    state.activeSession?.workingDirectory
    || state.settings.defaultProjectDirectory
  ).trim()
  const { badges: rightDockBadges, gitAvailable: rightDockGitAvailable } =
    useWorkspaceDockBadges(
      rightDockWorkingDirectory || null,
      rightDockView,
      state.currentView === 'chat',
    )

  const handleSelectRightDock = (view: RightDockView) => {
    if (view === 'git' && !rightDockGitAvailable) {
      return
    }

    if (view !== 'browser' || rightDockView === 'browser') {
      setCoBrowseActive(false)
      setCoBrowseControlError(null)
    }

    if (view === 'assistant') {
      if (state.currentView !== 'chat') {
        dispatch({ type: 'SET_VIEW', view: 'chat' })
      }

      setAssistantHomeVisible(false)
      setRightDockView((current) => (current === 'assistant' ? null : 'assistant'))
      if (rightDockView !== 'assistant') {
        setGlobalComposerFocusKey((current) => current + 1)
      }
      return
    }

    if (view === 'memory') {
      setRightDockView((current) => (current === 'memory' ? null : 'memory'))
      return
    }

    if (view === 'automations') {
      if (state.currentView === 'automations' && rightDockView === 'automations') {
        setRightDockView(null)
        dispatch({ type: 'SET_VIEW', view: 'chat' })
        return
      }

      openNewAutomationPanel()
      return
    }

    if (view === 'research') {
      if (rightDockView === 'research') {
        setRightDockView(null)
        return
      }

      if (state.currentView !== 'chat') {
        dispatch({ type: 'SET_VIEW', view: 'chat' })
      }

      openResearchConversationPanel()
      return
    }

    if (state.currentView !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
      setRightDockView(view)
      return
    }

    setRightDockView((current) => (current === view ? null : view))
  }

  const toggleAssistantHome = useCallback(() => {
    setAssistantHomeVisible((current) => !current)
  }, [])

  const enterWorkMode = useCallback(() => {
    setAssistantHomeVisible(false)
  }, [])

  const enterCoBrowseMode = useCallback(() => {
    if (state.currentView !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
    }

    setAssistantHomeVisible(true)
    setCoBrowseActive(true)
    setCoBrowseControlBusy(false)
    setCoBrowseControlError(null)
    setRightDockView(null)
  }, [dispatch, state.currentView])

  const toggleGlobalChatDockPin = useCallback(() => {
    if (globalChatPinnedToDock) {
      setGlobalChatPinnedToDock(false)
      setRightDockView((current) => (current === 'assistant' ? null : current))
      return
    }

    if (state.currentView !== 'chat') {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
    }

    setAssistantHomeVisible(false)
    setGlobalChatPinnedToDock(true)
    setRightDockView('assistant')
    setGlobalComposerFocusKey((current) => current + 1)
  }, [dispatch, globalChatPinnedToDock, state.currentView])

  useEffect(() => {
    void window.gemmaDesktopBridge.browser.getState()
      .then((nextState) => {
        const nextStateIsCoBrowse = isProjectBrowserCoBrowseState({
          projectBrowserOpen: nextState.open,
          projectBrowserCoBrowseActive: nextState.coBrowseActive,
        })
        setProjectBrowserState(nextState)
        projectBrowserOpenRef.current = nextState.open
        projectBrowserCoBrowseActiveRef.current = nextStateIsCoBrowse
        if (nextState.open) {
          dispatch({ type: 'SET_VIEW', view: 'chat' })
          if (nextStateIsCoBrowse) {
            setAssistantHomeVisible(true)
            setCoBrowseActive(true)
            setRightDockView(null)
          } else {
            setAssistantHomeVisible(false)
            setRightDockView('browser')
            setCoBrowseActive(false)
          }
        }
      })
      .catch((error) => {
        console.error('Failed to inspect project browser state:', error)
      })

    return window.gemmaDesktopBridge.browser.onStateChanged((nextState) => {
      const wasOpen = projectBrowserOpenRef.current
      const wasCoBrowse = projectBrowserCoBrowseActiveRef.current
      const nextStateIsCoBrowse = isProjectBrowserCoBrowseState({
        projectBrowserOpen: nextState.open,
        projectBrowserCoBrowseActive: nextState.coBrowseActive,
      })
      projectBrowserOpenRef.current = nextState.open
      projectBrowserCoBrowseActiveRef.current = nextStateIsCoBrowse
      setProjectBrowserState(nextState)
      if (wasOpen && !nextState.open) {
        setCoBrowseActive(false)
        setCoBrowseControlError(null)
      } else if (
        (!wasOpen && nextState.open)
        || (wasOpen && nextState.open && wasCoBrowse !== nextStateIsCoBrowse)
      ) {
        setCoBrowseActive(nextStateIsCoBrowse)
      }
      setRightDockView((current) => {
        if (
          (!wasOpen && nextState.open)
          || (wasOpen && nextState.open && wasCoBrowse !== nextStateIsCoBrowse)
        ) {
          dispatch({ type: 'SET_VIEW', view: 'chat' })
          if (nextStateIsCoBrowse) {
            setAssistantHomeVisible(true)
            return null
          }
          setAssistantHomeVisible(false)
          return 'browser'
        }
        if (wasOpen && !nextState.open) {
          return current === 'browser' ? null : current
        }
        return current
      })
      })
  }, [])

  useEffect(() => {
    let cancelled = false

    void window.gemmaDesktopBridge.terminalDrawer.getState()
      .then((nextState) => {
        if (!cancelled) {
          setTerminalDrawerState(nextState)
        }
      })
      .catch((error) => {
        console.error('Failed to inspect terminal drawer state:', error)
      })

    const unsubscribe = window.gemmaDesktopBridge.terminalDrawer.onStateChanged((nextState) => {
      if (!cancelled) {
        setTerminalDrawerState(nextState)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const previous = previousRightDockViewRef.current
    previousRightDockViewRef.current = rightDockView

    if (
      previous
      && rightDockView == null
      && state.currentView === 'chat'
      && state.activeSession
    ) {
      setMainComposerFocusKey((current) => current + 1)
    }
  }, [rightDockView, state.activeSession, state.currentView])

  useEffect(() => {
    if (!shouldCloseProjectBrowserForConversationSwitch({
      projectBrowserOpen: projectBrowserState.open,
      projectBrowserSessionId: projectBrowserState.sessionId,
      activeSessionId: state.activeSessionId,
      globalChatSessionId: globalChatSession.sessionId,
    })) {
      return
    }

    void window.gemmaDesktopBridge.browser.close().catch((error) => {
      console.error('Failed to close project browser for session switch:', error)
    })
  }, [
    globalChatSession.sessionId,
    projectBrowserState.open,
    projectBrowserState.sessionId,
    state.activeSessionId,
  ])

  useEffect(() => {
    if (
      rightDockView !== 'browser'
      || !splitContainerRef.current
    ) {
      return
    }

    rightDockResize.setWidth(splitContainerRef.current.clientWidth / 2)
  }, [rightDockResize.setWidth, rightDockView])

  const handleProjectBrowserClose = useCallback(() => {
    setRightDockView((current) => (current === 'browser' ? null : current))
    setCoBrowseActive(false)
    setCoBrowseControlBusy(false)
    setCoBrowseControlError(null)
    void window.gemmaDesktopBridge.browser.close().catch((error) => {
      console.error('Failed to close project browser:', error)
    })
  }, [])

  const projectBrowserPanel = (
    <ProjectBrowserPanel
      state={projectBrowserState}
      coBrowseActive={coBrowseActive}
      controlBusy={coBrowseControlBusy}
      takeControlDisabledReason={coBrowseTakeControlDisabledReason}
      resumeError={coBrowseControlError}
      surfaceVisible={projectBrowserSurfaceVisible}
      onTakeControl={handleCoBrowseTakeControl}
      onReleaseControl={handleCoBrowseReleaseControl}
      onClose={handleProjectBrowserClose}
    />
  )

  const renderRightDockPanel = () => {
    if (rightDockView === 'assistant') {
      return (
        <TalkPanel
          variant="docked"
          title={globalChatSession.title}
          targetKind={globalChatSession.targetKind}
          sessionId={globalChatSession.sessionId}
          messages={globalChatSession.messages}
          draftText={globalChatSession.draftText}
          streamingContent={globalChatSession.streamingContent}
          isGenerating={globalChatSession.isGenerating}
          isCompacting={globalChatSession.isCompacting}
          conversationRunDisabledReason={globalConversationRunDisabledReason}
          pendingCompaction={globalChatSession.pendingCompaction}
          pendingToolApproval={globalChatSession.pendingToolApproval}
          liveActivity={globalChatSession.liveActivity}
          sessionContext={globalChatContext}
          loading={globalChatSession.loading}
          error={globalChatSession.error}
          enterToSend={state.settings.enterToSend}
          onRetry={globalChatSession.retry}
          onSend={async (text) => {
            await handleGlobalChatInputSend({ text })
          }}
          onCancel={globalChatSession.cancelGeneration}
          onCompact={globalChatSession.compactSession}
          onSaveDraft={globalChatSession.saveDraft}
          onClearSession={globalChatSession.clearSession}
          onResolveToolApproval={globalChatSession.resolveToolApproval}
          getReadAloudButtonState={readAloudPlayer.buildButtonState}
        />
      )
    }

    if (rightDockView === 'browser') {
      return projectBrowserPanel
    }

    if (rightDockView === 'research') {
      return (
        <ResearchSetupPanel
          defaultTitle={researchPanelDefaultTitle}
          defaultPrompt={researchPanelDefaultPrompt}
          workingDirectory={researchPanelWorkingDirectory}
          disabledReason={newConversationRunDisabledReason}
          onClose={() => setRightDockView(null)}
          onSubmit={handleCreateResearchConversation}
          onPickWorkingDirectory={handlePickResearchWorkingDirectory}
        />
      )
    }

    if (rightDockView === 'automations') {
      return (
        <AutomationsPanel
          activeAutomation={state.activeAutomation}
          models={state.models}
          gemmaInstallStates={state.gemmaInstallStates}
          installedSkills={state.installedSkills}
          defaultWorkingDirectory={state.settings.defaultProjectDirectory}
          defaultModelTarget={defaultAutomationModelTarget}
          newAutomationSeed={newAutomationSeed}
          onEnsureGemmaModel={ensureGemmaModel}
          onCreateAutomation={createAutomation}
          onUpdateAutomation={updateAutomation}
          onDeleteAutomation={deleteAutomation}
          onRunNow={runAutomationNow}
          onCancelRun={cancelAutomationRun}
          onClose={() => {
            setRightDockView(null)
            dispatch({ type: 'SET_VIEW', view: 'chat' })
          }}
        />
      )
    }

    if (rightDockView === 'git') {
      return (
        <GitWorkspacePanel
          workingDirectory={rightDockWorkingDirectory}
          onClose={() => setRightDockView(null)}
        />
      )
    }

    if (rightDockView === 'files') {
      return (
        <FilesWorkspacePanel
          workingDirectory={rightDockWorkingDirectory}
          session={state.activeSession}
          onClose={() => setRightDockView(null)}
        />
      )
    }

    if (rightDockView === 'memory') {
      return (
        <MemoryPanel onClose={() => setRightDockView(null)} />
      )
    }

    if (rightDockView === 'debug') {
      return (
        <DebugPanel
          sessionId={state.activeSessionId ?? null}
          sessionTitle={state.activeSession?.title ?? null}
          onClose={() => setRightDockView(null)}
        />
      )
    }

    return null
  }

  const renderMainConversationPane = () => {
    if (hasActiveSession || state.streamingContent) {
      return (
        <ChatCanvas
          sessionId={state.activeSession?.id ?? null}
          messages={state.activeSession?.messages ?? []}
          streamingContent={state.streamingContent}
          isGenerating={state.isGenerating}
          isCompacting={state.isCompacting}
          debugEnabled={state.debugOpen}
          debugLogs={state.debugLogs}
          debugSession={state.debugSession}
          sessionTitle={state.activeSession?.title}
          queuedMessages={
            state.activeSessionId
              ? state.queuedMessagesBySession[state.activeSessionId] ?? []
              : []
          }
          onRemoveQueuedMessage={(messageId) => {
            if (!state.activeSessionId) {
              return
            }
            removeQueuedMessage(state.activeSessionId, messageId)
          }}
          getReadAloudButtonState={readAloudPlayer.buildButtonState}
          getSelectedTextReadAloudButtonState={readAloudPlayer.buildSelectedTextButtonState}
          selectionModeMessageId={activeSelection.selectionModeMessageId}
          pinnedSentenceKeysByMessageId={pinnedSentenceKeysByMessageId}
          onToggleSelectionMode={handleToggleSelectionMode}
          onToggleSentence={togglePinnedQuote}
          liveActivity={state.liveActivity}
          pendingCompaction={state.pendingCompaction}
          pendingToolApproval={state.pendingToolApproval}
          autoExpandActiveBlocks={false}
          topPaddingClass="pt-16"
          contentLayout={mainChatContentLayout}
        />
      )
    }

    const emptyStateSubheading = buildEmptyStateSubheading(
      state.activeSession,
      state.models,
    )

    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6">
        <p className="text-sm text-zinc-400">
          {state.activeSession
            ? 'Type a message to get started.'
            : 'Create or select a conversation to begin.'}
        </p>
        {emptyStateSubheading && (
          <p className="text-[11px] text-zinc-400/80 dark:text-zinc-500">
            {emptyStateSubheading}
          </p>
        )}
      </div>
    )
  }

  const refreshNotificationPermission = async () => {
    try {
      const next = await window.gemmaDesktopBridge.notifications.getPermissionState()
      setNotificationPermission(next)
    } catch (error) {
      console.error('Failed to inspect notification permission state:', error)
    }
  }

  const requestNotificationPermission = async () => {
    try {
      const next = await window.gemmaDesktopBridge.notifications.requestPermission()
      setNotificationPermission(next)
    } catch (error) {
      console.error('Failed to request notification permission:', error)
    }
  }

  const dismissNotificationPermissionPrompt = async () => {
    try {
      const next = await window.gemmaDesktopBridge.notifications.dismissPermissionPrompt()
      setNotificationPermission(next)
    } catch (error) {
      console.error('Failed to dismiss notification permission prompt:', error)
    }
  }

  const sendTestNotification = async () => {
    try {
      const result = await window.gemmaDesktopBridge.notifications.sendTest()
      if (!result.ok && result.reason === 'permission_default') {
        setNotificationPermission((current) => ({
          ...current,
          promptPending: true,
        }))
      }
    } catch (error) {
      console.error('Failed to send test notification:', error)
    }
  }

  useEffect(() => {
    void refreshNotificationPermission()
  }, [])

  useEffect(() => {
    void window.gemmaDesktopBridge.notifications
      .updateAttentionContext({
        currentView: state.currentView,
        activeSessionId: state.activeSessionId,
      })
      .catch((error) => {
        console.error('Failed to update notification attention context:', error)
      })
  }, [state.activeSessionId, state.currentView])

  useEffect(() => {
    const unsubActivate = window.gemmaDesktopBridge.notifications.onActivateTarget(
      (target) => {
        const activationTarget = target as NotificationActivationTarget
        if (activationTarget.kind === 'session') {
          dispatch({ type: 'SET_VIEW', view: 'chat' })
          setAssistantHomeVisible(false)
          setRightDockView(null)
          void selectSession(activationTarget.sessionId)
          return
        }

        dispatch({ type: 'SET_VIEW', view: 'automations' })
        setAssistantHomeVisible(false)
        setRightDockView('automations')
        void selectAutomation(activationTarget.automationId)
      },
    )

    const unsubPrompt = window.gemmaDesktopBridge.notifications.onPermissionPrompt(() => {
      setNotificationPermission((current) => ({
        ...current,
        promptPending: true,
      }))
      void refreshNotificationPermission()
    })

    return () => {
      unsubActivate()
      unsubPrompt()
    }
  }, [dispatch, selectAutomation, selectSession])

  useEffect(() => {
    return window.gemmaDesktopBridge.globalChat.onOpenInAppRequested(() => {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
      setAssistantHomeVisible(true)
      setGlobalComposerFocusKey((current) => current + 1)
    })
  }, [dispatch])

  useEffect(() => {
    if (!state.settingsOpen) {
      return
    }

    void refreshNotificationPermission()
  }, [state.settingsOpen])

  const ensureTargetModelReady = async (
    target: { modelId: string; runtimeId: string },
  ): Promise<boolean> => {
    const gemmaEntry = findGemmaCatalogEntryByTag(target.modelId)
    if (
      !gemmaEntry
      || target.runtimeId !== 'ollama-native'
      || !isGuidedGemmaMissing(
        state.models,
        target.modelId,
        state.gemmaInstallStates,
      )
    ) {
      return true
    }

    const result = await ensureGemmaModel(target.modelId)
    return result.ok
  }

  const switchActiveSessionModel = async (
    selection: { modelId: string; runtimeId: string },
  ): Promise<boolean> => {
    const ready = await ensureTargetModelReady(selection)
    if (!ready) {
      return false
    }

    if (
      state.activeSessionId
      && state.activeSession
      && !isBusy
      && (
        selection.modelId !== state.activeSession.modelId
        || selection.runtimeId !== state.activeSession.runtimeId
        || state.activeSession.usesTemporaryModelOverride
      )
    ) {
      await updateSession(state.activeSessionId, selection)
    }

    return true
  }

  const createConversationWithDefaults = async (workingDirectory: string) => {
    const normalizedWorkingDirectory = workingDirectory.trim()
    if (
      !normalizedWorkingDirectory
      || creatingSession
      || newConversationRunDisabledReason
    ) {
      return
    }

    const nextWorkMode =
      state.activeSession?.conversationKind === 'normal'
        ? state.activeSession.workMode
        : state.settings.defaultMode

    const target = resolveDefaultSessionModelTarget(
      state.models,
      nextWorkMode,
      state.gemmaInstallStates,
      state.settings.modelSelection,
    )

    setCreatingSession(true)
    try {
      const ready = await ensureTargetModelReady(target)
      if (!ready) {
        return
      }

      dispatch({ type: 'SET_VIEW', view: 'chat' })
      setAssistantHomeVisible(false)
      await createSession({
        modelId: target.modelId,
        runtimeId: target.runtimeId,
        conversationKind: 'normal',
        workMode: nextWorkMode,
        selectedToolIds: getDefaultSelectedSessionToolIds({
          chromeMcpEnabled: state.settings.tools.chromeMcp.enabled,
          chromeMcpDefaultSelected: state.settings.tools.chromeMcp.defaultSelected,
        }),
        workingDirectory: normalizedWorkingDirectory,
      })
    } catch (err) {
      console.error('Failed to create session:', err)
    } finally {
      setCreatingSession(false)
    }
  }

  const handleCreateProject = async () => {
    if (creatingSession) {
      return
    }

    const picked = await window.gemmaDesktopBridge.folders.pickDirectory(
      state.activeSession?.workingDirectory,
    )
    if (!picked) {
      return
    }

    const sessionToReopen = findReopenSessionForProject(
      state.sessions,
      state.sidebar,
      picked,
    )

    if (sessionToReopen) {
      dispatch({ type: 'SET_VIEW', view: 'chat' })
      setAssistantHomeVisible(false)

      try {
        await reopenProject(picked)
        await selectSession(sessionToReopen.id)
      } catch (error) {
        console.error('Failed to reopen project:', error)
      }
      return
    }

    await createConversationWithDefaults(picked)
  }

  const handleOpenProject = (projectPath: string) => {
    if (!projectPath.trim()) {
      return
    }

    void window.gemmaDesktopBridge.folders.openPath(projectPath)
  }

  const handleCloseProject = async (projectPath: string) => {
    const normalizedProjectPath = normalizeSidebarProjectPath(projectPath)
    if (!normalizedProjectPath) {
      return
    }

    try {
      const nextSidebar = await closeProject(normalizedProjectPath)
      const activeProjectPath = normalizeSidebarProjectPath(
        state.activeSession?.workingDirectory ?? '',
      )

      if (
        state.activeSessionId
        && activeProjectPath === normalizedProjectPath
      ) {
        const nextVisibleSessionId = buildSidebarModel(
          state.sessions,
          nextSidebar,
        ).visibleSessionIds[0] ?? null

        if (nextVisibleSessionId) {
          await selectSession(nextVisibleSessionId)
        } else {
          dispatch({ type: 'SET_ACTIVE_SESSION', session: null, id: null })
        }
      }
    } catch (error) {
      console.error('Failed to close project:', error)
    }
  }

  const conversationSupportCards = (
    <>
      {state.activeSession && state.pendingPlanQuestion && (
        <PlanQuestionCard
          question={state.pendingPlanQuestion}
          onAnswer={async (answer) => {
            await answerPlanQuestion(state.pendingPlanQuestion!.id, answer)
          }}
        />
      )}

      {state.activeSession
        && !state.pendingPlanQuestion
        && state.pendingPlanExit && (
          <PlanExecutionCard
            planExit={state.pendingPlanExit}
            busy={state.isGenerating || state.isCompacting}
            onExit={async (target) => {
              await exitPlanMode(target)
            }}
            onRevise={async (instructions) => {
              await revisePlanExit(instructions)
            }}
            onDismiss={async () => {
              await dismissPlanExit()
            }}
          />
        )}

      {state.activeSession && state.pendingToolApproval && (
        <ToolApprovalCard
          approval={state.pendingToolApproval}
          onResolve={async (approved) => {
            await resolveToolApproval(
              state.pendingToolApproval!.id,
              approved,
            )
          }}
        />
      )}
    </>
  )

  const handlePrimaryInputSend = useCallback(async (
    message: { text: string; attachments?: FileAttachment[] },
  ) => {
    const sessionId = state.activeSessionId
    const session = state.activeSession
    const previousAssistantIds = collectAssistantMessageIds(session?.messages ?? [])

    playAssistantNarration({
      phase: 'submission',
      userText: message.text,
      attachments: message.attachments,
      conversationTitle: session?.title,
      workingDirectory: session?.workingDirectory,
    })

    await sendMessage(message)

    if (!sessionId) {
      return
    }

    try {
      const detail = await window.gemmaDesktopBridge.sessions.get(sessionId)
      const assistantText = findLatestNewAssistantText(detail.messages, previousAssistantIds)
      if (!assistantText) {
        return
      }

      playAssistantNarration({
        phase: 'result',
        userText: message.text,
        attachments: message.attachments,
        assistantText,
        conversationTitle: detail.title,
        workingDirectory: detail.workingDirectory,
      })
    } catch (error) {
      console.warn('Failed to inspect completed turn for spoken summary:', error)
    }
  }, [
    playAssistantNarration,
    sendMessage,
    state.activeSession,
    state.activeSessionId,
  ])
  const primaryInputBar = state.activeSession ? (
    <InputBar
      sessionId={state.activeSession.id}
      focusRequestKey={mainComposerFocusKey}
      onSend={handlePrimaryInputSend}
      onRunShellCommand={runShellCommand}
      onCompact={compactSession}
      onClearHistory={clearActiveSessionHistory}
      onCancel={cancelGeneration}
      isGenerating={state.isGenerating}
      isCompacting={state.isCompacting}
      models={state.models}
      selectedModelId={state.activeSession.modelId}
      selectedRuntimeId={state.activeSession.runtimeId}
      selectedMode={activeMode}
      conversationKind={state.activeSession.conversationKind}
      planMode={activePlanMode}
      onSelectConversationMode={handleSelectConversationMode}
      onSelectModel={handleSelectConversationModel}
      modeChangeDisabled={isBusy || !state.activeSessionId}
      conversationRunDisabledReason={primaryConversationRunDisabledReason}
      busyQueueDisabledReason={primaryCoBrowseBusyQueueDisabledReason}
      messages={state.activeSession.messages}
      streamingContent={state.streamingContent}
      debugOpen={state.debugOpen}
      debugLogs={state.debugLogs}
      debugSession={state.debugSession}
      sessionTitle={state.activeSession.title}
      initialDraftText={state.activeSession.draftText}
      workingDirectory={state.activeSession.workingDirectory}
      sessionTools={availableSessionTools}
      selectedToolIds={state.activeSession.selectedToolIds}
      onToggleTool={(toolId, nextSelected) => {
        if (!state.activeSessionId || !state.activeSession) {
          return
        }

        const selectedToolIds = nextSelected
          ? Array.from(new Set([...state.activeSession.selectedToolIds, toolId]))
          : state.activeSession.selectedToolIds.filter((id) => id !== toolId)

        updateSession(state.activeSessionId, {
          selectedToolIds,
        }).catch((err) => {
          console.error('Failed to update selected session tools:', err)
        })
      }}
      onToggleDebug={() => dispatch({ type: 'TOGGLE_DEBUG' })}
      onShowSystemPrompt={() => setRightDockView('debug')}
      systemPromptPanelOpen={rightDockView === 'debug'}
      hasMessages={(state.activeSession?.messages.length ?? 0) > 0}
      sessionContext={sessionContext}
      liveActivity={state.liveActivity}
      pendingCompaction={state.pendingCompaction}
      enterToSend={state.settings.enterToSend}
      autoCompactEnabled={state.settings.compaction.autoCompactEnabled}
      autoCompactThresholdPercent={
        state.settings.compaction.autoCompactThresholdPercent
      }
      speechStatus={state.speechStatus}
      onInstallSpeech={installSpeech}
      onRepairSpeech={repairSpeech}
      onOpenSpeechSettings={() => openSettings('speech')}
      gemmaInstallStates={state.gemmaInstallStates}
      pinnedQuotes={activeSelection.pinnedQuotes}
      onRemovePinnedQuote={removePinnedQuote}
      onClearPinnedQuotes={clearPinnedQuotes}
      readAloudPlayback={readAloudPlayer.playbackControls}
      assistantNarrationMode={assistantNarrationMode}
      assistantNarrationAvailable={assistantNarrationAvailable}
      assistantNarrationDisabledReason={assistantNarrationDisabledReason}
      onToggleAssistantNarration={cycleAssistantNarrationMode}
      statusBarTarget={statusBarTarget}
      layout={mainChatContentLayout}
    />
  ) : null
  const handleGlobalChatInputSend = useCallback(async (
    message: { text: string; attachments?: FileAttachment[] },
  ) => {
    const sessionId = globalChatSession.sessionId
    const previousAssistantIds = collectAssistantMessageIds(globalChatDetail?.messages ?? [])

    playAssistantNarration({
      phase: 'submission',
      userText: message.text,
      attachments: message.attachments,
      conversationTitle: globalChatDetail?.title,
      workingDirectory: globalChatDetail?.workingDirectory,
    })

    await handleGlobalChatSend(message)

    if (!sessionId) {
      return
    }

    try {
      const detail = await window.gemmaDesktopBridge.sessions.get(sessionId)
      const assistantText = findLatestNewAssistantText(detail.messages, previousAssistantIds)
      if (!assistantText) {
        return
      }

      playAssistantNarration({
        phase: 'result',
        userText: message.text,
        attachments: message.attachments,
        assistantText,
        conversationTitle: detail.title,
        workingDirectory: detail.workingDirectory,
      })
    } catch (error) {
      console.warn('Failed to inspect completed Assistant Chat turn for spoken summary:', error)
    }
  }, [
    globalChatDetail,
    globalChatSession.sessionId,
    handleGlobalChatSend,
    playAssistantNarration,
  ])
  const globalChatInputBar = globalChatDetail ? (
    <InputBar
      sessionId={globalChatDetail.id}
      focusRequestKey={globalComposerFocusKey}
      onSend={handleGlobalChatInputSend}
      onRunShellCommand={handleRunGlobalChatShellCommand}
      onCompact={globalChatSession.compactSession}
      onClearHistory={globalChatSession.clearSession}
      onCancel={globalChatSession.cancelGeneration}
      isGenerating={globalChatSession.isGenerating}
      isCompacting={globalChatSession.isCompacting}
      models={state.models}
      selectedModelId={globalChatDetail.modelId}
      selectedRuntimeId={globalChatDetail.runtimeId}
      selectedMode={globalChatMode}
      conversationKind={globalChatDetail.conversationKind}
      planMode={globalChatPlanMode}
      onSelectConversationMode={handleSelectGlobalChatMode}
      onSelectModel={handleSelectGlobalChatModel}
      modeChangeDisabled={globalChatBusy || !globalChatSession.sessionId}
      conversationRunDisabledReason={globalConversationRunDisabledReason}
      busyQueueDisabledReason={globalCoBrowseBusyQueueDisabledReason}
      messages={globalChatDetail.messages}
      streamingContent={globalChatSession.streamingContent}
      debugOpen={false}
      debugLogs={[]}
      debugSession={null}
      sessionTitle={globalChatDetail.title}
      initialDraftText={globalChatDetail.draftText}
      workingDirectory={globalChatDetail.workingDirectory}
      sessionTools={globalChatSessionTools}
      selectedToolIds={globalChatDetail.selectedToolIds}
      onToggleTool={handleToggleGlobalChatTool}
      hasMessages={globalChatDetail.messages.length > 0}
      sessionContext={globalChatContext}
      liveActivity={globalChatSession.liveActivity}
      pendingCompaction={globalChatSession.pendingCompaction}
      enterToSend={state.settings.enterToSend}
      autoCompactEnabled={state.settings.compaction.autoCompactEnabled}
      autoCompactThresholdPercent={
        state.settings.compaction.autoCompactThresholdPercent
      }
      speechStatus={state.speechStatus}
      onInstallSpeech={installSpeech}
      onRepairSpeech={repairSpeech}
      onOpenSpeechSettings={() => openSettings('speech')}
      gemmaInstallStates={state.gemmaInstallStates}
      pinnedQuotes={globalChatPinnedQuotes}
      onRemovePinnedQuote={handleRemoveGlobalPinnedQuote}
      onClearPinnedQuotes={handleClearGlobalPinnedQuotes}
      readAloudPlayback={readAloudPlayer.playbackControls}
      presentation="floating"
    />
  ) : null
  const globalChatHomeHasConversation = Boolean(
    globalChatSession.loading
    || globalChatSession.error
    || globalChatSession.messages.length > 0
    || globalChatSession.streamingContent
    || globalQueuedMessages.length > 0,
  )
  const globalChatHomeStatusStartedAt = useMemo(() => {
    for (let i = globalChatSession.messages.length - 1; i >= 0; i -= 1) {
      const message = globalChatSession.messages[i]
      if (message?.role === 'user') {
        return message.timestamp
      }
    }

    return globalChatHomeStatusNow
  }, [globalChatHomeStatusNow, globalChatSession.messages])
  const globalChatHomeConversationSlot = globalChatSession.loading ? (
    <div className="flex h-full items-center justify-center px-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 text-sm text-zinc-200 shadow-sm backdrop-blur">
        <Loader2 size={14} className="animate-spin" />
        Loading Assistant Chat...
      </div>
    </div>
  ) : globalChatSession.error ? (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md rounded-3xl border border-red-300/30 bg-red-950/40 px-5 py-4 text-sm text-red-100 shadow-[0_24px_80px_-46px_rgba(248,113,113,0.55)] backdrop-blur">
        <div className="font-medium">Assistant Chat could not load.</div>
        <div className="mt-1 text-red-100/75">
          {globalChatSession.error}
        </div>
        <button
          type="button"
          onClick={() => {
            void globalChatSession.retry()
          }}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-200/30 px-3 py-2 text-xs font-medium text-red-50 transition-colors hover:bg-red-300/10"
        >
          Retry
        </button>
      </div>
    </div>
  ) : globalChatHomeHasConversation ? (
    <ChatCanvas
      sessionId={globalChatSession.sessionId}
      messages={globalChatSession.messages}
      streamingContent={globalChatSession.streamingContent}
      isGenerating={globalChatSession.isGenerating}
      isCompacting={globalChatSession.isCompacting}
      debugEnabled={false}
      debugLogs={[]}
      debugSession={null}
      sessionTitle={globalChatSession.title}
      queuedMessages={globalQueuedMessages}
      onRemoveQueuedMessage={handleRemoveGlobalQueuedMessage}
      getReadAloudButtonState={readAloudPlayer.buildButtonState}
      getSelectedTextReadAloudButtonState={readAloudPlayer.buildSelectedTextButtonState}
      selectionModeMessageId={globalChatSelectionModeMessageId}
      pinnedSentenceKeysByMessageId={globalPinnedSentenceKeysByMessageId}
      onToggleSelectionMode={handleToggleGlobalChatSelectionMode}
      onToggleSentence={handleToggleGlobalChatSentence}
      liveActivity={globalChatSession.liveActivity}
      pendingCompaction={globalChatSession.pendingCompaction}
      pendingToolApproval={globalChatSession.pendingToolApproval}
      autoExpandActiveBlocks={false}
      forceAutoScroll
      topPaddingClass="pt-4"
      contentLayout="expanded"
      streamingStatusPlacement="external"
    />
  ) : null
  const globalChatHomeConversationStatusSlot =
    globalChatHomeHasConversation && globalChatBusy ? (
      <StreamingStatus
        elapsedClock={formatElapsedClock(
          Math.max(globalChatHomeStatusNow - globalChatHomeStatusStartedAt, 0),
        )}
        activity={globalChatSession.liveActivity}
        className="assistant-chat-bottom-status"
      />
    ) : null
  const globalChatHomeSupportSlot = globalChatSession.pendingToolApproval ? (
    <div className="mb-3">
      <ToolApprovalCard
        approval={globalChatSession.pendingToolApproval}
        onResolve={async (approved) => {
          await globalChatSession.resolveToolApproval(
            globalChatSession.pendingToolApproval!.id,
            approved,
          )
        }}
      />
    </div>
  ) : null
  const globalChatSwitchBar = (
    <GlobalChatSwitchBar
      assistantHomeVisible={assistantHomeVisible}
      pinnedToDock={globalChatPinnedToDock}
      busy={globalChatBusy}
      coBrowseActive={coBrowseActive}
      onToggleHome={toggleAssistantHome}
      onTogglePin={toggleGlobalChatDockPin}
    />
  )
  const assistantHomeSurface = (
    <AssistantHome
      conversationSlot={globalChatHomeConversationSlot}
      conversationStatusSlot={globalChatHomeConversationStatusSlot}
      supportSlot={globalChatHomeSupportSlot}
      composerSlot={globalChatInputBar}
      coBrowseSlot={coBrowseActive ? projectBrowserPanel : undefined}
      readAloudSlot={
        <ReadAloudPlaybackOverlay
          controls={readAloudPlayer.playbackControls}
          className="pointer-events-auto mt-3"
        />
      }
      hasConversation={globalChatHomeHasConversation}
      busy={globalChatBusy}
      pinnedToDock={globalChatPinnedToDock}
      assistantNarrationMode={assistantNarrationMode}
      assistantNarrationAvailable={assistantNarrationAvailable}
      assistantNarrationDisabledReason={assistantNarrationDisabledReason}
      onWorkMode={enterWorkMode}
      onCoBrowse={enterCoBrowseMode}
      onExitCoBrowse={handleProjectBrowserClose}
      onTogglePin={toggleGlobalChatDockPin}
      onToggleAssistantNarration={cycleAssistantNarrationMode}
    />
  )

  const mainConversationColumn = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {renderMainConversationPane()}
      </div>
      {conversationSupportCards}
      {primaryInputBar}
      {terminalDrawerVisible && (
        <div className="px-6 pb-4">
          <div className="mx-auto w-full max-w-chat">
            <TerminalDrawer
              state={terminalDrawerState}
              expanded={terminalDrawerExpanded}
              onStart={startTerminalDrawer}
              onCollapse={() => setTerminalDrawerVisible(false)}
              onToggleExpanded={() => setTerminalDrawerExpanded((current) => !current)}
              onTerminate={handleTerminateTerminalDrawer}
            />
          </div>
        </div>
      )}
    </div>
  )

  if (!startupRiskAccepted) {
    return (
      <div className="relative flex h-full overflow-hidden">
        <StartupRiskDialog onAgree={() => setStartupRiskAccepted(true)} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full overflow-hidden">
      <AmbientMood
        isGenerating={state.isGenerating}
        enabled={state.settings.ambientEffects.enabled}
      />
      {/* Title bar drag region */}
      <div className="drag-region fixed inset-x-0 top-0 z-50 h-12" />

      {/* Zone 1: Sidebar */}
      <div
        className="relative flex-shrink-0 overflow-hidden"
        style={{ width: state.sidebarOpen ? sidebarResize.width : 0 }}
      >
        {/* Sidebar resize handle */}
        {state.sidebarOpen && (
          <div
            className="absolute right-0 top-0 z-[61] h-full w-1 cursor-col-resize select-none"
            {...sidebarResize.handleProps}
          />
        )}
        <Sidebar
          sessions={state.sessions}
          sidebarState={state.sidebar}
          activeSessionId={state.activeSessionId}
          onSelectSession={(sessionId) => {
            dispatch({ type: 'SET_VIEW', view: 'chat' })
            setAssistantHomeVisible(false)
            void selectSession(sessionId)
          }}
          onCreateProject={() => {
            void handleCreateProject()
          }}
          onCreateSessionInProject={(projectPath) => {
            void createConversationWithDefaults(projectPath)
          }}
          conversationCreationPending={creatingSession}
          onOpenProject={handleOpenProject}
          onCloseProject={(projectPath) => {
            void handleCloseProject(projectPath)
          }}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
          onCloseProcess={handleCloseBackgroundProcess}
          onPinSession={(sessionId) => {
            void pinSession(sessionId)
          }}
          onUnpinSession={(sessionId) => {
            void unpinSession(sessionId)
          }}
          onFlagFollowUp={(sessionId) => {
            void flagFollowUp(sessionId)
          }}
          onUnflagFollowUp={(sessionId) => {
            void unflagFollowUp(sessionId)
          }}
          onSetSessionTags={(sessionId, tags) => {
            void setSessionTags(sessionId, tags)
          }}
          onMovePinnedSession={(sessionId, toIndex) => {
            void movePinnedSession(sessionId, toIndex)
          }}
          onMoveProjectSession={(sessionId, toIndex) => {
            void setSessionOrder(sessionId, toIndex)
          }}
          onClearSessionOrder={(sessionId) => {
            void clearSessionOrder(sessionId)
          }}
          onMoveProject={(projectPath, toIndex) => {
            void setProjectOrder(projectPath, toIndex)
          }}
          onClearProjectOrder={(projectPath) => {
            void clearProjectOrder(projectPath)
          }}
          automations={state.automations}
          activeAutomationId={state.activeAutomationId}
          onSelectAutomation={(automationId) => {
            dispatch({ type: 'SET_VIEW', view: 'automations' })
            setAssistantHomeVisible(false)
            setRightDockView('automations')
            void selectAutomation(automationId)
          }}
          onNewAutomation={() => {
            openNewAutomationPanel()
          }}
          currentView={state.currentView}
          onOpenSettings={() => {
            openSettings('general')
          }}
          onOpenDoctor={() => setDoctorOpen(true)}
          doctorOpen={doctorOpen}
          preferredTerminalId={state.settings.terminal.preferredAppId}
          onOpenSkills={() => dispatch({ type: 'TOGGLE_SKILLS' })}
          selectedSkillCount={
            state.activeSession ? new Set(state.activeSession.selectedSkillIds).size : 0
          }
          onCollapse={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
          systemStats={state.systemStats}
          models={state.models}
          modelTokenUsage={state.modelTokenUsage}
          activeModelId={state.activeSession?.modelId ?? null}
          activeRuntimeId={state.activeSession?.runtimeId ?? null}
          helperModelId={state.bootstrapState.helperModelId}
          helperRuntimeId={state.bootstrapState.helperRuntimeId}
        />
      </div>

      {/* Main content area */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute right-0 top-1/2 z-[60] -translate-y-1/2">
          <div className="pointer-events-auto rounded-l-2xl border border-r-0 border-slate-200 bg-white/95 py-2 pl-2 pr-1 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
            <RightDockRail
              activeView={rightDockView}
              terminalActive={terminalDrawerVisible}
              terminalBusy={terminalDrawerBusy}
              browserAvailable
              badges={rightDockBadges}
              disabledViews={{ git: !rightDockGitAvailable }}
              onSelect={handleSelectRightDock}
              onToggleTerminal={handleToggleTerminalDrawer}
            />
          </div>
        </div>

        {/* Toggle sidebar button when collapsed */}
        {!state.sidebarOpen && (
          <button
            onClick={() => dispatch({ type: 'TOGGLE_SIDEBAR' })}
            className="no-drag fixed left-[76px] top-3.5 z-[60] rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Open sidebar"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {notificationPermission.promptPending
          && notificationPermission.status === 'default' && (
            <div className="bg-amber-50 px-5 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">
                    Gemma Desktop needs notification permission before it can alert you in the background.
                  </p>
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    Allow notifications to hear about finished automations, background session turns, and action-required pauses.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => {
                      void requestNotificationPermission()
                    }}
                    className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-600"
                  >
                    Allow Notifications
                  </button>
                  <button
                    onClick={() => {
                      openSettings('notifications')
                    }}
                    className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-900/50"
                  >
                    Review Settings
                  </button>
                  <button
                    onClick={() => {
                      void dismissNotificationPermissionPrompt()
                    }}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/50"
                  >
                    Not Now
                  </button>
                </div>
              </div>
            </div>
          )}

        <div
          ref={splitContainerRef}
          className={rightDockLayout.splitContainer}
        >
          <div className={rightDockLayout.mainPane}>
            {!assistantHomeVisible && globalChatSwitchBar}
            {mainConversationColumn}
          </div>
          {rightDockVisible && (
            <div
              className={rightDockLayout.rightPanel}
              style={{ width: rightDockResize.width }}
            >
              {/* Right dock resize handle */}
              <div
                className="absolute left-0 top-0 z-[61] h-full w-1 cursor-col-resize select-none"
                {...rightDockResize.handleProps}
              />
              <div className={rightDockLayout.rightPanelInner}>
                {renderRightDockPanel()}
              </div>
            </div>
          )}
        </div>
        {state.activeSession && (
          <div
            className={rightDockLayout.statusBar}
          >
            <div className={rightDockLayout.statusBarSurface}>
              <div
                ref={setStatusBarTarget}
                className={rightDockLayout.statusBarMain}
              />
            </div>
            {rightDockVisible && (
              <div
                className={rightDockLayout.statusBarSpacer}
                style={{ width: rightDockResize.width }}
              />
            )}
          </div>
        )}
      </div>

      {assistantHomeVisible && assistantHomeSurface}

      <SkillsModal
        open={state.skillsOpen}
        selectedSkillIds={Array.from(
          new Set(state.activeSession?.selectedSkillIds ?? []),
        )}
        installedSkills={state.installedSkills}
        onClose={() => dispatch({ type: 'TOGGLE_SKILLS' })}
        onToggleSkill={(skillId, nextSelected) => {
          if (!state.activeSessionId || !state.activeSession) {
            return
          }

          const selectedSkillIds = nextSelected
            ? Array.from(new Set([...state.activeSession.selectedSkillIds, skillId]))
            : state.activeSession.selectedSkillIds.filter((id) => id !== skillId)

          updateSession(state.activeSessionId, {
            selectedSkillIds,
          }).catch((err) => {
            console.error('Failed to update selected skills:', err)
          })
        }}
        onInstall={async (input) => {
          const skills = await installSkill(input)
          if (state.activeSessionId && state.activeSession) {
            try {
              await updateSession(state.activeSessionId, {
                selectedSkillIds: state.activeSession.selectedSkillIds,
              })
            } catch (err) {
              console.error('Failed to refresh session skills after install:', err)
            }
          }
          return skills
        }}
        onRemove={async (skillId) => {
          const skills = await removeSkill(skillId)
          if (state.activeSessionId && state.activeSession) {
            try {
              await updateSession(state.activeSessionId, {
                selectedSkillIds: state.activeSession.selectedSkillIds.filter(
                  (id) => id !== skillId,
                ),
              })
            } catch (err) {
              console.error('Failed to refresh session skills after removal:', err)
            }
          }
          return skills
        }}
      />

      {/* Zone 4: Settings Modal */}
      {state.settingsOpen && (
        <SettingsModal
          settings={state.settings}
          defaultModelSelection={ramAwareDefaultModelSelection}
          models={state.models}
          gemmaInstallStates={state.gemmaInstallStates}
          bootstrapState={state.bootstrapState}
          initialTab={settingsInitialTab}
          speechStatus={state.speechStatus}
          readAloudStatus={state.readAloudStatus}
          notificationPermission={notificationPermission}
          onEnsureGemmaModel={ensureGemmaModel}
          onInstallSpeech={installSpeech}
          onRepairSpeech={repairSpeech}
          onRemoveSpeech={removeSpeech}
          onTestReadAloud={readAloudPlayer.playTest}
          onRequestNotificationPermission={requestNotificationPermission}
          onSendTestNotification={sendTestNotification}
          onClose={() => dispatch({ type: 'SET_SETTINGS_OPEN', open: false })}
          onUpdate={async (patch) => {
            const updated = await window.gemmaDesktopBridge.settings.update(patch)
            dispatch({ type: 'SET_SETTINGS', settings: updated })
          }}
        />
      )}

      <DoctorPanel
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        onInstallSpeech={installSpeech}
        onRepairSpeech={repairSpeech}
        onOpenSettings={() => openSettings('speech')}
        onOpenVoiceSettings={() => openSettings('voice')}
        onTestReadAloud={readAloudPlayer.playTest}
      />

      <StartupLoadingOverlay
        bootstrap={state.bootstrapState}
        readAloudEnabled={state.settings.readAloud.enabled}
        readAloudStatus={state.readAloudStatus}
        dismissed={startupOverlayDismissed}
        onDismiss={() => setStartupOverlayDismissed(true)}
        onRetryBootstrap={() => {
          void window.gemmaDesktopBridge.environment.retryBootstrap().catch((error) => {
            console.error('Failed to retry model bootstrap:', error)
          })
        }}
      />
    </div>
  )
}
