import { useReducer, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  findInitialVisibleSessionId,
  findReplacementSessionAfterDelete,
} from '@/lib/sidebarModel'
import {
  buildComposedMessageText,
  type PinnedQuote,
} from '@/lib/composeQuotedMessage'
import {
  canQueueMessageWhileBusy,
  getBusyQueueBlockedReason,
} from '@/lib/sessionQueuePolicy'
import { shouldSummarizeThinking } from '@shared/thinkingSummary'
import {
  isConversationExecutionBlockedError,
  stripConversationExecutionBlockedErrorCode,
} from '@shared/conversationExecutionPolicy'
import { buildQueuedUserMessage } from '@/lib/queuedUserMessage'
import {
  EMPTY_SELECTION,
  appStateReducer,
  buildCreateSessionBridgeOptions,
  buildThinkingTurnContext,
  initialState,
  type SelectionState,
} from './appStateCore'
import type {
  SessionSummary,
  SessionDetail,
  SystemStats,
  ModelTokenUsageReport,
  AppSettings,
  ChatMessage,
  SessionStreamEvent,
  SessionMode,
  CreateSessionOpts,
  UpdateSessionOpts,
  InstalledSkillRecord,
  AutomationSummary,
  AutomationSchedule,
  FileAttachment,
  GemmaInstallState,
  SpeechInspection,
  SidebarState,
  ReadAloudInspection,
  ReadAloudTestInput,
  BootstrapState,
  ConversationIcon,
  GemmaDesktopBridge,
} from '@/types'

export { __testOnly } from './appStateCore'

const BRIDGE_UNAVAILABLE_MESSAGE =
  'Gemma Desktop bridge is unavailable. Open this renderer through the Electron app so preload APIs are available.'

function getGemmaDesktopBridge(): GemmaDesktopBridge | null {
  return window.gemmaDesktopBridge ?? null
}

export function useAppState() {
  const [state, dispatch] = useReducer(appStateReducer, initialState)
  const eventCleanupRef = useRef<(() => void) | null>(null)
  const debugCleanupRef = useRef<(() => void) | null>(null)
  const drainingQueuedMessagesRef = useRef(new Set<string>())
  const activeSessionRef = useRef<SessionDetail | null>(null)
  const pendingThinkingSummariesRef = useRef(new Set<string>())

  const syncActiveSessionDetail = useCallback(async (sessionId: string) => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      throw new Error(BRIDGE_UNAVAILABLE_MESSAGE)
    }
    const detail = await bridge.sessions.get(sessionId)
    dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
    return detail
  }, [])

  const rememberActiveSession = useCallback(async (sessionId: string | null) => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    try {
      const sidebar = await bridge.sidebar.rememberActiveSession(
        sessionId,
      )
      dispatch({ type: 'SET_SIDEBAR_STATE', sidebar })
    } catch (error) {
      console.error('Failed to remember active session:', error)
    }
  }, [])

  const selectAndRememberSession = useCallback(
    async (sessionId: string) => {
      const detail = await syncActiveSessionDetail(sessionId)
      void rememberActiveSession(detail.id)
      return detail
    },
    [rememberActiveSession, syncActiveSessionDetail],
  )

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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const { runtimes, models, bootstrap } = await bridge.environment.inspect()
    dispatch({ type: 'SET_MODELS', models })
    dispatch({ type: 'SET_RUNTIMES', runtimes })
    dispatch({ type: 'SET_BOOTSTRAP_STATE', bootstrapState: bootstrap })
  }, [])

  // Load initial data
  useEffect(() => {
    async function init() {
      const bridge = getGemmaDesktopBridge()
      if (!bridge) {
        console.warn(BRIDGE_UNAVAILABLE_MESSAGE)
        return
      }

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
            bridge.sidebar.get(),
            bridge.sessions.list(),
            bridge.environment.inspect(),
            bridge.system.getStats(),
            bridge.settings.get(),
            bridge.skills.listInstalled(),
            bridge.automations.list(),
            bridge.speech.inspect(),
            bridge.readAloud.inspect(),
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

        const initialSessionId = findInitialVisibleSessionId(sessions, sidebar)
        if (initialSessionId) {
          try {
            const detail = await bridge.sessions.get(initialSessionId)
            dispatch({ type: 'SET_ACTIVE_SESSION', session: detail, id: detail.id })
            void rememberActiveSession(detail.id)
          } catch (err) {
            console.error('Failed to load session detail:', err)
          }
        }
      } catch (err) {
        console.error('Failed to initialize app state:', err)
      }
    }
    void init()
  }, [rememberActiveSession])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.sidebar.onChanged((sidebar) => {
      dispatch({
        type: 'SET_SIDEBAR_STATE',
        sidebar: sidebar as SidebarState,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.environment.onBootstrapChanged((bootstrapState) => {
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.environment.onModelsChanged(() => {
      void refreshEnvironment().catch((err) => {
        console.error('Failed to refresh environment after model load update:', err)
      })
    })

    return unsub
  }, [refreshEnvironment])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.environment.onGemmaInstallChanged((states) => {
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }

    const unsub = bridge.sessions.onChanged((sessions) => {
      const nextSessions = sessions as SessionSummary[]
      dispatch({ type: 'SET_SESSIONS', sessions: nextSessions })

      const activeSessionId = state.activeSessionId
      if (!activeSessionId) {
        const nextSessionId = findInitialVisibleSessionId(nextSessions, state.sidebar)
        if (nextSessionId) {
          void selectAndRememberSession(nextSessionId).catch((err) => {
            if (!cancelled) {
              console.error('Failed to select a session after session list change:', err)
            }
          })
        }
        return
      }

      const activeSessionStillExists = nextSessions.some(
        (session) => session.id === activeSessionId,
      )

      if (!activeSessionStillExists) {
        const nextSessionId = findInitialVisibleSessionId(nextSessions, state.sidebar)
        if (nextSessionId) {
          void selectAndRememberSession(nextSessionId).catch((err) => {
            if (!cancelled) {
              console.error('Failed to select a session after active session removal:', err)
            }
          })
        } else {
          dispatch({ type: 'SET_ACTIVE_SESSION', session: null, id: null })
          void rememberActiveSession(null)
        }
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
  }, [
    rememberActiveSession,
    selectAndRememberSession,
    state.activeSessionId,
    state.sidebar,
    syncActiveSessionDetail,
  ])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.skills.onChanged((skills) => {
      dispatch({
        type: 'SET_INSTALLED_SKILLS',
        skills: skills as InstalledSkillRecord[],
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.settings.onChanged((settings) => {
      dispatch({
        type: 'SET_SETTINGS',
        settings: settings as AppSettings,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.speech.onStatusChanged((status) => {
      dispatch({
        type: 'SET_SPEECH_STATUS',
        speechStatus: status as SpeechInspection,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.readAloud.onStatusChanged((status) => {
      dispatch({
        type: 'SET_READ_ALOUD_STATUS',
        readAloudStatus: status as ReadAloudInspection,
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.automations.onChanged((automations) => {
      const nextAutomations = automations as AutomationSummary[]
      dispatch({
        type: 'SET_AUTOMATIONS',
        automations: nextAutomations,
      })

      const selectedId = state.activeAutomationId
      if (selectedId && nextAutomations.some((item) => item.id === selectedId)) {
        bridge.automations
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    const unsub = bridge.system.onStatsUpdate((stats) => {
      dispatch({ type: 'SET_SYSTEM_STATS', stats: stats as SystemStats })
    })
    return unsub
  }, [])

  // Subscribe to per-model session token usage
  useEffect(() => {
    let cancelled = false
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }
    bridge.system
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
    const unsub = bridge.system.onModelTokenUsageUpdate(
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }

    let cancelled = false

    const unsub = bridge.events.onSessionEvent(
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
              void bridge.debug
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }

    bridge.debug
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

    const unsub = bridge.debug.onSessionLog(
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
    const bridge = getGemmaDesktopBridge()
    if (!bridge) {
      return
    }

    bridge.debug
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
    await selectAndRememberSession(sessionId)
  }, [selectAndRememberSession])

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
      void rememberActiveSession(detail.id)
      return detail
    },
    [refreshEnvironment, rememberActiveSession],
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
      const replacementSessionId =
        sessionId === state.activeSessionId
          ? findReplacementSessionAfterDelete(
              state.sessions,
              state.sidebar,
              sessionId,
            )
          : null
      await window.gemmaDesktopBridge.sessions.delete(sessionId)
      dispatch({ type: 'REMOVE_SESSION', sessionId })
      if (replacementSessionId) {
        await selectAndRememberSession(replacementSessionId)
      } else if (sessionId === state.activeSessionId) {
        void rememberActiveSession(null)
      }
    },
    [
      rememberActiveSession,
      selectAndRememberSession,
      state.activeSessionId,
      state.isCompacting,
      state.isGenerating,
      state.sessions,
      state.sidebar,
    ],
  )

  const renameSession = useCallback(
    async (
      sessionId: string,
      title: string,
      conversationIcon?: ConversationIcon,
    ) => {
      await window.gemmaDesktopBridge.sessions.rename(
        sessionId,
        title,
        conversationIcon,
      )
      const sessions = await window.gemmaDesktopBridge.sessions.list()
      dispatch({ type: 'SET_SESSIONS', sessions })
      if (state.activeSession && state.activeSession.id === sessionId) {
        const updatedSession = sessions.find((session) => session.id === sessionId)
        dispatch({
          type: 'SET_ACTIVE_SESSION',
          session: updatedSession
            ? { ...state.activeSession, ...updatedSession }
            : {
                ...state.activeSession,
                title,
                conversationIcon:
                  conversationIcon === undefined
                    ? state.activeSession.conversationIcon ?? null
                    : conversationIcon,
              },
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
