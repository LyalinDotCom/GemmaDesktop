import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  GlobalChatOpenInAppRequest,
  GlobalChatState,
} from '../shared/globalChat'
import type { NotificationPermissionState } from '../shared/notifications'
import type { ProjectBrowserPanelBounds, ProjectBrowserState } from '../shared/projectBrowser'
import type { MenuBarPopupState, MenuBarScreenshotTarget } from '../shared/menuBarPopup'

const notificationApi = (
  globalThis as unknown as {
    Notification?: {
      permission?: string
      requestPermission?: () => Promise<string>
    }
  }
).Notification

contextBridge.exposeInMainWorld('gemmaDesktopBridge', {
  sidebar: {
    get: () => ipcRenderer.invoke('sidebar:get'),
    pinSession: (sessionId: string) =>
      ipcRenderer.invoke('sidebar:pin-session', sessionId),
    unpinSession: (sessionId: string) =>
      ipcRenderer.invoke('sidebar:unpin-session', sessionId),
    flagFollowUp: (sessionId: string) =>
      ipcRenderer.invoke('sidebar:flag-followup', sessionId),
    unflagFollowUp: (sessionId: string) =>
      ipcRenderer.invoke('sidebar:unflag-followup', sessionId),
    rememberActiveSession: (sessionId: string | null) =>
      ipcRenderer.invoke('sidebar:remember-active-session', sessionId),
    movePinnedSession: (sessionId: string, toIndex: number) =>
      ipcRenderer.invoke('sidebar:move-pinned-session', sessionId, toIndex),
    setSessionOrder: (sessionId: string, toIndex: number) =>
      ipcRenderer.invoke('sidebar:set-session-order', sessionId, toIndex),
    clearSessionOrder: (sessionId: string) =>
      ipcRenderer.invoke('sidebar:clear-session-order', sessionId),
    setProjectOrder: (projectPath: string, toIndex: number) =>
      ipcRenderer.invoke('sidebar:set-project-order', projectPath, toIndex),
    clearProjectOrder: (projectPath: string) =>
      ipcRenderer.invoke('sidebar:clear-project-order', projectPath),
    closeProject: (projectPath: string) =>
      ipcRenderer.invoke('sidebar:close-project', projectPath),
    reopenProject: (projectPath: string) =>
      ipcRenderer.invoke('sidebar:reopen-project', projectPath),
    onChanged: (callback: (state: unknown) => void) => {
      const handler = (_: unknown, state: unknown) => callback(state)
      ipcRenderer.on('sidebar:changed', handler)
      return () => ipcRenderer.removeListener('sidebar:changed', handler)
    },
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (opts: unknown) => ipcRenderer.invoke('sessions:create', opts),
    get: (sessionId: string) => ipcRenderer.invoke('sessions:get', sessionId),
    search: (input: unknown) => ipcRenderer.invoke('sessions:search', input),
    saveDraft: (sessionId: string, draftText: string) =>
      ipcRenderer.invoke('sessions:save-draft', sessionId, draftText),
    update: (sessionId: string, opts: unknown) =>
      ipcRenderer.invoke('sessions:update', sessionId, opts),
    delete: (sessionId: string) =>
      ipcRenderer.invoke('sessions:delete', sessionId),
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke('sessions:rename', sessionId, title),
    setTags: (sessionId: string, tags: unknown) =>
      ipcRenderer.invoke('sessions:set-tags', sessionId, tags),
    suggestTagEmoji: (tagName: string, excludeEmojis: string[]) =>
      ipcRenderer.invoke(
        'sessions:suggest-tag-emoji',
        tagName,
        excludeEmojis,
      ),
    sendMessage: (sessionId: string, message: unknown) =>
      ipcRenderer.invoke('sessions:send-message', sessionId, message),
    sendHiddenInstruction: (sessionId: string, text: string) =>
      ipcRenderer.invoke('sessions:send-hidden-instruction', sessionId, text),
    runShellCommand: (sessionId: string, input: unknown) =>
      ipcRenderer.invoke('sessions:run-shell-command', sessionId, input),
    writeShellInput: (sessionId: string, terminalId: string, data: string) =>
      ipcRenderer.invoke('sessions:write-shell-input', sessionId, terminalId, data),
    resizeShell: (
      sessionId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ) =>
      ipcRenderer.invoke(
        'sessions:resize-shell',
        sessionId,
        terminalId,
        cols,
        rows,
      ),
    closeShell: (sessionId: string, terminalId: string) =>
      ipcRenderer.invoke('sessions:close-shell', sessionId, terminalId),
    runResearch: (sessionId: string, message: unknown) =>
      ipcRenderer.invoke('sessions:run-research', sessionId, message),
    compact: (sessionId: string) =>
      ipcRenderer.invoke('sessions:compact', sessionId),
    clearHistory: (sessionId: string) =>
      ipcRenderer.invoke('sessions:clear-history', sessionId),
    cancelGeneration: (sessionId: string) =>
      ipcRenderer.invoke('sessions:cancel', sessionId),
    resolveToolApproval: (
      sessionId: string,
      approvalId: string,
      approved: boolean,
    ) =>
      ipcRenderer.invoke(
        'sessions:resolve-tool-approval',
        sessionId,
        approvalId,
        approved,
      ),
    onChanged: (callback: (sessions: unknown) => void) => {
      const handler = (_: unknown, sessions: unknown) => callback(sessions)
      ipcRenderer.on('sessions:changed', handler)
      return () => ipcRenderer.removeListener('sessions:changed', handler)
    },
  },

  environment: {
    inspect: () => ipcRenderer.invoke('environment:inspect'),
    listModels: () => ipcRenderer.invoke('environment:models'),
    listRuntimes: () => ipcRenderer.invoke('environment:runtimes'),
    getBootstrapState: () => ipcRenderer.invoke('environment:bootstrap-state'),
    retryBootstrap: () => ipcRenderer.invoke('environment:retry-bootstrap'),
    ensureGemmaModel: (tag: string) =>
      ipcRenderer.invoke('environment:ensure-gemma-model', tag),
    onBootstrapChanged: (callback: (state: unknown) => void) => {
      const handler = (_: unknown, state: unknown) => callback(state)
      ipcRenderer.on('environment:bootstrap-changed', handler)
      return () =>
        ipcRenderer.removeListener('environment:bootstrap-changed', handler)
    },
    onModelsChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('environment:models-changed', handler)
      return () =>
        ipcRenderer.removeListener('environment:models-changed', handler)
    },
    onGemmaInstallChanged: (callback: (states: unknown) => void) => {
      const handler = (_: unknown, states: unknown) => callback(states)
      ipcRenderer.on('environment:gemma-install-changed', handler)
      return () =>
        ipcRenderer.removeListener('environment:gemma-install-changed', handler)
    },
  },

  doctor: {
    inspect: () => ipcRenderer.invoke('doctor:inspect'),
    openPrivacySettings: (permissionId: 'screen' | 'camera' | 'microphone') =>
      ipcRenderer.invoke('doctor:open-privacy-settings', permissionId),
  },

  system: {
    getStats: () => ipcRenderer.invoke('system:stats'),
    onStatsUpdate: (callback: (stats: unknown) => void) => {
      const handler = (_: unknown, stats: unknown) => callback(stats)
      ipcRenderer.on('system:stats-update', handler)
      return () => ipcRenderer.removeListener('system:stats-update', handler)
    },
    getModelTokenUsage: () => ipcRenderer.invoke('system:model-token-usage'),
    onModelTokenUsageUpdate: (callback: (report: unknown) => void) => {
      const handler = (_: unknown, report: unknown) => callback(report)
      ipcRenderer.on('system:model-token-usage-update', handler)
      return () =>
        ipcRenderer.removeListener('system:model-token-usage-update', handler)
    },
  },

  events: {
    onSessionEvent: (
      sessionId: string,
      callback: (event: unknown) => void,
    ) => {
      const channel = `session:event:${sessionId}`
      const handler = (_: unknown, event: unknown) => callback(event)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
  },

  browser: {
    getState: () => ipcRenderer.invoke('browser:get-state'),
    navigate: (
      url: string,
      options?: { sessionId?: string | null; coBrowseActive?: boolean },
    ) => options
      ? ipcRenderer.invoke('browser:navigate', url, options)
      : ipcRenderer.invoke('browser:navigate', url),
    reload: () => ipcRenderer.invoke('browser:reload'),
    stopLoading: () => ipcRenderer.invoke('browser:stop-loading'),
    goBack: () => ipcRenderer.invoke('browser:go-back'),
    goForward: () => ipcRenderer.invoke('browser:go-forward'),
    takeControl: (reason?: string) => ipcRenderer.invoke('browser:take-control', reason),
    releaseControl: () => ipcRenderer.invoke('browser:release-control'),
    setPanelBounds: (bounds: ProjectBrowserPanelBounds | null) =>
      ipcRenderer.invoke('browser:set-panel-bounds', bounds),
    close: () => ipcRenderer.invoke('browser:close'),
    onStateChanged: (callback: (state: ProjectBrowserState) => void) => {
      const handler = (_: unknown, state: ProjectBrowserState) => callback(state)
      ipcRenderer.on('browser:state-changed', handler)
      return () => ipcRenderer.removeListener('browser:state-changed', handler)
    },
  },

  talk: {
    ensureSession: () => ipcRenderer.invoke('talk:ensure-session'),
    clearSession: () => ipcRenderer.invoke('talk:clear-session'),
  },

  globalChat: {
    getState: () => ipcRenderer.invoke('global-chat:get-state'),
    getSession: () => ipcRenderer.invoke('global-chat:get-session'),
    assignSession: (sessionId: string) =>
      ipcRenderer.invoke('global-chat:assign-session', sessionId),
    clearAssignment: () => ipcRenderer.invoke('global-chat:clear-assignment'),
    onChanged: (callback: (state: GlobalChatState) => void) => {
      const handler = (_: unknown, state: GlobalChatState) => callback(state)
      ipcRenderer.on('global-chat:changed', handler)
      return () => ipcRenderer.removeListener('global-chat:changed', handler)
    },
    onOpenInAppRequested: (
      callback: (request: GlobalChatOpenInAppRequest) => void,
    ) => {
      const handler = (_: unknown, request: GlobalChatOpenInAppRequest) =>
        callback(request)
      ipcRenderer.on('global-chat:open-in-app-requested', handler)
      return () =>
        ipcRenderer.removeListener('global-chat:open-in-app-requested', handler)
    },
  },

  menuBarPopup: {
    getState: () => ipcRenderer.invoke('menu-bar-popup:get-state'),
    close: () => ipcRenderer.invoke('menu-bar-popup:close'),
    openApp: () => ipcRenderer.invoke('menu-bar-popup:open-app'),
    captureScreenshot: (target: MenuBarScreenshotTarget) =>
      ipcRenderer.invoke('menu-bar-popup:capture-screenshot', target),
    onStateChanged: (callback: (state: MenuBarPopupState) => void) => {
      const handler = (_: unknown, state: MenuBarPopupState) => callback(state)
      ipcRenderer.on('menu-bar-popup:state-changed', handler)
      return () => ipcRenderer.removeListener('menu-bar-popup:state-changed', handler)
    },
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: unknown) => ipcRenderer.invoke('settings:update', patch),
    onChanged: (callback: (settings: unknown) => void) => {
      const handler = (_: unknown, settings: unknown) => callback(settings)
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    },
  },

  notifications: {
    updateAttentionContext: (context: unknown) =>
      ipcRenderer.invoke('notifications:update-attention-context', context),
    getPermissionState: () =>
      ipcRenderer.invoke(
        'notifications:get-permission-state',
        notificationApi?.permission ?? 'unsupported',
      ),
    requestPermission: async () => {
      const status = notificationApi?.requestPermission
        ? await notificationApi.requestPermission()
        : 'unsupported'
      const nextState =
        await ipcRenderer.invoke(
          'notifications:get-permission-state',
          status,
        ) as NotificationPermissionState
      return nextState
    },
    dismissPermissionPrompt: () =>
      ipcRenderer.invoke('notifications:dismiss-permission-prompt'),
    sendTest: () => ipcRenderer.invoke('notifications:send-test'),
    onActivateTarget: (callback: (target: unknown) => void) => {
      const handler = (_: unknown, target: unknown) => callback(target)
      ipcRenderer.on('notifications:activate-target', handler)
      return () => ipcRenderer.removeListener('notifications:activate-target', handler)
    },
    onPermissionPrompt: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('notifications:permission-prompt', handler)
      return () => ipcRenderer.removeListener('notifications:permission-prompt', handler)
    },
  },

  skills: {
    listInstalled: () => ipcRenderer.invoke('skills:list-installed'),
    searchCatalog: (query: string) =>
      ipcRenderer.invoke('skills:search-catalog', query),
    install: (input: unknown) => ipcRenderer.invoke('skills:install', input),
    remove: (skillId: string) => ipcRenderer.invoke('skills:remove', skillId),
    onChanged: (callback: (skills: unknown) => void) => {
      const handler = (_: unknown, skills: unknown) => callback(skills)
      ipcRenderer.on('skills:changed', handler)
      return () => ipcRenderer.removeListener('skills:changed', handler)
    },
  },

  folders: {
    pickDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke('folders:pick-directory', defaultPath),
    openPath: (targetPath: string) =>
      ipcRenderer.invoke('folders:open-path', targetPath),
  },

  terminalDrawer: {
    getState: () => ipcRenderer.invoke('terminalDrawer:get-state'),
    start: (input?: unknown) => ipcRenderer.invoke('terminalDrawer:start', input),
    writeInput: (data: string) =>
      ipcRenderer.invoke('terminalDrawer:write-input', data),
    resize: (cols: number, rows: number) =>
      ipcRenderer.invoke('terminalDrawer:resize', cols, rows),
    terminate: () => ipcRenderer.invoke('terminalDrawer:terminate'),
    onStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_: unknown, state: unknown) => callback(state)
      ipcRenderer.on('terminalDrawer:state-changed', handler)
      return () => ipcRenderer.removeListener('terminalDrawer:state-changed', handler)
    },
  },

  terminals: {
    listInstalled: () => ipcRenderer.invoke('terminals:list-installed'),
    openDirectory: (input: unknown) =>
      ipcRenderer.invoke('terminals:open-directory', input),
  },

  attachments: {
    planPdfProcessing: (input: unknown) =>
      ipcRenderer.invoke('attachments:plan-pdf-processing', input),
    discardPending: (input: unknown) =>
      ipcRenderer.invoke('attachments:discard-pending', input),
    onPendingAttachment: (callback: (payload: unknown) => void) => {
      const handler = (_: unknown, payload: unknown) => callback(payload)
      ipcRenderer.on('attachments:pending-added', handler)
      return () => ipcRenderer.removeListener('attachments:pending-added', handler)
    },
  },

  workspace: {
    inspect: (workingDirectory: string) =>
      ipcRenderer.invoke('workspace:inspect', workingDirectory),
    subscribe: async (
      workingDirectory: string,
      callback: (event: { rootPath: string }) => void,
    ): Promise<() => void> => {
      const { subscriptionId } = await ipcRenderer.invoke(
        'workspace:start-watch',
        workingDirectory,
      ) as { subscriptionId: string }

      const handler = (
        _: unknown,
        payload: { subscriptionId: string; rootPath: string },
      ) => {
        if (payload.subscriptionId === subscriptionId) {
          callback({ rootPath: payload.rootPath })
        }
      }
      ipcRenderer.on('workspace:changed', handler)

      return () => {
        ipcRenderer.removeListener('workspace:changed', handler)
        void ipcRenderer.invoke('workspace:stop-watch', subscriptionId)
      }
    },
  },

  files: {
    saveText: (input: unknown) => ipcRenderer.invoke('files:save-text', input),
  },

  links: {
    openTarget: (target: string) => ipcRenderer.invoke('links:open-target', target),
  },

  clipboard: {
    writeText: async (text: string) => {
      clipboard.writeText(text)
    },
  },

  media: {
    requestCameraAccess: () => ipcRenderer.invoke('media:request-camera-access'),
    requestMicrophoneAccess: () =>
      ipcRenderer.invoke('media:request-microphone-access'),
  },

  speech: {
    inspect: () => ipcRenderer.invoke('speech:inspect'),
    install: () => ipcRenderer.invoke('speech:install'),
    repair: () => ipcRenderer.invoke('speech:repair'),
    remove: () => ipcRenderer.invoke('speech:remove'),
    startSession: (input: unknown) => ipcRenderer.invoke('speech:start-session', input),
    sendChunk: (input: unknown) => ipcRenderer.invoke('speech:send-chunk', input),
    finishSession: (sessionId: string) => ipcRenderer.invoke('speech:finish-session', sessionId),
    stopSession: (sessionId: string) => ipcRenderer.invoke('speech:stop-session', sessionId),
    onEvent: (
      sessionId: string,
      callback: (event: unknown) => void,
    ) => {
      const channel = `speech:event:${sessionId}`
      const handler = (_: unknown, event: unknown) => callback(event)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onStatusChanged: (callback: (status: unknown) => void) => {
      const handler = (_: unknown, status: unknown) => callback(status)
      ipcRenderer.on('speech:status-changed', handler)
      return () => ipcRenderer.removeListener('speech:status-changed', handler)
    },
  },

  readAloud: {
    inspect: () => ipcRenderer.invoke('read-aloud:inspect'),
    synthesize: (input: unknown) => ipcRenderer.invoke('read-aloud:synthesize', input),
    cancelCurrent: () => ipcRenderer.invoke('read-aloud:cancel-current'),
    test: (input?: unknown) => ipcRenderer.invoke('read-aloud:test', input),
    listVoices: () => ipcRenderer.invoke('read-aloud:list-voices'),
    onStatusChanged: (callback: (status: unknown) => void) => {
      const handler = (_: unknown, status: unknown) => callback(status)
      ipcRenderer.on('read-aloud:status-changed', handler)
      return () => ipcRenderer.removeListener('read-aloud:status-changed', handler)
    },
  },

  assistantNarration: {
    generate: (input: unknown) => ipcRenderer.invoke('assistant-narration:generate', input),
  },

  thinkingSummary: {
    generate: (input: unknown) => ipcRenderer.invoke('thinking-summary:generate', input),
  },

  plan: {
    answerQuestion: (
      sessionId: string,
      questionId: string,
      answer: string,
    ) =>
      ipcRenderer.invoke('plan:answer-question', sessionId, questionId, answer),
    exit: (
      sessionId: string,
      options?: { target?: 'current' | 'fresh_summary' },
    ) =>
      ipcRenderer.invoke('plan:exit', sessionId, options),
    dismissExit: (sessionId: string) =>
      ipcRenderer.invoke('plan:dismiss-exit', sessionId),
  },

  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    get: (automationId: string) =>
      ipcRenderer.invoke('automations:get', automationId),
    create: (input: unknown) => ipcRenderer.invoke('automations:create', input),
    update: (automationId: string, patch: unknown) =>
      ipcRenderer.invoke('automations:update', automationId, patch),
    delete: (automationId: string) =>
      ipcRenderer.invoke('automations:delete', automationId),
    runNow: (automationId: string) =>
      ipcRenderer.invoke('automations:run-now', automationId),
    cancelRun: (automationId: string) =>
      ipcRenderer.invoke('automations:cancel-run', automationId),
    onChanged: (callback: (automations: unknown) => void) => {
      const handler = (_: unknown, automations: unknown) => callback(automations)
      ipcRenderer.on('automations:changed', handler)
      return () => ipcRenderer.removeListener('automations:changed', handler)
    },
  },

  debug: {
    getSessionLogs: (sessionId: string) =>
      ipcRenderer.invoke('debug:get-session-logs', sessionId),
    getSessionConfig: (sessionId: string) =>
      ipcRenderer.invoke('debug:get-session-config', sessionId),
    clearSessionLogs: (sessionId: string) =>
      ipcRenderer.invoke('debug:clear-session-logs', sessionId),
    onSessionLog: (
      sessionId: string,
      callback: (entry: unknown) => void,
    ) => {
      const channel = `debug:log:${sessionId}`
      const handler = (_: unknown, entry: unknown) => callback(entry)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
  },

  memory: {
    read: () => ipcRenderer.invoke('memory:read'),
    write: (content: string) => ipcRenderer.invoke('memory:write', content),
    appendNote: (input: { sessionId?: string; rawInput: string }) =>
      ipcRenderer.invoke('memory:append-note', input),
  },
})
