import type { ChatMessage } from '@/types'

export function appendChatMessage(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id)
  if (existingIndex < 0) {
    return [...messages, message]
  }

  return messages.map((entry, index) =>
    index === existingIndex ? message : entry,
  )
}

export function updateChatMessage(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const existingIndex = messages.findIndex((entry) => entry.id === message.id)
  if (existingIndex < 0) {
    return messages
  }

  return messages.map((entry, index) =>
    index === existingIndex ? message : entry,
  )
}

function isBackgroundProcessNoticeMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.content.length === 0) return false
  return message.content.every(
    (block) =>
      block.type === 'shell_session'
      && block.displayMode === 'sidebar',
  )
}

// A background-process notice is appended to the messages array the moment
// `start_background_process` runs — well before the assistant turn that issued
// the call has finished streaming. After `turn_complete` the SDK assistant
// message lands and gets pushed to the array end, so the notice ends up
// rendered ABOVE the actual assistant response. This helper rewrites each turn
// group so notices always render after the model's reply content. Notices that
// appear before the first user message (intro section) are left in place.
export function demoteBackgroundProcessNotices(
  messages: ChatMessage[],
): ChatMessage[] {
  if (messages.length === 0) return messages

  let hasNotice = false
  for (const message of messages) {
    if (isBackgroundProcessNoticeMessage(message)) {
      hasNotice = true
      break
    }
  }
  if (!hasNotice) return messages

  const result: ChatMessage[] = []
  let pendingNotices: ChatMessage[] = []
  let inTurnGroup = false

  for (const message of messages) {
    if (message.role === 'user') {
      result.push(...pendingNotices)
      pendingNotices = []
      result.push(message)
      inTurnGroup = true
      continue
    }

    if (!inTurnGroup) {
      result.push(message)
      continue
    }

    if (isBackgroundProcessNoticeMessage(message)) {
      pendingNotices.push(message)
    } else {
      result.push(message)
    }
  }

  result.push(...pendingNotices)

  return result
}
