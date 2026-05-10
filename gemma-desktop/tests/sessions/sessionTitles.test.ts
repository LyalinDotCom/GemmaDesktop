import { describe, expect, it } from 'vitest'
import {
  buildAutoSessionTitleTask,
  buildFallbackSessionTitle,
  isAutoSessionTitleReplaceable,
  normalizeGeneratedSessionTitle,
} from '../../src/main/sessionTitles'

function extractFirstText(input: ReturnType<typeof buildAutoSessionTitleTask>['sessionInput']): string {
  if (!Array.isArray(input)) {
    return typeof input === 'string' ? input : ''
  }

  const first = input[0]
  return first?.type === 'text' ? first.text : ''
}

describe('session title helpers', () => {
  it('builds bounded research title instructions from the request', () => {
    const task = buildAutoSessionTitleTask({
      conversationKind: 'research',
      promptSeed: 'Research Ollama vs LM Studio vs llama.cpp on macOS today.',
    })

    expect(task.systemInstructions).toContain('deep research session')
    expect(task.systemInstructions).toContain('Base it on the research request.')
    expect(task.systemInstructions).toContain('Use 3 to 5 words.')
    expect(extractFirstText(task.sessionInput)).toContain('3-5 word session title')
    expect(extractFirstText(task.sessionInput)).toContain('Ollama vs LM Studio')
    expect(task.fallbackMaxWords).toBe(5)
  })

  it('keeps normal chat titles on the existing concise developer-chat prompt', () => {
    const task = buildAutoSessionTitleTask({
      conversationKind: 'normal',
      promptSeed: 'Help me wire IPC for attachments.',
    })

    expect(task.systemInstructions).toContain('developer chat')
    expect(task.systemInstructions).toContain('Use 2 to 6 words.')
    expect(task.fallbackMaxWords).toBe(6)
  })

  it('normalizes generated titles and bounds research titles to five words', () => {
    expect(normalizeGeneratedSessionTitle(
      { title: '  "Ollama Runtime Comparison For Local Developers"  ' },
      5,
    )).toBe(
      'Ollama Runtime Comparison For Local',
    )
    expect(buildFallbackSessionTitle(
      'Research current Model Context Protocol adoption across vendors today',
      5,
    )).toBe('Research Current Model Context Protocol')
  })

  it('allows research defaults to be replaced by request-based auto titles', () => {
    expect(isAutoSessionTitleReplaceable({
      conversationKind: 'research',
      title: 'Research 1',
      titleSource: 'auto',
      placeholderTitle: 'New Conversation',
    })).toBe(true)

    expect(isAutoSessionTitleReplaceable({
      conversationKind: 'research',
      title: 'Qwen Packaging Landscape',
      titleSource: 'auto',
      placeholderTitle: 'New Conversation',
    })).toBe(false)

    expect(isAutoSessionTitleReplaceable({
      conversationKind: 'research',
      title: 'Research 1',
      titleSource: 'user',
      placeholderTitle: 'New Conversation',
    })).toBe(false)
  })

  it('keeps normal auto title replacement scoped to the placeholder', () => {
    expect(isAutoSessionTitleReplaceable({
      conversationKind: 'normal',
      title: 'New Conversation',
      titleSource: 'auto',
      placeholderTitle: 'New Conversation',
    })).toBe(true)

    expect(isAutoSessionTitleReplaceable({
      conversationKind: 'normal',
      title: 'Research 1',
      titleSource: 'auto',
      placeholderTitle: 'New Conversation',
    })).toBe(false)
  })
})
