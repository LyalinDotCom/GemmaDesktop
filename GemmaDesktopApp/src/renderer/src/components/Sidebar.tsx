import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Flag,
  FolderOpen,
  GripVertical,
  Loader2,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SmilePlus,
  SquareTerminal,
  Sparkles,
  Stethoscope,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { GpuWave } from '@/components/GpuWave'
import {
  MemoryStatusIndicator,
  MemoryStatusPanel,
} from '@/components/MemoryStatusIndicator'
import {
  basenameFromPath,
  buildSidebarModel,
  findActiveProjectForSession,
  type SessionIconGroup,
  type SessionProjectGroup,
} from '@/lib/sidebarModel'
import type {
  AppView,
  AutomationSummary,
  ModelSummary,
  ModelTokenUsageReport,
  SessionSearchResult,
  SessionSummary,
  SidebarState,
  SystemStats,
  TerminalAppInfo,
} from '@/types'
import type { LoadDefaultModelsResult } from '@shared/modelLifecycle'
import { normalizeConversationIcon } from '@shared/conversationIcon'

type SidebarSearchStatus = 'idle' | 'searching' | 'ready' | 'error'

const CONVERSATION_ICON_SUGGESTIONS = [
  { emoji: '⭐', words: 'star favorite important pinned' },
  { emoji: '🔥', words: 'fire hot urgent active' },
  { emoji: '🧪', words: 'test experiment lab regression' },
  { emoji: '🚀', words: 'rocket launch shipping release' },
  { emoji: '🧠', words: 'brain thinking research idea' },
  { emoji: '🛠️', words: 'tools build fix maintenance' },
  { emoji: '📚', words: 'docs documentation reading reference' },
  { emoji: '💬', words: 'chat conversation talk support' },
  { emoji: '🎯', words: 'target goal focus priority' },
  { emoji: '✅', words: 'done complete verified check' },
  { emoji: '⚙️', words: 'settings config runtime system' },
  { emoji: '🔒', words: 'security private locked auth' },
  { emoji: '📦', words: 'package release dependency bundle' },
  { emoji: '🌐', words: 'web browser network internet' },
  { emoji: '💡', words: 'idea insight note lightbulb' },
]

function normalizeIconInput(input: string): string {
  return normalizeConversationIcon(input) ?? ''
}

interface SidebarInitialSearchState {
  query: string
  status: SidebarSearchStatus
  results: SessionSearchResult[]
  errorMessage?: string | null
}

interface SidebarProps {
  sessions: SessionSummary[]
  sidebarState: SidebarState
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateProject: () => void
  onCreateSessionInProject: (path: string) => void
  conversationCreationPending?: boolean
  onOpenProject: (path: string) => void
  onCloseProject: (path: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, title: string, conversationIcon: string | null) => void
  onCloseProcess: (sessionId: string, terminalId: string) => void
  onPinSession: (id: string) => void
  onUnpinSession: (id: string) => void
  onFlagFollowUp: (id: string) => void
  onUnflagFollowUp: (id: string) => void
  onMovePinnedSession: (id: string, toIndex: number) => void
  onMoveProjectSession: (id: string, toIndex: number) => void
  onClearSessionOrder: (id: string) => void
  onMoveProject: (projectPath: string, toIndex: number) => void
  onClearProjectOrder: (projectPath: string) => void
  automations: AutomationSummary[]
  activeAutomationId: string | null
  onSelectAutomation: (id: string) => void
  onNewAutomation: () => void
  currentView: AppView
  modeToolbar?: ReactNode
  onOpenSettings: () => void
  onOpenDoctor: () => void
  doctorOpen?: boolean
  preferredTerminalId?: string | null
  onOpenSkills: () => void
  selectedSkillCount: number
  onCollapse?: () => void
  systemStats: SystemStats
  models: ModelSummary[]
  modelTokenUsage?: ModelTokenUsageReport
  activeModelId?: string | null
  activeRuntimeId?: string | null
  helperModelId?: string | null
  helperRuntimeId?: string | null
  reloadModelsDisabledReason?: string | null
  onReloadModels?: () => Promise<LoadDefaultModelsResult> | void
  initialSearchState?: SidebarInitialSearchState
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60_000)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`

  return new Date(timestamp).toLocaleDateString()
}

function automationStatusTone(status?: AutomationSummary['lastRunStatus']): string {
  switch (status) {
    case undefined:
      return 'bg-zinc-400'
    case 'running':
      return 'bg-amber-500'
    case 'success':
      return 'bg-emerald-500'
    case 'cancelled':
      return 'bg-zinc-500'
    case 'error':
      return 'bg-red-500'
  }
}

function buildProcessHoverText(
  command: string,
  workingDirectory: string,
  previewText: string,
): string {
  return [
    command,
    workingDirectory,
    previewText || 'No output recorded yet.',
  ].join('\n\n')
}

export function getSkillsButtonClassName(selectedSkillCount: number): string {
  if (selectedSkillCount > 0) {
    return 'relative rounded-lg border px-2 py-1.5 shadow-sm transition-all border-sky-200 bg-gradient-to-br from-sky-50 to-cyan-50 text-sky-700 hover:border-sky-300 hover:from-sky-100 hover:to-cyan-100 dark:border-sky-500/25 dark:bg-gradient-to-br dark:from-sky-950/70 dark:to-cyan-950/55 dark:text-sky-300 dark:hover:border-sky-400/35 dark:hover:from-sky-950/80 dark:hover:to-cyan-950/65'
  }

  return 'relative rounded-lg border px-2 py-1.5 shadow-sm transition-all border-cyan-200/80 bg-gradient-to-br from-cyan-50 to-teal-50 text-cyan-700 hover:border-cyan-300 hover:from-cyan-100 hover:to-teal-100 dark:border-cyan-500/20 dark:bg-gradient-to-br dark:from-cyan-950/65 dark:to-teal-950/55 dark:text-cyan-300 dark:hover:border-cyan-400/30 dark:hover:from-cyan-950/80 dark:hover:to-teal-950/70'
}

export function Sidebar({
  sessions,
  sidebarState,
  activeSessionId,
  onSelectSession,
  onCreateProject,
  onCreateSessionInProject,
  conversationCreationPending = false,
  onOpenProject,
  onCloseProject,
  onDeleteSession,
  onRenameSession,
  onCloseProcess,
  onPinSession,
  onUnpinSession,
  onFlagFollowUp,
  onUnflagFollowUp,
  onMovePinnedSession,
  onMoveProjectSession,
  onClearSessionOrder,
  onMoveProject,
  onClearProjectOrder,
  automations,
  activeAutomationId,
  onSelectAutomation,
  onNewAutomation,
  currentView,
  modeToolbar,
  onOpenSettings,
  onOpenDoctor,
  doctorOpen = false,
  preferredTerminalId = null,
  onOpenSkills,
  selectedSkillCount,
  onCollapse,
  systemStats,
  models,
  modelTokenUsage,
  activeModelId = null,
  activeRuntimeId = null,
  helperModelId = null,
  helperRuntimeId = null,
  reloadModelsDisabledReason = null,
  onReloadModels,
  initialSearchState,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string
    x: number
    y: number
  } | null>(null)
  const [installedTerminals, setInstalledTerminals] = useState<TerminalAppInfo[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmCloseProject, setConfirmCloseProject] = useState<{
    path: string
    name: string
  } | null>(null)
  const [quickCreateMenuPinned, setQuickCreateMenuPinned] = useState(false)
  const [modelMemoryPanelOpen, setModelMemoryPanelOpen] = useState(false)
  const [modelReloadPending, setModelReloadPending] = useState(false)
  const [renameDialog, setRenameDialog] = useState<{
    sessionId: string
    title: string
    icon: string
  } | null>(null)
  const [renameIconSearch, setRenameIconSearch] = useState('')
  const [expandedIcon, setExpandedIcon] = useState<string | null>(null)
  const [draggedPinnedSessionId, setDraggedPinnedSessionId] = useState<string | null>(null)
  const [pinnedDropTarget, setPinnedDropTarget] = useState<{
    sessionId: string
    placement: 'before' | 'after'
  } | null>(null)
  const [draggedProjectSession, setDraggedProjectSession] = useState<{
    sessionId: string
    projectKey: string
  } | null>(null)
  const [projectSessionDropTarget, setProjectSessionDropTarget] = useState<{
    projectKey: string
    sessionId: string
    placement: 'before' | 'after'
  } | null>(null)
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null)
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectKey: string
    placement: 'before' | 'after'
  } | null>(null)
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const [searchQuery, setSearchQuery] = useState(initialSearchState?.query ?? '')
  const [searchStatus, setSearchStatus] = useState<SidebarSearchStatus>(
    initialSearchState?.status ?? 'idle',
  )
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>(
    initialSearchState?.results ?? [],
  )
  const [searchErrorMessage, setSearchErrorMessage] = useState<string | null>(
    initialSearchState?.errorMessage ?? null,
  )
  const renameTitleInputRef = useRef<HTMLInputElement>(null)
  const renameIconInputRef = useRef<HTMLInputElement>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const sessionRequestRunning = sessions.some(
    (session) => session.isGenerating || session.isCompacting,
  )
  const effectiveReloadModelsDisabledReason =
    reloadModelsDisabledReason
    ?? (sessionRequestRunning
      ? 'Finish or stop the running request before reloading models.'
      : null)
  const searchRequestRef = useRef(0)

  const sidebarModel = useMemo(
    () => buildSidebarModel(sessions, sidebarState),
    [sessions, sidebarState],
  )
  const pinnedSessionIds = useMemo(
    () => new Set(sidebarState.pinnedSessionIds),
    [sidebarState.pinnedSessionIds],
  )
  const followUpSessionIds = useMemo(
    () => new Set(sidebarState.followUpSessionIds),
    [sidebarState.followUpSessionIds],
  )
  const activeProject = useMemo(
    () => findActiveProjectForSession(sessions, activeSessionId),
    [sessions, activeSessionId],
  )
  const visibleSessionIdsKey = useMemo(
    () => sidebarModel.visibleSessionIds.join('\u001f'),
    [sidebarModel.visibleSessionIds],
  )
  const expandedIconGroup =
    expandedIcon
      ? sidebarModel.iconGroups.find((group) => group.icon === expandedIcon) ?? null
      : null
  const hasActiveSearch = currentView === 'chat' && searchQuery.trim().length > 0

  useEffect(() => {
    if (renameDialog && renameTitleInputRef.current) {
      renameTitleInputRef.current.focus()
      renameTitleInputRef.current.select()
    }
  }, [renameDialog?.sessionId])

  useEffect(() => {
    if (
      expandedIcon
      && !sidebarModel.iconGroups.some((group) => group.icon === expandedIcon)
    ) {
      setExpandedIcon(null)
    }
  }, [expandedIcon, sidebarModel.iconGroups])

  useEffect(() => {
    const handler = () => {
      setContextMenu(null)
      setQuickCreateMenuPinned(false)
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    if (currentView !== 'chat' && quickCreateMenuPinned) {
      setQuickCreateMenuPinned(false)
    }
  }, [currentView, quickCreateMenuPinned])

  useEffect(() => {
    let cancelled = false

    void window.gemmaDesktopBridge.terminals.listInstalled()
      .then((terminals) => {
        if (!cancelled) {
          setInstalledTerminals(terminals)
        }
      })
      .catch((error) => {
        console.error('Failed to inspect installed terminals:', error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
      }
      searchRequestRef.current += 1
    },
    [],
  )

  useEffect(() => {
    if (currentView !== 'chat') {
      return
    }

    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }

    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      searchRequestRef.current += 1
      setSearchStatus('idle')
      setSearchResults([])
      setSearchErrorMessage(null)
      return
    }

    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    setSearchStatus('searching')
    setSearchResults([])
    setSearchErrorMessage(null)

    searchTimeoutRef.current = window.setTimeout(() => {
      void window.gemmaDesktopBridge.sessions.search({
        query: trimmedQuery,
        sessionIds: sidebarModel.visibleSessionIds,
      })
        .then((results) => {
          if (requestId !== searchRequestRef.current) {
            return
          }

          setSearchResults(results)
          setSearchStatus('ready')
        })
        .catch((error) => {
          if (requestId !== searchRequestRef.current) {
            return
          }

          setSearchResults([])
          setSearchStatus('error')
          setSearchErrorMessage(
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : 'Search failed.',
          )
        })
    }, 250)

    return () => {
      if (searchTimeoutRef.current !== null) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
    }
  }, [currentView, searchQuery, sidebarModel.visibleSessionIds, visibleSessionIdsKey])

  const clearSearch = () => {
    if (searchTimeoutRef.current !== null) {
      window.clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }
    searchRequestRef.current += 1
    setSearchQuery('')
    setSearchStatus('idle')
    setSearchResults([])
    setSearchErrorMessage(null)
  }

  const createActionLabel =
    currentView === 'automations'
      ? 'Create a new automation'
      : null
  const createActionHint =
    currentView === 'automations'
      ? 'Set up a scheduled workflow'
      : null
  const quickCreateConversationDisabled =
    conversationCreationPending || activeProject === null
  const quickCreateConversationTitle = activeProject
    ? conversationCreationPending
      ? `Creating conversation in ${activeProject.name}`
      : `Add conversation to ${activeProject.name}`
    : 'Open a project before adding a conversation'
  const quickCreateConversationHint = activeProject
    ? activeProject.name
    : 'No project selected'
  const quickCreateMenuClassName = quickCreateMenuPinned
    ? 'pointer-events-auto translate-y-0 opacity-100'
    : 'pointer-events-none translate-y-1 opacity-0 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100'
  const filteredConversationIcons = useMemo(() => {
    const query = renameIconSearch.trim().toLowerCase()
    if (!query) {
      return CONVERSATION_ICON_SUGGESTIONS
    }
    return CONVERSATION_ICON_SUGGESTIONS.filter((entry) =>
      entry.emoji.includes(query) || entry.words.includes(query),
    )
  }, [renameIconSearch])

  const updateRenameIconDraft = (value: string) => {
    setRenameDialog((current) =>
      current ? { ...current, icon: normalizeIconInput(value) } : current,
    )
  }

  const openSystemEmojiPanel = () => {
    renameIconInputRef.current?.focus()
    renameIconInputRef.current?.select()
    void window.gemmaDesktopBridge.system.openEmojiPanel().catch((error) => {
      console.error('Failed to open emoji picker:', error)
    })
  }

  const handleReloadModels = async () => {
    if (!onReloadModels || modelReloadPending || effectiveReloadModelsDisabledReason) {
      return
    }

    setModelReloadPending(true)
    try {
      await onReloadModels()
    } catch (error) {
      console.error('Failed to reload models:', error)
    } finally {
      setModelReloadPending(false)
    }
  }

  const startRenamingSession = (session: SessionSummary) => {
    setRenameDialog({
      sessionId: session.id,
      title: session.title,
      icon: session.conversationIcon ?? '',
    })
    setRenameIconSearch('')
    setContextMenu(null)
  }

  const saveRenameDialog = () => {
    if (!renameDialog) {
      return
    }

    const title = renameDialog.title.trim()
    if (!title) {
      return
    }

    onRenameSession(
      renameDialog.sessionId,
      title,
      normalizeIconInput(renameDialog.icon) || null,
    )
    setRenameDialog(null)
    setRenameIconSearch('')
  }

  const confirmDeleteSession = (sessionId: string) => {
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session || session.isGenerating || session.isCompacting) {
      setContextMenu(null)
      return
    }

    setConfirmDeleteId(sessionId)
    setContextMenu(null)
  }

  const contextSession = contextMenu
    ? sessions.find((session) => session.id === contextMenu.sessionId) ?? null
    : null
  const contextSessionPinned = contextSession ? pinnedSessionIds.has(contextSession.id) : false
  const contextSessionFollowUp = contextSession ? followUpSessionIds.has(contextSession.id) : false
  const canDeleteContextSession =
    contextMenu?.sessionId !== undefined
    && contextSession !== null
    && !contextSession.isGenerating
    && !contextSession.isCompacting

  const clearPinnedDragState = () => {
    setDraggedPinnedSessionId(null)
    setPinnedDropTarget(null)
  }

  const handlePinnedDragStart = (
    event: DragEvent<HTMLButtonElement>,
    sessionId: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
    setDraggedPinnedSessionId(sessionId)
  }

  const updatePinnedDropTarget = (
    event: DragEvent<HTMLDivElement>,
    sessionId: string,
  ) => {
    if (!draggedPinnedSessionId || draggedPinnedSessionId === sessionId) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setPinnedDropTarget({ sessionId, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handlePinnedDrop = (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string,
  ) => {
    event.preventDefault()

    const sourceSessionId =
      draggedPinnedSessionId || event.dataTransfer.getData('text/plain')
    if (!sourceSessionId || sourceSessionId === targetSessionId) {
      clearPinnedDragState()
      return
    }

    const sourceIndex = sidebarModel.pinnedSessions.findIndex(
      (session) => session.id === sourceSessionId,
    )
    const targetIndex = sidebarModel.pinnedSessions.findIndex(
      (session) => session.id === targetSessionId,
    )

    if (sourceIndex === -1 || targetIndex === -1) {
      clearPinnedDragState()
      return
    }

    const placement =
      pinnedDropTarget?.sessionId === targetSessionId
        ? pinnedDropTarget.placement
        : 'after'
    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex

    onMovePinnedSession(sourceSessionId, nextIndex)
    clearPinnedDragState()
  }

  const clearProjectSessionDragState = () => {
    setDraggedProjectSession(null)
    setProjectSessionDropTarget(null)
  }

  const handleProjectSessionDragStart = (
    event: DragEvent<HTMLButtonElement>,
    sessionId: string,
    projectKey: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
    setDraggedProjectSession({ sessionId, projectKey })
  }

  const updateProjectSessionDropTarget = (
    event: DragEvent<HTMLDivElement>,
    sessionId: string,
    projectKey: string,
  ) => {
    if (!draggedProjectSession) {
      return
    }
    if (draggedProjectSession.projectKey !== projectKey) {
      return
    }
    if (draggedProjectSession.sessionId === sessionId) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setProjectSessionDropTarget({ projectKey, sessionId, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handleProjectSessionDrop = (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string,
    projectKey: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const dragged = draggedProjectSession
    if (!dragged || dragged.projectKey !== projectKey) {
      clearProjectSessionDragState()
      return
    }

    const sourceSessionId = dragged.sessionId || event.dataTransfer.getData('text/plain')
    if (!sourceSessionId || sourceSessionId === targetSessionId) {
      clearProjectSessionDragState()
      return
    }

    const group = sidebarModel.projectGroups.find((entry) => entry.key === projectKey)
    if (!group) {
      clearProjectSessionDragState()
      return
    }

    const sourceIndex = group.sessions.findIndex((session) => session.id === sourceSessionId)
    const targetIndex = group.sessions.findIndex((session) => session.id === targetSessionId)
    if (sourceIndex === -1 || targetIndex === -1) {
      clearProjectSessionDragState()
      return
    }

    const placement =
      projectSessionDropTarget?.projectKey === projectKey
      && projectSessionDropTarget.sessionId === targetSessionId
        ? projectSessionDropTarget.placement
        : 'after'

    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex
    const clampedIndex = Math.max(0, Math.min(group.sessions.length - 1, nextIndex))

    onMoveProjectSession(sourceSessionId, clampedIndex)
    clearProjectSessionDragState()
  }

  const clearProjectDragState = () => {
    setDraggedProjectKey(null)
    setProjectDropTarget(null)
  }

  const handleProjectDragStart = (
    event: DragEvent<HTMLButtonElement>,
    projectKey: string,
  ) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectKey)
    setDraggedProjectKey(projectKey)
  }

  const updateProjectDropTarget = (
    event: DragEvent<HTMLDivElement>,
    projectKey: string,
  ) => {
    if (!draggedProjectKey || draggedProjectKey === projectKey) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const placement =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'

    setProjectDropTarget({ projectKey, placement })
    event.dataTransfer.dropEffect = 'move'
  }

  const handleProjectDrop = (
    event: DragEvent<HTMLDivElement>,
    targetProjectKey: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()

    const sourceProjectKey =
      draggedProjectKey || event.dataTransfer.getData('text/plain')
    if (!sourceProjectKey || sourceProjectKey === targetProjectKey) {
      clearProjectDragState()
      return
    }

    const sourceIndex = sidebarModel.projectGroups.findIndex(
      (group) => group.key === sourceProjectKey,
    )
    const targetIndex = sidebarModel.projectGroups.findIndex(
      (group) => group.key === targetProjectKey,
    )
    if (sourceIndex === -1 || targetIndex === -1) {
      clearProjectDragState()
      return
    }

    const sourceGroup = sidebarModel.projectGroups[sourceIndex]
    if (!sourceGroup || !sourceGroup.path) {
      clearProjectDragState()
      return
    }

    const placement =
      projectDropTarget?.projectKey === targetProjectKey
        ? projectDropTarget.placement
        : 'after'

    const rawIndex = placement === 'before' ? targetIndex : targetIndex + 1
    const nextIndex = sourceIndex < rawIndex ? rawIndex - 1 : rawIndex
    const clampedIndex = Math.max(
      0,
      Math.min(sidebarModel.projectGroups.length - 1, nextIndex),
    )

    onMoveProject(sourceGroup.path, clampedIndex)
    clearProjectDragState()
  }

  const preferredTerminal = (
    installedTerminals.find((terminal) => terminal.id === preferredTerminalId)
    ?? installedTerminals[0]
    ?? null
  )

  const renderSessionRow = (
    session: SessionSummary,
    options?: {
      inPinnedSection?: boolean
      inIconSection?: boolean
      projectKey?: string
    },
  ) => {
    const inPinnedSection = options?.inPinnedSection === true
    const inIconSection = options?.inIconSection === true
    const projectKey = options?.projectKey ?? null
    const isActiveSession = session.id === activeSessionId
    const isSessionRunning = session.isGenerating || session.isCompacting
    const isPinnedSession = pinnedSessionIds.has(session.id)
    const canDeleteSession = !isSessionRunning
    const hoverActionVisible = inPinnedSection || canDeleteSession || true
    const runningProcesses =
      !inPinnedSection && !inIconSection && session.runningProcesses
        ? session.runningProcesses
        : []
    const projectDropMatch =
      !inPinnedSection
      && !inIconSection
      && projectKey
      && projectSessionDropTarget?.projectKey === projectKey
      && projectSessionDropTarget.sessionId === session.id
        ? projectSessionDropTarget
        : null
    const dropIndicatorClass = inPinnedSection
      ? pinnedDropTarget?.sessionId === session.id
        ? pinnedDropTarget.placement === 'before'
          ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
          : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
        : ''
      : projectDropMatch
        ? projectDropMatch.placement === 'before'
          ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
          : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
        : ''
    const hasSessionOrderOverride = Boolean(
      sidebarState.sessionOrderOverrides
      && session.id in sidebarState.sessionOrderOverrides,
    )
    const rowKind = inPinnedSection ? 'pinned' : inIconSection ? 'icon' : 'project'

    return (
      <div key={`${rowKind}-${session.id}`}>
        <div
          onClick={() => onSelectSession(session.id)}
          onDoubleClick={() => startRenamingSession(session)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelectSession(session.id)
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setContextMenu({
              sessionId: session.id,
              x: event.clientX,
              y: event.clientY,
            })
          }}
          onDragOver={
            inPinnedSection
              ? (event) => updatePinnedDropTarget(event, session.id)
              : projectKey
                ? (event) => updateProjectSessionDropTarget(event, session.id, projectKey)
                : undefined
          }
          onDrop={
            inPinnedSection
              ? (event) => handlePinnedDrop(event, session.id)
              : projectKey
                ? (event) => handleProjectSessionDrop(event, session.id, projectKey)
                : undefined
          }
          role="button"
          tabIndex={0}
          className={`group relative flex items-center gap-2 rounded-xl py-2 pr-2 transition-colors focus:outline-none ${
            inPinnedSection || inIconSection ? 'pl-3' : 'pl-6'
          } ${
            isActiveSession
              ? 'bg-zinc-900/[0.09] dark:bg-white/[0.09]'
              : 'hover:bg-zinc-900/[0.035] dark:hover:bg-white/[0.04]'
          } ${dropIndicatorClass} ${isSessionRunning ? 'sidebar-session-running' : ''}`}
          aria-current={isActiveSession ? 'true' : undefined}
        >
          {inPinnedSection ? (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handlePinnedDragStart(event, session.id)}
              onDragEnd={clearPinnedDragState}
              className="cursor-grab rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 active:cursor-grabbing dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Drag to reorder pinned chats"
              aria-label={`Reorder pinned chat ${session.title}`}
            >
              <GripVertical size={13} />
            </button>
          ) : projectKey ? (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handleProjectSessionDragStart(event, session.id, projectKey)}
              onDragEnd={clearProjectSessionDragState}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (hasSessionOrderOverride) {
                  onClearSessionOrder(session.id)
                }
              }}
              className={`pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 cursor-grab rounded-md p-0.5 opacity-0 transition-opacity hover:bg-zinc-200 active:cursor-grabbing group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 dark:hover:bg-zinc-800 ${
                hasSessionOrderOverride
                  ? 'text-cyan-500/80 hover:text-cyan-600 dark:text-cyan-400/80 dark:hover:text-cyan-300'
                  : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
              title={
                hasSessionOrderOverride
                  ? 'Drag to reorder · double-click to reset to default'
                  : 'Drag to reorder'
              }
              aria-label={`Reorder ${session.title}`}
            >
              <GripVertical size={12} />
            </button>
          ) : null}

          <>
            {followUpSessionIds.has(session.id) && (
              <Flag size={12} className="flex-shrink-0 text-amber-500/70 dark:text-amber-400/60" />
            )}
            {session.conversationIcon && (
              <span
                className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-sm leading-none"
                title="Conversation icon"
                role="img"
                aria-label={`Conversation icon ${session.conversationIcon}`}
              >
                {session.conversationIcon}
              </span>
            )}
            <div className="min-w-0 flex flex-1 items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-[15px] ${
                    isActiveSession
                      ? 'font-medium text-zinc-950 dark:text-zinc-50'
                      : 'text-zinc-700 dark:text-zinc-300'
                  }`}
                  title={session.title}
                >
                  {session.title}
                </span>
                {session.conversationKind === 'research' && (
                  <span
                    className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300"
                    title="Research conversation"
                  >
                    <Sparkles size={9} />
                    Research
                  </span>
                )}
              </div>

              <div className={`relative h-5 flex-shrink-0 ${inPinnedSection ? 'w-[52px]' : 'w-[88px]'}`}>
                <span
                  className={`absolute inset-0 flex items-center justify-end text-right text-xs text-zinc-400 dark:text-zinc-600 ${
                    hoverActionVisible
                      ? 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0'
                      : ''
                  }`}
                >
                  {formatRelativeTime(session.updatedAt)}
                </span>

                {inPinnedSection ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-end opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onUnpinSession(session.id)
                      }}
                      title="Unpin conversation"
                      aria-label={`Unpin ${session.title}`}
                      className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <PinOff size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (isPinnedSession) {
                          onUnpinSession(session.id)
                        } else {
                          onPinSession(session.id)
                        }
                      }}
                      title={isPinnedSession ? 'Unpin conversation' : 'Pin conversation'}
                      aria-label={isPinnedSession ? `Unpin ${session.title}` : `Pin ${session.title}`}
                      className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      {isPinnedSession ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    {canDeleteSession && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          confirmDeleteSession(session.id)
                        }}
                        title="Delete conversation"
                        aria-label={`Delete ${session.title}`}
                        className="rounded p-1 text-zinc-500 transition-colors hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
          </>
        </div>

        {runningProcesses.length > 0 && (
          <div className="ml-9 mt-1.5 space-y-1.5 pb-1">
            {runningProcesses.map((process) => (
              <div
                key={process.terminalId}
                className="group/process flex items-start gap-2 rounded-lg border border-l-4 border-emerald-200 border-l-emerald-500 bg-emerald-50/90 px-2.5 py-2 text-[11px] text-emerald-950 shadow-sm dark:border-emerald-900/70 dark:border-l-emerald-400 dark:bg-emerald-950/30 dark:text-emerald-50"
                title={buildProcessHoverText(
                  process.command,
                  process.workingDirectory,
                  process.previewText,
                )}
              >
                <SquareTerminal size={12} className="mt-0.5 flex-shrink-0 text-emerald-700 dark:text-emerald-300" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-200">
                    <Loader2 size={10} className="animate-spin" />
                    <span className="uppercase tracking-[0.14em]">
                      Live process
                    </span>
                  </div>
                  <div className="truncate font-mono text-zinc-900 dark:text-zinc-100">
                    {process.command}
                  </div>
                  {process.previewText && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-emerald-800/75 dark:text-emerald-100/75">
                      {process.previewText}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseProcess(session.id, process.terminalId)
                  }}
                  className="rounded p-0.5 text-emerald-700/80 transition-colors hover:bg-emerald-100 hover:text-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900/50 dark:hover:text-white"
                  aria-label={`Terminate process ${process.command}`}
                  title="Terminate process"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const renderIconButton = (group: SessionIconGroup) => {
    const active = expandedIcon === group.icon
    return (
      <button
        key={group.icon}
        type="button"
        onClick={() => setExpandedIcon((current) =>
          current === group.icon ? null : group.icon,
        )}
        className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-base leading-none transition-colors ${
          active
            ? 'bg-zinc-900/[0.08] text-zinc-950 ring-1 ring-zinc-900/10 dark:bg-white/[0.11] dark:text-zinc-50 dark:ring-white/10'
            : 'text-zinc-500 hover:bg-zinc-900/[0.045] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100'
        }`}
        title={`${group.sessions.length} conversation${group.sessions.length === 1 ? '' : 's'}`}
        aria-label={`Show ${group.icon} conversations`}
        aria-pressed={active}
      >
        <span role="img" aria-hidden="true">{group.icon}</span>
        <span className="ml-1.5 text-[10px] font-medium leading-none text-zinc-400 dark:text-zinc-500">
          {group.sessions.length}
        </span>
      </button>
    )
  }

  const renderPinnedAndIcons = () => (
    <section className="mb-4">
      <div className="mb-1 flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400 dark:text-zinc-500">
        <Pin size={12} />
        <span className="min-w-0 flex-1">PINNED</span>
      </div>

      {sidebarModel.pinnedSessions.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {sidebarModel.pinnedSessions.map((session) =>
            renderSessionRow(session, { inPinnedSection: true }),
          )}
        </div>
      )}

      {sidebarModel.iconGroups.length > 0 && (
        <div className="space-y-1.5">
          <div
            className="flex flex-wrap items-center gap-1 px-2"
            aria-label="Conversation icons"
          >
            {sidebarModel.iconGroups.map((group) => renderIconButton(group))}
          </div>
          {expandedIconGroup && (
            <div className="space-y-0.5 border-t border-zinc-200/70 pt-1.5 dark:border-zinc-800">
              {expandedIconGroup.sessions.map((session) =>
                renderSessionRow(session, { inIconSection: true }),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )

  const renderProjectGroup = (group: SessionProjectGroup) => {
    const projectBusy = group.sessions.some(
      (session) => session.isGenerating || session.isCompacting,
    )
    const isCollapsed = collapsedProjectKeys.has(group.key)
    const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown
    const isProjectDraggable = group.path.length > 0
    const projectDropMatch =
      projectDropTarget?.projectKey === group.key ? projectDropTarget : null
    const projectDropClass = projectDropMatch
      ? projectDropMatch.placement === 'before'
        ? 'shadow-[inset_0_2px_0_0_rgba(14,165,233,0.95)]'
        : 'shadow-[inset_0_-2px_0_0_rgba(14,165,233,0.95)]'
      : ''
    const hasProjectOrderOverride = Boolean(
      group.path.length > 0
      && sidebarState.projectOrderOverrides
      && group.path in sidebarState.projectOrderOverrides,
    )

    return (
      <section key={group.key} className="mb-4">
        <div
          className={`group/project relative mb-1 flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm font-medium text-zinc-700 transition-colors dark:text-zinc-200 ${projectDropClass}`}
          title={group.path || 'No project folder selected'}
          onClick={() => {
            setCollapsedProjectKeys((prev) => {
              const next = new Set(prev)
              if (next.has(group.key)) {
                next.delete(group.key)
              } else {
                next.add(group.key)
              }
              return next
            })
          }}
          onDragOver={
            isProjectDraggable
              ? (event) => updateProjectDropTarget(event, group.key)
              : undefined
          }
          onDrop={
            isProjectDraggable
              ? (event) => handleProjectDrop(event, group.key)
              : undefined
          }
          aria-expanded={!isCollapsed}
        >
          {isProjectDraggable && (
            <button
              type="button"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => handleProjectDragStart(event, group.key)}
              onDragEnd={clearProjectDragState}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (hasProjectOrderOverride) {
                  onClearProjectOrder(group.path)
                }
              }}
              className={`pointer-events-none absolute -left-0.5 top-1/2 -translate-y-1/2 cursor-grab rounded-md p-0.5 opacity-0 transition-opacity hover:bg-zinc-200 active:cursor-grabbing group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 dark:hover:bg-zinc-800 ${
                hasProjectOrderOverride
                  ? 'text-cyan-500/80 hover:text-cyan-600 dark:text-cyan-400/80 dark:hover:text-cyan-300'
                  : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
              title={
                hasProjectOrderOverride
                  ? 'Drag to reorder project · double-click to reset to default'
                  : 'Drag to reorder project'
              }
              aria-label={`Reorder project ${group.name}`}
            >
              <GripVertical size={12} />
            </button>
          )}
          <ChevronIcon
            size={14}
            className="flex-shrink-0 text-zinc-400 dark:text-zinc-500"
          />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          <div className="ml-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onCreateSessionInProject(group.path)
              }}
              disabled={conversationCreationPending || !group.path.trim()}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                group.path
                  ? `Add conversation to ${group.name}`
                  : 'No project folder selected'
              }
              aria-label={
                group.path
                  ? `Add conversation to ${group.name}`
                  : 'No project folder selected'
              }
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                if (group.path.trim()) {
                  onOpenProject(group.path)
                }
              }}
              disabled={!group.path.trim()}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                group.path
                  ? `Open ${group.name} in Finder`
                  : 'No project folder selected'
              }
              aria-label={
                group.path
                  ? `Open ${group.name} in Finder`
                  : 'No project folder selected'
              }
            >
              <FolderOpen size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                void window.gemmaDesktopBridge.terminals.openDirectory({
                  directoryPath: group.path,
                  terminalId: preferredTerminal?.id,
                }).catch((error) => {
                  console.error('Failed to open project in terminal:', error)
                })
              }}
              disabled={!group.path.trim() || preferredTerminal === null}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                preferredTerminal
                  ? `Open ${group.name} in ${preferredTerminal.label}`
                  : 'No supported terminal app detected'
              }
              aria-label={
                preferredTerminal
                  ? `Open ${group.name} in ${preferredTerminal.label}`
                  : 'No supported terminal app detected'
              }
            >
              <SquareTerminal size={13} />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setConfirmCloseProject({
                  path: group.path,
                  name: group.name,
                })
              }}
              disabled={!group.path.trim() || projectBusy}
              className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={
                projectBusy
                  ? 'Stop active conversations before closing this project'
                  : 'Close project'
              }
              aria-label="Close project"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {!isCollapsed && (
          <div className="space-y-0.5">
            {group.sessions.map((session) =>
              renderSessionRow(session, { projectKey: group.key }),
            )}
          </div>
        )}
      </section>
    )
  }

  const renderSearchResults = () => {
    if (searchStatus === 'searching') {
      return (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 size={14} className="animate-spin" />
          <span>Searching open conversations…</span>
        </div>
      )
    }

    if (searchStatus === 'error') {
      return (
        <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
          {searchErrorMessage ?? 'Search failed.'}
        </div>
      )
    }

    if (searchResults.length === 0) {
      return (
        <div className="px-3 py-6 text-center text-sm text-zinc-400">
          No open conversations matched &ldquo;{searchQuery.trim()}&rdquo;.
        </div>
      )
    }

    return (
      <section className="space-y-2 px-1">
        <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Search results
        </div>
        {searchResults.map((result) => {
          const isActiveResult = result.sessionId === activeSessionId
          const projectName = basenameFromPath(result.workingDirectory)

          return (
            <button
              key={result.sessionId}
              type="button"
              onClick={() => {
                clearSearch()
                onSelectSession(result.sessionId)
              }}
              className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${
                isActiveResult
                  ? 'bg-zinc-900/[0.06] dark:bg-white/[0.06]'
                  : 'hover:bg-zinc-900/[0.035] dark:hover:bg-white/[0.04]'
              }`}
              title={result.workingDirectory}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {result.title}
                </span>
                <span className="flex-shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                  {formatRelativeTime(result.updatedAt)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="truncate font-medium">{projectName}</span>
                <span className="truncate text-zinc-400 dark:text-zinc-500">
                  {result.workingDirectory}
                </span>
              </div>
              <div className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                {result.snippet}
              </div>
            </button>
          )
        })}
      </section>
    )
  }

  return (
    <div className="surface-rail flex h-full w-full min-w-0 flex-shrink-0 flex-col">
      <div className="drag-region relative px-3 pb-2 pt-10">
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="no-drag absolute right-3 top-3 z-[60] rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}

        {currentView === 'chat' ? (
          <div className="no-drag px-4 pr-12">
            <div className="flex justify-center">
              {modeToolbar}
            </div>
            <div className="mt-3">
              <label htmlFor="sidebar-session-search" className="sr-only">
                Search open conversations
              </label>
              <div
                className="flex items-center gap-1.5 rounded-full bg-zinc-900/[0.045] px-3 py-1.5 text-sm transition-colors focus-within:bg-zinc-900/[0.07] dark:bg-white/[0.06] dark:focus-within:bg-white/[0.09]"
              >
                <Search
                  size={13}
                  className="flex-shrink-0 text-zinc-400 dark:text-zinc-500"
                />
                <input
                  id="sidebar-session-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && searchQuery.trim().length > 0) {
                      event.preventDefault()
                      clearSearch()
                    }
                  }}
                  placeholder="Search"
                  className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
                {searchStatus === 'searching' ? (
                  <Loader2
                    size={13}
                    className="flex-shrink-0 animate-spin text-zinc-400 dark:text-zinc-500"
                  />
                ) : searchQuery.trim().length > 0 ? (
                  <button
                    type="button"
                    onClick={clearSearch}
                    className="rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-900/10 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-zinc-200"
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="no-drag px-1 pr-8">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Automations
            </div>
            <div className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Scheduled agents
            </div>
          </div>
        )}
      </div>

      <div
        className="scrollbar-thin min-h-[150px] flex-1 basis-0 overflow-y-auto border-y border-zinc-200/70 bg-white/30 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-950/20"
        aria-label={currentView === 'chat' ? 'Conversation history' : 'Automations'}
      >
        {currentView === 'chat' ? (
          hasActiveSearch ? renderSearchResults() : (
          <>
            {renderPinnedAndIcons()}

            {sidebarModel.projectGroups.map((group) => renderProjectGroup(group))}

            {sidebarModel.projectGroups.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-zinc-400">
                {sessions.length === 0
                  ? 'No conversations yet.'
                  : 'No open projects. Use New project to reopen a folder or start a new one.'}
              </div>
            )}
          </>)
        ) : (
          <>
            {automations.map((automation) => (
              <button
                key={automation.id}
                onClick={() => onSelectAutomation(automation.id)}
                className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                  automation.id === activeAutomationId
                    ? 'bg-zinc-200 dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${automationStatusTone(automation.lastRunStatus)}`}
                  />
                  <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    {automation.name}
                  </span>
                </div>
                <div className="mt-1 truncate pl-3.5 text-xs text-zinc-500 dark:text-zinc-500">
                  {automation.scheduleText}
                </div>
                <div className="mt-1 pl-3.5 text-[11px] text-zinc-400 dark:text-zinc-600">
                  {automation.nextRunAt
                    ? new Date(automation.nextRunAt).toLocaleString()
                    : automation.enabled
                      ? 'No next run'
                      : 'Paused'}
                </div>
              </button>
            ))}

            {automations.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-zinc-400">
                No automations yet.
              </div>
            )}
          </>
        )}
      </div>

      {modelMemoryPanelOpen && (
        <div className="no-drag h-[44%] min-h-[260px] max-h-[390px] flex-shrink-0">
          <MemoryStatusPanel
            systemStats={systemStats}
            models={models}
            modelTokenUsage={modelTokenUsage}
            selectedModelId={activeModelId ?? undefined}
            selectedRuntimeId={activeRuntimeId ?? undefined}
            helperModelId={helperModelId ?? undefined}
            helperRuntimeId={helperRuntimeId ?? undefined}
            reloadModelsBusy={modelReloadPending}
            reloadModelsDisabledReason={effectiveReloadModelsDisabledReason}
            onReloadModels={handleReloadModels}
          />
        </div>
      )}

      <div className="no-drag px-3 pb-3 pt-2">
        {currentView === 'chat' ? (
          <div className="group relative flex justify-end">
            <div
              role="menu"
              aria-label="Quick create"
              className={`absolute bottom-full right-1 w-60 pb-2 transition-all duration-200 ease-out ${quickCreateMenuClassName}`}
            >
              <div className="rounded-2xl border border-zinc-200 bg-white/95 p-1.5 shadow-[0_18px_40px_-28px_rgba(24,24,27,0.52)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-[0_22px_44px_-30px_rgba(0,0,0,0.86)]">
                <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  Quick create
                </div>
                <div className="space-y-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (!activeProject) {
                        return
                      }

                      setQuickCreateMenuPinned(false)
                      onCreateSessionInProject(activeProject.path)
                    }}
                    disabled={quickCreateConversationDisabled}
                    title={quickCreateConversationTitle}
                    aria-label={quickCreateConversationTitle}
                    className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                      <Plus size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Add conversation
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {quickCreateConversationHint}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation()
                      setQuickCreateMenuPinned(false)
                      onCreateProject()
                    }}
                    disabled={conversationCreationPending}
                    title="Open a project folder"
                    aria-label="Open a project folder"
                    className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                      <FolderOpen size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        Open project
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                        Pick a folder and open its latest or first conversation
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setQuickCreateMenuPinned((prev) => !prev)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuickCreateMenuPinned(false)
                }
              }}
              disabled={conversationCreationPending}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-zinc-200 bg-white/95 text-zinc-700 shadow-[0_16px_34px_-22px_rgba(24,24,27,0.46)] backdrop-blur transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 hover:border-zinc-300 hover:bg-white hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:focus-visible:ring-zinc-600 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-white"
              title="Quick create"
              aria-label="Quick create"
              aria-haspopup="menu"
              aria-expanded={quickCreateMenuPinned}
            >
              <Plus size={18} />
            </button>
          </div>
        ) : createActionLabel && createActionHint && (
          <div className="group relative flex justify-end">
            <div className="pointer-events-none absolute bottom-full right-0 mb-2 translate-y-1 opacity-0 transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
                <div className="rounded-xl border border-zinc-200 bg-white/95 px-3 py-2 text-right shadow-[0_14px_36px_-26px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-[0_18px_42px_-30px_rgba(0,0,0,0.82)]">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                    New automation
                  </div>
                  <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {createActionHint}
                  </div>
                </div>
            </div>

            <button
              onClick={onNewAutomation}
              className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-zinc-200 bg-white/95 text-zinc-700 shadow-[0_16px_34px_-22px_rgba(24,24,27,0.46)] backdrop-blur transition-all duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 hover:border-zinc-300 hover:bg-white hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:focus-visible:ring-zinc-600 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-white"
              title={createActionLabel}
              aria-label={createActionLabel}
            >
              <Plus size={18} />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 px-3 py-2">
        <button
          onClick={onOpenSettings}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
        <button
          onClick={onOpenDoctor}
          className={`rounded-md p-1.5 transition-colors ${
            doctorOpen
              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:hover:bg-emerald-500/25'
              : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
          }`}
          title="Doctor"
          aria-label="Doctor"
        >
          <Stethoscope size={16} />
        </button>
        <button
          onClick={onOpenSkills}
          className={getSkillsButtonClassName(selectedSkillCount)}
          title="Skills"
          aria-label="Skills"
        >
          <Sparkles size={16} />
          {selectedSkillCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[17px] items-center justify-center rounded-full bg-sky-600 px-1 text-[10px] font-medium leading-none text-white shadow-sm dark:bg-sky-300 dark:text-sky-950">
              {selectedSkillCount}
            </span>
          )}
        </button>
        <div className="flex-1" />
        <div className="flex flex-col items-end gap-0.5">
          <GpuWave stats={systemStats} />
          <MemoryStatusIndicator
            systemStats={systemStats}
            models={models}
            modelTokenUsage={modelTokenUsage}
            selectedModelId={activeModelId ?? undefined}
            selectedRuntimeId={activeRuntimeId ?? undefined}
            helperModelId={helperModelId ?? undefined}
            helperRuntimeId={helperRuntimeId ?? undefined}
            panelOpen={modelMemoryPanelOpen}
            onTogglePanel={() => setModelMemoryPanelOpen((open) => !open)}
          />
        </div>
      </div>

      {contextMenu && currentView === 'chat' && (
        <div
          className="fixed z-50 min-w-[170px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              if (contextSession) {
                startRenamingSession(contextSession)
              }
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            onClick={() => {
              if (!contextSession) {
                return
              }

              if (contextSessionPinned) {
                onUnpinSession(contextSession.id)
              } else {
                onPinSession(contextSession.id)
              }
              setContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Pin size={14} />
            {contextSessionPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            onClick={() => {
              if (!contextSession) {
                return
              }

              if (contextSessionFollowUp) {
                onUnflagFollowUp(contextSession.id)
              } else {
                onFlagFollowUp(contextSession.id)
              }
              setContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Flag size={14} />
            {contextSessionFollowUp ? 'Remove follow-up' : 'Follow up'}
          </button>
          <button
            onClick={() => {
              confirmDeleteSession(contextMenu.sessionId)
            }}
            disabled={!canDeleteContextSession}
            title={
              canDeleteContextSession
                ? 'Delete conversation'
                : 'Running conversation cannot be deleted'
            }
            aria-label={
              canDeleteContextSession
                ? 'Delete conversation'
                : 'Running conversation cannot be deleted'
            }
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
              canDeleteContextSession
                ? 'text-red-600 hover:bg-zinc-100 dark:text-red-400 dark:hover:bg-zinc-800'
                : 'cursor-not-allowed text-zinc-400 dark:text-zinc-600'
            }`}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Delete conversation?
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500">
              This will permanently delete &ldquo;{sessions.find((session) => session.id === confirmDeleteId)?.title}&rdquo;, its history, and any saved attachments for that conversation. This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDeleteSession(confirmDeleteId)
                  setConfirmDeleteId(null)
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmCloseProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[28rem] rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Close project folder?
            </h3>
            <p className="mt-1.5 text-xs text-zinc-500">
              This will hide &ldquo;{confirmCloseProject.name}&rdquo; from the sidebar. Its chats stay on disk, and any pinned chats from this project will be removed from Pinned until you reopen the folder.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmCloseProject(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onCloseProject(confirmCloseProject.path)
                  setConfirmCloseProject(null)
                }}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Close project
              </button>
            </div>
          </div>
        </div>
      )}

      {renameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            className="w-[24rem] rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
            role="dialog"
            aria-label="Rename conversation"
          >
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Rename conversation
            </h3>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="conversation-title-value" className="sr-only">
                  Conversation title
                </label>
                <input
                  ref={renameTitleInputRef}
                  id="conversation-title-value"
                  value={renameDialog.title}
                  onChange={(event) => {
                    const title = event.target.value
                    setRenameDialog((current) =>
                      current ? { ...current, title } : current,
                    )
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && renameDialog.title.trim()) {
                      event.preventDefault()
                      saveRenameDialog()
                    }
                    if (event.key === 'Escape') {
                      setRenameDialog(null)
                      setRenameIconSearch('')
                    }
                  }}
                  className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-sky-500/60 dark:focus:ring-sky-500/30"
                  aria-label="Conversation title"
                />
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="conversation-icon-value" className="sr-only">
                  Conversation icon
                </label>
                <input
                  ref={renameIconInputRef}
                  id="conversation-icon-value"
                  value={renameDialog.icon}
                  onChange={(event) => updateRenameIconDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-10 w-12 rounded-lg border border-zinc-200 bg-zinc-50 text-center text-xl leading-none text-zinc-900 outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-sky-500/60 dark:focus:ring-sky-500/30"
                  aria-label="Conversation icon"
                />
                <button
                  type="button"
                  onClick={() => updateRenameIconDraft('')}
                  className="flex h-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                  title="Clear conversation icon"
                  aria-label="Clear conversation icon"
                >
                  <X size={14} />
                </button>
                <button
                  type="button"
                  onClick={openSystemEmojiPanel}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-600 transition-colors hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-sky-500/35 dark:hover:bg-sky-500/15 dark:hover:text-sky-300"
                  title="Open macOS emoji picker"
                  aria-label="Open macOS emoji picker"
                >
                  <SmilePlus size={16} />
                  <span>All macOS emoji</span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="conversation-icon-search" className="sr-only">
                  Filter suggestions
                </label>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950">
                  <Search size={14} className="flex-shrink-0 text-zinc-400 dark:text-zinc-500" />
                  <input
                    id="conversation-icon-search"
                    value={renameIconSearch}
                    onChange={(event) => setRenameIconSearch(event.target.value)}
                    placeholder="Filter suggestions"
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-8 gap-1">
                {filteredConversationIcons.map((entry) => (
                  <button
                    key={entry.emoji}
                    type="button"
                    onClick={() => updateRenameIconDraft(entry.emoji)}
                    className={`flex h-8 items-center justify-center rounded-lg text-lg transition-colors ${
                      renameDialog.icon === entry.emoji
                        ? 'bg-sky-100 ring-1 ring-sky-300 dark:bg-sky-500/20 dark:ring-sky-500/50'
                        : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                    title={entry.words}
                    aria-label={`Use ${entry.emoji}`}
                  >
                    {entry.emoji}
                  </button>
                ))}
              </div>
              {renameIconSearch.trim() && filteredConversationIcons.length === 0 && (
                <div className="text-xs text-zinc-500">
                  No matching suggestions.
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setRenameDialog(null)
                  setRenameIconSearch('')
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={saveRenameDialog}
                disabled={!renameDialog.title.trim()}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
