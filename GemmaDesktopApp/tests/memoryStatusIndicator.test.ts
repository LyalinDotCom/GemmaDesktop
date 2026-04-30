import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  buildRuntimeParameterChips,
  describeMemoryModelBadges,
  describeMemoryModelStack,
  describeMemoryModelStatus,
  findTokenUsageForModel,
  formatTokenCount,
  isMemoryModelMlxOptimized,
  isMemoryModelVisible,
  MemoryStatusIndicator,
  MemoryStatusPanel,
} from '../src/renderer/src/components/MemoryStatusIndicator'
import type { ModelSummary, ModelTokenUsageSnapshot } from '../src/renderer/src/types'

describe('describeMemoryModelBadges', () => {
  it('marks the loaded helper and current session roles independently', () => {
    expect(
      describeMemoryModelBadges({
        model: {
          id: 'gemma4:e2b',
          runtimeId: 'ollama-native',
        },
        selectedModelId: 'gemma4:26b',
        selectedRuntimeId: 'ollama-native',
        helperModelId: 'gemma4:e2b',
      }),
    ).toEqual(['Assistant helper'])

    expect(
      describeMemoryModelBadges({
        model: {
          id: 'gemma4:e2b',
          runtimeId: 'ollama-native',
        },
        selectedModelId: 'gemma4:e2b',
        selectedRuntimeId: 'ollama-native',
        helperModelId: 'gemma4:e2b',
      }),
    ).toEqual(['Main', 'Assistant helper'])
  })
})

describe('isMemoryModelVisible', () => {
  it('keeps loading models in the memory tooltip until they finish loading', () => {
    expect(isMemoryModelVisible({ status: 'loading' })).toBe(true)
    expect(isMemoryModelVisible({ status: 'loaded' })).toBe(true)
    expect(isMemoryModelVisible({ status: 'available' })).toBe(false)
  })

  it('labels visible runtime states explicitly', () => {
    expect(describeMemoryModelStatus({ status: 'loading' })).toBe('Loading')
    expect(describeMemoryModelStatus({ status: 'loaded' })).toBe('Loaded')
    expect(describeMemoryModelStatus({ status: 'available' })).toBeNull()
  })
})

describe('memory model compact labels', () => {
  it('describes the runtime stack without the long adapter suffix', () => {
    expect(describeMemoryModelStack({
      runtimeId: 'ollama-native',
      runtimeName: 'Ollama Native',
    })).toBe('Ollama native')
    expect(describeMemoryModelStack({
      runtimeId: 'omlx-openai',
      runtimeName: 'oMLX OpenAI-Compatible',
    })).toBe('oMLX OpenAI')
    expect(describeMemoryModelStack({
      runtimeId: 'custom-runtime',
      runtimeName: 'Custom Runtime',
    })).toBe('Custom Runtime')
  })

  it('marks oMLX and MLX-tagged models as MLX optimized', () => {
    expect(isMemoryModelMlxOptimized({
      runtimeId: 'omlx-openai',
    })).toBe(true)
    expect(isMemoryModelMlxOptimized({
      runtimeId: 'lmstudio-openai',
      optimizationTags: ['MLX'],
    })).toBe(true)
    expect(isMemoryModelMlxOptimized({
      runtimeId: 'ollama-native',
      runtimeConfig: { provider: 'ollama' },
    })).toBe(false)
  })
})

describe('formatTokenCount', () => {
  it('formats small numbers with thousands separators', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(9999)).toBe('9,999')
  })

  it('abbreviates large numbers', () => {
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(123_456)).toBe('123k')
    expect(formatTokenCount(1_234_567)).toBe('1.23M')
    expect(formatTokenCount(25_678_900)).toBe('25.7M')
  })
})

describe('findTokenUsageForModel', () => {
  const snapshot: ModelTokenUsageSnapshot = {
    runtimeId: 'ollama-native',
    modelId: 'gemma4:26b',
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 1500,
    turns: 3,
    lastUpdatedMs: 1,
  }

  it('returns the exact runtime+model match when present', () => {
    expect(
      findTokenUsageForModel([snapshot], {
        id: 'gemma4:26b',
        runtimeId: 'ollama-native',
      }),
    ).toEqual(snapshot)
  })

  it('falls back to a model-id-only match when runtime differs', () => {
    expect(
      findTokenUsageForModel([snapshot], {
        id: 'gemma4:26b',
        runtimeId: 'ollama-openai',
      }),
    ).toEqual(snapshot)
  })

  it('returns null when no match is found', () => {
    expect(
      findTokenUsageForModel([snapshot], {
        id: 'gemma4:e2b',
        runtimeId: 'ollama-native',
      }),
    ).toBeNull()
  })
})

describe('buildRuntimeParameterChips', () => {
  it('renders context length, GPU residency, and all configured parameters', () => {
    const model: ModelSummary = {
      id: 'gemma4:26b',
      name: 'Gemma 4 26B',
      runtimeId: 'ollama-native',
      runtimeName: 'Ollama',
      status: 'loaded',
      runtimeConfig: {
        provider: 'ollama',
        baseParameters: { stop: '</s>' },
        requestedOptions: {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          num_predict: 512,
          mirostat: 2,
          num_ctx: 32000,
        },
        loadedContextLength: 32768,
        approxGpuResidencyPercent: 100,
      },
    }

    const chips = buildRuntimeParameterChips(model)
    expect(chips).toEqual([
      '32.8k ctx',
      '100% GPU',
      'temperature 0.7',
      'top p 0.9',
      'top k 40',
      'num predict 512',
      'mirostat 2',
      'stop </s>',
    ])
  })

  it('returns empty list when there is no runtime config', () => {
    expect(
      buildRuntimeParameterChips({
        id: 'fake',
        name: 'fake',
        runtimeId: 'fake',
        runtimeName: 'fake',
        status: 'loaded',
      }),
    ).toEqual([])
  })

  it('shows oMLX requested context separately from the live runtime limit', () => {
    const model: ModelSummary = {
      id: 'gemma-4-26b-a4b-it-nvfp4',
      name: 'Gemma 4 26B',
      runtimeId: 'omlx-openai',
      runtimeName: 'oMLX',
      status: 'loaded',
      runtimeConfig: {
        provider: 'omlx',
        requestedOptions: {
          max_context_window: 262_144,
          max_tokens: 32_768,
          temperature: 1,
          top_p: 0.95,
          top_k: 64,
        },
        loadedContextLength: 32_768,
      },
    }

    expect(buildRuntimeParameterChips(model)).toEqual([
      '262.1k ctx requested',
      '32.8k ctx runtime',
      'temperature 1',
      'top p 0.95',
      'top k 64',
      'max tokens 32768',
    ])
  })
})

describe('MemoryStatusIndicator layout', () => {
  const systemStats = {
    memoryUsedGB: 42,
    memoryTotalGB: 96,
    gpuUsagePercent: 10,
    cpuUsagePercent: 20,
  }
  const model: ModelSummary = {
    id: 'gemma4:e2b',
    name: 'Gemma 4 E2B',
    runtimeId: 'ollama-native',
    runtimeName: 'Ollama',
    status: 'loaded',
    parameterCount: '5.1B',
    quantization: 'Q4_K_M',
  }

  it('renders the memory control as a persistent toggle button', () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryStatusIndicator, {
        systemStats,
        models: [model],
        panelOpen: true,
        onTogglePanel: () => {},
      }),
    )

    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('42GB')
    expect(markup).not.toContain('role="tooltip"')
  })

  it('renders a compact expandable row for loaded model details inside the pinned memory panel', () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryStatusPanel, {
        systemStats,
        models: [model],
        selectedModelId: 'gemma4:e2b',
        selectedRuntimeId: 'ollama-native',
        helperModelId: 'gemma4:e2b',
        helperRuntimeId: 'ollama-native',
        onReloadModels: () => {},
      }),
    )

    expect(markup).toContain('Model Memory (1)')
    expect(markup).toContain('aria-label="Reload expected models"')
    expect(markup).toContain('<details')
    expect(markup).toContain('<summary')
    expect(markup).not.toContain('<details open')
    expect(markup).toContain('Gemma 4 E2B')
    expect(markup).toContain('Ollama native')
    expect(markup).toContain('Not MLX')
    expect(markup).toContain('Main')
    expect(markup).toContain('Assistant helper')
    expect(markup).toContain('Q4_K_M')
  })

  it('labels token usage as elapsed since the first completed turn', () => {
    const usage: ModelTokenUsageSnapshot = {
      runtimeId: 'ollama-native',
      modelId: 'gemma4:e2b',
      inputTokens: 7000,
      outputTokens: 2856,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 9856,
      turns: 2,
      lastUpdatedMs: Date.now(),
    }

    const markup = renderToStaticMarkup(
      createElement(MemoryStatusPanel, {
        systemStats,
        models: [model],
        modelTokenUsage: {
          startedAtMs: Date.now() - 5000,
          usage: [usage],
        },
      }),
    )

    expect(markup).toContain('Session tokens')
    expect(markup).toContain('9,856')
    expect(markup).toContain('2 turns')
    expect(markup).toContain('since first turn')
    expect(markup).not.toContain('since app start')
  })

  it('shows reload progress in the pinned memory panel action', () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryStatusPanel, {
        systemStats,
        models: [model],
        reloadModelsBusy: true,
        onReloadModels: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Reload expected models"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('animate-spin')
  })
})
