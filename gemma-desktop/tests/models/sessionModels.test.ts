import { describe, expect, it } from 'vitest'
import { buildSelectableModels, resolveSessionModelContextLength } from '../../src/renderer/src/lib/sessionModels'
import type { ModelSummary } from '../../src/renderer/src/types'

function makeModel(
  input: Partial<ModelSummary> & Pick<ModelSummary, 'id' | 'runtimeId'>,
): ModelSummary {
  const { id, runtimeId, ...rest } = input

  return {
    status: 'available',
    id,
    name: id,
    runtimeId,
    runtimeName: runtimeId,
    ...rest,
  }
}

describe('resolveSessionModelContextLength', () => {
  it('borrows same-model Ollama native metadata for OpenAI-compatible sessions', () => {
    const models: ModelSummary[] = [
      makeModel({
        id: 'gemma4:31b-mlx-bf16',
        runtimeId: 'ollama-openai',
      }),
      makeModel({
        id: 'gemma4:31b-mlx-bf16',
        runtimeId: 'ollama-native',
        contextLength: 262_144,
      }),
    ]

    expect(
      resolveSessionModelContextLength(models, {
        modelId: 'gemma4:31b-mlx-bf16',
        runtimeId: 'ollama-openai',
      }),
    ).toBe(262_144)
  })

  it('uses requested runtime options before the generic fallback', () => {
    const models: ModelSummary[] = [
      makeModel({
        id: 'custom:latest',
        runtimeId: 'ollama-openai',
        runtimeConfig: {
          provider: 'ollama',
          requestedOptions: {
            num_ctx: 65_536,
          },
        },
      }),
    ]

    expect(
      resolveSessionModelContextLength(models, {
        modelId: 'custom:latest',
        runtimeId: 'ollama-openai',
      }),
    ).toBe(65_536)
  })
})

describe('buildSelectableModels', () => {
  it('carries optimization tags across same-family runtime variants', () => {
    const models: ModelSummary[] = [
      makeModel({
        id: 'minimax-m2.7-ram-90gb-mlx',
        runtimeId: 'lmstudio-openai',
      }),
      makeModel({
        id: 'minimax-m2.7-ram-90gb-mlx',
        runtimeId: 'lmstudio-native',
        optimizationTags: ['MLX'],
      }),
    ]

    expect(buildSelectableModels(models, 'build')).toContainEqual(
      expect.objectContaining({
        id: 'minimax-m2.7-ram-90gb-mlx',
        optimizationTags: ['MLX'],
      }),
    )
  })

  it('exposes canonical provider runtimes in selectable rows', () => {
    const models: ModelSummary[] = [
      makeModel({
        id: 'gemma4:31b',
        runtimeId: 'ollama-openai',
      }),
      makeModel({
        id: 'gemma4:31b',
        runtimeId: 'ollama-native',
      }),
      makeModel({
        id: 'gemma-4-31b-it-mlx',
        runtimeId: 'lmstudio-native',
      }),
      makeModel({
        id: 'gemma-4-31b-it-mlx',
        runtimeId: 'lmstudio-openai',
      }),
    ]

    expect(buildSelectableModels(models, 'build')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gemma4:31b',
          preferredRuntimeId: 'ollama-native',
        }),
        expect.objectContaining({
          id: 'gemma-4-31b-it-mlx',
          preferredRuntimeId: 'lmstudio-openai',
        }),
      ]),
    )
  })
})
