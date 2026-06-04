/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal'
import type { AppSettings } from '../../src/renderer/src/types'
import { getDefaultGeminiApiSettings } from '../../src/shared/geminiApiRuntimeConfig'
import { ASK_GEMINI_DEFAULT_MODEL } from '../../src/shared/geminiModels'
import { getDefaultLmStudioSettings } from '../../src/shared/lmstudioRuntimeConfig'
import { getDefaultOllamaSettings } from '../../src/shared/ollamaRuntimeConfig'
import { getDefaultOmlxSettings } from '../../src/shared/omlxRuntimeConfig'
import { getDefaultReasoningSettings } from '../../src/shared/reasoningSettings'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '../../src/shared/sessionModelDefaults'

function makeSettings(): AppSettings {
  return {
    theme: 'system',
    enterToSend: true,
    defaultMode: 'explore',
    defaultProjectDirectory: '',
    terminal: {
      preferredAppId: null,
    },
    modelSelection: {
      mainModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.mainModel },
      helperModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.helperModel },
      helperModelEnabled: DEFAULT_MODEL_SELECTION_SETTINGS.helperModelEnabled,
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
    reasoning: getDefaultReasoningSettings(),
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
        allowedTools: [],
      },
      build: {
        allowedTools: [],
      },
    },
    runtimes: {
      ollama: {
        endpoint: 'http://127.0.0.1:11434',
        numParallel: 2,
        maxLoadedModels: 2,
        keepAliveEnabled: true,
      },
      lmstudio: {
        endpoint: 'http://127.0.0.1:1234',
        maxConcurrentPredictions: 4,
      },
      llamacpp: {
        endpoint: 'http://127.0.0.1:8080',
      },
      litertlm: {
        endpoint: 'http://127.0.0.1:9379',
      },
      omlx: {
        endpoint: 'http://127.0.0.1:8000',
        apiKey: '',
      },
    },
    integrations: {
      geminiApi: getDefaultGeminiApiSettings(),
      geminiCli: {
        model: ASK_GEMINI_DEFAULT_MODEL,
      },
    },
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function blurInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

describe('SettingsModal text inputs', () => {
  let container: HTMLDivElement
  let root: Root
  let originalScrollToDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalScrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')
    Object.defineProperty(Element.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })

    vi.stubGlobal('gemmaDesktopBridge', {
      terminals: {
        listInstalled: vi.fn(async () => []),
      },
      talk: {
        listSessions: vi.fn(async () => []),
      },
      sessions: {
        list: vi.fn(async () => []),
      },
      appData: {
        reset: vi.fn(),
      },
      settings: {
        get: vi.fn(async () => makeSettings()),
      },
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    if (originalScrollToDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollTo', originalScrollToDescriptor)
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollTo')
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  function renderSettings(
    onUpdate: (patch: Partial<AppSettings>) => void | Promise<void>,
    initialTab: 'gemini' | 'integrations',
  ): void {
    act(() => {
      root.render(createElement(SettingsModal, {
        settings: makeSettings(),
        models: [],
        onClose: () => {},
        onUpdate,
        initialTab,
        speechStatus: null,
        readAloudStatus: null,
        notificationPermission: {
          status: 'unsupported',
          promptPending: false,
        },
        onInstallSpeech: () => {},
        onRepairSpeech: () => {},
        onRemoveSpeech: () => {},
        onTestReadAloud: () => {},
        onRequestNotificationPermission: () => {},
        onSendTestNotification: () => {},
      }))
    })
  }

  it('keeps Gemini API key typing local until blur', async () => {
    const onUpdate = vi.fn<(patch: Partial<AppSettings>) => void>()
    renderSettings(onUpdate, 'gemini')

    const input = container.querySelector<HTMLInputElement>('input[placeholder="AIza..."]')
    expect(input).not.toBeNull()

    await act(async () => {
      setInputValue(input!, 'AIza-partial-key')
    })

    expect(input?.value).toBe('AIza-partial-key')
    expect(onUpdate).not.toHaveBeenCalled()

    await act(async () => {
      blurInput(input!)
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.lastCall?.[0].integrations?.geminiApi.apiKey).toBe('AIza-partial-key')
  })

  it('keeps Gemini CLI model typing local until blur', async () => {
    const onUpdate = vi.fn<(patch: Partial<AppSettings>) => void>()
    renderSettings(onUpdate, 'integrations')

    const input = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((entry) => entry.value === ASK_GEMINI_DEFAULT_MODEL)
    expect(input).not.toBeUndefined()

    await act(async () => {
      setInputValue(input!, 'gemini-3-pro-preview')
    })

    expect(input?.value).toBe('gemini-3-pro-preview')
    expect(onUpdate).not.toHaveBeenCalled()

    await act(async () => {
      blurInput(input!)
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.lastCall?.[0].integrations?.geminiCli.model).toBe('gemini-3-pro-preview')
  })
})
