export const READ_ALOUD_PROVIDER_ID = 'kokoro-js' as const
export const READ_ALOUD_PROVIDER_LABEL = 'Kokoro'
export const READ_ALOUD_MODEL_ID = 'Kokoro-82M-v1.0-ONNX' as const
export const READ_ALOUD_MODEL_LABEL = 'Kokoro 82M'
export const READ_ALOUD_MODEL_DTYPE = 'q8' as const
export const READ_ALOUD_BACKEND = 'cpu' as const
export const READ_ALOUD_SAMPLE_RATE = 24_000
export const READ_ALOUD_DEFAULT_VOICE = 'af_heart' as const
export const READ_ALOUD_DEFAULT_SPEED = 1
export const READ_ALOUD_MIN_SPEED = 0.7
export const READ_ALOUD_MAX_SPEED = 1.3
export const READ_ALOUD_CACHE_FORMAT_VERSION = 1
export const READ_ALOUD_TEST_PHRASE =
  'Gemma Desktop is ready to read this response aloud using the selected voice.'

export type ReadAloudVoiceId =
  | 'af_heart'
  | 'af_bella'
  | 'am_michael'
  | 'bf_emma'
  | 'bm_george'

export interface ReadAloudVoiceOption {
  id: ReadAloudVoiceId
  label: string
  accent: 'American English' | 'British English'
  gender: 'Female' | 'Male'
}

export const READ_ALOUD_VOICE_OPTIONS: readonly ReadAloudVoiceOption[] = [
  {
    id: 'af_heart',
    label: 'Heart',
    accent: 'American English',
    gender: 'Female',
  },
  {
    id: 'af_bella',
    label: 'Bella',
    accent: 'American English',
    gender: 'Female',
  },
  {
    id: 'am_michael',
    label: 'Michael',
    accent: 'American English',
    gender: 'Male',
  },
  {
    id: 'bf_emma',
    label: 'Emma',
    accent: 'British English',
    gender: 'Female',
  },
  {
    id: 'bm_george',
    label: 'George',
    accent: 'British English',
    gender: 'Male',
  },
] as const

export type ReadAloudState =
  | 'unsupported'
  | 'missing_assets'
  | 'installing'
  | 'loading'
  | 'ready'
  | 'error'

export interface ReadAloudInstallProgress {
  assetPath: string
  assetIndex: number
  assetCount: number
  downloadedBytes: number
  totalBytes: number
  percent: number | null
}

export interface ReadAloudInspection {
  supported: boolean
  enabled: boolean
  provider: typeof READ_ALOUD_PROVIDER_ID
  providerLabel: string
  model: typeof READ_ALOUD_MODEL_ID
  modelLabel: string
  dtype: typeof READ_ALOUD_MODEL_DTYPE
  backend: typeof READ_ALOUD_BACKEND
  state: ReadAloudState
  healthy: boolean
  busy: boolean
  detail: string
  lastError: string | null
  assetRoot: string | null
  cacheDir: string | null
  bundledBytes: number | null
  installProgress: ReadAloudInstallProgress | null
  checkedAt: string
}

export interface ReadAloudSynthesisInput {
  messageId: string
  text: string
  voice: ReadAloudVoiceId
  speed: number
  purpose?: 'message' | 'preview'
  useCache?: boolean
}

export interface ReadAloudSynthesisResult {
  audioPath: string
  fromCache: boolean
  durationMs: number | null
  voice: ReadAloudVoiceId
  speed: number
  textHash: string
}

export interface ReadAloudTestInput {
  voice?: ReadAloudVoiceId
  speed?: number
}

const READ_ALOUD_VOICE_SET = new Set<ReadAloudVoiceId>(
  READ_ALOUD_VOICE_OPTIONS.map((voice) => voice.id),
)

export function isReadAloudVoiceId(value: unknown): value is ReadAloudVoiceId {
  return typeof value === 'string' && READ_ALOUD_VOICE_SET.has(value as ReadAloudVoiceId)
}

export function normalizeReadAloudVoice(
  value: unknown,
): ReadAloudVoiceId {
  return isReadAloudVoiceId(value) ? value : READ_ALOUD_DEFAULT_VOICE
}

export function clampReadAloudSpeed(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : NaN

  if (!Number.isFinite(numeric)) {
    return READ_ALOUD_DEFAULT_SPEED
  }

  return Number(
    Math.min(READ_ALOUD_MAX_SPEED, Math.max(READ_ALOUD_MIN_SPEED, numeric)).toFixed(2),
  )
}

export function describeReadAloudVoice(
  voiceId: ReadAloudVoiceId,
): ReadAloudVoiceOption {
  return (
    READ_ALOUD_VOICE_OPTIONS.find((voice) => voice.id === voiceId)
    ?? READ_ALOUD_VOICE_OPTIONS[0]
  )!
}
