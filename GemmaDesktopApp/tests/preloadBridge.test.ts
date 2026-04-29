import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exposedApis = new Map<string, unknown>()
const clipboardWriteText = vi.fn()
const notificationRequestPermission = vi.fn<() => Promise<string>>()
const exposeInMainWorld = vi.fn((name: string, api: unknown) => {
  exposedApis.set(name, api)
})
const invoke = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()

vi.mock('electron', () => ({
  clipboard: {
    writeText: clipboardWriteText,
  },
  contextBridge: {
    exposeInMainWorld,
  },
  ipcRenderer: {
    invoke,
    on,
    removeListener,
  },
}))

async function loadBridge(): Promise<Record<string, unknown>> {
  vi.resetModules()
  exposedApis.clear()
  await import('../src/preload/index.js')
  const bridge = exposedApis.get('gemmaDesktopBridge')
  if (!bridge || typeof bridge !== 'object') {
    throw new Error('Expected preload to expose gemmaDesktopBridge.')
  }
  return bridge as Record<string, unknown>
}

describe('preload bridge', () => {
  beforeEach(() => {
    exposedApis.clear()
    clipboardWriteText.mockReset()
    exposeInMainWorld.mockClear()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    notificationRequestPermission.mockReset()
    notificationRequestPermission.mockImplementation(async () => 'granted')
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:start-watch') {
        return { subscriptionId: 'watch-1' }
      }
      if (channel === 'notifications:get-permission-state') {
        return { status: 'granted' }
      }
      return undefined
    })
    ;(globalThis as { Notification?: { permission?: string; requestPermission?: () => Promise<string> } }).Notification = {
      permission: 'default',
      requestPermission: notificationRequestPermission,
    }
  })

  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification
  })

  it('exposes the bridge and routes direct commands through ipcRenderer', async () => {
    const bridge = await loadBridge()
    const sessions = bridge.sessions as {
      sendMessage: (sessionId: string, message: unknown) => Promise<unknown>
      sendHiddenInstruction: (sessionId: string, text: string) => Promise<unknown>
    }
    const terminalDrawer = bridge.terminalDrawer as {
      start: (input?: { workingDirectory?: string }) => Promise<unknown>
      terminate: () => Promise<unknown>
      onStateChanged: (callback: (state: unknown) => void) => () => void
    }
    const browser = bridge.browser as {
      navigate: (url: string) => Promise<unknown>
      reload: () => Promise<unknown>
      stopLoading: () => Promise<unknown>
      goBack: () => Promise<unknown>
      goForward: () => Promise<unknown>
      takeControl: (reason?: string) => Promise<unknown>
      releaseControl: () => Promise<unknown>
      close: () => Promise<unknown>
      onStateChanged: (callback: (state: unknown) => void) => () => void
    }
    const environment = bridge.environment as {
      onModelsChanged: (callback: () => void) => () => void
    }
    const system = bridge.system as {
      openEmojiPanel: () => Promise<unknown>
    }
    const clipboard = bridge.clipboard as {
      writeText: (text: string) => Promise<void>
    }

    await sessions.sendMessage('session-1', { text: 'Ship it.' })
    await sessions.sendHiddenInstruction('session-1', 'Resume from the current page.')
    await terminalDrawer.start({ workingDirectory: '/tmp/project' })
    await terminalDrawer.terminate()
    await browser.navigate('https://example.com')
    await browser.reload()
    await browser.stopLoading()
    await browser.goBack()
    await browser.goForward()
    await browser.takeControl('Need a login step.')
    await browser.releaseControl()
    await browser.close()
    await system.openEmojiPanel()
    await clipboard.writeText('copied text')

    expect(exposeInMainWorld).toHaveBeenCalledWith('gemmaDesktopBridge', expect.anything())
    expect(typeof bridge.sessions).toBe('object')
    expect(typeof bridge.browser).toBe('object')
    expect(invoke).toHaveBeenCalledWith('sessions:send-message', 'session-1', {
      text: 'Ship it.',
    })
    expect(invoke).toHaveBeenCalledWith(
      'sessions:send-hidden-instruction',
      'session-1',
      'Resume from the current page.',
    )
    expect(invoke).toHaveBeenCalledWith('terminalDrawer:start', {
      workingDirectory: '/tmp/project',
    })
    expect(invoke).toHaveBeenCalledWith('terminalDrawer:terminate')
    expect(invoke).toHaveBeenCalledWith('browser:navigate', 'https://example.com')
    expect(invoke).toHaveBeenCalledWith('browser:reload')
    expect(invoke).toHaveBeenCalledWith('browser:stop-loading')
    expect(invoke).toHaveBeenCalledWith('browser:go-back')
    expect(invoke).toHaveBeenCalledWith('browser:go-forward')
    expect(invoke).toHaveBeenCalledWith('browser:take-control', 'Need a login step.')
    expect(invoke).toHaveBeenCalledWith('browser:release-control')
    expect(invoke).toHaveBeenCalledWith('browser:close')
    expect(invoke).toHaveBeenCalledWith('system:open-emoji-panel')
    expect(clipboardWriteText).toHaveBeenCalledWith('copied text')

    const unsubscribeTerminal = terminalDrawer.onStateChanged(() => {})
    const terminalListenerCall = on.mock.calls.find((call) => call[0] === 'terminalDrawer:state-changed')
    const terminalHandler = terminalListenerCall?.[1] as ((_: unknown, state: unknown) => void) | undefined
    expect(typeof terminalHandler).toBe('function')
    unsubscribeTerminal()
    expect(removeListener).toHaveBeenCalledWith('terminalDrawer:state-changed', terminalHandler)

    const unsubscribe = browser.onStateChanged(() => {})
    const browserListenerCall = on.mock.calls.find((call) => call[0] === 'browser:state-changed')
    const handler = browserListenerCall?.[1] as ((_: unknown, state: unknown) => void) | undefined
    expect(typeof handler).toBe('function')
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('browser:state-changed', handler)

    const unsubscribeModels = environment.onModelsChanged(() => {})
    const modelsListenerCall = on.mock.calls.find((call) => call[0] === 'environment:models-changed')
    const modelsHandler = modelsListenerCall?.[1] as (() => void) | undefined
    expect(typeof modelsHandler).toBe('function')
    unsubscribeModels()
    expect(removeListener).toHaveBeenCalledWith('environment:models-changed', modelsHandler)
  })

  it('subscribes to workspace updates with a server-issued subscription id and cleans up correctly', async () => {
    const bridge = await loadBridge()
    const received: string[] = []
    const workspace = bridge.workspace as {
      subscribe: (
        workingDirectory: string,
        callback: (event: { rootPath: string }) => void,
      ) => Promise<() => void>
    }

    const unsubscribe = await workspace.subscribe('/tmp/project', (event) => {
      received.push(event.rootPath)
    })

    expect(invoke).toHaveBeenCalledWith('workspace:start-watch', '/tmp/project')

    const handler = on.mock.calls.find((call) => call[0] === 'workspace:changed')?.[1] as
      | ((_: unknown, payload: { subscriptionId: string; rootPath: string }) => void)
      | undefined
    if (!handler) {
      throw new Error('Expected preload workspace subscription handler.')
    }

    handler(undefined, { subscriptionId: 'other-watch', rootPath: '/tmp/other' })
    handler(undefined, { subscriptionId: 'watch-1', rootPath: '/tmp/project' })

    expect(received).toEqual(['/tmp/project'])

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('workspace:changed', handler)
    expect(invoke).toHaveBeenCalledWith('workspace:stop-watch', 'watch-1')
  })

  it('maps notification permission requests through the browser api and ipc permission normalizer', async () => {
    const bridge = await loadBridge()
    const notifications = bridge.notifications as {
      requestPermission: () => Promise<unknown>
      getPermissionState: () => Promise<unknown>
    }
    expect(await notifications.getPermissionState()).toEqual({ status: 'granted' })
    expect(await notifications.requestPermission()).toEqual({ status: 'granted' })
    expect(notificationRequestPermission).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('notifications:get-permission-state', 'default')
    expect(invoke).toHaveBeenCalledWith('notifications:get-permission-state', 'granted')
  })

  it('exposes global chat commands and subscriptions', async () => {
    const bridge = await loadBridge()
    const globalChat = bridge.globalChat as {
      getState: () => Promise<unknown>
      getSession: () => Promise<unknown>
      assignSession: (sessionId: string) => Promise<unknown>
      clearAssignment: () => Promise<unknown>
      onChanged: (callback: (state: unknown) => void) => () => void
      onOpenInAppRequested: (callback: (request: unknown) => void) => () => void
    }

    await globalChat.getState()
    await globalChat.getSession()
    await globalChat.assignSession('session-1')
    await globalChat.clearAssignment()

    expect(invoke).toHaveBeenCalledWith('global-chat:get-state')
    expect(invoke).toHaveBeenCalledWith('global-chat:get-session')
    expect(invoke).toHaveBeenCalledWith('global-chat:assign-session', 'session-1')
    expect(invoke).toHaveBeenCalledWith('global-chat:clear-assignment')

    const unsubscribeChanged = globalChat.onChanged(() => {})
    const changedHandler = on.mock.calls.find(
      (call) => call[0] === 'global-chat:changed',
    )?.[1] as ((_: unknown, state: unknown) => void) | undefined
    expect(typeof changedHandler).toBe('function')
    unsubscribeChanged()
    expect(removeListener).toHaveBeenCalledWith('global-chat:changed', changedHandler)

    const unsubscribeOpenRequest = globalChat.onOpenInAppRequested(() => {})
    const openRequestHandler = on.mock.calls.find(
      (call) => call[0] === 'global-chat:open-in-app-requested',
    )?.[1] as ((_: unknown, request: unknown) => void) | undefined
    expect(typeof openRequestHandler).toBe('function')
    unsubscribeOpenRequest()
    expect(removeListener).toHaveBeenCalledWith(
      'global-chat:open-in-app-requested',
      openRequestHandler,
    )
  })
})
