const TOKEN_SEPARATOR = /\s+/
const PUNCTUATION_ONLY = /^[\s.,!?;:'"()\-[\]{}]+$/
const HALLUCINATION_BIAS_PATTERNS = [
  /^thank you$/,
  /^thank you for watching$/,
  /^thanks for watching$/,
  /^translated by amara org community$/,
  /^subtitles by amara org community$/,
  /^subtitles by the amara org community$/,
  /^subtitles by the amara community$/,
  /^subtitles by amara community$/,
  /^legendas pela comunidade amara org$/,
  /^untertitel der amara org community$/,
  /^untertitelung aufgrund der amara org community$/,
  /amara org community/,
  /soustitreur/,
  /subtitles done by/,
] as const

export const SPEECH_PROVIDER_ID = 'managed-whisper-cpp' as const
export const SPEECH_PROVIDER_LABEL = 'Managed whisper.cpp'
export const SPEECH_MODEL_ID = 'large-v3-turbo-q5_0' as const
export const SPEECH_MODEL_LABEL = 'large-v3-turbo-q5_0'
export const SPEECH_CHUNK_DURATION_MS = 3_000
export const SPEECH_CHUNK_OVERLAP_MS = 250

export type SpeechProviderId = typeof SPEECH_PROVIDER_ID
export type SpeechModelId = typeof SPEECH_MODEL_ID
export type SpeechInstallState =
  | 'unsupported'
  | 'not_installed'
  | 'installing'
  | 'installed'
  | 'repairing'
  | 'removing'
  | 'error'

export type SpeechSessionState =
  | 'idle'
  | 'processing'
  | 'stopping'
  | 'stopped'

export interface SpeechInspection {
  supported: boolean
  enabled: boolean
  provider: SpeechProviderId
  providerLabel: string
  model: SpeechModelId
  modelLabel: string
  installState: SpeechInstallState
  installed: boolean
  healthy: boolean
  busy: boolean
  detail: string
  lastError: string | null
  runtimeVersion: string | null
  networkDownloadBytes: number | null
  diskUsageBytes: number | null
  installLocation: string | null
  checkedAt: string
}

export interface SpeechSessionStartInput {
  sessionId: string
  baseText: string
  selectionStart: number
  selectionEnd: number
}

export interface SpeechSessionStartResult {
  sessionId: string
}

export interface SpeechChunkInput {
  sessionId: string
  sequence: number
  audioBase64: string
  mimeType: string
  durationMs: number
  final: boolean
  signalMetrics?: SpeechSignalMetrics | null
}

export interface SpeechSignalMetrics {
  rms: number
  peak: number
  activeRatio: number
}

export type SpeechEvent =
  | {
      type: 'state'
      sessionId: string
      state: SpeechSessionState
      queueDepth: number
      activeSequence: number | null
    }
  | {
      type: 'chunk'
      sessionId: string
      sequence: number
      status: 'queued' | 'processing' | 'completed' | 'error'
      final: boolean
      errorMessage?: string
    }
  | {
      type: 'transcript'
      sessionId: string
      sequence: number
      final: boolean
      transcript: string
      appendedText: string
    }
  | {
      type: 'error'
      sessionId: string
      stage: 'runtime' | 'transcription'
      message: string
      sequence?: number
    }

function tokenize(value: string): string[] {
  return value
    .trim()
    .split(TOKEN_SEPARATOR)
    .map((token) => token.trim())
    .filter(Boolean)
}

function normalizeSpeechBiasText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function findTokenOverlap(existing: string[], incoming: string[]): number {
  const max = Math.min(existing.length, incoming.length, 12)
  for (let size = max; size > 0; size -= 1) {
    const existingTail = existing.slice(-size).map(normalizeToken)
    const incomingHead = incoming.slice(0, size).map(normalizeToken)
    if (
      existingTail.every((token, index) =>
        token.length > 0 && token === incomingHead[index],
      )
    ) {
      return size
    }
  }

  return 0
}

export function mergeSpeechTranscriptChunks(
  existingTranscript: string,
  incomingChunkText: string,
): { transcript: string; appendedText: string } {
  const incoming = incomingChunkText.trim()
  if (incoming.length === 0 || PUNCTUATION_ONLY.test(incoming)) {
    return {
      transcript: existingTranscript,
      appendedText: '',
    }
  }

  const existing = existingTranscript.trimEnd()
  if (existing.length === 0) {
    return {
      transcript: incoming,
      appendedText: incoming,
    }
  }

  const existingTokens = tokenize(existing)
  const incomingTokens = tokenize(incoming)
  const overlap = findTokenOverlap(existingTokens, incomingTokens)
  const mergedIncoming = incomingTokens.slice(overlap).join(' ').trim()

  if (mergedIncoming.length === 0) {
    return {
      transcript: existing,
      appendedText: '',
    }
  }

  const separator = /[-—–(/]$/.test(existing) ? '' : ' '
  return {
    transcript: `${existing}${separator}${mergedIncoming}`.trim(),
    appendedText: mergedIncoming,
  }
}

export function shouldFilterLikelySpeechHallucination(input: {
  text: string
  avgLogprob: number
  noSpeechProb: number
  averageWordProbability: number
  signalMetrics?: SpeechSignalMetrics | null
}): boolean {
  const normalized = normalizeSpeechBiasText(input.text)
  if (normalized.length === 0) {
    return true
  }

  const tokenCount = normalized.split(TOKEN_SEPARATOR).filter(Boolean).length
  const lowSignal = Boolean(
    input.signalMetrics
    && (input.signalMetrics.activeRatio < 0.03 || input.signalMetrics.rms < 0.008),
  )
  const whisperNoSpeechHeuristic = input.noSpeechProb >= 0.6 && input.avgLogprob <= -0.4
  if (whisperNoSpeechHeuristic) {
    return true
  }

  const matchesKnownBias = HALLUCINATION_BIAS_PATTERNS.some((pattern) => pattern.test(normalized))
  if (
    matchesKnownBias
    && (input.avgLogprob <= -0.3 || input.averageWordProbability <= 0.8 || lowSignal)
  ) {
    return true
  }

  if (
    lowSignal
    && tokenCount <= 2
    && (input.avgLogprob <= -0.45 || input.averageWordProbability <= 0.55)
  ) {
    return true
  }

  return false
}
