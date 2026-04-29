import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DefaultModelTargetPicker,
  SettingsModal,
  formatDefaultModelOptionLabel,
  groupDefaultModelOptions,
  type DefaultModelOption,
  type SettingsTab,
} from '../src/renderer/src/components/SettingsModal'
import type { AppSettings, BootstrapState, ModelSummary } from '../src/renderer/src/types'
import { getDefaultLmStudioSettings } from '../src/shared/lmstudioRuntimeConfig'
import { getDefaultOllamaSettings } from '../src/shared/ollamaRuntimeConfig'
import { getDefaultReasoningSettings } from '../src/shared/reasoningSettings'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '../src/shared/sessionModelDefaults'
import { ASK_GEMINI_DEFAULT_MODEL } from '../src/shared/geminiModels'

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

const bootstrapState: BootstrapState = {
  status: 'ready',
  ready: true,
  message: 'Ready',
  helperModelId: 'gemma4:e2b',
  helperRuntimeId: 'ollama-native',
  requiredPrimaryModelIds: ['gemma4:26b'],
  updatedAt: 0,
}

function renderSettingsModal(
  initialTab: SettingsTab = 'general',
  models: ModelSummary[] = [],
): string {
  return renderToStaticMarkup(
    createElement(SettingsModal, {
      settings: makeSettings(),
      defaultModelSelection: {
        mainModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.mainModel },
        helperModel: { ...DEFAULT_MODEL_SELECTION_SETTINGS.helperModel },
      },
      models,
      gemmaInstallStates: [],
      bootstrapState,
      onClose: () => {},
      onUpdate: () => {},
      onEnsureGemmaModel: async (tag: string) => ({
        ok: true,
        tag,
        installed: true,
      }),
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
    }),
  )
}

function modelOption(
  modelId: string,
  label: string,
  runtimeId: string,
  providerLabel: string,
  apiTypeLabel: string,
): DefaultModelOption {
  return {
    modelId,
    runtimeId,
    label,
    providerLabel,
    apiTypeLabel,
  }
}

describe('SettingsModal layout', () => {
  it('renders settings sections as a vertical sidebar', () => {
    const markup = renderSettingsModal()

    expect(markup).toContain('max-w-4xl')
    expect(markup).toContain('aria-label="Settings sections"')
    expect(markup).toContain('w-44 shrink-0 overflow-y-auto border-r')
    expect(markup).toContain('Integrations')
    expect(markup).toContain('aria-current="page"')
    expect(markup).not.toContain('border-b-2 pb-2.5 pt-3')
  })

  it('renders searchable saved default model pickers in general settings', () => {
    const markup = renderSettingsModal('general', [
      {
        id: 'qwen3:8b',
        name: 'Qwen3 8B',
        runtimeId: 'lmstudio-openai',
        runtimeName: 'LM Studio',
        status: 'available',
      },
    ])

    expect(markup).toContain('aria-label="Default main model"')
    expect(markup).toContain('aria-label="Default helper model"')
    expect(markup).toContain('aria-haspopup="listbox"')
    expect(markup).toContain('gemma4:26b')
    expect(markup).toContain('Ollama · Native API')
    expect(markup).not.toContain('<optgroup')
  })

  it('groups saved default model options by provider and sorts inside each group', () => {
    const groups = groupDefaultModelOptions([
      modelOption('zeta:7b', 'Zeta 7B', 'lmstudio-openai', 'LM Studio', 'OpenAI-compatible API'),
      modelOption('qwen3:8b', 'Qwen3 8B', 'lmstudio-openai', 'LM Studio', 'OpenAI-compatible API'),
      modelOption('alpha:7b', 'Alpha 7B', 'lmstudio-openai', 'LM Studio', 'OpenAI-compatible API'),
      modelOption('qwen3:8b', 'Qwen3 8B', 'lmstudio-native', 'LM Studio', 'Native API'),
      modelOption('gemma4:26b', 'Gemma 4 26B', 'ollama-native', 'Ollama', 'Native API'),
    ])

    expect(groups.map((group) => group.providerLabel)).toEqual([
      'LM Studio',
      'Ollama',
    ])
    expect(groups[0]?.options.map(formatDefaultModelOptionLabel)).toEqual([
      'Alpha 7B - LM Studio - OpenAI-compatible API',
      'Qwen3 8B - LM Studio - Native API',
      'Qwen3 8B - LM Studio - OpenAI-compatible API',
      'Zeta 7B - LM Studio - OpenAI-compatible API',
    ])
  })

  it('opens default model pickers as bounded searchable lists', () => {
    const groups = groupDefaultModelOptions([
      modelOption('alpha:7b', 'Alpha 7B', 'lmstudio-openai', 'LM Studio', 'OpenAI-compatible API'),
      modelOption('gemma4:26b', 'Gemma 4 26B', 'ollama-native', 'Ollama', 'Native API'),
    ])
    const markup = renderToStaticMarkup(
      createElement(DefaultModelTargetPicker, {
        ariaLabel: 'Default main model',
        value: {
          modelId: 'gemma4:26b',
          runtimeId: 'ollama-native',
        },
        groups,
        onSelect: () => {},
        initialOpen: true,
      }),
    )

    expect(markup).toContain('Filter by model, provider, or API...')
    expect(markup).toContain('role="listbox"')
    expect(markup).toContain('max-h-64 overflow-y-auto overscroll-contain')
    expect(markup).toContain('LM Studio')
    expect(markup).toContain('Alpha 7B')
  })

  it('does not expose reasoning-off controls on Ollama model cards', () => {
    const markup = renderSettingsModal('ollama')

    expect(markup).not.toContain('Reasoning Preference')
    expect(markup).not.toContain('speed-over-depth tradeoff for this model')
    expect(markup).not.toContain('aria-label="Reasoning mode for gemma4:26b"')
    expect(markup).not.toContain('title="Set gemma4:26b reasoning to off"')
  })

  it('surfaces the Ollama keep-alive switch in runtime settings', () => {
    const markup = renderSettingsModal('runtimes')

    expect(markup).toContain('Keep Ollama models warm')
    expect(markup).toContain('aria-label="Toggle Ollama model keep-alive"')
    expect(markup).toContain('Doctor reports server-level setting drift')
    expect(markup).toContain('keepAlive=on')
  })

  it('surfaces Gemini API settings for grounded web search', () => {
    const markup = renderSettingsModal('integrations')

    expect(markup).toContain('Gemini API (web search)')
    expect(markup).toContain('Gemini CLI (Ask Gemini)')
    expect(markup).toContain(ASK_GEMINI_DEFAULT_MODEL)
    expect(markup).toContain('aistudio.google.com/app/apikey')
    expect(markup).toContain('gemini-3-flash-preview')
  })
})
