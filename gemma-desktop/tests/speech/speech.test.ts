import { describe, expect, it } from 'vitest'
import {
  mergeSpeechTranscriptChunks,
  shouldFilterLikelySpeechHallucination,
} from '../../src/shared/speech'
import { analyzeSpeechAudio, hasMeaningfulSpeechAudio } from '../../src/renderer/src/lib/speechAudio'

describe('mergeSpeechTranscriptChunks', () => {
  it('drops duplicated overlap at chunk boundaries', () => {
    const merged = mergeSpeechTranscriptChunks(
      'hello there general',
      'general kenobi and welcome',
    )

    expect(merged.transcript).toBe('hello there general kenobi and welcome')
    expect(merged.appendedText).toBe('kenobi and welcome')
  })

  it('ignores punctuation-only chunk output', () => {
    const merged = mergeSpeechTranscriptChunks('hello there', '...')

    expect(merged.transcript).toBe('hello there')
    expect(merged.appendedText).toBe('')
  })
})

describe('hasMeaningfulSpeechAudio', () => {
  it('rejects silent chunks', () => {
    const samples = new Float32Array(16_000)

    expect(hasMeaningfulSpeechAudio(samples)).toBe(false)
  })

  it('keeps chunks with clear voiced audio', () => {
    const samples = new Float32Array(16_000)
    for (let index = 2_000; index < 6_000; index += 1) {
      samples[index] = Math.sin(index / 10) * 0.08
    }

    expect(hasMeaningfulSpeechAudio(samples)).toBe(true)
  })
})

describe('shouldFilterLikelySpeechHallucination', () => {
  it('drops low-confidence thank-you hallucinations from low-signal chunks', () => {
    const signal = analyzeSpeechAudio(new Float32Array(16_000))

    expect(shouldFilterLikelySpeechHallucination({
      text: 'Thank you.',
      avgLogprob: -0.73,
      noSpeechProb: 0.000000001,
      averageWordProbability: 0.62,
      signalMetrics: signal,
    })).toBe(true)
  })

  it('keeps a confident spoken thank-you segment', () => {
    expect(shouldFilterLikelySpeechHallucination({
      text: 'Thank you.',
      avgLogprob: -0.04,
      noSpeechProb: 0.000000001,
      averageWordProbability: 0.95,
      signalMetrics: {
        rms: 0.03,
        peak: 0.24,
        activeRatio: 0.18,
      },
    })).toBe(false)
  })
})
