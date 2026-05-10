import { describe, expect, it } from 'vitest'
import {
  buildAssistantNarrationFallback,
  buildAssistantNarrationTask,
  normalizeAssistantNarrationText,
} from '../../src/shared/assistantNarration'

function extractFirstText(
  input: ReturnType<typeof buildAssistantNarrationTask>['sessionInput'],
): string {
  if (!Array.isArray(input)) {
    return typeof input === 'string' ? input : ''
  }

  const first = input[0]
  return first?.type === 'text' ? first.text : ''
}

describe('assistant narration helper prompt', () => {
  it('asks for a friendly short spoken line for image submissions', () => {
    const task = buildAssistantNarrationTask({
      phase: 'submission',
      userText: 'What is in this image?',
      attachments: [{ kind: 'image', name: 'seat.jpg' }],
    })

    expect(task.systemInstructions).toContain('one short line')
    expect(task.systemInstructions).toContain('friendly, calm, and direct')
    expect(task.systemInstructions).toContain('4 to 16 words')
    expect(task.fallbackText).toBe('Sure, let me take a look at that image.')
    expect(extractFirstText(task.sessionInput)).toContain('Phase: submission')
    expect(extractFirstText(task.sessionInput)).toContain('Attachments: 1 image')
  })

  it('keeps result narration compact and normalizes generated text', () => {
    const task = buildAssistantNarrationTask({
      phase: 'result',
      userText: 'Analyze this image.',
      assistantText: 'The image shows a man in an airplane seat wearing earbuds.',
    })

    expect(task.fallbackText).toBe("Okay, here's what I found.")
    expect(extractFirstText(task.sessionInput)).toContain('Assistant result excerpt')
    expect(normalizeAssistantNarrationText({
      text: ' "Okay, here is what I see. The image shows more detail." ',
    })).toBe('Okay, here is what I see.')
    expect(buildAssistantNarrationFallback({ phase: 'submission', attachments: [] }))
      .toBe("Sure, I'll take a look.")
  })

  it('treats submission narration as an action acknowledgement, not an answer', () => {
    const task = buildAssistantNarrationTask({
      phase: 'submission',
      userText: 'is he married',
      conversationTitle: 'Sam Altman',
    })

    expect(task.systemInstructions).toContain('This is an acknowledgement before work starts')
    expect(task.systemInstructions).toContain('Do not try to answer the user request yet.')
    expect(task.systemInstructions).toContain('trust the conversation context')
    expect(task.systemInstructions).toContain('Never say that you do not know')
    expect(extractFirstText(task.sessionInput)).toContain('User request: is he married')
    expect(normalizeAssistantNarrationText(
      { text: "I don't have the answer to that question." },
      { phase: 'submission' },
    )).toBeNull()
    expect(normalizeAssistantNarrationText(
      { text: "I don't have the answer to that question." },
      { phase: 'result' },
    )).toBe("I don't have the answer to that question.")
  })
})
