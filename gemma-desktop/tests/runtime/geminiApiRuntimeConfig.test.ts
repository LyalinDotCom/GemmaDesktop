import { describe, expect, it } from 'vitest'
import {
  buildGeminiGenerationOptions,
  getDefaultGeminiApiSettings,
  normalizeGeminiApiSettings,
  resolveGeminiApiProfileKey,
  resolveGeminiContextTokens,
} from '../../src/shared/geminiApiRuntimeConfig'

describe('Gemini API runtime config', () => {
  it('uses Google Gemini CLI chat defaults for Gemini 3 hosted models', () => {
    const settings = getDefaultGeminiApiSettings()

    expect(settings.profiles.gemini3).toEqual(expect.objectContaining({
      temperature: 1,
      topP: 0.95,
      topK: 64,
      maxOutputTokens: null,
      contextTokens: null,
      includeThoughts: true,
      thinkingLevel: 'high',
      thinkingBudget: 8192,
    }))
    expect(resolveGeminiApiProfileKey('gemini-3.5-flash')).toBe('gemini3')
    expect(buildGeminiGenerationOptions(settings, 'gemini-3.5-flash')).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 64,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: 'high',
      },
    })
  })

  it('keeps Gemini 2.5 budget settings for legacy hosted models', () => {
    const settings = normalizeGeminiApiSettings({
      ...getDefaultGeminiApiSettings(),
      profiles: {
        ...getDefaultGeminiApiSettings().profiles,
        gemini25: {
          ...getDefaultGeminiApiSettings().profiles.gemini25,
          thinkingLevel: 'minimal',
          thinkingBudget: 4096,
          maxOutputTokens: 32_000,
        },
      },
    })

    expect(resolveGeminiApiProfileKey('gemini-2.5-pro')).toBe('gemini25')
    expect(buildGeminiGenerationOptions(settings, 'gemini-2.5-pro')).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 64,
      maxOutputTokens: 32_000,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 4096,
      },
    })
  })

  it('uses the Gemma-family profile for Gemma models hosted by the Gemini API', () => {
    const settings = getDefaultGeminiApiSettings()

    expect(resolveGeminiApiProfileKey('gemma-4-26b-a4b-it')).toBe('gemmaApi')
    expect(buildGeminiGenerationOptions(settings, 'gemma-4-26b-a4b-it')).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 64,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: 'high',
      },
    })
  })

  it('does not send thinking config for unknown hosted/open model families', () => {
    const settings = getDefaultGeminiApiSettings()

    expect(resolveGeminiApiProfileKey('partner-open-model')).toBe('openModel')
    expect(buildGeminiGenerationOptions(settings, 'partner-open-model')).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 64,
    })
  })

  it('normalizes profile values without dropping the shared API key', () => {
    const settings = normalizeGeminiApiSettings({
      apiKey: 'AIza-test',
      model: 'gemini-3.5-flash',
      profiles: {
        gemini3: {
          temperature: '3',
          topP: '-1',
          topK: '0',
          maxOutputTokens: '4096',
          contextTokens: '1048576',
          includeThoughts: false,
          thinkingLevel: 'medium',
          thinkingBudget: '-1',
        },
      },
    })

    expect(settings.apiKey).toBe('AIza-test')
    expect(settings.model).toBe('gemini-3.5-flash')
    expect(settings.profiles.gemini3).toEqual(expect.objectContaining({
      temperature: 2,
      topP: 0,
      topK: 1,
      maxOutputTokens: 4096,
      contextTokens: 1_048_576,
      includeThoughts: false,
      thinkingLevel: 'medium',
      thinkingBudget: 0,
    }))
    expect(resolveGeminiContextTokens(settings, 'gemini-3.5-flash')).toBe(1_048_576)
  })

  it('migrates legacy flat Gemini API settings into the Gemini 3 profile', () => {
    const settings = normalizeGeminiApiSettings({
      apiKey: 'AIza-test',
      temperature: '0.7',
      topP: '0.8',
      topK: '32',
      includeThoughts: false,
      thinkingLevel: 'low',
    })

    expect(settings.profiles.gemini3).toEqual(expect.objectContaining({
      temperature: 0.7,
      topP: 0.8,
      topK: 32,
      includeThoughts: false,
      thinkingLevel: 'low',
    }))
    expect(settings.profiles.gemmaApi).toEqual(expect.objectContaining({
      temperature: 1,
      topP: 0.95,
      topK: 64,
    }))
  })
})
