export const MEMORY_INPUT_PREFIX = '#'

export function isMemoryInput(text: string): boolean {
  return extractMemoryPayload(text) !== null
}

export function extractMemoryPayload(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(MEMORY_INPUT_PREFIX)) {
    return null
  }
  const body = trimmed.slice(MEMORY_INPUT_PREFIX.length).trim()
  if (body.length === 0) {
    return null
  }
  if (body.startsWith(MEMORY_INPUT_PREFIX)) {
    return null
  }
  return body
}
