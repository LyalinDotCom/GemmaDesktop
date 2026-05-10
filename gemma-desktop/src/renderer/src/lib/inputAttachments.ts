import type {
  AttachmentKind,
  FileAttachment,
  ImageAttachment,
} from '@/types'

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif',
  '.avif',
  '.tif',
  '.tiff',
])
const PDF_EXTENSIONS = new Set([
  '.pdf',
])
const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff',
  '.caf',
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
])
const VIDEO_MIN_KEYFRAME_COUNT = 8
const VIDEO_MAX_KEYFRAME_COUNT = 18
const VIDEO_CANDIDATE_FRAME_LIMIT = 36
const VIDEO_SAMPLE_MAX_LONG_EDGE = 1024
const VIDEO_FINGERPRINT_WIDTH = 32
const VIDEO_FINGERPRINT_HEIGHT = 18
const VIDEO_KEYFRAME_CHANGE_THRESHOLD = 12

type FileWithOptionalPath = File & {
  path?: string
}

export type InputAttachmentFile = Blob & {
  name: string
  size: number
  type: string
  path?: string
}

export interface VideoFrameFingerprintCandidate {
  timeMs: number
  fingerprint: readonly number[]
}

type FileReaderLike = {
  error: unknown
  result: string | ArrayBuffer | null
  onerror: null | (() => void)
  onload: null | (() => void)
  readAsDataURL(file: Blob): void
}

type FileReaderLikeCtor = new () => FileReaderLike

type FileTransferLike = {
  files: {
    length: number
  }
  types: Iterable<string>
}

function normalizeFilePathForUrl(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

export function filePathToPreviewUrl(filePath: string): string {
  const normalizedPath = normalizeFilePathForUrl(filePath.trim())

  if (normalizedPath.startsWith('file://')) {
    const rawPath = decodeURI(normalizedPath.replace(/^file:\/\/\/?/, '/'))
    return `gemma-desktop-file://${encodeURI(rawPath)}`
  }

  const encodedPath = encodeURI(normalizedPath)
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `gemma-desktop-file:///${encodedPath}`
  }
  if (normalizedPath.startsWith('/')) {
    return `gemma-desktop-file://${encodedPath}`
  }
  return `gemma-desktop-file://${encodedPath}`
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export function resolveAttachmentPreviewUrl(
  attachment: Pick<FileAttachment, 'previewUrl' | 'path'>,
): string | undefined {
  const previewUrl = attachment.previewUrl?.trim()
  if (previewUrl) {
    if (isAbsoluteFilesystemPath(previewUrl) || previewUrl.startsWith('file://')) {
      return filePathToPreviewUrl(previewUrl)
    }
    return previewUrl
  }

  const filePath = attachment.path?.trim()
  if (!filePath) {
    return undefined
  }
  return filePathToPreviewUrl(filePath)
}

function extensionOf(name: string): string {
  const trimmed = name.trim()
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return ''
  }
  return trimmed.slice(lastDot).toLowerCase()
}

function inferMediaTypeFromName(name: string): string | undefined {
  switch (extensionOf(name)) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.heic':
      return 'image/heic'
    case '.heif':
      return 'image/heif'
    case '.avif':
      return 'image/avif'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.pdf':
      return 'application/pdf'
    case '.wav':
      return 'audio/wav'
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.ogg':
    case '.oga':
      return 'audio/ogg'
    case '.opus':
      return 'audio/opus'
    case '.aif':
    case '.aiff':
      return 'audio/aiff'
    case '.caf':
      return 'audio/x-caf'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.m4v':
      return 'video/x-m4v'
    case '.webm':
      return 'video/webm'
    default:
      return undefined
  }
}

export function isImageFileLike(file: Pick<InputAttachmentFile, 'name' | 'type'>): boolean {
  if (file.type.startsWith('image/')) {
    return true
  }
  return IMAGE_EXTENSIONS.has(extensionOf(file.name))
}

export function isPdfFileLike(file: Pick<InputAttachmentFile, 'name' | 'type'>): boolean {
  if (file.type === 'application/pdf') {
    return true
  }
  return PDF_EXTENSIONS.has(extensionOf(file.name))
}

export function isAudioFileLike(file: Pick<InputAttachmentFile, 'name' | 'type'>): boolean {
  if (file.type.startsWith('audio/')) {
    return true
  }
  return AUDIO_EXTENSIONS.has(extensionOf(file.name))
}

export function isVideoFileLike(file: Pick<InputAttachmentFile, 'name' | 'type'>): boolean {
  if (file.type.startsWith('video/')) {
    return true
  }
  return VIDEO_EXTENSIONS.has(extensionOf(file.name))
}

export function detectAttachmentKind(
  file: Pick<InputAttachmentFile, 'name' | 'type'>,
): AttachmentKind | undefined {
  if (isImageFileLike(file)) {
    return 'image'
  }
  if (isPdfFileLike(file)) {
    return 'pdf'
  }
  if (isAudioFileLike(file)) {
    return 'audio'
  }
  if (isVideoFileLike(file)) {
    return 'video'
  }
  return undefined
}

function readFileAsDataUrl(file: InputAttachmentFile): Promise<string> {
  return new Promise((resolve, reject) => {
    const Reader = (globalThis as typeof globalThis & {
      FileReader?: FileReaderLikeCtor
    }).FileReader
    if (!Reader) {
      reject(new Error('FileReader is not available in this environment.'))
      return
    }

    const reader = new Reader()
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Unable to read file: ${file.name}`))
    }
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Unexpected file reader result for: ${file.name}`))
        return
      }
      resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function estimateDataUrlSize(dataUrl: string): number {
  const payload = dataUrl.split(',')[1] ?? ''
  return Math.round((payload.length * 3) / 4)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function resolveVideoTargetFrameCount(durationMs?: number): number {
  if (!Number.isFinite(durationMs) || durationMs == null || durationMs <= 0) {
    return VIDEO_MIN_KEYFRAME_COUNT
  }

  const durationSeconds = durationMs / 1000
  return clamp(
    Math.ceil(durationSeconds / 5) + 6,
    VIDEO_MIN_KEYFRAME_COUNT,
    VIDEO_MAX_KEYFRAME_COUNT,
  )
}

export function buildVideoSampleTimes(durationSeconds: number, frameCount: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0]
  }

  if (frameCount <= 1) {
    return [Math.min(durationSeconds / 2, Math.max(durationSeconds - 0.1, 0))]
  }

  const safeStart = Math.min(0.5, durationSeconds / 4)
  const safeEnd = Math.max(durationSeconds - 0.5, safeStart)
  const usableDuration = Math.max(safeEnd - safeStart, 0)
  const step = frameCount > 1 ? usableDuration / (frameCount - 1) : 0

  return Array.from({ length: frameCount }, (_, index) =>
    Number((safeStart + step * index).toFixed(3)),
  )
}

function buildVideoFingerprint(
  sourceCanvas: HTMLCanvasElement,
  fingerprintCanvas: HTMLCanvasElement,
  fingerprintContext: CanvasRenderingContext2D,
): number[] {
  fingerprintContext.clearRect(0, 0, fingerprintCanvas.width, fingerprintCanvas.height)
  fingerprintContext.drawImage(
    sourceCanvas,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
    0,
    0,
    fingerprintCanvas.width,
    fingerprintCanvas.height,
  )

  const { data } = fingerprintContext.getImageData(
    0,
    0,
    fingerprintCanvas.width,
    fingerprintCanvas.height,
  )
  const fingerprint: number[] = []
  for (let index = 0; index < data.length; index += 4) {
    fingerprint.push(
      Math.round((data[index]! + data[index + 1]! + data[index + 2]!) / 3),
    )
  }
  return fingerprint
}

function averageVideoFingerprintDifference(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length)
  if (length === 0) {
    return 0
  }

  let total = 0
  for (let index = 0; index < length; index += 1) {
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0))
  }
  return total / length
}

function pickEvenlyDistributedIndices(
  indices: number[],
  desiredCount: number,
): number[] {
  if (desiredCount >= indices.length) {
    return [...indices]
  }

  const picked: number[] = []
  const used = new Set<number>()

  for (let position = 0; position < desiredCount; position += 1) {
    let sourceIndex = Math.round(
      (position * (indices.length - 1)) / Math.max(desiredCount - 1, 1),
    )

    while (used.has(sourceIndex) && sourceIndex < indices.length - 1) {
      sourceIndex += 1
    }
    while (used.has(sourceIndex) && sourceIndex > 0) {
      sourceIndex -= 1
    }

    used.add(sourceIndex)
    picked.push(indices[sourceIndex]!)
  }

  return [...new Set(picked)].sort((left, right) => left - right)
}

function fillKeyframeSelection(
  candidates: VideoFrameFingerprintCandidate[],
  selectedIndices: number[],
  desiredCount: number,
): number[] {
  const filled = [...selectedIndices]
  const selectedSet = new Set(selectedIndices)
  const totalDurationMs = Math.max(
    (candidates[candidates.length - 1]?.timeMs ?? 0) - (candidates[0]?.timeMs ?? 0),
    1,
  )

  while (filled.length < desiredCount) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (selectedSet.has(candidateIndex)) {
        continue
      }

      const candidate = candidates[candidateIndex]!
      const novelty = filled.reduce((lowestDifference, selectedIndex) => {
        const selected = candidates[selectedIndex]!
        return Math.min(
          lowestDifference,
          averageVideoFingerprintDifference(candidate.fingerprint, selected.fingerprint),
        )
      }, Number.POSITIVE_INFINITY)

      const temporalDistance = filled.reduce((lowestDistance, selectedIndex) => {
        const selected = candidates[selectedIndex]!
        return Math.min(lowestDistance, Math.abs(candidate.timeMs - selected.timeMs))
      }, Number.POSITIVE_INFINITY)

      const normalizedTemporalBonus = (temporalDistance / totalDurationMs) * 32
      const score = novelty + normalizedTemporalBonus

      if (score > bestScore) {
        bestScore = score
        bestIndex = candidateIndex
      }
    }

    if (bestIndex === -1) {
      break
    }

    selectedSet.add(bestIndex)
    filled.push(bestIndex)
  }

  return filled.sort((left, right) => left - right)
}

export function selectVideoKeyframeIndices(
  candidates: VideoFrameFingerprintCandidate[],
  targetFrameCount: number,
): number[] {
  if (candidates.length === 0) {
    return []
  }

  const desiredCount = Math.min(Math.max(targetFrameCount, 1), candidates.length)
  if (candidates.length <= desiredCount) {
    return candidates.map((_, index) => index)
  }

  const lastCandidateIndex = candidates.length - 1
  const totalDurationMs = Math.max(
    candidates[lastCandidateIndex]!.timeMs - candidates[0]!.timeMs,
    0,
  )
  const minGapMs = totalDurationMs > 0
    ? totalDurationMs / Math.max(desiredCount * 1.5, 1)
    : 0
  const maxGapMs = totalDurationMs > 0
    ? totalDurationMs / Math.max(Math.floor(desiredCount / 2), 1)
    : 0

  const selected = [0]

  for (let candidateIndex = 1; candidateIndex < lastCandidateIndex; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!
    const previousSelected = candidates[selected[selected.length - 1]!]!
    const gapMs = candidate.timeMs - previousSelected.timeMs
    const changeScore = averageVideoFingerprintDifference(
      candidate.fingerprint,
      previousSelected.fingerprint,
    )

    if (
      (gapMs >= minGapMs && changeScore >= VIDEO_KEYFRAME_CHANGE_THRESHOLD)
      || gapMs >= maxGapMs
    ) {
      selected.push(candidateIndex)
    }
  }

  if (!selected.includes(lastCandidateIndex)) {
    selected.push(lastCandidateIndex)
  }

  const uniqueSelected = [...new Set(selected)].sort((left, right) => left - right)

  if (uniqueSelected.length > desiredCount) {
    return pickEvenlyDistributedIndices(uniqueSelected, desiredCount)
  }

  if (uniqueSelected.length < desiredCount) {
    return fillKeyframeSelection(candidates, uniqueSelected, desiredCount)
  }

  return uniqueSelected
}

function scaleFrameSize(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (!Number.isFinite(longEdge) || longEdge <= VIDEO_SAMPLE_MAX_LONG_EDGE) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
  }

  const scale = VIDEO_SAMPLE_MAX_LONG_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function waitForVideoReady(
  video: HTMLVideoElement,
): Promise<void> {
  if (video.readyState >= 1) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', handleLoaded)
      video.removeEventListener('error', handleError)
    }
    const handleLoaded = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error('Unable to read video metadata.'))
    }
    video.addEventListener('loadedmetadata', handleLoaded, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

async function seekVideo(
  video: HTMLVideoElement,
  timeSeconds: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }
    const handleSeeked = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error('Unable to sample video frames.'))
    }
    video.addEventListener('seeked', handleSeeked, { once: true })
    video.addEventListener('error', handleError, { once: true })
    video.currentTime = timeSeconds
  })
}

async function sampleVideoFrames(
  file: InputAttachmentFile,
): Promise<{ durationMs?: number; sampledFrames: ImageAttachment[] }> {
  if (
    typeof document === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    return { sampledFrames: [] }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.src = objectUrl

    await waitForVideoReady(video)

    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0
    const durationMs = durationSeconds > 0 ? Math.round(durationSeconds * 1000) : undefined
    const targetFrameCount = resolveVideoTargetFrameCount(durationMs)
    const candidateFrameCount = clamp(
      targetFrameCount * 2,
      12,
      VIDEO_CANDIDATE_FRAME_LIMIT,
    )
    const sampleTimes = buildVideoSampleTimes(durationSeconds, candidateFrameCount)
    const captureCanvas = document.createElement('canvas')
    const fingerprintCanvas = document.createElement('canvas')
    fingerprintCanvas.width = VIDEO_FINGERPRINT_WIDTH
    fingerprintCanvas.height = VIDEO_FINGERPRINT_HEIGHT
    const fingerprintContext = fingerprintCanvas.getContext('2d')
    const sampledCandidates: Array<{
      timeMs: number
      dataUrl: string
      fingerprint: number[]
    }> = []

    for (const timeSeconds of sampleTimes) {
      await seekVideo(video, timeSeconds)

      const { width, height } = scaleFrameSize(video.videoWidth, video.videoHeight)
      captureCanvas.width = width
      captureCanvas.height = height
      const context = captureCanvas.getContext('2d')
      if (!context || !fingerprintContext) {
        continue
      }

      context.clearRect(0, 0, captureCanvas.width, captureCanvas.height)
      context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height)
      const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.86)
      sampledCandidates.push({
        timeMs: Math.round(timeSeconds * 1000),
        dataUrl,
        fingerprint: buildVideoFingerprint(
          captureCanvas,
          fingerprintCanvas,
          fingerprintContext,
        ),
      })
    }

    const selectedCandidateIndices = selectVideoKeyframeIndices(
      sampledCandidates.map(({ timeMs, fingerprint }) => ({
        timeMs,
        fingerprint,
      })),
      targetFrameCount,
    )
    const sampledFrames: ImageAttachment[] = selectedCandidateIndices.map((candidateIndex, index) => {
      const candidate = sampledCandidates[candidateIndex]!
      return {
        kind: 'image',
        name: `${file.name.replace(/\.[^.]+$/, '') || 'video'}-frame-${index + 1}.jpg`,
        size: estimateDataUrlSize(candidate.dataUrl),
        mediaType: 'image/jpeg',
        dataUrl: candidate.dataUrl,
        previewUrl: candidate.dataUrl,
        source: 'file',
        timestampMs: candidate.timeMs,
      }
    })

    if (sampledFrames.length === 0 && sampledCandidates.length > 0) {
      const firstCandidate = sampledCandidates[0]!
      sampledFrames.push({
        kind: 'image',
        name: `${file.name.replace(/\.[^.]+$/, '') || 'video'}-frame-1.jpg`,
        size: estimateDataUrlSize(firstCandidate.dataUrl),
        mediaType: 'image/jpeg',
        dataUrl: firstCandidate.dataUrl,
        previewUrl: firstCandidate.dataUrl,
        source: 'file',
        timestampMs: firstCandidate.timeMs,
      })
    }

    return {
      durationMs,
      sampledFrames,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function fileToAttachment(file: InputAttachmentFile): Promise<FileAttachment | null> {
  const kind = detectAttachmentKind(file)
  if (!kind) {
    return null
  }

  const nativeFile = file as FileWithOptionalPath
  const mediaType = file.type || inferMediaTypeFromName(file.name)
  const nativePath =
    typeof nativeFile.path === 'string' && nativeFile.path.trim().length > 0
      ? nativeFile.path
      : undefined

  if (kind === 'pdf') {
    if (nativePath) {
      return {
        kind: 'pdf',
        name: file.name,
        path: nativePath,
        size: file.size,
        mediaType: 'application/pdf',
        source: 'file',
      }
    }

    return {
      kind: 'pdf',
      name: file.name,
      size: file.size,
      mediaType: 'application/pdf',
      dataUrl: await readFileAsDataUrl(file),
      source: 'file',
    }
  }

  if (kind === 'image') {
    if (nativePath) {
      return {
        kind: 'image',
        name: file.name,
        path: nativePath,
        size: file.size,
        mediaType,
        previewUrl: filePathToPreviewUrl(nativePath),
        source: 'file',
      }
    }

    const dataUrl = await readFileAsDataUrl(file)
    return {
      kind: 'image',
      name: file.name,
      size: file.size,
      mediaType,
      dataUrl,
      previewUrl: dataUrl,
      source: 'file',
    }
  }

  if (kind === 'audio') {
    if (nativePath) {
      return {
        kind: 'audio',
        name: file.name,
        path: nativePath,
        size: file.size,
        mediaType,
        source: 'file',
      }
    }

    return {
      kind: 'audio',
      name: file.name,
      size: file.size,
      mediaType,
      dataUrl: await readFileAsDataUrl(file),
      source: 'file',
    }
  }

  const sampled = await sampleVideoFrames(file)
  const previewUrl =
    sampled.sampledFrames[0]?.previewUrl
    ?? (nativePath ? filePathToPreviewUrl(nativePath) : undefined)

  if (nativePath) {
    return {
      kind: 'video',
      name: file.name,
      path: nativePath,
      size: file.size,
      mediaType,
      previewUrl,
      source: 'file',
      durationMs: sampled.durationMs,
      sampledFrames: sampled.sampledFrames,
    }
  }

  return {
    kind: 'video',
    name: file.name,
    size: file.size,
    mediaType,
    dataUrl: await readFileAsDataUrl(file),
    previewUrl,
    source: 'file',
    durationMs: sampled.durationMs,
    sampledFrames: sampled.sampledFrames,
  }
}

export async function filesToAttachments(files: Iterable<InputAttachmentFile>): Promise<FileAttachment[]> {
  const attachments = await Promise.all(
    Array.from(files, async (file) => await fileToAttachment(file)),
  )
  return attachments.filter((attachment): attachment is FileAttachment => attachment != null)
}

export function dataTransferMayContainFiles(dataTransfer: FileTransferLike | null): boolean {
  if (!dataTransfer) {
    return false
  }

  if (dataTransfer.files.length > 0) {
    return true
  }

  return Array.from(dataTransfer.types).includes('Files')
}
