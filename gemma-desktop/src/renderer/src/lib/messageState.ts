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

export function isBackgroundProcessNoticeMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.content.length === 0) return false
  return message.content.every(
    (block) =>
      block.type === 'shell_session'
      && block.displayMode === 'sidebar',
  )
}

// Background-process notices are persisted in app messages so the main process
// can update status, support peek/terminate lookup, and feed the sidebar. The
// chat transcript already has the tool call and the left-panel process row, so
// these bookkeeping messages should not render as assistant history entries.
export function getRenderableChatMessages(
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

  return messages.filter((message) => !isBackgroundProcessNoticeMessage(message))
}
