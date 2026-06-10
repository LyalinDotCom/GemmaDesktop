import { describe, expect, it } from 'vitest'
import {
  VOICE_LIVE_CHAT_ERROR_TAG,
  VOICE_LIVE_CHAT_RESPONSE_TAG,
  VOICE_LIVE_RESPONSE_CHAR_LIMIT,
  VOICE_LIVE_SEND_TOOL_NAME,
  buildChatAcceptedResult,
  buildChatBusyResult,
  buildChatEmptyResponseUpdate,
  buildChatErrorUpdate,
  buildChatRejectedResult,
  buildChatResponseUpdate,
  buildVoiceLiveSystemInstruction,
  buildVoiceLiveToolDeclarations,
  normalizeVoiceLiveError,
} from '../../src/renderer/src/lib/voiceLivePrompt'

describe('voice live system instruction', () => {
  it('frames the live model as a delegating Gemma Desktop voice assistant', () => {
    const instruction = buildVoiceLiveSystemInstruction({
      surfaceLabel: 'the project conversation "My App"',
      modelLabel: 'gemma4:26b',
    })

    expect(instruction).toContain('Gemma Desktop')
    expect(instruction).toContain('voice interface, not the worker')
    expect(instruction).toContain('gemma4:26b')
    expect(instruction).toContain('the project conversation "My App"')
    expect(instruction).toContain(VOICE_LIVE_SEND_TOOL_NAME)
    expect(instruction).toContain('Do not do substantive work yourself')
    expect(instruction).toContain('short spoken summary')
    expect(instruction).toContain('explicitly asks you to read it aloud')
  })
})

describe('voice live tool declarations', () => {
  it('exposes exactly one flat send_chat_message tool', () => {
    const declarations = buildVoiceLiveToolDeclarations()

    expect(declarations).toHaveLength(1)
    const tool = declarations[0]!
    expect(tool.name).toBe(VOICE_LIVE_SEND_TOOL_NAME)
    expect(tool.description).toContain(VOICE_LIVE_CHAT_RESPONSE_TAG)
    expect(tool.parameters?.required).toEqual(['prompt'])
    expect(Object.keys(tool.parameters?.properties ?? {})).toEqual(['prompt'])
  })
})

describe('voice live tool results', () => {
  it('builds accepted, busy, and rejected results with literal statuses', () => {
    expect(buildChatAcceptedResult()).toMatchObject({ ok: true, status: 'sent' })
    expect(buildChatBusyResult()).toMatchObject({ ok: false, status: 'busy' })
    expect(buildChatRejectedResult('nope')).toEqual({
      ok: false,
      status: 'rejected',
      detail: 'nope',
    })
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

  it('builds empty-response and error updates with their tags', () => {
    expect(buildChatEmptyResponseUpdate()).toContain(VOICE_LIVE_CHAT_RESPONSE_TAG)
    expect(buildChatEmptyResponseUpdate()).toContain('no readable text')

    const errorUpdate = buildChatErrorUpdate('the runtime is offline')
    expect(errorUpdate).toContain(VOICE_LIVE_CHAT_ERROR_TAG)
    expect(errorUpdate).toContain('the runtime is offline')
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
