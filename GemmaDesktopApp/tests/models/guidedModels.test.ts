import { describe, expect, it } from 'vitest'
import {
  buildGuidedGemmaModels,
  resolveDefaultAutomationModelTarget,
  buildOtherSelectableModels,
  resolveDefaultResearchModelTarget,
  resolveDefaultInteractiveSessionTarget,
  resolveDefaultSessionModelTarget,
  resolveGuidedModelSelectionState,
  sortGuidedGemmaModelsHighestFirst,
} from '../../src/renderer/src/lib/guidedModels'
import type { GemmaInstallState, ModelSummary } from '../../src/renderer/src/types'
import { DEFAULT_MODEL_SELECTION_SETTINGS } from '../../src/shared/sessionModelDefaults'

function makeModel(input: Partial<ModelSummary> & Pick<ModelSummary, 'id'>): ModelSummary {
  return {
    id: input.id,
    name: input.name ?? input.id,
    runtimeId: input.runtimeId ?? 'ollama-native',
    runtimeName: input.runtimeName ?? 'Ollama Native',
    parameterCount: input.parameterCount,
    quantization: input.quantization,
    contextLength: input.contextLength,
    status: input.status ?? 'available',
  }
}

describe('guided Gemma model helpers', () => {
  it('projects the hard-coded Gemma catalog onto discovered Ollama models', () => {
    const models = [
      makeModel({
        id: 'gemma4:e4b',
        name: 'Gemma 4 E4B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'loaded',
      }),
    ]

    const guided = buildGuidedGemmaModels(models)

    expect(guided.map((entry) => entry.tag)).toEqual([
      'gemma4:e2b',
      'gemma4:e4b',
      'gemma4:26b',
      'gemma4:31b',
    ])
    expect(guided.find((entry) => entry.tag === 'gemma4:e4b')?.availability).toBe(
      'available',
    )
    expect(guided.find((entry) => entry.tag === 'gemma4:31b')?.availability).toBe(
      'loaded',
    )
  })

  it('sorts guided Gemma sizes from highest to lowest capability', () => {
    const ordered = sortGuidedGemmaModelsHighestFirst(
      buildGuidedGemmaModels([]),
    )

    expect(ordered.map((entry) => entry.tag)).toEqual([
      'gemma4:31b',
      'gemma4:26b',
      'gemma4:e4b',
      'gemma4:e2b',
    ])
  })

  it('keeps guided Gemma sizes out of the fallback Other models list while preserving cloud tags', () => {
    const models = [
      makeModel({
        id: 'gemma4:e4b',
        name: 'Gemma 4 E4B',
      }),
      makeModel({
        id: 'gemma4:e4b-mlx-bf16',
        name: 'Gemma 4 E4B MLX BF16',
      }),
      makeModel({
        id: 'gemma4:31b-cloud',
        name: 'Gemma 4 31B Cloud',
      }),
      makeModel({
        id: 'google/gemma-4-27b-it-qat',
        name: 'Gemma 4 27B IT QAT',
        runtimeId: 'lmstudio-openai',
        runtimeName: 'LM Studio',
      }),
      makeModel({
        id: 'qwen3:8b',
        name: 'Qwen3 8B',
      }),
    ]

    const otherModels = buildOtherSelectableModels(models, 'explore')

    expect(otherModels.map((model) => model.id)).toEqual([
      'google/gemma-4-27b-it-qat',
      'gemma4:31b-cloud',
      'qwen3:8b',
    ])
  })

  it('defaults empty selections to the mode default and preserves existing non-Gemma sessions as Other models', () => {
    const models = [
      makeModel({
        id: 'qwen3:8b',
        name: 'Qwen3 8B',
        runtimeId: 'ollama-native',
      }),
    ]

    const emptySelection = resolveGuidedModelSelectionState(
      models,
      'explore',
      {},
    )
    const otherSelection = resolveGuidedModelSelectionState(
      models,
      'explore',
      {
        modelId: 'qwen3:8b',
        runtimeId: 'ollama-native',
      },
    )

    expect(emptySelection.family).toBe('gemma')
    expect(emptySelection.gemma?.tag).toBe('gemma4:26b')
    expect(otherSelection.family).toBe('other')
    expect(otherSelection.otherModel?.id).toBe('qwen3:8b')
  })

  it('maps Ollama Gemma variants onto the guided size ladder', () => {
    const models = [
      makeModel({
        id: 'gemma4:e4b-mlx-bf16',
        name: 'Gemma 4 E4B MLX BF16',
        status: 'loaded',
      }),
      makeModel({
        id: 'gemma4:31b-mlx-bf16',
        name: 'Gemma 4 31B MLX BF16',
        status: 'available',
      }),
    ]

    const guided = buildGuidedGemmaModels(models)
    const medium = guided.find((entry) => entry.tier === 'medium')
    const extraHighSelection = resolveGuidedModelSelectionState(
      models,
      'explore',
      {
        modelId: 'gemma4:31b-mlx-bf16',
        runtimeId: 'ollama-native',
      },
    )

    expect(medium?.availability).toBe('loaded')
    expect(medium?.model?.id).toBe('gemma4:e4b-mlx-bf16')
    expect(extraHighSelection.family).toBe('gemma')
    expect(extraHighSelection.gemma?.tier).toBe('extra-high')
  })

  it('defaults sessions by mode and lets saved settings override the built-in policy', () => {
    const models = [
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'available',
      }),
    ]
    const installs: GemmaInstallState[] = [
      {
        tag: 'gemma4:e4b',
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        progressText: 'Pulling',
      },
    ]

    const exploreDefault = resolveDefaultSessionModelTarget(models, 'explore')
    const buildDefault = resolveDefaultSessionModelTarget(models, 'build')
    const withSmallerGemmaAlsoInstalled = resolveDefaultSessionModelTarget([
      ...models,
      makeModel({
        id: 'gemma4:e4b',
        name: 'Gemma 4 E4B',
        status: 'available',
      }),
    ], 'explore')
    const withInstallState = resolveDefaultSessionModelTarget(
      models,
      'explore',
      installs,
    )
    const withPersistedCustomDefault = resolveDefaultSessionModelTarget(
      models,
      'explore',
      installs,
      {
        ...DEFAULT_MODEL_SELECTION_SETTINGS,
        mainModel: {
          modelId: 'qwen3:8b',
          runtimeId: 'lmstudio-openai',
        },
      },
    )

    expect(exploreDefault).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(buildDefault).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(withSmallerGemmaAlsoInstalled).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(withInstallState).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(withPersistedCustomDefault).toEqual({
      modelId: 'qwen3:8b',
      runtimeId: 'lmstudio-openai',
    })
  })

  it('uses the same default model target for new interactive sessions', () => {
    const models = [
      makeModel({
        id: 'gemma4:e2b',
        name: 'Gemma 4 E2B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'available',
      }),
    ]

    const target = resolveDefaultInteractiveSessionTarget(models, 'explore')

    expect(target).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
  })

  it('keeps research conversations on the memory-aware primary default target', () => {
    const models = [
      makeModel({
        id: 'gemma4:e2b',
        name: 'Gemma 4 E2B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'loaded',
      }),
    ]
    const target = resolveDefaultResearchModelTarget(models)
    const persistedCustomDefault = resolveDefaultResearchModelTarget(
      models,
      [],
      {
        ...DEFAULT_MODEL_SELECTION_SETTINGS,
        mainModel: {
          modelId: 'qwen3:14b',
          runtimeId: 'ollama-native',
        },
      },
    )

    expect(target).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(persistedCustomDefault).toEqual({
      modelId: 'qwen3:14b',
      runtimeId: 'ollama-native',
    })
  })

  it('defaults automations to the same saved primary Gemma target', () => {
    const prefers26B = resolveDefaultAutomationModelTarget([
      makeModel({
        id: 'gemma4:26b',
        name: 'Gemma 4 26B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'loaded',
      }),
    ])
    const fallsBackToStrongestInstalled = resolveDefaultAutomationModelTarget([
      makeModel({
        id: 'gemma4:e4b',
        name: 'Gemma 4 E4B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:31b',
        name: 'Gemma 4 31B',
        status: 'loaded',
      }),
    ])
    const persistedCustomDefault = resolveDefaultAutomationModelTarget(
      [],
      [],
      {
        ...DEFAULT_MODEL_SELECTION_SETTINGS,
        mainModel: {
          modelId: 'gemma4:e4b',
          runtimeId: 'ollama-native',
        },
      },
    )

    expect(prefers26B).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(fallsBackToStrongestInstalled).toEqual({
      modelId: 'gemma4:26b',
      runtimeId: 'ollama-native',
    })
    expect(persistedCustomDefault).toEqual({
      modelId: 'gemma4:e4b',
      runtimeId: 'ollama-native',
    })
  })

  it('treats explicit Gemma targets as Gemma selections and falls back to the mode default when empty', () => {
    const models = [
      makeModel({
        id: 'gemma4:e2b',
        name: 'Gemma 4 E2B',
        status: 'available',
      }),
      makeModel({
        id: 'gemma4:26b',
        name: 'Gemma 4 26B',
        status: 'loaded',
      }),
    ]

    const defaultSelection = resolveGuidedModelSelectionState(
      models,
      'build',
      {},
    )
    const explicitSelection = resolveGuidedModelSelectionState(
      models,
      'build',
      {
        modelId: 'gemma4:26b',
        runtimeId: 'ollama-native',
      },
    )

    expect(defaultSelection.family).toBe('gemma')
    expect(defaultSelection.gemma?.tag).toBe('gemma4:26b')
    expect(explicitSelection.family).toBe('gemma')
    expect(explicitSelection.gemma?.tag).toBe('gemma4:26b')
  })
})
