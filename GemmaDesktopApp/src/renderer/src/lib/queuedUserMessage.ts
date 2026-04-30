import { resolveAttachmentPreviewUrl } from '@/lib/inputAttachments'
import type {
  FileAttachment,
  MessageContent,
  QueuedUserMessage,
} from '@/types'

function buildQueuedMessageContent(
  text: string,
  attachments: FileAttachment[] = [],
): MessageContent[] {
  const content: MessageContent[] = []

  if (text.trim().length > 0) {
    content.push({
      type: 'text',
      text,
    })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        alt: attachment.name,
        filename: attachment.name,
        mediaType: attachment.mediaType,
        source: attachment.source,
      })
      continue
    }

    if (attachment.kind === 'audio') {
      content.push({
        type: 'audio',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        filename: attachment.name,
        mediaType: attachment.normalizedMediaType ?? attachment.mediaType,
        durationMs: attachment.durationMs,
        normalizedMediaType: attachment.normalizedMediaType,
      })
      continue
    }

    if (attachment.kind === 'video') {
      content.push({
        type: 'video',
        url:
          resolveAttachmentPreviewUrl(attachment)
          ?? attachment.dataUrl
          ?? attachment.path
          ?? '',
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        sampledFrameCount: attachment.sampledFrames?.length ?? 0,
        sampledFrameTimestampsMs: (attachment.sampledFrames ?? [])
          .map((frame) => frame.timestampMs)
          .filter((value): value is number => value != null),
        thumbnails: (attachment.sampledFrames ?? [])
          .map((frame) => resolveAttachmentPreviewUrl(frame) ?? frame.dataUrl ?? frame.path ?? '')
          .filter((value) => value.length > 0),
      })
      continue
    }

    const pageCount = attachment.pageCount ?? attachment.processedRange?.endPage ?? 1
    const processedRange = attachment.processedRange ?? {
      startPage: 1,
      endPage: Math.max(pageCount, 1),
    }

    content.push({
      type: 'pdf',
      url:
        resolveAttachmentPreviewUrl(attachment)
        ?? attachment.dataUrl
        ?? attachment.path
        ?? '',
      filename: attachment.name,
      mediaType: 'application/pdf',
      pageCount,
      processingMode: attachment.processingMode ?? 'full_document',
      processedRange,
      batchCount: attachment.batchCount ?? 0,
      workerModelId: attachment.workerModelId,
      fitStatus: attachment.fitStatus ?? 'ready',
      previewThumbnails: attachment.previewThumbnails ?? [],
    })
  }

  return content
}

export function buildQueuedUserMessage(
  message: { text: string; attachments?: FileAttachment[]; coBrowse?: boolean },
): QueuedUserMessage {
  const timestamp = Date.now()
  const attachments = [...(message.attachments ?? [])]

  return {
    id: `queued-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    text: message.text,
    attachments,
    coBrowse: message.coBrowse,
    content: buildQueuedMessageContent(message.text, attachments),
    timestamp,
    status: 'queued',
  }
}
