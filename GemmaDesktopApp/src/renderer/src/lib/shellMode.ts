export interface ParsedShellDraft {
  isShellMode: boolean
  visibleText: string
  command: string
}

export type ComposerSubmitIntent = 'chat' | 'research' | 'shell'

export function parseShellDraft(text: string): ParsedShellDraft {
  const source = typeof text === 'string' ? text : ''
  const trimmedLeading = source.trimStart()

  if (!trimmedLeading.startsWith('!')) {
    return {
      isShellMode: false,
      visibleText: source.trim(),
      command: '',
    }
  }

  return {
    isShellMode: true,
    visibleText: source.trim(),
    command: trimmedLeading.slice(1).trim(),
  }
}

export function resolveComposerSubmitIntent(input: {
  text: string
  researchMode: boolean
  planMode: boolean
}): ComposerSubmitIntent {
  if (parseShellDraft(input.text).isShellMode) {
    return 'shell'
  }

  if (input.researchMode && !input.planMode) {
    return 'research'
  }

  return 'chat'
}
