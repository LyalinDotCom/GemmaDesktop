export type ComposerPresentation = 'default' | 'floating'

export interface ComposerHistoryNavigationInput {
  presentation: ComposerPresentation
  key: string
  text: string
  selectionStart: number
  selectionEnd: number
}

export function shouldOfferComposerHistoryNavigation({
  presentation,
  key,
  text,
  selectionStart,
  selectionEnd,
}: ComposerHistoryNavigationInput): boolean {
  if (presentation === 'floating' || selectionStart !== selectionEnd) {
    return false
  }

  if (key === 'ArrowUp') {
    return selectionStart === 0
  }

  if (key === 'ArrowDown') {
    return selectionEnd === text.length
  }

  return false
}
