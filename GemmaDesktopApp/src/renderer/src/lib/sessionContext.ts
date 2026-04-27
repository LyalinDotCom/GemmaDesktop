import type { ChatMessage, DebugSessionSnapshot } from '@/types'

function estimateCharsFromUnknown(value: unknown): number {
  if (typeof value === 'string') {
    return value.length
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).reduce(
      (sum: number, item) => sum + estimateCharsFromUnknown(item),
      0,
    )
  }

  if (value && typeof value === 'object') {
    return (Object.values(value) as unknown[]).reduce(
      (sum: number, item) => sum + estimateCharsFromUnknown(item),
      0,
    )
  }

  return 0
}

function estimateVisibleMessageTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce(
    (sum, message) =>
      sum
      + message.content.reduce((contentSum, content) => {
        switch (content.type) {
          case 'image':
            return contentSum + content.url.length + (content.alt?.length ?? 0)
          case 'audio':
            return (
              contentSum
              + content.url.length
              + content.filename.length
              + String(content.durationMs ?? '').length
            )
          case 'video':
            return (
              contentSum
              + content.url.length
              + content.filename.length
              + content.thumbnails.reduce((sum, thumbnail) => sum + thumbnail.length, 0)
            )
          case 'pdf':
            return (
              contentSum
              + content.url.length
              + content.filename.length
              + content.previewThumbnails.reduce((sum, thumbnail) => sum + thumbnail.length, 0)
              + String(content.batchCount).length
              + (content.workerModelId?.length ?? 0)
            )
          case 'text':
          case 'thinking':
            return contentSum + content.text.length
          case 'tool_call':
            return (
              contentSum
              + JSON.stringify(content.input ?? {}).length
              + (content.output?.length ?? 0)
            )
          case 'code':
            return contentSum + content.code.length
          case 'file_edit':
            return contentSum + content.path.length + content.diff.length
          case 'diff':
            return contentSum + content.diff.length
          case 'file_excerpt':
            return contentSum + content.content.length
          case 'error':
            return contentSum + content.message.length + (content.details?.length ?? 0)
          case 'warning':
            return contentSum + content.message.length
          case 'research_panel':
            return (
              contentSum
              + (content.panel.title?.length ?? 0)
              + content.panel.runStatus.length
              + content.panel.stage.length
              + (content.panel.liveHint?.length ?? 0)
              + (content.panel.errorMessage?.length ?? 0)
            )
          case 'shell_session':
            return contentSum
          case 'folder_link':
            return contentSum + content.label.length + content.path.length
          default:
            return contentSum
        }
      }, 0),
    0,
  )

  return Math.max(0, Math.round(chars / 4))
}

export function buildSessionContextEstimate(
  session: DebugSessionSnapshot | null,
  fallbackMessages: ChatMessage[],
): {
  tokensUsed: number
  source: 'request-preview' | 'visible-chat'
} {
  if (session?.requestPreview) {
    const chars =
      estimateCharsFromUnknown(session.requestPreview.messages)
      + estimateCharsFromUnknown(session.requestPreview.tools)

    return {
      tokensUsed: Math.max(0, Math.round(chars / 4)),
      source: 'request-preview',
    }
  }

  return {
    tokensUsed: estimateVisibleMessageTokens(fallbackMessages),
    source: 'visible-chat',
  }
}
