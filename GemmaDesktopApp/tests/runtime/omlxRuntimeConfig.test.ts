import { describe, expect, it } from 'vitest'
import {
  buildOmlxDisplayOptionsRecord,
  buildOmlxModelSettingsRecord,
  buildOmlxRequestOptionsRecord,
  getDefaultOmlxSettings,
  normalizeOmlxSettings,
  normalizeOmlxManagedModelProfile,
  resolveManagedOmlxProfile,
} from '../../src/shared/omlxRuntimeConfig'

describe('omlx runtime config', () => {
  it('uses memory-aware context for managed Gemma defaults', () => {
    const settings = getDefaultOmlxSettings(32 * 1024 ** 3)
    const highMemorySettings = getDefaultOmlxSettings(128 * 1024 ** 3)

    expect(settings.modelProfiles['gemma4:26b']?.max_context_window).toBe(131_072)
    expect(settings.modelProfiles['gemma4:31b']?.max_context_window).toBe(65_536)
    expect(highMemorySettings.modelProfiles['gemma4:26b']?.max_context_window).toBe(262_144)
    expect(highMemorySettings.modelProfiles['gemma4:31b']?.max_context_window).toBe(262_144)
  })

  it('keeps persisted managed Gemma context at or below the catalog maximum', () => {
    const settings = normalizeOmlxSettings({
      modelProfiles: {
        'gemma4:26b': { max_context_window: 131_072 },
        'gemma4:31b': { max_context_window: 65_536 },
      },
    }, getDefaultOmlxSettings(128 * 1024 ** 3))

    expect(settings.modelProfiles['gemma4:26b']?.max_context_window).toBe(131_072)
    expect(settings.modelProfiles['gemma4:31b']?.max_context_window).toBe(65_536)
  })

  it('infers Gemma defaults from oMLX model identifiers', () => {
    const profile = resolveManagedOmlxProfile(
      undefined,
      'gemma-4-26b-a4b-it-nvfp4',
      'omlx-openai',
      undefined,
      32 * 1024 ** 3,
    )

    expect(profile).toEqual(expect.objectContaining({
      max_context_window: 131_072,
      max_tokens: 32_768,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    }))
  })

  it('splits request-safe options from oMLX model settings', () => {
    const profile = normalizeOmlxManagedModelProfile({
      max_context_window: '999999',
      max_tokens: '4096',
      temperature: '0.8',
      top_p: '0.9',
      top_k: '32',
      min_p: '0.1',
      repetition_penalty: '1.05',
      presence_penalty: '0.2',
      frequency_penalty: '0.3',
      seed: '42',
    })

    expect(buildOmlxRequestOptionsRecord(profile)).toEqual({
      max_tokens: 4096,
      temperature: 0.8,
      top_p: 0.9,
      min_p: 0.1,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      seed: 42,
    })
    expect(buildOmlxRequestOptionsRecord(profile)).not.toHaveProperty('max_context_window')
    expect(buildOmlxRequestOptionsRecord(profile)).not.toHaveProperty('top_k')
    expect(buildOmlxModelSettingsRecord(profile)).toEqual({
      max_context_window: 262_144,
      max_tokens: 4096,
      temperature: 0.8,
      top_p: 0.9,
      top_k: 32,
      min_p: 0.1,
      repetition_penalty: 1.05,
      presence_penalty: 0.2,
    })
    expect(buildOmlxDisplayOptionsRecord(profile)).toEqual(expect.objectContaining({
      max_context_window: 262_144,
      top_k: 32,
      repetition_penalty: 1.05,
      frequency_penalty: 0.3,
      seed: 42,
    }))
  })
})
