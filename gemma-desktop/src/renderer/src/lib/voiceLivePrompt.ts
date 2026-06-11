import { Type, type FunctionDeclaration } from '@google/genai'

export const VOICE_LIVE_SEND_TOOL_NAME = 'send_chat_message'
export const VOICE_LIVE_APP_CONTEXT_TOOL_NAME = 'get_app_context'
export const VOICE_LIVE_NEW_CHAT_TOOL_NAME = 'start_new_chat'
export const VOICE_LIVE_RESEARCH_TOOL_NAME = 'start_research_chat'

export const VOICE_LIVE_CHAT_RESPONSE_TAG = '[chat_response]'
export const VOICE_LIVE_CHAT_ERROR_TAG = '[chat_error]'
export const VOICE_LIVE_APP_UPDATE_TAG = '[app_update]'

// Keep the full response available so "read it out loud" works, but bound the
// live-session context cost for very large turns.
export const VOICE_LIVE_RESPONSE_CHAR_LIMIT = 12_000

// History briefing bounds: enough for "what were we doing", cheap to carry.
export const VOICE_LIVE_HISTORY_MAX_TURNS = 12
export const VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT = 400
export const VOICE_LIVE_HISTORY_TOTAL_CHAR_LIMIT = 4_800

export interface VoiceLiveModelFacts {
  id: string
  name: string
  runtimeName: string
  attachments: {
    image: boolean
    audio: boolean
    video: boolean
    pdf: boolean
  }
  contextLength?: number
}

// Conservative default when the selected model's attachment metadata is not
// resolved: claim nothing rather than promising capabilities we cannot prove.
// (Renderer-local on purpose — the shared attachmentSupport module pulls in
// @gemma-sdk/core, which is not browser-safe.)
export const VOICE_LIVE_UNKNOWN_ATTACHMENTS: VoiceLiveModelFacts['attachments'] = {
  image: false,
  audio: false,
  video: false,
  pdf: false,
}

export interface VoiceLiveAvailability {
  ok: boolean
  reason?: string
}

// A reality-based snapshot of what the app can do right now. Every field is
// derived from live app state, never assumed.
export interface VoiceLiveAppCapabilities {
  surfaceLabel: string
  conversationKind: 'normal' | 'research'
  workMode: 'explore' | 'build' | null
  planMode: boolean
  workingDirectory: string | null
  model: VoiceLiveModelFacts | null
  coBrowseActive: boolean
  chatBusy: boolean
  addOnTools: string[]
  canStartNewChat: VoiceLiveAvailability
  canStartResearchChat: VoiceLiveAvailability
}

export interface VoiceLiveHistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

// Pull plain text out of app chat messages for the history briefing. Accepts
// a structural view of ChatMessage so it stays renderer-type agnostic.
export function extractVoiceHistoryTurns(
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string }>
  }>,
): VoiceLiveHistoryTurn[] {
  const turns: VoiceLiveHistoryTurn[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    if (text) {
      turns.push({ role: message.role, text })
    }
  }
  return turns
}

export function buildVoiceLiveHistorySection(
  turns: VoiceLiveHistoryTurn[],
): string | null {
  if (turns.length === 0) {
    return null
  }

  const recent = turns.slice(-VOICE_LIVE_HISTORY_MAX_TURNS).map((turn) => {
    const text = turn.text.length > VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT
      ? `${turn.text.slice(0, VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT)}…`
      : turn.text
    return `${turn.role === 'user' ? 'User' : 'Chat model'}: ${text.replace(/\s+/g, ' ').trim()}`
  })

  while (
    recent.length > 1
    && recent.join('\n').length > VOICE_LIVE_HISTORY_TOTAL_CHAR_LIMIT
  ) {
    recent.shift()
  }

  return [
    'Recent conversation history (oldest first), so you have context on what is already going on. Do not re-send these requests; use them only to understand follow-ups:',
    ...recent,
  ].join('\n')
}

function describeAttachmentFacts(model: VoiceLiveModelFacts): string {
  const supported: string[] = []
  const unsupported: string[] = []
  const pairs: Array<[keyof VoiceLiveModelFacts['attachments'], string]> = [
    ['image', 'images'],
    ['pdf', 'PDFs'],
    ['audio', 'audio files'],
    ['video', 'video files'],
  ]
  for (const [key, label] of pairs) {
    if (model.attachments[key]) {
      supported.push(label)
    } else {
      unsupported.push(label)
    }
  }
  const parts: string[] = []
  if (supported.length > 0) {
    parts.push(`it can look at ${supported.join(', ')} the user attaches in the composer`)
  }
  if (unsupported.length > 0) {
    parts.push(`it cannot process ${unsupported.join(', ')}`)
  }
  return parts.join('; ')
}

export function buildVoiceLiveCapabilityBriefing(
  capabilities: VoiceLiveAppCapabilities,
): string {
  const lines: string[] = []

  if (capabilities.model) {
    const model = capabilities.model
    const contextNote = model.contextLength
      ? `, ${Math.round(model.contextLength / 1024)}k context`
      : ''
    lines.push(
      `- Chat model: ${model.name} (${model.id}) running on ${model.runtimeName}${contextNote}. ${describeAttachmentFacts(model)}.`,
    )
    lines.push(
      '- You cannot attach files yourself; when the user mentions an image or document, tell them to attach it in the composer, then send the prompt about it.',
    )
  } else {
    lines.push('- Chat model: none is currently resolved; requests may fail until the user picks a model.')
  }

  if (capabilities.conversationKind === 'research') {
    lines.push('- This is a research conversation: the chat model runs a multi-step research pipeline with web search and produces a cited report. Research turns can take a long time.')
  } else if (capabilities.workMode === 'build') {
    lines.push(
      `- Work mode is Build: the chat model can edit files, run shell commands, and build software inside ${capabilities.workingDirectory ?? 'the project directory'}${capabilities.planMode ? ' (plan mode is on: it plans first and asks before executing)' : ''}.`,
    )
  } else if (capabilities.workMode === 'explore') {
    lines.push('- Work mode is Explore: the chat model investigates, reads files, and answers questions, but does not edit files.')
  }

  lines.push('- The chat model can search the web with grounded Google Search, fetch readable pages, and use a managed browser for deeper website interaction. Asking it to look something up, open a site, or check a page is normal and works.')

  if (capabilities.coBrowseActive) {
    lines.push('- CoBrowse is ON: browsing happens in the visible in-app browser the user can see and help with (logins, captchas, payments). Asking the chat model to open or search a site drives that visible browser.')
  } else {
    lines.push('- CoBrowse is OFF: browsing happens through the managed background browser, not a visible window.')
  }

  if (capabilities.addOnTools.length > 0) {
    lines.push(`- Extra tools enabled for this conversation: ${capabilities.addOnTools.join(', ')}.`)
  }

  lines.push(
    capabilities.chatBusy
      ? '- The chat model is BUSY working on a request right now.'
      : '- The chat model is idle and ready for requests.',
  )

  lines.push(
    capabilities.canStartNewChat.ok
      ? `- You can start a fresh conversation with ${VOICE_LIVE_NEW_CHAT_TOOL_NAME}.`
      : `- Starting a new conversation is unavailable right now: ${capabilities.canStartNewChat.reason ?? 'unknown reason'}.`,
  )
  lines.push(
    capabilities.canStartResearchChat.ok
      ? `- You can start a deep-research conversation with ${VOICE_LIVE_RESEARCH_TOOL_NAME}.`
      : `- Starting a research conversation is unavailable right now: ${capabilities.canStartResearchChat.reason ?? 'unknown reason'}.`,
  )

  return lines.join('\n')
}

export interface VoiceLiveInstructionContext {
  surfaceLabel: string
  capabilities: VoiceLiveAppCapabilities
  historyTurns: VoiceLiveHistoryTurn[]
}

export function buildVoiceLiveSystemInstruction(
  context: VoiceLiveInstructionContext,
): string {
  const modelLabel = context.capabilities.model?.name
    ?? context.capabilities.model?.id
    ?? 'the configured chat model'
  const sections = [
    'You are the voice assistant for Gemma Desktop, a macOS desktop app where the user chats and builds software with locally run open models such as Gemma, plus other configured models.',
    '',
    'Your role:',
    `- You are the voice interface, not the worker. The chat model (${modelLabel}) does the actual work inside ${context.surfaceLabel}.`,
    `- Default rule: whenever the user asks you to DO something — answer a question, open a page, look something up, write or fix code, summarize, analyze an image, anything — they are asking you to prompt the chat model. Write one clear, self-contained prompt and call ${VOICE_LIVE_SEND_TOOL_NAME}, unless the request explicitly matches one of your other tools below.`,
    '- Include the details the user said out loud; never invent requirements they did not state. Do not do substantive work yourself.',
    `- After calling ${VOICE_LIVE_SEND_TOOL_NAME}, tell the user in one short sentence that the request was sent and the model is working.`,
    `- When a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update arrives, give a short spoken summary of it: one to three sentences. Only read the response out in full when the user explicitly asks you to read it aloud.`,
    `- When a ${VOICE_LIVE_CHAT_ERROR_TAG} update arrives, or a tool reports busy or unavailable, relay that briefly and clearly.`,
    '- You may answer brief small talk or quick questions about the app and what you are doing directly, without tools.',
    '- Keep every spoken reply short and conversational. You are speaking out loud, not writing.',
    '',
    'Your other tools:',
    `- ${VOICE_LIVE_NEW_CHAT_TOOL_NAME}: start a fresh conversation. Use when the user asks for a new chat, or clearly starts an unrelated piece of work and wants a clean slate. Voice mode follows to the new conversation automatically.`,
    `- ${VOICE_LIVE_RESEARCH_TOOL_NAME}: start a dedicated deep-research conversation. Use whenever the user asks you to research, investigate, or deeply look into a topic. Pass their research goal verbatim plus any constraints they stated.`,
    `- ${VOICE_LIVE_APP_CONTEXT_TOOL_NAME}: returns the current real state of the app (model, modes, CoBrowse, busy state, what you can start). Use it when you are unsure what the app can do right now — state can change while you talk.`,
    '',
    'What the app can do right now (real state, not assumptions):',
    buildVoiceLiveCapabilityBriefing(context.capabilities),
  ]

  const historySection = buildVoiceLiveHistorySection(context.historyTurns)
  if (historySection) {
    sections.push('', historySection)
  }

  return sections.join('\n')
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
    {
      name: VOICE_LIVE_NEW_CHAT_TOOL_NAME,
      description:
        'Start a fresh Gemma Desktop conversation and switch voice mode to it. '
        + `An ${VOICE_LIVE_APP_UPDATE_TAG} message confirms when it is ready.`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Optional short title for the new conversation.',
          },
          first_message: {
            type: Type.STRING,
            description:
              'Optional first prompt to send to the chat model in the new conversation.',
          },
        },
      },
    },
    {
      name: VOICE_LIVE_RESEARCH_TOOL_NAME,
      description:
        'Start a dedicated deep-research conversation that runs a multi-step research pipeline on a goal, and switch voice mode to it. '
        + `An ${VOICE_LIVE_APP_UPDATE_TAG} message confirms the start and a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update arrives when the research finishes (it can take a while).`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          research_goal: {
            type: Type.STRING,
            description:
              'The complete research goal, including any constraints the user stated.',
          },
          title: {
            type: Type.STRING,
            description: 'Optional short title for the research conversation.',
          },
        },
        required: ['research_goal'],
      },
    },
    {
      name: VOICE_LIVE_APP_CONTEXT_TOOL_NAME,
      description:
        'Get the current real state of Gemma Desktop: active conversation, chat model and what it can see, work mode, CoBrowse state, busy state, and which actions are available right now.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
      },
    },
  ]
}

export interface VoiceLiveToolResult {
  ok: boolean
  status: 'sent' | 'busy' | 'rejected' | 'starting' | 'ok'
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

export function buildCreationStartingResult(kind: 'chat' | 'research'): VoiceLiveToolResult {
  return {
    ok: true,
    status: 'starting',
    detail:
      kind === 'research'
        ? `Creating the research conversation now. An ${VOICE_LIVE_APP_UPDATE_TAG} message will confirm it started.`
        : `Creating the new conversation now. An ${VOICE_LIVE_APP_UPDATE_TAG} message will confirm it is ready.`,
  }
}

export function buildAppContextResult(
  capabilities: VoiceLiveAppCapabilities,
): VoiceLiveToolResult & { context: string } {
  return {
    ok: true,
    status: 'ok',
    detail: 'Current app state below.',
    context: buildVoiceLiveCapabilityBriefing(capabilities),
  }
}

export function buildNewChatStartedUpdate(title: string, firstMessageSent: boolean): string {
  return (
    `${VOICE_LIVE_APP_UPDATE_TAG} A new conversation "${title}" is ready and voice mode now controls it. `
    + (firstMessageSent
      ? `The first request was sent to the chat model; a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update will follow. Tell the user briefly.`
      : 'Tell the user briefly and ask what they want to do in it.')
  )
}

export function buildResearchStartedUpdate(title: string): string {
  return (
    `${VOICE_LIVE_APP_UPDATE_TAG} The research conversation "${title}" started and voice mode now controls it. `
    + `The research goal was sent; research can take several minutes and a ${VOICE_LIVE_CHAT_RESPONSE_TAG} update will arrive when it finishes. Tell the user briefly.`
  )
}

export function buildCreationFailedUpdate(kind: 'chat' | 'research', message: string): string {
  return (
    `${VOICE_LIVE_APP_UPDATE_TAG} Starting the ${kind === 'research' ? 'research conversation' : 'new conversation'} failed: ${message}. `
    + 'Tell the user briefly.'
  )
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
