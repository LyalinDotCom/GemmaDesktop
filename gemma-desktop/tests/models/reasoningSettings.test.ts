import { describe, expect, it } from 'vitest'
import {
  getDefaultReasoningSettings,
  normalizeReasoningSettings,
  resolveModelReasoningMode,
  supportsReasoningControlForModel,
} from '../../src/shared/reasoningSettings'

describe('reasoning settings helpers', () => {
  it('defaults Gemma reasoning to on', () => {
    expect(
      resolveModelReasoningMode(
        getDefaultReasoningSettings(),
        'gemma4:31b',
      ),
    ).toBe('on')
  })

  it('normalizes legacy persisted overrides away', () => {
    const normalized = normalizeReasoningSettings({
      modelModes: {
        'gemma4:e2b': 'on',
        'gemma4:26b': 'auto',
        'gemma4:31b': 'off',
        '': 'on',
        'bad:model': 'sideways',
      },
    })

    expect(normalized).toEqual({
      modelModes: {},
    })
  })

  it('only exposes explicit reasoning control for guided Gemma on Ollama', () => {
    expect(
      supportsReasoningControlForModel('gemma4:31b', 'ollama-native'),
    ).toBe(true)
    expect(
      supportsReasoningControlForModel('gemma4:31b-mlx-bf16', 'ollama-native'),
    ).toBe(true)
    expect(
      supportsReasoningControlForModel('gemma4:31b', 'lmstudio-native'),
    ).toBe(false)
    expect(
      supportsReasoningControlForModel('qwen3:8b', 'ollama-native'),
    ).toBe(false)
  })
})
