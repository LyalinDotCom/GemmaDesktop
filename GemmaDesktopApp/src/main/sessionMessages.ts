import { pathToFileURL } from 'url'

export interface SessionDetailMessage {
  id: string
  role: string
  content: Array<Record<string, unknown>>
  timestamp: number
  durationMs?: number
  primaryModelId?: string
  primaryRuntimeId?: string
}

const USER_MESSAGE_CLOCK_SKEW_MS = 250
const USER_MESSAGE_FALLBACK_DEDUPE_WINDOW_MS = 1_500

function normalizeTextContent(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function extractManifestPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*Path:\s+(.+?)\s*$/.exec(line)
      return match?.[1]?.trim()
    })
    .filter((value): value is string => Boolean(value))
}

function extractManifestAttachmentKinds(text: string): Array<{
  kind: 'image' | 'audio' | 'video' | 'pdf'
  path: string
}> {
  const lines = text.split(/\r?\n/)
  const entries: Array<{
    kind: 'image' | 'audio' | 'video' | 'pdf'
    path: string
  }> = []
  let pendingKind: 'image' | 'audio' | 'video' | 'pdf' | null = null

  for (const line of lines) {
    const headerMatch = /^\s*\d+\.\s+(IMAGE|AUDIO|VIDEO|PDF):/i.exec(line)
    if (headerMatch?.[1]) {
      const normalized = headerMatch[1].toLowerCase()
      pendingKind =
        normalized === 'image'
        || normalized === 'audio'
        || normalized === 'video'
        || normalized === 'pdf'
          ? normalized
          : null
      continue
    }

    const pathMatch = /^\s*Path:\s+(.+?)\s*$/.exec(line)
    if (pendingKind && pathMatch?.[1]) {
      entries.push({
        kind: pendingKind,
        path: pathMatch[1].trim(),
      })
      pendingKind = null
    }
  }

  return entries
}

function splitManifestText(text: string): {
  mainText: string
  manifestText: string | null
} {
  const marker = 'Attached local files for this turn are available on disk.'
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) {
    return {
      mainText: text,
      manifestText: null,
    }
  }

  return {
    mainText: text.slice(0, markerIndex).trim(),
    manifestText: text.slice(markerIndex).trim(),
  }
}

function normalizeMessageAssetUrl(url: string): string {
  if (url.startsWith('file://') || url.startsWith('data:')) {
    return url
  }

  if (url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('\\\\')) {
    return pathToFileURL(url).toString()
  }

  if (/^[A-Za-z][A-Za-z\d+\-.]*:/.test(url)) {
    return url
  }

  return url
}

function buildMessageFingerprint(content: Array<Record<string, unknown>>): string {
  const parts: string[] = []

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = normalizeTextContent(block.text)
      if (text.length > 0) {
        const { mainText, manifestText } = splitManifestText(text)
        if (mainText.length > 0) {
          parts.push(`text:${mainText}`)
        } else if (!manifestText) {
          parts.push(`text:${text}`)
        }
        for (const manifestPath of extractManifestPaths(manifestText ?? text)) {
          parts.push(`file:${normalizeMessageAssetUrl(manifestPath)}`)
        }
        for (const attachment of extractManifestAttachmentKinds(manifestText ?? text)) {
          parts.push(`${attachment.kind}:${normalizeMessageAssetUrl(attachment.path)}`)
        }
      }
      continue
    }

    if (
      (block.type === 'image' || block.type === 'image_url')
      && typeof block.url === 'string'
    ) {
      parts.push(`image:${normalizeMessageAssetUrl(block.url)}`)
      parts.push(`file:${normalizeMessageAssetUrl(block.url)}`)
      continue
    }

    if (
      (block.type === 'audio' || block.type === 'audio_url')
      && typeof block.url === 'string'
    ) {
      parts.push(`audio:${normalizeMessageAssetUrl(block.url)}`)
      parts.push(`file:${normalizeMessageAssetUrl(block.url)}`)
      continue
    }

    if (block.type === 'pdf') {
      const previewThumbnails = Array.isArray(block.previewThumbnails)
        ? block.previewThumbnails.filter((entry): entry is string => typeof entry === 'string')
        : []

      if (previewThumbnails.length > 0) {
        for (const thumbnail of previewThumbnails) {
          parts.push(`image:${normalizeMessageAssetUrl(thumbnail)}`)
          parts.push(`file:${normalizeMessageAssetUrl(thumbnail)}`)
        }
        continue
      }

      if (typeof block.url === 'string') {
        parts.push(`pdf:${normalizeMessageAssetUrl(block.url)}`)
        parts.push(`file:${normalizeMessageAssetUrl(block.url)}`)
      }
      continue
    }

    if (block.type === 'video') {
      const thumbnails = Array.isArray(block.thumbnails)
        ? block.thumbnails.filter((entry): entry is string => typeof entry === 'string')
        : []

      if (thumbnails.length > 0) {
        for (const thumbnail of thumbnails) {
          parts.push(`image:${normalizeMessageAssetUrl(thumbnail)}`)
          parts.push(`file:${normalizeMessageAssetUrl(thumbnail)}`)
        }
        continue
      }

      if (typeof block.url === 'string') {
        parts.push(`video:${normalizeMessageAssetUrl(block.url)}`)
        parts.push(`file:${normalizeMessageAssetUrl(block.url)}`)
      }
    }
  }

  return [...new Set(parts)].sort().join('\u001f')
}

function findEquivalentSdkUserMessage(
  appMessage: SessionDetailMessage,
  sdkCandidates: Array<{
    index: number
    timestamp: number
    fingerprint: string
  }>,
  consumedSdkIndexes: Set<number>,
): number | null {
  const fingerprint = buildMessageFingerprint(appMessage.content)
  if (fingerprint.length === 0) {
    return null
  }

  let bestFutureIndex: number | null = null
  let bestFutureDelay = Number.POSITIVE_INFINITY
  let bestNearbyIndex: number | null = null
  let bestNearbyDistance = Number.POSITIVE_INFINITY

  for (const candidate of sdkCandidates) {
    if (candidate.fingerprint !== fingerprint || consumedSdkIndexes.has(candidate.index)) {
      continue
    }

    const delay = candidate.timestamp - appMessage.timestamp
    if (delay >= -USER_MESSAGE_CLOCK_SKEW_MS && delay < bestFutureDelay) {
      bestFutureIndex = candidate.index
      bestFutureDelay = delay
    }

    const distance = Math.abs(delay)
    if (
      distance <= USER_MESSAGE_FALLBACK_DEDUPE_WINDOW_MS
      && distance < bestNearbyDistance
    ) {
      bestNearbyIndex = candidate.index
      bestNearbyDistance = distance
    }
  }

  return bestFutureIndex ?? bestNearbyIndex
}

function findMissingAppUserMessageIndexes(
  sdkMessages: SessionDetailMessage[],
  appMessages: SessionDetailMessage[],
): Set<number> {
  const sdkUserCandidates = sdkMessages
    .map((message, index) => ({
      index,
      role: message.role,
      timestamp: message.timestamp,
      fingerprint: buildMessageFingerprint(message.content),
    }))
    .filter(
      (candidate) =>
        candidate.role === 'user'
        && candidate.fingerprint.length > 0,
    )
  const consumedSdkIndexes = new Set<number>()
  const missingAppMessageIndexes = new Set<number>()

  for (const [index, message] of appMessages.entries()) {
    if (message.role !== 'user') {
      continue
    }

    const equivalentSdkIndex = findEquivalentSdkUserMessage(
      message,
      sdkUserCandidates,
      consumedSdkIndexes,
    )

    if (equivalentSdkIndex != null) {
      consumedSdkIndexes.add(equivalentSdkIndex)
      continue
    }

    missingAppMessageIndexes.add(index)
  }

  return missingAppMessageIndexes
}

export function findMissingAppUserMessages(
  sdkMessages: SessionDetailMessage[],
  appMessages: SessionDetailMessage[] = [],
): SessionDetailMessage[] {
  const missingAppMessageIndexes = findMissingAppUserMessageIndexes(
    sdkMessages,
    appMessages,
  )

  return appMessages.filter((message, index) =>
    message.role === 'user' && missingAppMessageIndexes.has(index),
  )
}

export function mergeSessionMessages(
  sdkMessages: SessionDetailMessage[],
  appMessages: SessionDetailMessage[] = [],
): SessionDetailMessage[] {
  const byMessageKey = new Map<string, SessionDetailMessage>()

  for (const message of sdkMessages) {
    byMessageKey.set(`${message.id}:${message.role}`, message)
  }

  const missingAppMessageIndexes = findMissingAppUserMessageIndexes(
    sdkMessages,
    appMessages,
  )

  for (const [index, message] of appMessages.entries()) {
    if (message.role === 'user' && !missingAppMessageIndexes.has(index)) {
      continue
    }

    byMessageKey.set(`${message.id}:${message.role}`, message)
  }

  return [...byMessageKey.values()].sort(compareSessionMessagesForTimeline)
}

// Timestamp-only sorting is unstable when two messages share a millisecond —
// which happens regularly because `Date.now()` is the source for many event
// timestamps and modern hardware can emit several events per ms. Without a
// deterministic tie-breaker, the same input could order shell-session notices
// differently across loads, producing the kind of "row jumped to a new spot"
// flicker users see when a long-running background process changes state.
export function compareSessionMessagesForTimeline(
  a: SessionDetailMessage,
  b: SessionDetailMessage,
): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp
  }
  // Users come before assistants at the same instant — protects the
  // user→assistant turn boundary that ChatCanvas relies on.
  if (a.role !== b.role) {
    if (a.role === 'user') return -1
    if (b.role === 'user') return 1
  }
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}
