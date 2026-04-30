import { execFile } from 'child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import type { SessionInput, SessionCapabilityContext } from '@gemma-desktop/sdk-core'
import {
  PDF_RENDERER_INFO,
  inspectPdfDocument,
  renderPdfPages,
} from '@gemma-desktop/sdk-node'
import {
  attachmentKindLabels,
  deriveAttachmentSupport,
  type AttachmentKind,
} from '../shared/attachmentSupport'

export const PDF_RENDER_SCALE = 2
export const PDF_MAX_WORKER_BATCH_BYTES = 48 * 1024 * 1024
export const PDF_MAX_WORKER_BATCHES = 12
export const PDF_PREVIEW_PAGE_LIMIT = 4
const PDF_ESTIMATED_RENDER_EXPANSION = 4

const execFileAsync = promisify(execFile)

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function warnAttachmentCleanupFailure(action: string, error: unknown): void {
  if (isMissingPathError(error)) {
    return
  }

  console.warn(`[gemma-desktop] ${action}:`, error)
}

async function removePathBestEffort(
  targetPath: string,
  options: Parameters<typeof rm>[1] = { force: true },
): Promise<void> {
  await rm(targetPath, options).catch((error) => {
    warnAttachmentCleanupFailure(`Failed to remove attachment cleanup path ${targetPath}`, error)
  })
}

export type PdfProcessingMode = 'full_document' | 'custom_range'
export type PdfFitStatus =
  | 'ready'
  | 'too_large'
  | 'worker_unavailable'
  | 'planning_failed'

export interface AttachmentPageRange {
  startPage: number
  endPage: number
}

export interface PdfProcessingPlanResult {
  pageCount: number
  defaultRange: AttachmentPageRange
  workerModelId?: string
  estimatedBatchCount: number
  fitStatus: PdfFitStatus
  reason?: string
}

interface BaseIncomingAttachment {
  name: string
  size: number
  path?: string
  mediaType?: string
  dataUrl?: string
  previewUrl?: string
  timestampMs?: number
}

export interface IncomingImageAttachment extends BaseIncomingAttachment {
  kind: 'image'
  source?: 'camera' | 'file'
}

export interface IncomingAudioAttachment extends BaseIncomingAttachment {
  kind: 'audio'
  source?: 'file'
  durationMs?: number
  normalizedDataUrl?: string
  normalizedMediaType?: string
}

export interface IncomingVideoAttachment extends BaseIncomingAttachment {
  kind: 'video'
  source?: 'file'
  durationMs?: number
  sampledFrames?: IncomingImageAttachment[]
}

export interface IncomingPdfAttachment extends BaseIncomingAttachment {
  kind: 'pdf'
  mediaType: 'application/pdf'
  source?: 'file'
  pageCount?: number
  processingMode?: PdfProcessingMode
  processedRange?: AttachmentPageRange
  workerModelId?: string
  batchCount?: number
  fitStatus?: PdfFitStatus
  previewThumbnails?: string[]
  planningReason?: string
}

export type IncomingAttachment =
  | IncomingImageAttachment
  | IncomingAudioAttachment
  | IncomingVideoAttachment
  | IncomingPdfAttachment

export interface PersistedImageAttachment {
  kind: 'image'
  name: string
  size: number
  path: string
  fileUrl: string
  mediaType: string
  source: 'camera' | 'file'
  timestampMs?: number
}

export interface PersistedAudioAttachment {
  kind: 'audio'
  name: string
  size: number
  path: string
  fileUrl: string
  mediaType: string
  source: 'file'
  durationMs?: number
  normalizedMediaType?: string
}

export interface PersistedVideoAttachment {
  kind: 'video'
  name: string
  size: number
  path: string
  fileUrl: string
  mediaType: string
  source: 'file'
  durationMs?: number
  sampledFrames: PersistedImageAttachment[]
}

export interface PersistedPdfAttachment {
  kind: 'pdf'
  name: string
  size: number
  path: string
  fileUrl: string
  mediaType: 'application/pdf'
  source: 'file'
  pageCount: number
  processingMode: PdfProcessingMode
  processedRange: AttachmentPageRange
  workerModelId?: string
  batchCount: number
  fitStatus: PdfFitStatus
  previewThumbnails: string[]
  planningReason?: string
  derivedArtifactPath?: string
  derivedTextPath?: string
  derivedSummary?: string
  derivedPromptText?: string
  derivedPromptTokenEstimate?: number
  derivedByModelId?: string
  derivedByRuntimeId?: string
  renderedPages: PersistedImageAttachment[]
  renderedBytes: number
}

export type PersistedAttachment =
  | PersistedImageAttachment
  | PersistedAudioAttachment
  | PersistedVideoAttachment
  | PersistedPdfAttachment

export interface PdfInspectionResult {
  pageCount: number
}

interface PlannedPdfWorkerBatch {
  index: number
  range: AttachmentPageRange
  pages: PersistedImageAttachment[]
  renderedBytes: number
}

export interface PdfConversionDebugRecord {
  sourceName: string
  sourcePath: string
  pageCount: number
  processedRange: AttachmentPageRange
  processingMode: PdfProcessingMode
  fitStatus: PdfFitStatus
  batchCount: number
  renderedPageCount: number
  renderedBytes: number
  parser: {
    name: string
    version: string
  }
}

export class PdfAttachmentConversionError extends Error {
  readonly debugData: Record<string, unknown>

  constructor(message: string, debugData: Record<string, unknown>) {
    super(message)
    this.name = 'PdfAttachmentConversionError'
    this.debugData = debugData
  }
}

function sanitizeAttachmentFileName(name: string): string {
  const trimmed = name.trim()
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return safe.length > 0 ? safe : `attachment-${Date.now()}`
}

function buildStagedAttachmentFileName(
  inputPath: string,
  fallbackName?: string,
): string {
  const sourceName = fallbackName?.trim().length
    ? fallbackName.trim()
    : path.basename(inputPath)
  const safeName = sanitizeAttachmentFileName(sourceName)
  const ext = path.extname(safeName || inputPath)
  const base = path.basename(safeName || inputPath, ext)
  return `${base || 'attachment'}-${Date.now()}${ext}`
}

async function stageExistingFileIntoAssetDir(input: {
  inputPath: string
  assetDir: string
  fallbackName?: string
}): Promise<string> {
  const resolvedPath = path.resolve(input.inputPath)
  const filename = buildStagedAttachmentFileName(
    resolvedPath,
    input.fallbackName,
  )
  const targetPath = path.join(input.assetDir, filename)
  await copyFile(resolvedPath, targetPath)
  return targetPath
}

function extensionFromMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/mp4':
      return '.m4a'
    case 'audio/aac':
      return '.aac'
    case 'audio/flac':
      return '.flac'
    case 'video/mp4':
      return '.mp4'
    case 'video/quicktime':
      return '.mov'
    case 'video/x-m4v':
      return '.m4v'
    case 'video/webm':
      return '.webm'
    case 'application/pdf':
      return '.pdf'
    default:
      return ''
  }
}

function parseDataUrl(dataUrl: string): { mediaType: string; buffer: Buffer } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) {
    throw new Error('Unsupported attachment data URL.')
  }

  const mediaType = match[1]
  const encodedBody = match[2]

  if (!mediaType || !encodedBody) {
    throw new Error('Malformed attachment data URL.')
  }

  return {
    mediaType,
    buffer: Buffer.from(encodedBody, 'base64'),
  }
}

function defaultPdfRange(pageCount: number): AttachmentPageRange {
  return {
    startPage: 1,
    endPage: Math.max(pageCount, 1),
  }
}

function validatePdfSelection(
  selection: AttachmentPageRange,
  pageCount: number,
): void {
  if (
    !Number.isInteger(selection.startPage)
    || !Number.isInteger(selection.endPage)
  ) {
    throw new Error('PDF page selections must be whole numbers.')
  }

  if (selection.startPage < 1 || selection.endPage < 1) {
    throw new Error('PDF page selections must start at page 1 or later.')
  }

  if (selection.startPage > selection.endPage) {
    throw new Error('The PDF start page must be before the end page.')
  }

  if (selection.endPage > pageCount) {
    throw new Error(`This PDF only has ${pageCount} page${pageCount === 1 ? '' : 's'}.`)
  }
}

function normalizePdfSelection(
  selection: AttachmentPageRange | undefined,
  pageCount: number,
): AttachmentPageRange {
  const nextSelection = selection ?? defaultPdfRange(pageCount)
  validatePdfSelection(nextSelection, pageCount)
  return nextSelection
}

function estimatePdfBatchCount(input: {
  pageCount: number
  selectedRange: AttachmentPageRange
  sourceBytes?: number
}): number {
  const selectedPages = Math.max(
    input.selectedRange.endPage - input.selectedRange.startPage + 1,
    1,
  )
  const estimatedSelectedSourceBytes =
    typeof input.sourceBytes === 'number' && input.sourceBytes > 0
      ? Math.max(
          input.sourceBytes / Math.max(input.pageCount, 1) * selectedPages,
          selectedPages * 256 * 1024,
        )
      : 0
  const estimatedRenderedBytes =
    Math.max(estimatedSelectedSourceBytes, selectedPages * 512 * 1024)
    * PDF_ESTIMATED_RENDER_EXPANSION
  return Math.max(
    1,
    Math.ceil(estimatedRenderedBytes / PDF_MAX_WORKER_BATCH_BYTES),
  )
}

function buildPdfFitReason(
  fitStatus: PdfFitStatus,
  estimatedBatchCount: number,
): string | undefined {
  if (fitStatus === 'worker_unavailable') {
    return 'Install Gemma 4 31B or Gemma 4 26B locally to process PDFs.'
  }

  if (fitStatus === 'too_large') {
    return `This PDF is estimated to require ${estimatedBatchCount} worker batches, which exceeds the ${PDF_MAX_WORKER_BATCHES} batch limit. Try a custom page range.`
  }

  return undefined
}

function createPdfProcessingPlan(input: {
  pageCount: number
  sourceBytes?: number
  selectedRange?: AttachmentPageRange
  workerModelId?: string
}): PdfProcessingPlanResult {
  const defaultRange = defaultPdfRange(input.pageCount)
  const selectedRange = normalizePdfSelection(
    input.selectedRange ?? defaultRange,
    input.pageCount,
  )
  const estimatedBatchCount = estimatePdfBatchCount({
    pageCount: input.pageCount,
    selectedRange,
    sourceBytes: input.sourceBytes,
  })
  const fitStatus: PdfFitStatus =
    !input.workerModelId
      ? 'worker_unavailable'
      : estimatedBatchCount > PDF_MAX_WORKER_BATCHES
        ? 'too_large'
        : 'ready'

  return {
    pageCount: input.pageCount,
    defaultRange,
    workerModelId: input.workerModelId,
    estimatedBatchCount,
    fitStatus,
    reason: buildPdfFitReason(fitStatus, estimatedBatchCount),
  }
}

function inferImageMediaTypeFromPath(filePath: string): string {
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }[path.extname(filePath).toLowerCase()] ?? 'image/jpeg'
  )
}

function inferAudioMediaTypeFromPath(filePath: string): string {
  return (
    {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.opus': 'audio/opus',
      '.aif': 'audio/aiff',
      '.aiff': 'audio/aiff',
      '.caf': 'audio/x-caf',
    }[path.extname(filePath).toLowerCase()] ?? 'audio/wav'
  )
}

function inferVideoMediaTypeFromPath(filePath: string): string {
  return (
    {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.webm': 'video/webm',
    }[path.extname(filePath).toLowerCase()] ?? 'video/mp4'
  )
}

function isWaveLike(mediaType: string | undefined, filePath?: string): boolean {
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav') {
    return true
  }
  return filePath?.toLowerCase().endsWith('.wav') ?? false
}

async function materializePdfForInspection(
  input: Pick<IncomingPdfAttachment, 'path' | 'dataUrl' | 'name'>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (input.path) {
    return {
      path: path.resolve(input.path),
      cleanup: async () => {},
    }
  }

  if (!input.dataUrl) {
    throw new Error('PDF attachment is missing file data.')
  }

  const parsed = parseDataUrl(input.dataUrl)
  if (parsed.mediaType !== 'application/pdf') {
    throw new Error(`Expected a PDF attachment, received ${parsed.mediaType}.`)
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-pdf-inspect-'))
  const baseName = sanitizeAttachmentFileName(input.name || 'document.pdf')
  const filename = path.extname(baseName) ? baseName : `${baseName}.pdf`
  const filePath = path.join(tempDir, filename)
  await writeFile(filePath, parsed.buffer)

  return {
    path: filePath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function parseWavDurationMs(buffer: Buffer): number | undefined {
  if (buffer.length < 44) {
    return undefined
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined
  }

  let offset = 12
  let byteRate: number | undefined
  let dataBytes: number | undefined

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkDataOffset = offset + 8

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataOffset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8)
    }

    if (chunkId === 'data') {
      dataBytes = chunkSize
      break
    }

    offset += 8 + chunkSize + (chunkSize % 2)
  }

  if (!byteRate || !dataBytes || byteRate <= 0) {
    return undefined
  }

  return Math.round((dataBytes / byteRate) * 1000)
}

async function parseWavDurationFromFile(filePath: string): Promise<number | undefined> {
  return parseWavDurationMs(await readFile(filePath))
}

async function normalizeAudioFileToWav(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync('afconvert', [
    inputPath,
    '-o',
    outputPath,
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    '-c',
    '1',
  ])
}

async function persistIncomingImageAttachment(
  attachment: IncomingImageAttachment,
  assetDir: string,
): Promise<PersistedImageAttachment> {
  if (attachment.path) {
    const stagedPath = await stageExistingFileIntoAssetDir({
      inputPath: attachment.path,
      assetDir,
      fallbackName: attachment.name,
    })
    const mediaType = attachment.mediaType ?? inferImageMediaTypeFromPath(stagedPath)
    const stagedStats = await stat(stagedPath)
    return {
      kind: 'image',
      name: attachment.name || path.basename(stagedPath),
      size: stagedStats.size,
      path: stagedPath,
      fileUrl: pathToFileURL(stagedPath).toString(),
      mediaType,
      source: attachment.source ?? 'file',
      timestampMs: attachment.timestampMs,
    }
  }

  if (!attachment.dataUrl) {
    throw new Error('Image attachment is missing data.')
  }

  const parsed = parseDataUrl(attachment.dataUrl)
  const ext = extensionFromMediaType(
    attachment.mediaType ?? parsed.mediaType,
  )
  const baseName = sanitizeAttachmentFileName(
    attachment.name || `camera-${Date.now()}${ext}`,
  )
  const filename = path.extname(baseName)
    ? baseName
    : `${baseName}${ext || '.jpg'}`
  const targetPath = path.join(assetDir, filename)
  await writeFile(targetPath, parsed.buffer)

  return {
    kind: 'image',
    name: filename,
    size: attachment.size || parsed.buffer.byteLength,
    path: targetPath,
    fileUrl: pathToFileURL(targetPath).toString(),
    mediaType: attachment.mediaType ?? parsed.mediaType,
    source: attachment.source ?? 'camera',
    timestampMs: attachment.timestampMs,
  }
}

async function persistIncomingAudioAttachment(
  attachment: IncomingAudioAttachment,
  assetDir: string,
): Promise<PersistedAudioAttachment> {
  let tempDir: string | undefined

  try {
    if (attachment.path) {
      const resolvedPath = path.resolve(attachment.path)
      if (isWaveLike(attachment.mediaType, resolvedPath)) {
        const stagedPath = await stageExistingFileIntoAssetDir({
          inputPath: resolvedPath,
          assetDir,
          fallbackName: attachment.name,
        })
        const stagedStats = await stat(stagedPath)
        return {
          kind: 'audio',
          name: attachment.name || path.basename(stagedPath),
          size: stagedStats.size,
          path: stagedPath,
          fileUrl: pathToFileURL(stagedPath).toString(),
          mediaType: attachment.mediaType ?? inferAudioMediaTypeFromPath(stagedPath),
          source: 'file',
          durationMs: attachment.durationMs ?? await parseWavDurationFromFile(stagedPath),
          normalizedMediaType: 'audio/wav',
        }
      }

      const normalizedName = `${path.basename(
        sanitizeAttachmentFileName(path.basename(resolvedPath, path.extname(resolvedPath))),
      ) || 'audio'}-${Date.now()}.wav`
      const normalizedPath = path.join(assetDir, normalizedName)
      await normalizeAudioFileToWav(resolvedPath, normalizedPath)
      const normalizedStats = await stat(normalizedPath)
      return {
        kind: 'audio',
        name: attachment.name || path.basename(resolvedPath),
        size: normalizedStats.size,
        path: normalizedPath,
        fileUrl: pathToFileURL(normalizedPath).toString(),
        mediaType: 'audio/wav',
        source: 'file',
        durationMs: attachment.durationMs ?? await parseWavDurationFromFile(normalizedPath),
        normalizedMediaType: 'audio/wav',
      }
    }

    const normalizedDataUrl = attachment.normalizedDataUrl
    if (normalizedDataUrl) {
      const parsed = parseDataUrl(normalizedDataUrl)
      const filename = `${path.basename(
        sanitizeAttachmentFileName(path.basename(attachment.name, path.extname(attachment.name))),
      ) || 'audio'}-${Date.now()}.wav`
      const targetPath = path.join(assetDir, filename)
      await writeFile(targetPath, parsed.buffer)
      return {
        kind: 'audio',
        name: attachment.name,
        size: parsed.buffer.byteLength,
        path: targetPath,
        fileUrl: pathToFileURL(targetPath).toString(),
        mediaType: 'audio/wav',
        source: 'file',
        durationMs: attachment.durationMs ?? parseWavDurationMs(parsed.buffer),
        normalizedMediaType: attachment.normalizedMediaType ?? 'audio/wav',
      }
    }

    if (!attachment.dataUrl) {
      throw new Error('Audio attachment is missing file data.')
    }

    const parsed = parseDataUrl(attachment.dataUrl)
    if (isWaveLike(parsed.mediaType)) {
      const filename = `${path.basename(
        sanitizeAttachmentFileName(path.basename(attachment.name, path.extname(attachment.name))),
      ) || 'audio'}-${Date.now()}.wav`
      const targetPath = path.join(assetDir, filename)
      await writeFile(targetPath, parsed.buffer)
      return {
        kind: 'audio',
        name: attachment.name,
        size: parsed.buffer.byteLength,
        path: targetPath,
        fileUrl: pathToFileURL(targetPath).toString(),
        mediaType: 'audio/wav',
        source: 'file',
        durationMs: attachment.durationMs ?? parseWavDurationMs(parsed.buffer),
        normalizedMediaType: 'audio/wav',
      }
    }

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-audio-normalize-'))
    const sourceName = sanitizeAttachmentFileName(attachment.name || 'audio')
    const sourcePath = path.join(
      tempDir,
      path.extname(sourceName) ? sourceName : `${sourceName}${extensionFromMediaType(parsed.mediaType) || '.bin'}`,
    )
    await writeFile(sourcePath, parsed.buffer)

    const normalizedName = `${path.basename(
      sanitizeAttachmentFileName(path.basename(attachment.name, path.extname(attachment.name))),
    ) || 'audio'}-${Date.now()}.wav`
    const normalizedPath = path.join(assetDir, normalizedName)
    await normalizeAudioFileToWav(sourcePath, normalizedPath)
    const normalizedStats = await stat(normalizedPath)

    return {
      kind: 'audio',
      name: attachment.name,
      size: normalizedStats.size,
      path: normalizedPath,
      fileUrl: pathToFileURL(normalizedPath).toString(),
      mediaType: 'audio/wav',
      source: 'file',
      durationMs: attachment.durationMs ?? await parseWavDurationFromFile(normalizedPath),
      normalizedMediaType: 'audio/wav',
    }
  } finally {
    if (tempDir) {
      await removePathBestEffort(tempDir, { recursive: true, force: true })
    }
  }
}

async function persistIncomingVideoAttachment(
  attachment: IncomingVideoAttachment,
  assetDir: string,
): Promise<PersistedVideoAttachment> {
  let persistedSourcePath: string
  if (attachment.path) {
    persistedSourcePath = await stageExistingFileIntoAssetDir({
      inputPath: attachment.path,
      assetDir,
      fallbackName: attachment.name,
    })
  } else {
    if (!attachment.dataUrl) {
      throw new Error('Video attachment is missing file data.')
    }
    const parsed = parseDataUrl(attachment.dataUrl)
    const ext = extensionFromMediaType(attachment.mediaType ?? parsed.mediaType) || '.mp4'
    const baseName = sanitizeAttachmentFileName(attachment.name || `video-${Date.now()}${ext}`)
    const filename = path.extname(baseName) ? baseName : `${baseName}${ext}`
    persistedSourcePath = path.join(assetDir, filename)
    await writeFile(persistedSourcePath, parsed.buffer)
  }

  const sampledFrames = await Promise.all(
    (attachment.sampledFrames ?? []).map(async (frame) =>
      await persistIncomingImageAttachment(frame, assetDir),
    ),
  )

  if (sampledFrames.length === 0) {
    throw new Error(
      `Video attachment "${attachment.name}" could not be prepared into local keyframes for the current multimodal pipeline.`,
    )
  }

  return {
    kind: 'video',
    name: attachment.name || path.basename(persistedSourcePath),
    size: attachment.size,
    path: persistedSourcePath,
    fileUrl: pathToFileURL(persistedSourcePath).toString(),
    mediaType: attachment.mediaType ?? inferVideoMediaTypeFromPath(persistedSourcePath),
    source: 'file',
    durationMs: attachment.durationMs,
    sampledFrames,
  }
}

function planPdfWorkerBatches(
  renderedPages: PersistedImageAttachment[],
  processedRange: AttachmentPageRange,
): PlannedPdfWorkerBatch[] {
  if (renderedPages.length === 0) {
    throw new Error('Gemma Desktop could not render any PDF pages for processing.')
  }

  const batches: PlannedPdfWorkerBatch[] = []
  let currentPages: PersistedImageAttachment[] = []
  let currentBytes = 0
  let currentStartPage = processedRange.startPage

  const flush = (): void => {
    if (currentPages.length === 0) {
      return
    }

    const currentEndPage = currentStartPage + currentPages.length - 1
    batches.push({
      index: batches.length,
      range: {
        startPage: currentStartPage,
        endPage: currentEndPage,
      },
      pages: currentPages,
      renderedBytes: currentBytes,
    })
    currentStartPage = currentEndPage + 1
    currentPages = []
    currentBytes = 0
  }

  for (const page of renderedPages) {
    if (page.size > PDF_MAX_WORKER_BATCH_BYTES) {
      throw new Error(
        `PDF page ${currentStartPage + currentPages.length} renders to ${page.size.toLocaleString()} bytes, which exceeds the ${PDF_MAX_WORKER_BATCH_BYTES.toLocaleString()} byte batch limit. Try a different PDF or a narrower page range.`,
      )
    }

    if (
      currentPages.length > 0
      && currentBytes + page.size > PDF_MAX_WORKER_BATCH_BYTES
    ) {
      flush()
    }

    currentPages.push(page)
    currentBytes += page.size
  }

  flush()

  if (batches.length > PDF_MAX_WORKER_BATCHES) {
    throw new Error(
      `This PDF requires ${batches.length} worker batches, which exceeds the ${PDF_MAX_WORKER_BATCHES} batch limit. Try a custom page range.`,
    )
  }

  return batches
}

async function persistIncomingPdfAttachment(
  attachment: IncomingPdfAttachment,
  assetDir: string,
): Promise<{
  attachment: PersistedPdfAttachment
  debug: PdfConversionDebugRecord
}> {
  let sourcePath: string | undefined
  let renderedDirectory: string | undefined

  try {
    let persistedSourcePath: string
    if (attachment.path) {
      persistedSourcePath = await stageExistingFileIntoAssetDir({
        inputPath: attachment.path,
        assetDir,
        fallbackName: attachment.name,
      })
    } else {
      if (!attachment.dataUrl) {
        throw new Error('PDF attachment is missing data.')
      }
      const parsed = parseDataUrl(attachment.dataUrl)
      if (parsed.mediaType !== 'application/pdf') {
        throw new Error(`Expected a PDF attachment, received ${parsed.mediaType}.`)
      }
      const baseName = sanitizeAttachmentFileName(attachment.name || 'document.pdf')
      const filename = path.extname(baseName) ? baseName : `${baseName}.pdf`
      persistedSourcePath = path.join(assetDir, filename)
      await writeFile(persistedSourcePath, parsed.buffer)
    }

    sourcePath = persistedSourcePath
    const inspection = await inspectPdfDocument(persistedSourcePath)
    const pageCount = inspection.pageCount
    const processedRange = normalizePdfSelection(attachment.processedRange, pageCount)
    const processingMode: PdfProcessingMode =
      attachment.processingMode
      ?? (attachment.processedRange ? 'custom_range' : 'full_document')
    const directoryName = `${path.basename(
      sanitizeAttachmentFileName(path.basename(persistedSourcePath, '.pdf') || 'pdf'),
      path.extname(persistedSourcePath),
    )}-pages-${Date.now()}`
    renderedDirectory = path.join(assetDir, directoryName)
    await mkdir(renderedDirectory, { recursive: true })

    const rendered = await renderPdfPages({
      path: persistedSourcePath,
      startPage: processedRange.startPage,
      endPage: processedRange.endPage,
      scale: PDF_RENDER_SCALE,
      outputDir: renderedDirectory,
      filenamePrefix: 'page',
    })

    const renderedBytes = rendered.reduce(
      (sum: number, page) => sum + page.bytes,
      0,
    )
    const renderedPages = rendered.map((page): PersistedImageAttachment => ({
      kind: 'image' as const,
      name: path.basename(page.path),
      size: page.bytes,
      path: page.path,
      fileUrl: pathToFileURL(page.path).toString(),
      mediaType: 'image/png',
      source: 'file' as const,
    }))
    const batches = planPdfWorkerBatches(renderedPages, processedRange)
    const previewThumbnails = renderedPages
      .slice(0, PDF_PREVIEW_PAGE_LIMIT)
      .map((page) => page.fileUrl)

    return {
      attachment: {
        kind: 'pdf',
        name: attachment.name || path.basename(persistedSourcePath),
        size: attachment.size,
        path: persistedSourcePath,
        fileUrl: pathToFileURL(persistedSourcePath).toString(),
        mediaType: 'application/pdf',
        source: 'file',
        pageCount,
        processingMode,
        processedRange,
        workerModelId: attachment.workerModelId,
        batchCount: batches.length,
        fitStatus: 'ready',
        previewThumbnails,
        planningReason: attachment.planningReason,
        renderedPages,
        renderedBytes,
      },
      debug: {
        sourceName: attachment.name || path.basename(persistedSourcePath),
        sourcePath: persistedSourcePath,
        pageCount,
        processedRange,
        processingMode,
        fitStatus: 'ready',
        batchCount: batches.length,
        renderedPageCount: renderedPages.length,
        renderedBytes,
        parser: PDF_RENDERER_INFO,
      },
    }
  } catch (error) {
    if (renderedDirectory) {
      await removePathBestEffort(renderedDirectory, { recursive: true, force: true })
    }

    const message = error instanceof Error ? error.message : String(error)
    throw new PdfAttachmentConversionError(message, {
      sourceName: attachment.name,
      sourcePath,
      processedRange: attachment.processedRange,
      parser: PDF_RENDERER_INFO,
      reason: message,
    })
  }
}

export async function planPdfAttachmentProcessing(
  input: Pick<IncomingPdfAttachment, 'path' | 'dataUrl' | 'name' | 'size' | 'processedRange'> & {
    workerModelId?: string
  },
): Promise<PdfProcessingPlanResult> {
  const materialized = await materializePdfForInspection(input)
  try {
    const inspection = await inspectPdfDocument(materialized.path)
    return createPdfProcessingPlan({
      pageCount: inspection.pageCount,
      sourceBytes: input.size,
      selectedRange: input.processedRange,
      workerModelId: input.workerModelId,
    })
  } finally {
    await materialized.cleanup().catch((error) => {
      warnAttachmentCleanupFailure(`Failed to clean up inspected PDF ${materialized.path}`, error)
    })
  }
}

export async function inspectPdfAttachment(
  input: Pick<IncomingPdfAttachment, 'path' | 'dataUrl' | 'name'>,
): Promise<PdfInspectionResult> {
  const materialized = await materializePdfForInspection(input)
  try {
    return await inspectPdfDocument(materialized.path)
  } finally {
    await materialized.cleanup().catch((error) => {
      warnAttachmentCleanupFailure(`Failed to clean up inspected PDF ${materialized.path}`, error)
    })
  }
}

export async function persistIncomingAttachments(args: {
  attachments: IncomingAttachment[]
  getAssetDirectory: () => Promise<string>
}): Promise<{
  attachments: PersistedAttachment[]
  pdfDebugRecords: PdfConversionDebugRecord[]
}> {
  const persisted: PersistedAttachment[] = []
  const pdfDebugRecords: PdfConversionDebugRecord[] = []

  for (const attachment of args.attachments) {
    const assetDir = await args.getAssetDirectory()
    if (attachment.kind === 'image') {
      persisted.push(await persistIncomingImageAttachment(attachment, assetDir))
      continue
    }

    if (attachment.kind === 'audio') {
      persisted.push(await persistIncomingAudioAttachment(attachment, assetDir))
      continue
    }

    if (attachment.kind === 'video') {
      persisted.push(await persistIncomingVideoAttachment(attachment, assetDir))
      continue
    }

    const result = await persistIncomingPdfAttachment(attachment, assetDir)
    persisted.push(result.attachment)
    pdfDebugRecords.push(result.debug)
  }

  return {
    attachments: persisted,
    pdfDebugRecords,
  }
}

function buildAttachmentManifestEntry(
  attachment: PersistedAttachment,
  index: number,
): string {
  const lines = [
    `${index + 1}. ${attachment.kind.toUpperCase()}: ${attachment.name}`,
    `Path: ${attachment.path}`,
  ]

  if (attachment.mediaType) {
    lines.push(`Media type: ${attachment.mediaType}`)
  }

  if (attachment.kind === 'audio') {
    if (attachment.normalizedMediaType) {
      lines.push(`Normalized media type: ${attachment.normalizedMediaType}`)
    }
    if (attachment.durationMs != null) {
      lines.push(`Duration: ${(attachment.durationMs / 1000).toFixed(1)} seconds`)
    }
    return lines.join('\n')
  }

  if (attachment.kind === 'video') {
    if (attachment.durationMs != null) {
      lines.push(`Duration: ${(attachment.durationMs / 1000).toFixed(1)} seconds`)
    }
    if (attachment.sampledFrames.length > 0) {
      lines.push(
        `Derived keyframe paths: ${attachment.sampledFrames.map((frame) => frame.path).join(', ')}`,
      )
    }
    return lines.join('\n')
  }

  if (attachment.kind === 'pdf') {
    lines.push(
      `Processed pages: ${attachment.processedRange.startPage}-${attachment.processedRange.endPage} of ${attachment.pageCount}`,
    )
    lines.push(`Worker batches: ${attachment.batchCount}`)
    if (attachment.workerModelId) {
      lines.push(`Worker model: ${attachment.workerModelId}`)
    }
    if (attachment.derivedTextPath) {
      lines.push(`Derived text artifact path: ${attachment.derivedTextPath}`)
    }
    if (attachment.derivedArtifactPath) {
      lines.push(`Derived artifact path: ${attachment.derivedArtifactPath}`)
    }
    if (attachment.derivedSummary?.trim()) {
      lines.push(`Prepared PDF summary:\n${attachment.derivedSummary.trim()}`)
    }
  }

  return lines.join('\n')
}

function buildAttachedFilesManifest(
  attachments: PersistedAttachment[],
): string {
  return [
    'Attached local files for this turn are available on disk.',
    'Decide which attachments matter based on the user request and use their paths when you need to inspect or operate on them.',
    'Attached files:',
    ...attachments.map((attachment, index) =>
      buildAttachmentManifestEntry(attachment, index),
    ),
  ].join('\n\n')
}

function buildDirectSessionAttachmentParts(message: {
  attachments: PersistedAttachment[]
  capabilityContext?: SessionCapabilityContext
}): Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string; mediaType?: string }
  | { type: 'audio_url'; url: string; mediaType?: string }
> {
  const support = deriveSessionAttachmentSupport(message.capabilityContext)
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; url: string; mediaType?: string }
    | { type: 'audio_url'; url: string; mediaType?: string }
  > = []

  for (const attachment of message.attachments) {
    if (attachment.kind === 'image' && support.image) {
      parts.push({
        type: 'image_url',
        url: attachment.fileUrl,
        mediaType: attachment.mediaType,
      })
      continue
    }

    if (attachment.kind === 'audio' && support.audio) {
      parts.push({
        type: 'audio_url',
        url: attachment.fileUrl,
        mediaType: attachment.mediaType,
      })
      continue
    }

    if (
      attachment.kind === 'pdf'
      && attachment.fitStatus === 'ready'
      && attachment.derivedPromptText?.trim()
    ) {
      parts.push({
        type: 'text',
        text: [
          `Attached PDF: ${attachment.name}`,
          `Processed pages: ${attachment.processedRange.startPage}-${attachment.processedRange.endPage} of ${attachment.pageCount}`,
          attachment.derivedSummary?.trim()
            ? `Prepared PDF summary:\n${attachment.derivedSummary.trim()}`
            : '',
          `Prepared PDF context:\n${attachment.derivedPromptText.trim()}`,
        ].filter(Boolean).join('\n\n'),
      })
    }
  }

  return parts
}

function isDirectSessionAttachment(
  attachment: PersistedAttachment,
  support: ReturnType<typeof deriveSessionAttachmentSupport>,
): boolean {
  if (attachment.kind === 'image') {
    return support.image
  }
  if (attachment.kind === 'audio') {
    return support.audio
  }
  if (attachment.kind === 'pdf') {
    return attachment.fitStatus === 'ready' && Boolean(attachment.derivedPromptText?.trim())
  }
  return false
}

export function buildSessionInputFromUserMessage(message: {
  text: string
  attachments?: PersistedAttachment[]
  capabilityContext?: SessionCapabilityContext
}): SessionInput {
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; url: string; mediaType?: string }
    | { type: 'audio_url'; url: string; mediaType?: string }
  > = []

  if (message.text.trim().length > 0) {
    parts.push({ type: 'text', text: message.text.trim() })
  }

  const attachments = message.attachments ?? []
  const support = deriveSessionAttachmentSupport(message.capabilityContext)
  parts.push(...buildDirectSessionAttachmentParts({
    attachments,
    capabilityContext: message.capabilityContext,
  }))
  const manifestAttachments = attachments.filter((attachment) =>
    !isDirectSessionAttachment(attachment, support),
  )
  if (manifestAttachments.length > 0) {
    parts.push({
      type: 'text',
      text: buildAttachedFilesManifest(manifestAttachments),
    })
  }

  return parts.length === 1 && parts[0]?.type === 'text'
    ? parts[0].text
    : parts
}

export function buildUserMessageContent(
  text: string,
  attachments: PersistedAttachment[],
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []

  if (text.trim().length > 0) {
    content.push({ type: 'text', text })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        url: attachment.fileUrl,
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
        url: attachment.fileUrl,
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        normalizedMediaType: attachment.normalizedMediaType,
      })
      continue
    }

    if (attachment.kind === 'video') {
      content.push({
        type: 'video',
        url: attachment.fileUrl,
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        sampledFrameCount: attachment.sampledFrames.length,
        sampledFrameTimestampsMs: attachment.sampledFrames
          .map((frame) => frame.timestampMs)
          .filter((value): value is number => value != null),
        thumbnails: attachment.sampledFrames.map((frame) => frame.fileUrl),
      })
      continue
    }

    content.push({
      type: 'pdf',
      url: attachment.fileUrl,
      filename: attachment.name,
      mediaType: attachment.mediaType,
      pageCount: attachment.pageCount,
      processingMode: attachment.processingMode,
      processedRange: attachment.processedRange,
      batchCount: attachment.batchCount,
      workerModelId: attachment.workerModelId,
      fitStatus: attachment.fitStatus,
      previewThumbnails: attachment.previewThumbnails,
      derivedSummary: attachment.derivedSummary,
      derivedTextPath: attachment.derivedTextPath,
    })
  }

  return content
}

function resolveIncomingAttachmentChatUrl(
  attachment: Pick<BaseIncomingAttachment, 'previewUrl' | 'dataUrl' | 'path'>,
): string {
  const previewUrl = attachment.previewUrl?.trim()
  if (previewUrl) {
    return previewUrl
  }

  const dataUrl = attachment.dataUrl?.trim()
  if (dataUrl) {
    return dataUrl
  }

  const filePath = attachment.path?.trim()
  if (filePath) {
    return pathToFileURL(path.resolve(filePath)).toString()
  }

  return ''
}

export function buildOptimisticUserMessageContent(
  text: string,
  attachments: IncomingAttachment[],
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []

  if (text.trim().length > 0) {
    content.push({ type: 'text', text })
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        url: resolveIncomingAttachmentChatUrl(attachment),
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
        url: resolveIncomingAttachmentChatUrl(attachment),
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        normalizedMediaType: attachment.normalizedMediaType,
      })
      continue
    }

    if (attachment.kind === 'video') {
      content.push({
        type: 'video',
        url: resolveIncomingAttachmentChatUrl(attachment),
        filename: attachment.name,
        mediaType: attachment.mediaType,
        durationMs: attachment.durationMs,
        sampledFrameCount: attachment.sampledFrames?.length ?? 0,
        sampledFrameTimestampsMs: (attachment.sampledFrames ?? [])
          .map((frame) => frame.timestampMs)
          .filter((value): value is number => value != null),
        thumbnails: (attachment.sampledFrames ?? [])
          .map((frame) => resolveIncomingAttachmentChatUrl(frame))
          .filter((value) => value.length > 0),
      })
      continue
    }

    const pageCount = attachment.pageCount ?? attachment.processedRange?.endPage ?? 1
    const processedRange = attachment.processedRange ?? defaultPdfRange(pageCount)

    content.push({
      type: 'pdf',
      url: resolveIncomingAttachmentChatUrl(attachment),
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

export function summarizeMessageForDebug(message: {
  text: string
  attachments?: IncomingAttachment[]
}): Record<string, unknown> {
  return {
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      size: attachment.size,
      path: attachment.path,
      mediaType: attachment.mediaType,
      source: attachment.source,
      durationMs:
        attachment.kind === 'audio' || attachment.kind === 'video'
          ? attachment.durationMs
          : undefined,
      sampledFrameCount:
        attachment.kind === 'video'
          ? attachment.sampledFrames?.length ?? 0
          : undefined,
      sampledFrameTimestampsMs:
        attachment.kind === 'video'
          ? attachment.sampledFrames?.map((frame) => frame.timestampMs).filter((value): value is number => value != null)
          : undefined,
      pageCount: attachment.kind === 'pdf' ? attachment.pageCount : undefined,
      processingMode:
        attachment.kind === 'pdf' ? attachment.processingMode : undefined,
      processedRange:
        attachment.kind === 'pdf' ? attachment.processedRange : undefined,
      workerModelId:
        attachment.kind === 'pdf' ? attachment.workerModelId : undefined,
      batchCount:
        attachment.kind === 'pdf' ? attachment.batchCount : undefined,
      fitStatus:
        attachment.kind === 'pdf' ? attachment.fitStatus : undefined,
      hasInlineData: Boolean(attachment.dataUrl || ('normalizedDataUrl' in attachment && attachment.normalizedDataUrl)),
    })),
  }
}

export function deriveSessionAttachmentSupport(
  capabilityContext: SessionCapabilityContext | undefined,
): Record<AttachmentKind, boolean> {
  return deriveAttachmentSupport(capabilityContext?.modelCapabilities ?? [])
}

export function findUnsupportedAttachmentKinds(
  attachments: Array<Pick<PersistedAttachment, 'kind'>>,
  capabilityContext: SessionCapabilityContext | undefined,
  options: {
    allowPdf?: boolean
  } = {},
): AttachmentKind[] {
  const support = deriveSessionAttachmentSupport(capabilityContext)
  const kinds = new Set<AttachmentKind>()

  for (const attachment of attachments) {
    kinds.add(attachment.kind)
  }

  return [...kinds].filter((kind) =>
    kind === 'pdf'
      ? !options.allowPdf
      : !support[kind],
  )
}

export function buildUnsupportedAttachmentErrorMessage(input: {
  modelId: string
  unsupportedKinds: AttachmentKind[]
}): string {
  const unsupportedLabels = input.unsupportedKinds.map((kind) =>
    attachmentKindLabels(kind),
  )

  if (unsupportedLabels.length === 1) {
    return `Model "${input.modelId}" is not marked as supporting ${unsupportedLabels[0]}, so Gemma Desktop cannot send that attachment in this session.`
  }

  return `Model "${input.modelId}" is not marked as supporting ${unsupportedLabels.join(', ')}, so Gemma Desktop cannot send those attachments in this session.`
}

export function isKnownVisionUnsupported(
  capabilityContext: SessionCapabilityContext | undefined,
): boolean {
  return !deriveSessionAttachmentSupport(capabilityContext).image
}
