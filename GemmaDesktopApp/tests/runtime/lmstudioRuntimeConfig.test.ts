import { describe, expect, it } from 'vitest'
import {
  buildLmStudioLoadOptionsRecord,
  buildLmStudioRequestOptionsRecord,
  getDefaultLmStudioSettings,
  normalizeLmStudioManagedModelProfile,
  resolveManagedLmStudioProfile,
} from '../../src/shared/lmstudioRuntimeConfig'

describe('lmstudio runtime config', () => {
  it('uses Gemma defaults for managed load and request options', () => {
    const settings = getDefaultLmStudioSettings(32 * 1024 ** 3)
    const profile = resolveManagedLmStudioProfile(
      settings,
      'gemma4:26b',
      'lmstudio-openai',
    )

    expect(profile).toEqual(expect.objectContaining({
      context_length: 262_144,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      num_experts: 4,
    }))
    expect(buildLmStudioLoadOptionsRecord(profile)).toEqual({
      context_length: 262_144,
      num_experts: 4,
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
    })
    expect(buildLmStudioRequestOptionsRecord(profile)).toEqual({
      context_length: 262_144,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    })
  })

  it('infers Gemma defaults from LM Studio model identifiers', () => {
    const profile = resolveManagedLmStudioProfile(
      undefined,
      'google/gemma-4-27b-it-qat',
      'lmstudio-native',
      'Gemma 4 27B IT QAT',
      24 * 1024 ** 3,
    )

    expect(profile).toEqual(expect.objectContaining({
      context_length: 262_144,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
    }))
  })

  it('normalizes persisted profile fields into bounded runtime options', () => {
    expect(
      normalizeLmStudioManagedModelProfile({
        context_length: '999999',
        temperature: '2',
        top_p: '0.8',
        top_k: '32',
        max_output_tokens: '4096',
        repeat_penalty: '1.1',
        flash_attention: 'false',
        offload_kv_cache_to_gpu: true,
      }),
    ).toEqual({
      context_length: 262_144,
      temperature: 1,
      top_p: 0.8,
      top_k: 32,
      max_output_tokens: 4096,
      repeat_penalty: 1.1,
      min_p: undefined,
      eval_batch_size: undefined,
      flash_attention: false,
      offload_kv_cache_to_gpu: true,
      num_experts: undefined,
    })
  })
})
