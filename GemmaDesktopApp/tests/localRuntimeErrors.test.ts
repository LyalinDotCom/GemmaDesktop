import { describe, expect, it } from 'vitest'
import {
  LocalRuntimeUnavailableError,
  isLocalRuntimeConnectionFailure,
  isModelNotLoadedError,
  toLocalRuntimeUnavailableError,
} from '../src/main/localRuntimeErrors'

describe('local runtime errors', () => {
  it('detects connection failures from nested fetch causes', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
        code: 'ECONNREFUSED',
      }),
    })

    expect(isLocalRuntimeConnectionFailure(error)).toBe(true)
  })

  it('wraps offline runtime failures with an actionable provider message', () => {
    const raw = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
      code: 'ECONNREFUSED',
    })
    const wrapped = toLocalRuntimeUnavailableError(raw, {
      runtimeId: 'lmstudio-openai',
      endpoint: 'http://127.0.0.1:1234',
      modelId: 'qwen3:8b',
      action: 'loading',
    })

    expect(wrapped).toBeInstanceOf(LocalRuntimeUnavailableError)
    expect(wrapped?.message).toContain('LM Studio is not reachable')
    expect(wrapped?.message).toContain('http://127.0.0.1:1234')
    expect(wrapped?.message).toContain('Start LM Studio')
  })

  it('does not classify model-side HTTP errors as offline providers', () => {
    expect(
      toLocalRuntimeUnavailableError(new Error('404 model not found'), {
        runtimeId: 'ollama-native',
        endpoint: 'http://127.0.0.1:11434',
        modelId: 'gemma4:26b',
      }),
    ).toBeNull()
  })

  it('recognizes benign unload misses from model lifecycle endpoints', () => {
    const error = new Error(JSON.stringify({
      error: {
        message: 'Model not loaded: gemma-4-26b-a4b-it-nvfp4',
        type: 'invalid_request_error',
      },
    }))

    expect(isModelNotLoadedError(error)).toBe(true)
  })
})
