import { Type, type FunctionDeclaration } from '@google/genai'

export const VOICE_LIVE_SEND_TOOL_NAME = 'send_chat_message'

export const VOICE_LIVE_CHAT_RESPONSE_TAG = '[chat_response]'
export const VOICE_LIVE_CHAT_ERROR_TAG = '[chat_error]'

// Keep the full response available so "read it out loud" works, but bound the
// live-session context cost for very large turns.
export const VOICE_LIVE_RESPONSE_CHAR_LIMIT = 12_000

export interface VoiceLiveSurfaceContext {
  surfaceLabel: string
  modelLabel: string
}

export function buildVoiceLiveSystemInstruction(
  context: VoiceLiveSurfaceContext,
): string {
  return [
    'You are the voice assistant for Gemma Desktop, a macOS desktop app where the user chats and builds software with locally run open models such as Gemma, plus other configured models.',
    '',
    'Your role:',
    `- You are the voice interface, not the worker. The configured chat model (${context.modelLabel}) does the actual work inside ${context.surfaceLabel}.`,
    `- When the user states a goal, request, or question for the app, write one clear, self-contained prompt for the chat model and call ${VOICE_LIVE_SEND_TOOL_NAME} with it. Include the details the user said out loud; never invent requirements they did not state.`,
    '- Do not do substantive work yourself. Do not write code, documents, or long answers yourself; delegate to the chat model instead.',
    `- After calling ${VOICE_LIVE_SEND_TOOL_NAME}, tell the user in one short sentence that the request was sent and the model is working.`,
    `- When a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update arrives, give a short spoken summary of it: one to three sentences. Only read the response out in full when the user explicitly asks you to read it aloud.`,
    `- When a ${VOICE_LIVE_CHAT_ERROR_TAG} update arrives, or the tool reports the chat model is busy, relay that briefly and clearly.`,
    '- You may answer brief small talk or clarifying questions about what you are doing directly, without the tool.',
    '- Keep every spoken reply short and conversational. You are speaking out loud, not writing.',
  ].join('\n')
}

export function buildVoiceLiveToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: VOICE_LIVE_SEND_TOOL_NAME,
      description:
        'Send one prompt to the active Gemma Desktop conversation. The configured chat model does the actual work. '
        + `You will receive a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update message when it finishes.`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          prompt: {
            type: Type.STRING,
            description:
              'The complete, self-contained prompt to send to the chat model.',
          },
        },
        required: ['prompt'],
      },
    },
  ]
}

export interface VoiceLiveToolResult {
  ok: boolean
  status: 'sent' | 'busy' | 'rejected'
  detail: string
}

export function buildChatAcceptedResult(): VoiceLiveToolResult {
  return {
    ok: true,
    status: 'sent',
    detail:
      'Request sent. The chat model is working; a '
      + `${VOICE_LIVE_CHAT_RESPONSE_TAG} update will arrive when it finishes.`,
  }
}

export function buildChatBusyResult(): VoiceLiveToolResult {
  return {
    ok: false,
    status: 'busy',
    detail:
      'The chat model is still working on a previous request. Tell the user and ask them to wait.',
  }
}

export function buildChatRejectedResult(reason: string): VoiceLiveToolResult {
  return { ok: false, status: 'rejected', detail: reason }
}

export function buildChatResponseUpdate(responseText: string): string {
  const trimmed = responseText.trim()
  const truncated = trimmed.length > VOICE_LIVE_RESPONSE_CHAR_LIMIT
    ? `${trimmed.slice(0, VOICE_LIVE_RESPONSE_CHAR_LIMIT)}\n…[response truncated for voice mode]`
    : trimmed

  return [
    `${VOICE_LIVE_CHAT_RESPONSE_TAG} The chat model finished. Its full response is below.`,
    '---',
    truncated,
    '---',
    'Give the user a short spoken summary of this response now. Read it out in full only if they ask.',
  ].join('\n')
}

export function buildChatEmptyResponseUpdate(): string {
  return (
    `${VOICE_LIVE_CHAT_RESPONSE_TAG} The chat model finished its turn but produced no readable text `
    + '(it may have only run tools or updated files). Tell the user it finished and offer to send a follow-up request.'
  )
}

export function buildChatErrorUpdate(message: string): string {
  return (
    `${VOICE_LIVE_CHAT_ERROR_TAG} Sending the request to the chat model failed: ${message}. `
    + 'Tell the user briefly and suggest trying again.'
  )
}

// Map raw Gemini Live API/WebSocket failures onto short messages that are safe
// and useful to show directly in the UI.
export function normalizeVoiceLiveError(raw: unknown): string {
  const text = raw instanceof Error
    ? raw.message
    : typeof raw === 'string'
      ? raw
      : JSON.stringify(raw ?? '')
  const lower = text.toLowerCase()

  if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('invalid api key')) {
    return 'The Gemini API rejected the configured API key. Check the key in Settings → Gemini Hosted API.'
  }
  if (lower.includes('permission_denied') || lower.includes('permission denied')) {
    return 'The Gemini API denied access for this API key. Check the key and its project permissions in Settings → Gemini Hosted API.'
  }
  if (lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
    return 'The Gemini Live API reported a quota or rate limit problem. Wait a moment and try again.'
  }
  if (lower.includes('not found') && lower.includes('model')) {
    return 'The Gemini Live voice model is not available for this API key.'
  }
  if (lower.includes('notallowederror') || lower.includes('permission dismissed') || lower.includes('microphone')) {
    return 'Voice mode could not access the microphone. Allow microphone access for Gemma Desktop and try again.'
  }
  if (
    lower.includes('network')
    || lower.includes('failed to fetch')
    || lower.includes('enotfound')
    || lower.includes('socket')
    || lower.includes('websocket')
  ) {
    return 'Voice mode lost its connection to the Gemini Live API. Check your network and try again.'
  }

  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return 'Voice mode hit an unexpected Gemini Live API error.'
  }
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact
}
