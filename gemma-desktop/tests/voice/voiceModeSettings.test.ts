import { describe, expect, it } from 'vitest'
import {
  GEMINI_LIVE_DEFAULT_VOICE,
  GEMINI_LIVE_VOICE_OPTIONS,
  formatGeminiLiveVoiceLabel,
  getDefaultVoiceModeSettings,
  normalizeGeminiLiveVoice,
} from '../../src/shared/voiceMode'

describe('gemini live voice catalog', () => {
  it('lists all thirty documented prebuilt voices with unique ids', () => {
    expect(GEMINI_LIVE_VOICE_OPTIONS).toHaveLength(30)
    const ids = GEMINI_LIVE_VOICE_OPTIONS.map((option) => option.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const option of GEMINI_LIVE_VOICE_OPTIONS) {
      expect(option.id).toMatch(/^[A-Z][a-z]+$/i)
      expect(option.character.length).toBeGreaterThan(0)
      expect(['female', 'male']).toContain(option.gender)
    }
  })

  it('defaults to a female voice', () => {
    const defaultOption = GEMINI_LIVE_VOICE_OPTIONS.find(
      (option) => option.id === GEMINI_LIVE_DEFAULT_VOICE,
    )
    expect(defaultOption).toBeDefined()
    expect(defaultOption!.gender).toBe('female')
    expect(getDefaultVoiceModeSettings()).toEqual({
      voiceName: GEMINI_LIVE_DEFAULT_VOICE,
    })
  })

  it('formats labels with character and gender', () => {
    const kore = GEMINI_LIVE_VOICE_OPTIONS.find((option) => option.id === 'Kore')!
    expect(formatGeminiLiveVoiceLabel(kore)).toBe('Kore · Firm · Female')
  })
})

describe('normalizeGeminiLiveVoice', () => {
  it('accepts every catalog voice and is case-insensitive', () => {
    for (const option of GEMINI_LIVE_VOICE_OPTIONS) {
      expect(normalizeGeminiLiveVoice(option.id)).toBe(option.id)
      expect(normalizeGeminiLiveVoice(option.id.toUpperCase())).toBe(option.id)
      expect(normalizeGeminiLiveVoice(` ${option.id.toLowerCase()} `)).toBe(option.id)
    }
  })

  it('falls back to the default for unknown or invalid values', () => {
    expect(normalizeGeminiLiveVoice('NotARealVoice')).toBe(GEMINI_LIVE_DEFAULT_VOICE)
    expect(normalizeGeminiLiveVoice('')).toBe(GEMINI_LIVE_DEFAULT_VOICE)
    expect(normalizeGeminiLiveVoice(undefined)).toBe(GEMINI_LIVE_DEFAULT_VOICE)
    expect(normalizeGeminiLiveVoice(42)).toBe(GEMINI_LIVE_DEFAULT_VOICE)
  })
})
