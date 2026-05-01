import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_SELECTION_SETTINGS,
  DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES,
  createDefaultModelSelectionSettings,
  normalizeAppModelSelectionSettings,
  normalizeProviderRuntimeId,
  normalizeSessionPrimaryModelTarget,
  resolveDefaultPrimaryModelIdForMemory,
  resolveConfiguredHelperModelTarget,
  resolveConfiguredSessionPrimaryTarget,
  resolveHelperModelEnabled,
  resolveSavedDefaultSessionPrimaryTarget,
} from '../../src/shared/sessionModelDefaults'

describe('session model defaults', () => {
  it('defaults main work by memory and helper work to the lowest Gemma model', () => {
    expect(
      resolveDefaultPrimaryModelIdForMemory(
        DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES - 1,
      ),
    ).toBe('gemma4:26b')
    expect(
      resolveDefaultPrimaryModelIdForMemory(
        DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES + 1,
      ),
    ).toBe('gemma4:31b')
    expect(
      resolveDefaultPrimaryModelIdForMemory(
        DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES,
      ),
    ).toBe('gemma4:26b')
    expect(
      createDefaultModelSelectionSettings(
        DEFAULT_PRIMARY_MODEL_MEMORY_THRESHOLD_BYTES + 1,
      ).mainModel,
    ).toEqual({
      modelId: 'gemma4:31b',
      runtimeId: 'ollama-native',
    })

    expect(
      resolveConfiguredSessionPrimaryTarget(
        {
          conversationKind: 'normal',
          baseMode: 'explore',
        },
      ),
    ).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })

    expect(resolveConfiguredHelperModelTarget()).toEqual({
      modelId: 'gemma4:e2b',
      runtimeId: 'ollama-native',
    })
    expect(resolveHelperModelEnabled()).toBe(true)
  })

  it('uses the saved default main model across conversation kinds', () => {
    const modelSelection = {
      ...DEFAULT_MODEL_SELECTION_SETTINGS,
      mainModel: {
        modelId: 'qwen3:8b',
        runtimeId: 'lmstudio-openai',
      },
    }

    expect(
      resolveConfiguredSessionPrimaryTarget(
        {
          conversationKind: 'normal',
          baseMode: 'explore',
        },
        modelSelection,
      ),
    ).toEqual(modelSelection.mainModel)
    expect(
      resolveConfiguredSessionPrimaryTarget(
        {
          conversationKind: 'normal',
          baseMode: 'build',
        },
        modelSelection,
      ),
    ).toEqual(modelSelection.mainModel)
    expect(
      resolveConfiguredSessionPrimaryTarget(
        {
          conversationKind: 'research',
          baseMode: 'explore',
        },
        modelSelection,
      ),
    ).toEqual(modelSelection.mainModel)
  })

  it('normalizes persisted model settings while preserving valid overrides', () => {
    expect(
      normalizeAppModelSelectionSettings({
        mainModel: {
          modelId: 'qwen3:8b',
          runtimeId: 'lmstudio-openai',
        },
        helperModel: {
          modelId: 'gemma4:e4b',
          runtimeId: 'ollama-native',
        },
      }),
    ).toEqual({
      mainModel: {
        modelId: 'qwen3:8b',
        runtimeId: 'lmstudio-openai',
      },
      helperModel: {
        modelId: 'gemma4:e4b',
        runtimeId: 'ollama-native',
      },
      helperModelEnabled: true,
    })

    expect(
      normalizeAppModelSelectionSettings({
        mainModel: {
          modelId: 'qwen3:8b',
          runtimeId: 'lmstudio-openai',
        },
        helperModel: {
          modelId: 'gemma4:e4b',
          runtimeId: 'ollama-native',
        },
        helperModelEnabled: false,
      }).helperModelEnabled,
    ).toBe(false)
  })

  it('normalizes saved provider defaults onto each provider canonical API', () => {
    expect(normalizeProviderRuntimeId('lmstudio-native')).toBe('lmstudio-openai')
    expect(normalizeProviderRuntimeId('ollama-openai')).toBe('ollama-native')
    expect(normalizeProviderRuntimeId('ollama-native')).toBe('ollama-native')

    expect(
      normalizeSessionPrimaryModelTarget({
        modelId: 'gemma-4-31b-it-mlx',
        runtimeId: 'lmstudio-native',
      }),
    ).toEqual({
      modelId: 'gemma-4-31b-it-mlx',
      runtimeId: 'lmstudio-openai',
    })

    expect(
      normalizeAppModelSelectionSettings({
        mainModel: {
          modelId: 'gemma-4-31b-it-mlx',
          runtimeId: 'lmstudio-native',
        },
        helperModel: {
          modelId: 'gemma4:e4b',
          runtimeId: 'ollama-native',
        },
      }).mainModel,
    ).toEqual({
      modelId: 'gemma-4-31b-it-mlx',
      runtimeId: 'lmstudio-openai',
    })

    expect(
      normalizeSessionPrimaryModelTarget({
        modelId: 'gemma4:31b',
        runtimeId: 'ollama-openai',
      }),
    ).toEqual({
      modelId: 'gemma4:31b',
      runtimeId: 'ollama-native',
    })
  })

  it('uses persisted custom model settings as the default targets', () => {
    const modelSelection = {
      mainModel: {
        modelId: 'qwen3:8b',
        runtimeId: 'lmstudio-openai',
      },
      helperModel: {
        modelId: 'gemma4:e4b',
        runtimeId: 'ollama-native',
      },
      helperModelEnabled: false,
    }

    expect(resolveSavedDefaultSessionPrimaryTarget(modelSelection)).toEqual(modelSelection.mainModel)
    expect(resolveConfiguredHelperModelTarget(modelSelection)).toEqual(modelSelection.helperModel)
    expect(resolveHelperModelEnabled(modelSelection)).toBe(false)
  })
})
