import { describe, expect, it } from 'vitest'
import {
  buildOllamaOptionsRecord,
  getDefaultOllamaSettings,
  normalizeOllamaSettings,
  ollamaLoadedConfigMatchesManagedProfile,
  resolveManagedOllamaProfile,
} from '../../src/shared/ollamaRuntimeConfig'

describe('ollama runtime config', () => {
  it('uses catalog maximum context for managed Gemma defaults', () => {
    const settings = getDefaultOllamaSettings(32 * 1024 ** 3)

    expect(settings.modelProfiles['gemma4:e2b']?.num_ctx).toBe(131_072)
    expect(settings.modelProfiles['gemma4:e4b']?.num_ctx).toBe(131_072)
    expect(settings.modelProfiles['gemma4:26b']?.num_ctx).toBe(262_144)
    expect(settings.modelProfiles['gemma4:31b']?.num_ctx).toBe(262_144)
  })

  it('raises persisted managed Gemma context to the catalog maximum', () => {
    const settings = normalizeOllamaSettings({
      modelProfiles: {
        'gemma4:e2b': { num_ctx: 65_536, temperature: 0.7 },
        'gemma4:26b': { num_ctx: 131_072, top_k: 32 },
        'gemma4:31b': { num_ctx: 65_536 },
      },
    }, getDefaultOllamaSettings(128 * 1024 ** 3))

    expect(settings.modelProfiles['gemma4:e2b']).toEqual(expect.objectContaining({
      num_ctx: 131_072,
      temperature: 0.7,
    }))
    expect(settings.modelProfiles['gemma4:26b']).toEqual(expect.objectContaining({
      num_ctx: 262_144,
      top_k: 32,
    }))
    expect(settings.modelProfiles['gemma4:31b']?.num_ctx).toBe(262_144)
  })

  it('builds max-context Ollama load options for guided Gemma tags', () => {
    const settings = getDefaultOllamaSettings()
    const profile = resolveManagedOllamaProfile(settings, 'gemma4:31b', 'ollama-native')
    const variantProfile = resolveManagedOllamaProfile(
      settings,
      'gemma4:31b-mlx-bf16',
      'ollama-native',
    )
    const openAiProfile = resolveManagedOllamaProfile(settings, 'gemma4:31b', 'ollama-openai')

    expect(buildOllamaOptionsRecord(profile)).toEqual(expect.objectContaining({
      num_ctx: 262_144,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    }))
    expect(buildOllamaOptionsRecord(variantProfile)).toEqual(expect.objectContaining({
      num_ctx: 262_144,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    }))
    expect(buildOllamaOptionsRecord(openAiProfile)).toEqual(expect.objectContaining({
      num_ctx: 262_144,
    }))
  })

  it('detects resident Ollama models loaded with a stale context', () => {
    const profile = getDefaultOllamaSettings().modelProfiles['gemma4:31b']

    expect(ollamaLoadedConfigMatchesManagedProfile({
      context_length: 65_536,
    }, profile)).toBe(false)
    expect(ollamaLoadedConfigMatchesManagedProfile({
      context_length: 262_144,
    }, profile)).toBe(true)
  })
})
