import type { SpeechSignalMetrics } from '@shared/speech'

const TARGET_SAMPLE_RATE = 16_000
const SPEECH_ACTIVITY_SAMPLE_THRESHOLD = 0.01
const SPEECH_MIN_ACTIVE_RATIO = 0.008
const SPEECH_MIN_RMS = 0.0045
const SPEECH_MIN_PEAK = 0.03

export function mergeSpeechChunkBuffers(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return merged
}

export function analyzeSpeechAudio(samples: Float32Array): SpeechSignalMetrics & {
  hasMeaningfulSpeech: boolean
} {
  if (samples.length === 0) {
    return {
      rms: 0,
      peak: 0,
      activeRatio: 0,
      hasMeaningfulSpeech: false,
    }
  }

  let squaredSum = 0
  let peak = 0
  let activeSamples = 0

  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = Math.abs(samples[index] ?? 0)
    squaredSum += amplitude * amplitude
    if (amplitude > peak) {
      peak = amplitude
    }
    if (amplitude >= SPEECH_ACTIVITY_SAMPLE_THRESHOLD) {
      activeSamples += 1
    }
  }

  const rms = Math.sqrt(squaredSum / samples.length)
  const activeRatio = activeSamples / samples.length

  return {
    rms,
    peak,
    activeRatio,
    hasMeaningfulSpeech:
      rms >= SPEECH_MIN_RMS || (peak >= SPEECH_MIN_PEAK && activeRatio >= SPEECH_MIN_ACTIVE_RATIO),
  }
}

export function hasMeaningfulSpeechAudio(samples: Float32Array): boolean {
  return analyzeSpeechAudio(samples).hasMeaningfulSpeech
}

export function downsampleSpeechBuffer(
  input: Float32Array,
  sourceRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (sourceRate === targetRate) {
    return input
  }

  const ratio = sourceRate / targetRate
  const newLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(newLength)

  let offsetResult = 0
  let offsetBuffer = 0
  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio)
    let accum = 0
    let count = 0

    for (
      let sampleIndex = offsetBuffer;
      sampleIndex < nextOffsetBuffer && sampleIndex < input.length;
      sampleIndex += 1
    ) {
      accum += input[sampleIndex] ?? 0
      count += 1
    }

    output[offsetResult] = count > 0 ? accum / count : 0
    offsetResult += 1
    offsetBuffer = nextOffsetBuffer
  }

  return output
}

export function encodeSpeechWavPcm16(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
): ArrayBuffer {
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)

  function writeString(offset: number, value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataLength, true)

  let offset = 44
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    )
    offset += bytesPerSample
  }

  return buffer
}

export function speechBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

export function finalizeSpeechChunkFromBuffers(input: {
  buffers: Float32Array[]
  sourceRate: number
}): { wavBase64: string; durationMs: number } | null {
  if (input.buffers.length === 0) {
    return null
  }

  const merged = mergeSpeechChunkBuffers(input.buffers)
  if (merged.length === 0) {
    return null
  }

  const resampled = downsampleSpeechBuffer(merged, input.sourceRate)
  const wav = encodeSpeechWavPcm16(resampled)
  return {
    wavBase64: speechBufferToBase64(wav),
    durationMs: Math.round((resampled.length / TARGET_SAMPLE_RATE) * 1000),
  }
}
