import { extractFirstGrapheme } from './emoji'

export type ConversationIcon = string | null

const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u
const REGIONAL_INDICATOR_PAIR_PATTERN = /^\p{Regional_Indicator}{2}$/u
const KEYCAP_EMOJI_PATTERN = /^[0-9#*]\uFE0F?\u20E3$/u

function isEmojiGrapheme(input: string): boolean {
  return EXTENDED_PICTOGRAPHIC_PATTERN.test(input)
    || REGIONAL_INDICATOR_PAIR_PATTERN.test(input)
    || KEYCAP_EMOJI_PATTERN.test(input)
}

export function normalizeConversationIcon(input: unknown): ConversationIcon {
  if (typeof input !== 'string') {
    return null
  }

  const icon = extractFirstGrapheme(input)
  if (!icon || !isEmojiGrapheme(icon)) {
    return null
  }

  return icon
}
