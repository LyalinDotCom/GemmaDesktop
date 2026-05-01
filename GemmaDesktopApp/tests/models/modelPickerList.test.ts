import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelPickerList } from '../../src/renderer/src/components/ModelPickerList'
import type { ModelSummary } from '../../src/renderer/src/types'

function makeModel(input: Partial<ModelSummary> & Pick<ModelSummary, 'id' | 'name' | 'runtimeId' | 'runtimeName'>): ModelSummary {
  return {
    status: 'available',
    ...input,
  }
}

const models: ModelSummary[] = [
  makeModel({
    id: 'gemma4:26b',
    name: 'Gemma 4 26B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama Native',
  }),
  makeModel({
    id: 'qwen3.5:35b-a3b-coding-nvfp4',
    name: 'Qwen 3.5 Coding 35B',
    runtimeId: 'lmstudio-openai',
    runtimeName: 'LM Studio',
    parameterCount: '35B',
    quantization: 'NVFP4',
    contextLength: 262_144,
    optimizationTags: ['MLX'],
    status: 'loaded',
  }),
  makeModel({
    id: 'llama3.3:70b',
    name: 'Llama 3.3 70B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama Native',
    parameterCount: '70B',
    quantization: 'Q4_K_M',
  }),
]

describe('ModelPickerList', () => {
  it('pins the selected custom model above the scrollable runtime groups', () => {
    const markup = renderToStaticMarkup(
      createElement(ModelPickerList, {
        models,
        selectedModelId: 'qwen3.5:35b-a3b-coding-nvfp4',
        selectedRuntimeId: 'lmstudio-openai',
        mode: 'build',
        pinSelectedModel: true,
      }),
    )

    expect(markup).toContain('Selected model')
    expect(markup).toContain('Qwen 3.5 Coding 35B')
    expect(markup).toContain('MLX optimized')
    expect(markup.match(/Qwen 3\.5 Coding 35B/g)).toHaveLength(1)
    expect(markup.indexOf('Selected model')).toBeLessThan(
      markup.indexOf('Llama 3.3 70B'),
    )
  })

  it('keeps the selected custom model visible when the filter hides every other row', () => {
    const markup = renderToStaticMarkup(
      createElement(ModelPickerList, {
        models,
        selectedModelId: 'qwen3.5:35b-a3b-coding-nvfp4',
        selectedRuntimeId: 'lmstudio-openai',
        mode: 'build',
        searchQuery: 'no matching model',
        pinSelectedModel: true,
      }),
    )

    expect(markup).toContain('Selected model')
    expect(markup).toContain('Qwen 3.5 Coding 35B')
    expect(markup).toContain('No other models match the current filter.')
  })

  it('renders and filters by optimization tags', () => {
    const markup = renderToStaticMarkup(
      createElement(ModelPickerList, {
        models,
        selectedModelId: 'llama3.3:70b',
        selectedRuntimeId: 'ollama-native',
        mode: 'build',
        searchQuery: 'mlx',
      }),
    )

    expect(markup).toContain('Qwen 3.5 Coding 35B')
    expect(markup).toContain('MLX optimized')
    expect(markup).not.toContain('Llama 3.3 70B')
  })
})
