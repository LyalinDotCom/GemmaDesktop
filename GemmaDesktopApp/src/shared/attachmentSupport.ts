import {
  ATTACHMENT_CAPABILITY_IDS,
  type AttachmentKind as SdkAttachmentKind,
  type CapabilityRecord,
  resolveCapabilityStatus,
} from '@gemma-desktop/sdk-core'

export type AttachmentKind = SdkAttachmentKind

export interface AttachmentSupport {
  image: boolean
  audio: boolean
  video: boolean
  pdf: boolean
}

export const DEFAULT_ATTACHMENT_SUPPORT: AttachmentSupport = {
  image: false,
  audio: false,
  video: false,
  pdf: false,
}

export function attachmentKindLabel(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image'
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    case 'pdf':
      return 'PDF'
  }
}

export function attachmentKindLabels(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'images'
    case 'audio':
      return 'audio files'
    case 'video':
      return 'video files'
    case 'pdf':
      return 'PDF files'
  }
}

export function deriveAttachmentSupport(
  capabilities: CapabilityRecord[],
): AttachmentSupport {
  const imageSupported = resolveCapabilityStatus(
    capabilities,
    ATTACHMENT_CAPABILITY_IDS.image,
  ) === 'supported'
  const audioSupported = resolveCapabilityStatus(
    capabilities,
    ATTACHMENT_CAPABILITY_IDS.audio,
  ) === 'supported'

  return {
    image: imageSupported,
    audio: audioSupported,
    // Local video still depends on image-capable models because Gemma Desktop turns
    // videos into keyframe images before sending them to the model.
    video: imageSupported,
    // PDF availability is resolved separately from installed Gemma workers.
    pdf: false,
  }
}

export function isAttachmentKindSupported(
  support: AttachmentSupport | undefined,
  kind: AttachmentKind,
): boolean {
  return Boolean(support?.[kind])
}

export function summarizeAttachmentSupport(
  support: AttachmentSupport | undefined,
): AttachmentKind[] {
  return (['image', 'audio', 'video', 'pdf'] as AttachmentKind[]).filter(
    (kind) => Boolean(support?.[kind]),
  )
}
