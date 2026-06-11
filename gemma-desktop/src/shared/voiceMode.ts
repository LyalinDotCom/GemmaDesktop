// Voice-mode (Gemini Live) speech settings shared between main, renderer,
// and tests.
//
// The voice list mirrors the documented prebuilt Gemini speech voices and was
// verified live against the pinned voice model: every name below was accepted
// by a gemini-3.1-flash-live-preview session, and unknown names are rejected
// by the server, so this catalog is reality-based rather than aspirational.

export interface GeminiLiveVoiceOption {
  id: string
  character: string
  gender: 'female' | 'male'
}

export const GEMINI_LIVE_VOICE_OPTIONS: readonly GeminiLiveVoiceOption[] = [
  { id: 'Kore', character: 'Firm', gender: 'female' },
  { id: 'Aoede', character: 'Breezy', gender: 'female' },
  { id: 'Leda', character: 'Youthful', gender: 'female' },
  { id: 'Zephyr', character: 'Bright', gender: 'female' },
  { id: 'Autonoe', character: 'Bright', gender: 'female' },
  { id: 'Callirrhoe', character: 'Easy-going', gender: 'female' },
  { id: 'Despina', character: 'Smooth', gender: 'female' },
  { id: 'Erinome', character: 'Clear', gender: 'female' },
  { id: 'Laomedeia', character: 'Upbeat', gender: 'female' },
  { id: 'Achernar', character: 'Soft', gender: 'female' },
  { id: 'Gacrux', character: 'Mature', gender: 'female' },
  { id: 'Pulcherrima', character: 'Forward', gender: 'female' },
  { id: 'Vindemiatrix', character: 'Gentle', gender: 'female' },
  { id: 'Sulafat', character: 'Warm', gender: 'female' },
  { id: 'Puck', character: 'Upbeat', gender: 'male' },
  { id: 'Charon', character: 'Informative', gender: 'male' },
  { id: 'Fenrir', character: 'Excitable', gender: 'male' },
  { id: 'Orus', character: 'Firm', gender: 'male' },
  { id: 'Enceladus', character: 'Breathy', gender: 'male' },
  { id: 'Iapetus', character: 'Clear', gender: 'male' },
  { id: 'Umbriel', character: 'Easy-going', gender: 'male' },
  { id: 'Algieba', character: 'Smooth', gender: 'male' },
  { id: 'Algenib', character: 'Gravelly', gender: 'male' },
  { id: 'Rasalgethi', character: 'Informative', gender: 'male' },
  { id: 'Alnilam', character: 'Firm', gender: 'male' },
  { id: 'Schedar', character: 'Even', gender: 'male' },
  { id: 'Achird', character: 'Friendly', gender: 'male' },
  { id: 'Zubenelgenubi', character: 'Casual', gender: 'male' },
  { id: 'Sadachbia', character: 'Lively', gender: 'male' },
  { id: 'Sadaltager', character: 'Knowledgeable', gender: 'male' },
] as const

// Default to a female voice; without an explicit speechConfig the live server
// may pick a different voice on every session.
export const GEMINI_LIVE_DEFAULT_VOICE = 'Kore'

export interface AppVoiceModeSettings {
  voiceName: string
}

export function getDefaultVoiceModeSettings(): AppVoiceModeSettings {
  return { voiceName: GEMINI_LIVE_DEFAULT_VOICE }
}

export function normalizeGeminiLiveVoice(value: unknown): string {
  if (typeof value === 'string') {
    const match = GEMINI_LIVE_VOICE_OPTIONS.find(
      (option) => option.id.toLowerCase() === value.trim().toLowerCase(),
    )
    if (match) {
      return match.id
    }
  }
  return GEMINI_LIVE_DEFAULT_VOICE
}

export function formatGeminiLiveVoiceLabel(option: GeminiLiveVoiceOption): string {
  return `${option.id} · ${option.character} · ${option.gender === 'female' ? 'Female' : 'Male'}`
}
