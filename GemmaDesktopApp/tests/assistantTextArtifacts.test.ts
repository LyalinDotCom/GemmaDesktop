import { describe, expect, it } from 'vitest'
import {
  sanitizeRenderableContentBlocks,
  stripAssistantTransportArtifacts,
} from '../src/shared/assistantTextArtifacts'

describe('assistant text artifact sanitization', () => {
  it('strips leaked raw channel markers from assistant deltas', () => {
    expect(
      stripAssistantTransportArtifacts(
        'Step 2: Create main.js\n\nI will start by writing these files.<channel|>\n\nwrite_file',
      ),
    ).toBe(
      'Step 2: Create main.js\n\nI will start by writing these files.\n\nwrite_file',
    )
  })

  it('preserves literal mentions wrapped in inline code', () => {
    expect(
      stripAssistantTransportArtifacts(
        'The leaked token was `<channel|>` in the stream.',
      ),
    ).toBe('The leaked token was `<channel|>` in the stream.')
    expect(
      stripAssistantTransportArtifacts(
        'The leaked token was `<|channel>` in the stream.',
      ),
    ).toBe('The leaked token was `<|channel>` in the stream.')
  })

  it('strips opening and closing channel markers plus wrapped labels', () => {
    expect(
      stripAssistantTransportArtifacts(
        '<|channel>thought\n<channel|>',
      ),
    ).toBe('')
    expect(
      stripAssistantTransportArtifacts(
        'Before <|channel>thought\n<channel|> after',
      ),
    ).toBe('Before  after')
  })

  it('suppresses partial leaked channel labels while a marker is still unfolding', () => {
    expect(stripAssistantTransportArtifacts('<|channel>t')).toBe('')
    expect(stripAssistantTransportArtifacts('<|channel>thou')).toBe('')
  })

  it('sanitizes text and thinking blocks without rewriting tool payloads', () => {
    const blocks = [
      {
        type: 'text',
        text: 'files.<|channel>thought\n<channel|>\n\nwrite_file',
      },
      {
        type: 'thinking',
        text: '<|channel>t',
      },
      {
        type: 'tool_call',
        toolName: 'write_file',
        input: {},
        output: 'literal <channel|> should stay in tool output',
        status: 'success',
      },
    ] satisfies Array<Record<string, unknown>>

    const sanitized = sanitizeRenderableContentBlocks(blocks)

    expect(sanitized).toEqual([
      {
        type: 'text',
        text: 'files.\n\nwrite_file',
      },
      {
        type: 'thinking',
        text: '',
      },
      {
        type: 'tool_call',
        toolName: 'write_file',
        input: {},
        output: 'literal <channel|> should stay in tool output',
        status: 'success',
      },
    ])
  })

  it('coalesces adjacent text and thinking blocks from tokenized reasoning streams', () => {
    const blocks = [
      {
        type: 'thinking',
        text: 'The',
      },
      {
        type: 'thinking',
        text: ' model',
      },
      {
        type: 'text',
        text: 'Answer',
      },
      {
        type: 'text',
        text: ' body',
      },
      {
        type: 'tool_call',
        toolName: 'read_file',
        input: {},
        output: 'done',
        status: 'success',
      },
      {
        type: 'thinking',
        text: 'Later thought',
      },
    ] satisfies Array<Record<string, unknown>>

    expect(sanitizeRenderableContentBlocks(blocks)).toEqual([
      {
        type: 'thinking',
        text: 'The model',
      },
      {
        type: 'text',
        text: 'Answer body',
      },
      {
        type: 'tool_call',
        toolName: 'read_file',
        input: {},
        output: 'done',
        status: 'success',
      },
      {
        type: 'thinking',
        text: 'Later thought',
      },
    ])
  })

  it('returns the original block array when nothing needs cleanup', () => {
    const cleanBlocks = [
      {
        type: 'text',
        text: 'All clear.',
      },
    ] satisfies Array<Record<string, unknown>>

    expect(sanitizeRenderableContentBlocks(cleanBlocks)).toBe(cleanBlocks)
  })
})
