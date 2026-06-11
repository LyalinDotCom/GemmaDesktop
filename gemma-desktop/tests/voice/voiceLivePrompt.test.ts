import { describe, expect, it } from 'vitest'
import {
  VOICE_LIVE_APP_CONTEXT_TOOL_NAME,
  VOICE_LIVE_APP_UPDATE_TAG,
  VOICE_LIVE_CHAT_ERROR_TAG,
  VOICE_LIVE_CHAT_RESPONSE_TAG,
  VOICE_LIVE_HISTORY_MAX_TURNS,
  VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT,
  VOICE_LIVE_NEW_CHAT_TOOL_NAME,
  VOICE_LIVE_RESEARCH_TOOL_NAME,
  VOICE_LIVE_RESPONSE_CHAR_LIMIT,
  VOICE_LIVE_SEND_TOOL_NAME,
  buildAppContextResult,
  buildChatAcceptedResult,
  buildChatBusyResult,
  buildChatEmptyResponseUpdate,
  buildChatErrorUpdate,
  buildChatRejectedResult,
  buildChatResponseUpdate,
  buildCreationFailedUpdate,
  buildCreationStartingResult,
  buildNewChatStartedUpdate,
  buildResearchStartedUpdate,
  buildVoiceLiveCapabilityBriefing,
  buildVoiceLiveHistorySection,
  buildVoiceLiveSystemInstruction,
  buildVoiceLiveToolDeclarations,
  extractVoiceHistoryTurns,
  normalizeVoiceLiveError,
  type VoiceLiveAppCapabilities,
} from '../../src/renderer/src/lib/voiceLivePrompt'

function makeCapabilities(
  overrides: Partial<VoiceLiveAppCapabilities> = {},
): VoiceLiveAppCapabilities {
  return {
    surfaceLabel: 'the project conversation "My App"',
    conversationKind: 'normal',
    workMode: 'build',
    planMode: false,
    workingDirectory: '/Users/dev/myapp',
    model: {
      id: 'gemma4:26b',
      name: 'Gemma 4 26B',
      runtimeName: 'Ollama',
      attachments: { image: true, audio: false, video: false, pdf: true },
      contextLength: 131_072,
    },
    coBrowseActive: false,
    chatBusy: false,
    addOnTools: [],
    canStartNewChat: { ok: true },
    canStartResearchChat: { ok: true },
    ...overrides,
  }
}

describe('voice live system instruction', () => {
  it('frames the live model as a delegating Gemma Desktop voice assistant', () => {
    const instruction = buildVoiceLiveSystemInstruction({
      surfaceLabel: 'the project conversation "My App"',
      capabilities: makeCapabilities(),
      historyTurns: [],
    })

    expect(instruction).toContain('Gemma Desktop')
    expect(instruction).toContain('voice interface, not the worker')
    expect(instruction).toContain('Gemma 4 26B')
    expect(instruction).toContain('the project conversation "My App"')
    expect(instruction).toContain(VOICE_LIVE_SEND_TOOL_NAME)
    expect(instruction).toContain('short spoken summary')
    expect(instruction).toContain('explicitly asks you to read it aloud')
  })

  it('states the delegation-first default rule and names every tool', () => {
    const instruction = buildVoiceLiveSystemInstruction({
      surfaceLabel: 'the Assistant Chat conversation',
      capabilities: makeCapabilities(),
      historyTurns: [],
    })

    expect(instruction).toContain('Default rule')
    expect(instruction).toContain('they are asking you to prompt the chat model')
    expect(instruction).toContain(VOICE_LIVE_NEW_CHAT_TOOL_NAME)
    expect(instruction).toContain(VOICE_LIVE_RESEARCH_TOOL_NAME)
    expect(instruction).toContain(VOICE_LIVE_APP_CONTEXT_TOOL_NAME)
    expect(instruction).toContain('real state, not assumptions')
  })

  it('includes recent history when present and omits the section when empty', () => {
    const withHistory = buildVoiceLiveSystemInstruction({
      surfaceLabel: 'the Assistant Chat conversation',
      capabilities: makeCapabilities(),
      historyTurns: [
        { role: 'user', text: 'Build me a kanban board app' },
        { role: 'assistant', text: 'Created the initial scaffold.' },
      ],
    })
    expect(withHistory).toContain('Recent conversation history')
    expect(withHistory).toContain('Build me a kanban board app')
    expect(withHistory).toContain('Chat model: Created the initial scaffold.')

    const withoutHistory = buildVoiceLiveSystemInstruction({
      surfaceLabel: 'the Assistant Chat conversation',
      capabilities: makeCapabilities(),
      historyTurns: [],
    })
    expect(withoutHistory).not.toContain('Recent conversation history')
  })
})

describe('voice live capability briefing', () => {
  it('reports vision support and the lack of it honestly', () => {
    const withVision = buildVoiceLiveCapabilityBriefing(makeCapabilities())
    expect(withVision).toContain('can look at images, PDFs')
    expect(withVision).toContain('cannot process audio files, video files')

    const noVision = buildVoiceLiveCapabilityBriefing(makeCapabilities({
      model: {
        id: 'tiny-text',
        name: 'Tiny Text Model',
        runtimeName: 'llama.cpp',
        attachments: { image: false, audio: false, video: false, pdf: false },
      },
    }))
    expect(noVision).toContain('cannot process images')
    expect(noVision).not.toContain('can look at')
  })

  it('describes work modes, research conversations, and plan mode from state', () => {
    expect(buildVoiceLiveCapabilityBriefing(makeCapabilities()))
      .toContain('Build: the chat model can edit files, run shell commands')
    expect(buildVoiceLiveCapabilityBriefing(makeCapabilities({ workMode: 'explore' })))
      .toContain('Explore: the chat model investigates')
    expect(buildVoiceLiveCapabilityBriefing(makeCapabilities({ planMode: true })))
      .toContain('plan mode is on')
    expect(buildVoiceLiveCapabilityBriefing(makeCapabilities({ conversationKind: 'research' })))
      .toContain('research conversation')
  })

  it('reflects CoBrowse, busy state, and creation availability from reality', () => {
    const coBrowse = buildVoiceLiveCapabilityBriefing(makeCapabilities({
      coBrowseActive: true,
      chatBusy: true,
      canStartResearchChat: { ok: false, reason: 'no project directory is configured' },
    }))
    expect(coBrowse).toContain('CoBrowse is ON')
    expect(coBrowse).toContain('visible in-app browser')
    expect(coBrowse).toContain('BUSY')
    expect(coBrowse).toContain('research conversation is unavailable right now: no project directory is configured')

    const idle = buildVoiceLiveCapabilityBriefing(makeCapabilities())
    expect(idle).toContain('CoBrowse is OFF')
    expect(idle).toContain('idle and ready')
    expect(idle).toContain(VOICE_LIVE_RESEARCH_TOOL_NAME)
  })

  it('handles a missing model without inventing capabilities', () => {
    const briefing = buildVoiceLiveCapabilityBriefing(makeCapabilities({ model: null }))
    expect(briefing).toContain('none is currently resolved')
    expect(briefing).not.toContain('can look at images')
  })

  it('lists enabled add-on tools', () => {
    const briefing = buildVoiceLiveCapabilityBriefing(makeCapabilities({
      addOnTools: ['Chrome DevTools', 'Ask Gemini'],
    }))
    expect(briefing).toContain('Extra tools enabled for this conversation: Chrome DevTools, Ask Gemini')
  })
})

describe('voice live history extraction', () => {
  it('extracts only user and assistant text blocks, never thinking or tools', () => {
    const turns = extractVoiceHistoryTurns([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'hi there' },
      ] },
      { role: 'system', content: [{ type: 'text', text: 'system note' }] },
      { role: 'assistant', content: [{ type: 'tool_call' }] },
    ])

    expect(turns).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ])
  })

  it('caps the history section to the most recent turns', () => {
    const turns = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `message ${index}`,
    }))
    const section = buildVoiceLiveHistorySection(turns)

    expect(section).not.toBeNull()
    expect(section).toContain('message 29')
    expect(section).not.toContain('message 0')
    const lines = section!.split('\n')
    expect(lines.length - 1).toBeLessThanOrEqual(VOICE_LIVE_HISTORY_MAX_TURNS)
  })

  it('truncates oversized turns and returns null for empty history', () => {
    const section = buildVoiceLiveHistorySection([
      { role: 'assistant', text: 'x'.repeat(VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT + 200) },
    ])
    expect(section).toContain('…')
    expect(section!.length).toBeLessThan(VOICE_LIVE_HISTORY_TURN_CHAR_LIMIT + 300)

    expect(buildVoiceLiveHistorySection([])).toBeNull()
  })
})

describe('voice live tool declarations', () => {
  it('exposes the four flat tools with literal names', () => {
    const declarations = buildVoiceLiveToolDeclarations()
    const names = declarations.map((declaration) => declaration.name)

    expect(names).toEqual([
      VOICE_LIVE_SEND_TOOL_NAME,
      VOICE_LIVE_NEW_CHAT_TOOL_NAME,
      VOICE_LIVE_RESEARCH_TOOL_NAME,
      VOICE_LIVE_APP_CONTEXT_TOOL_NAME,
    ])

    const send = declarations[0]!
    expect(send.parameters?.required).toEqual(['prompt'])

    const research = declarations[2]!
    expect(research.parameters?.required).toEqual(['research_goal'])
    expect(Object.keys(research.parameters?.properties ?? {}))
      .toEqual(['research_goal', 'title'])

    const context = declarations[3]!
    expect(Object.keys(context.parameters?.properties ?? {})).toEqual([])
  })
})

describe('voice live tool results', () => {
  it('builds accepted, busy, rejected, starting, and context results', () => {
    expect(buildChatAcceptedResult()).toMatchObject({ ok: true, status: 'sent' })
    expect(buildChatBusyResult()).toMatchObject({ ok: false, status: 'busy' })
    expect(buildChatRejectedResult('nope')).toEqual({
      ok: false,
      status: 'rejected',
      detail: 'nope',
    })
    expect(buildCreationStartingResult('chat')).toMatchObject({ ok: true, status: 'starting' })
    expect(buildCreationStartingResult('research').detail).toContain('research')

    const context = buildAppContextResult(makeCapabilities({ coBrowseActive: true }))
    expect(context).toMatchObject({ ok: true, status: 'ok' })
    expect(context.context).toContain('CoBrowse is ON')
  })
})

describe('voice live chat updates', () => {
  it('wraps the full response and asks for a spoken summary', () => {
    const update = buildChatResponseUpdate('Here is the plan.')

    expect(update).toContain(VOICE_LIVE_CHAT_RESPONSE_TAG)
    expect(update).toContain('Here is the plan.')
    expect(update).toContain('short spoken summary')
    expect(update).toContain('only if they ask')
  })

  it('truncates very large responses but keeps the head intact', () => {
    const huge = 'a'.repeat(VOICE_LIVE_RESPONSE_CHAR_LIMIT + 5_000)
    const update = buildChatResponseUpdate(huge)

    expect(update).toContain('[response truncated for voice mode]')
    expect(update.length).toBeLessThan(huge.length)
    expect(update).toContain('a'.repeat(100))
  })

  it('builds empty-response, error, and creation updates with their tags', () => {
    expect(buildChatEmptyResponseUpdate()).toContain(VOICE_LIVE_CHAT_RESPONSE_TAG)
    expect(buildChatEmptyResponseUpdate()).toContain('no readable text')

    const errorUpdate = buildChatErrorUpdate('the runtime is offline')
    expect(errorUpdate).toContain(VOICE_LIVE_CHAT_ERROR_TAG)
    expect(errorUpdate).toContain('the runtime is offline')

    const chatStarted = buildNewChatStartedUpdate('Ideas', false)
    expect(chatStarted).toContain(VOICE_LIVE_APP_UPDATE_TAG)
    expect(chatStarted).toContain('"Ideas"')
    expect(chatStarted).toContain('ask what they want')

    const chatStartedWithMessage = buildNewChatStartedUpdate('Ideas', true)
    expect(chatStartedWithMessage).toContain('first request was sent')

    const researchStarted = buildResearchStartedUpdate('Research 3')
    expect(researchStarted).toContain(VOICE_LIVE_APP_UPDATE_TAG)
    expect(researchStarted).toContain('"Research 3"')
    expect(researchStarted).toContain('several minutes')

    const failed = buildCreationFailedUpdate('research', 'model missing')
    expect(failed).toContain('research conversation')
    expect(failed).toContain('model missing')
  })
})

describe('normalizeVoiceLiveError', () => {
  it('maps invalid API key errors to a settings hint', () => {
    expect(normalizeVoiceLiveError(new Error('API key not valid. Please pass a valid API key.')))
      .toContain('Settings → Gemini Hosted API')
    expect(normalizeVoiceLiveError('error 400 API_KEY_INVALID'))
      .toContain('Settings → Gemini Hosted API')
  })

  it('maps quota, microphone, and network failures to friendly messages', () => {
    expect(normalizeVoiceLiveError('RESOURCE_EXHAUSTED: quota exceeded'))
      .toContain('quota or rate limit')
    expect(normalizeVoiceLiveError(new Error('NotAllowedError: Permission dismissed')))
      .toContain('microphone')
    expect(normalizeVoiceLiveError(new Error('WebSocket connection failed')))
      .toContain('connection')
  })

  it('compacts unknown errors and never returns an empty message', () => {
    expect(normalizeVoiceLiveError('')).toBe('Voice mode hit an unexpected Gemini Live API error.')
    const long = normalizeVoiceLiveError(`boom ${'x'.repeat(500)}`)
    expect(long.length).toBeLessThanOrEqual(241)
  })
})
