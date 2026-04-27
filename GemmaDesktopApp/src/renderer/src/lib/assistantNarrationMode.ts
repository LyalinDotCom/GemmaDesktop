export type AssistantNarrationMode = 'off' | 'summary' | 'full'

export function getNextAssistantNarrationMode(
  mode: AssistantNarrationMode,
): AssistantNarrationMode {
  switch (mode) {
    case 'off':
      return 'summary'
    case 'summary':
      return 'full'
    case 'full':
      return 'off'
  }
}

export function describeAssistantNarrationMode(
  mode: AssistantNarrationMode,
): string {
  switch (mode) {
    case 'off':
      return 'Spoken responses off'
    case 'summary':
      return 'Speak summaries'
    case 'full':
      return 'Read full responses'
  }
}
