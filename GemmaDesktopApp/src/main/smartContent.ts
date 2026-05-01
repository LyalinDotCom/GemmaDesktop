import { createHash, randomUUID } from 'crypto'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
  type GemmaDesktop,
  type GemmaDesktopSession,
} from '@gemma-desktop/sdk-node'
import type {
  SessionInput,
  StructuredOutputSpec,
} from '@gemma-desktop/sdk-core'
import { createWorkspaceSearchBackend } from '@gemma-desktop/sdk-tools'
import {
  PDF_RENDER_SCALE,
  type PersistedPdfAttachment,
} from './sessionAttachments'

export interface SmartContentModelTarget {
  modelId: string
  runtimeId: string
  loadedInstanceId?: string
}

export interface SmartContentModelRecord {
  id: string
  runtimeId: string
  status: string
  attachmentSupport: {
    image: boolean
    audio: boolean
  }
}

export interface SmartContentServiceDependencies {
  getGemmaDesktop: () => GemmaDesktop
  getOrResumeLiveSession: (sessionId: string) => Promise<{ session: GemmaDesktopSession }>
  mapModels: (inspectionResults: Awaited<ReturnType<GemmaDesktop['inspectEnvironment']>>['runtimes']) => SmartContentModelRecord[]
  acquirePrimaryModelLease: (leaseId: string, target: SmartContentModelTarget) => Promise<() => void>
  buildWorkerSessionMetadata: (workerTarget: SmartContentModelTarget) => Promise<Record<string, unknown>>
  isHelperModelEnabled?: () => boolean | Promise<boolean>
  removePathBestEffort: (targetPath: string, options?: Parameters<typeof fs.rm>[1]) => Promise<void>
}

export type ContentMaterializeTarget = 'auto' | 'text' | 'markdown'

export type InspectableFileKind = 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'unknown'

export interface FileWorkerCapabilitySnapshot {
  modelId: string
  runtimeId: string
  imageSupported: boolean
  audioSupported: boolean
}

export interface MultimodalFileWorkerResult {
  structuredOutput: Record<string, unknown>
  outputText: string
}

export interface PdfDerivedPageRecord {
  pageNumber: number
  markdown: string
  warnings: string[]
}

export interface PdfDerivedArtifactRecord {
  sourceName: string
  sourcePath: string
  pageCount: number
  processedRange: {
    startPage: number
    endPage: number
  }
  derivedAt: string
  worker: {
    modelId: string
    runtimeId: string
  }
  goal: string
  summary: string
  promptText: string
  promptTokenEstimate: number
  evidence: string[]
  warnings: string[]
  pages: PdfDerivedPageRecord[]
}

export interface PdfDerivationResult {
  artifactPath?: string
  textPath?: string
  summary: string
  promptText: string
  promptTokenEstimate: number
  evidence: string[]
  warnings: string[]
  pageCount: number
  batchCount: number
  pages: PdfDerivedPageRecord[]
}

export interface ResolvedInspectableFile {
  path: string
  fileUrl: string
  name: string
  mediaType: string | undefined
  kind: InspectableFileKind
  size: number
  modifiedAtMs: number
}

export type SmartReadStrategy =
  | 'direct_text'
  | 'pdf_to_text'
  | 'image_to_text'
  | 'audio_to_text'

export interface MaterializedContentInternal {
  artifactId: string
  artifactPath: string
  displayArtifactPath: string
  sourcePath: string
  displaySourcePath: string
  cachePath?: string
  outputPath?: string
  displayOutputPath?: string
  target: ContentMaterializeTarget
  kind: InspectableFileKind
  mediaType?: string
  strategy: SmartReadStrategy
  bytes: number
  lineCount: number
  helperModelId?: string
  helperRuntimeId?: string
  cacheHit?: boolean
  text: string
}

export interface ContentSearchMatch {
  path: string
  line: number
  text: string
  submatches: Array<{
    text: string
    start: number
    end: number
  }>
  beforeContext?: Array<{ line: number; text: string }>
  afterContext?: Array<{ line: number; text: string }>
}

export type SmartFileReadProgress = {
  id: string
  label: string
  tone?: 'info' | 'success' | 'warning'
}

export function createSmartContentService(dependencies: SmartContentServiceDependencies) {
  const getOrResumeLiveSession = dependencies.getOrResumeLiveSession
  const mapModels = dependencies.mapModels
  const acquirePrimaryModelLease = dependencies.acquirePrimaryModelLease
  const buildPdfWorkerSessionMetadata = dependencies.buildWorkerSessionMetadata
  const removePathBestEffort = dependencies.removePathBestEffort
  const isHelperModelEnabled = async () =>
    dependencies.isHelperModelEnabled ? await dependencies.isHelperModelEnabled() : true

  async function assertHelperModelEnabledForSmartContent(): Promise<void> {
    if (!(await isHelperModelEnabled())) {
      throw new Error('Helper model is disabled in Settings.')
    }
  }

  function makeStructuredResponseFormat(
    name: string,
    properties: Record<string, unknown>,
    required: string[],
  ): StructuredOutputSpec {
    return {
      name,
      strict: false,
      schema: {
        type: 'object',
        properties,
        required,
        additionalProperties: true,
      },
    }
  }

  const PDF_PAGE_EXTRACTION_RESPONSE_FORMAT = makeStructuredResponseFormat(
    'pdf_page_extraction',
    {
      markdown: { type: 'string' },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    ['markdown'],
  )
  const PDF_CHUNK_SUMMARY_RESPONSE_FORMAT = makeStructuredResponseFormat(
    'pdf_chunk_summary',
    {
      summary: { type: 'string' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    ['summary'],
  )
  const PDF_ATTACHMENT_SYNTHESIS_RESPONSE_FORMAT = makeStructuredResponseFormat(
    'pdf_attachment_synthesis',
    {
      summary: { type: 'string' },
      promptText: { type: 'string' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    ['summary', 'promptText'],
  )
  const FILE_TEXT_EXTRACTION_RESPONSE_FORMAT = makeStructuredResponseFormat(
    'file_text_extraction',
    {
      text: { type: 'string' },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    ['text'],
  )

  const SMART_READ_DEFAULT_LINE_LIMIT = 200
  const SMART_READ_DEFAULT_MAX_BYTES = 50 * 1024
  const SMART_MULTI_READ_DEFAULT_MAX_BYTES = 120 * 1024
  const PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS = 80
  const PDF_EMBEDDED_TEXT_MIN_CHARS_PER_PAGE = 20

  const IMAGE_FILE_EXTENSIONS = new Set([
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
  const AUDIO_FILE_EXTENSIONS = new Set([
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
  const VIDEO_FILE_EXTENSIONS = new Set([
    '.mp4',
    '.mov',
    '.m4v',
    '.webm',
  ])
  const TEXT_FILE_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.jsonc',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.csv',
    '.tsv',
    '.log',
    '.xml',
    '.html',
    '.css',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.swift',
    '.c',
    '.cc',
    '.cpp',
    '.h',
    '.hpp',
    '.sh',
    '.zsh',
    '.fish',
    '.sql',
  ])

  function inferInspectableMediaType(filePath: string): string | undefined {
    switch (path.extname(filePath).toLowerCase()) {
      case '.pdf':
        return 'application/pdf'
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

  function detectInspectableKind(
    filePath: string,
    mediaType: string | undefined,
  ): InspectableFileKind {
    const normalizedMediaType = mediaType?.trim().toLowerCase()
    const ext = path.extname(filePath).toLowerCase()

    if (normalizedMediaType === 'application/pdf' || ext === '.pdf') {
      return 'pdf'
    }
    if (normalizedMediaType?.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(ext)) {
      return 'image'
    }
    if (normalizedMediaType?.startsWith('audio/') || AUDIO_FILE_EXTENSIONS.has(ext)) {
      return 'audio'
    }
    if (normalizedMediaType?.startsWith('video/') || VIDEO_FILE_EXTENSIONS.has(ext)) {
      return 'video'
    }
    if (normalizedMediaType?.startsWith('text/') || TEXT_FILE_EXTENSIONS.has(ext)) {
      return 'text'
    }

    return 'unknown'
  }

  function normalizeInspectableInputPath(
    rawPath: string,
    workingDirectory: string,
  ): string {
    const trimmed = rawPath.trim()
    if (trimmed.startsWith('file://')) {
      return fileURLToPath(trimmed)
    }
    return path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(workingDirectory, trimmed)
  }

  async function readFileProbe(filePath: string): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  function isLikelyTextProbe(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return true
    }
    let controlBytes = 0
    for (const byte of buffer) {
      if (byte === 0) {
        return false
      }
      if (byte < 9 || (byte > 13 && byte < 32)) {
        controlBytes += 1
      }
    }
    return controlBytes / buffer.length < 0.08
  }

  async function resolveInspectableFile(
    input: {
      path: string
      mediaType?: string
    },
    workingDirectory: string,
  ): Promise<ResolvedInspectableFile> {
    const resolvedPath = normalizeInspectableInputPath(input.path, workingDirectory)
    const stats = await fs.stat(resolvedPath)
    if (!stats.isFile()) {
      throw new Error(`Expected a file path, received: ${input.path}`)
    }

    const mediaType = input.mediaType?.trim() || inferInspectableMediaType(resolvedPath)
    let kind = detectInspectableKind(resolvedPath, mediaType)
    if (kind === 'unknown') {
      const probe = await readFileProbe(resolvedPath)
      if (isLikelyTextProbe(probe)) {
        kind = 'text'
      }
    }

    return {
      path: resolvedPath,
      fileUrl: pathToFileURL(resolvedPath).toString(),
      name: path.basename(resolvedPath),
      mediaType,
      kind,
      size: stats.size,
      modifiedAtMs: stats.mtimeMs,
    }
  }

  async function resolveSessionFileWorkerCapabilitySnapshot(
    sessionId: string,
  ): Promise<FileWorkerCapabilitySnapshot> {
    const { session } = await getOrResumeLiveSession(sessionId)
    const snapshot = session.snapshot()

    try {
      const env = await dependencies.getGemmaDesktop().inspectEnvironment()
      const matched = mapModels(env.runtimes).find(
        (model) =>
          model.id === snapshot.modelId
          && model.runtimeId === snapshot.runtimeId,
      )

      return {
        modelId: snapshot.modelId,
        runtimeId: snapshot.runtimeId,
        imageSupported: matched?.attachmentSupport.image ?? false,
        audioSupported: matched?.attachmentSupport.audio ?? false,
      }
    } catch {
      return {
        modelId: snapshot.modelId,
        runtimeId: snapshot.runtimeId,
        imageSupported: false,
        audioSupported: false,
      }
    }
  }

  function toWorkerSnapshot(model: {
    id: string
    runtimeId: string
    attachmentSupport?: {
      image?: boolean
      audio?: boolean
    }
  }): FileWorkerCapabilitySnapshot {
    return {
      modelId: model.id,
      runtimeId: model.runtimeId,
      imageSupported: model.attachmentSupport?.image === true,
      audioSupported: model.attachmentSupport?.audio === true,
    }
  }

  async function resolvePreferredFileReadWorker(input: {
    sessionId: string
    kind: 'pdf' | 'audio' | 'image'
  }): Promise<FileWorkerCapabilitySnapshot> {
    await assertHelperModelEnabledForSmartContent()

    const { session } = await getOrResumeLiveSession(input.sessionId)
    const snapshot = session.snapshot()
    const env = await dependencies.getGemmaDesktop().inspectEnvironment()
    const models = mapModels(env.runtimes)
    const currentModel = models.find(
      (model) =>
        model.id === snapshot.modelId
        && model.runtimeId === snapshot.runtimeId,
    )

    const pickByTags = (
      tags: string[],
      predicate: (model: typeof models[number]) => boolean,
    ): typeof models[number] | undefined => {
      for (const tag of tags) {
        const sameRuntime = models.find((model) =>
          model.id === tag
          && model.runtimeId === snapshot.runtimeId
          && predicate(model),
        )
        if (sameRuntime) {
          return sameRuntime
        }
        const anyRuntime = models.find((model) =>
          model.id === tag
          && predicate(model),
        )
        if (anyRuntime) {
          return anyRuntime
        }
      }
      return undefined
    }

    const isResident = (model: typeof models[number]) =>
      model.status === 'loaded' || model.status === 'loading'

    const isLowestGemmaTier = (model: typeof models[number]) =>
      model.id === 'gemma4:e2b'

    const preferResidentModel = (
      predicate: (model: typeof models[number]) => boolean,
      orderedTags: string[],
    ): typeof models[number] | undefined => {
      if (
        currentModel
        && isResident(currentModel)
        && predicate(currentModel)
        && !isLowestGemmaTier(currentModel)
      ) {
        return currentModel
      }

      const residentByTags = pickByTags(
        orderedTags,
        (candidate) => isResident(candidate) && predicate(candidate),
      )
      if (residentByTags && !isLowestGemmaTier(residentByTags)) {
        return residentByTags
      }

      const residentCompatible = models.find((candidate) =>
        candidate.runtimeId === snapshot.runtimeId
        && isResident(candidate)
        && predicate(candidate)
        && !isLowestGemmaTier(candidate),
      )
        ?? models.find((candidate) =>
          isResident(candidate)
          && predicate(candidate)
          && !isLowestGemmaTier(candidate),
        )

      if (residentCompatible) {
        return residentCompatible
      }

      return undefined
    }

    const defaultHelperTags = ['gemma4:26b', 'gemma4:31b', 'gemma4:e4b', 'gemma4:e2b']

    if (input.kind === 'pdf') {
      const model =
        preferResidentModel(
          (candidate) => candidate.attachmentSupport.image,
          ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
        )
        ?? pickByTags(
          ['gemma4:26b', 'gemma4:31b', 'gemma4:e4b', 'gemma4:e2b'],
          (candidate) => candidate.attachmentSupport.image,
        )
        ?? (currentModel?.attachmentSupport.image ? currentModel : undefined)
      if (!model) {
        throw new Error('Gemma Desktop could not find a vision-capable Gemma helper for PDF reading. Install Gemma 4 26B, 31B, or another image-capable Gemma runtime.')
      }
      return toWorkerSnapshot(model)
    }

    if (input.kind === 'audio') {
      const model =
        preferResidentModel(
          (candidate) => candidate.attachmentSupport.audio,
          ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
        )
        ?? pickByTags(
          defaultHelperTags,
          (candidate) => candidate.attachmentSupport.audio,
        )
        ?? (currentModel?.attachmentSupport.audio ? currentModel : undefined)
      if (!model) {
        throw new Error('Gemma Desktop could not find an audio-capable helper model for audio reading.')
      }
      return toWorkerSnapshot(model)
    }

    const model =
      preferResidentModel(
        (candidate) => candidate.attachmentSupport.image,
        ['gemma4:31b', 'gemma4:26b', 'gemma4:e4b', 'gemma4:e2b'],
      )
      ?? pickByTags(
        defaultHelperTags,
        (candidate) => candidate.attachmentSupport.image,
      )
      ?? (currentModel?.attachmentSupport.image ? currentModel : undefined)
    if (!model) {
      throw new Error('Gemma Desktop could not find a vision-capable helper model for image reading.')
    }
    return toWorkerSnapshot(model)
  }

  const SMART_FILE_READ_CACHE_VERSION = 'v2'

  async function ensureSmartFileReadCacheRoot(workingDirectory: string): Promise<string> {
    const root = path.join(workingDirectory, '.gemma', 'file-read-cache')
    await fs.mkdir(root, { recursive: true })
    return root
  }

  async function buildSmartFileReadCacheDirectory(input: {
    workingDirectory: string
    file: ResolvedInspectableFile
    worker?: Pick<FileWorkerCapabilitySnapshot, 'modelId' | 'runtimeId'>
    mode: string
  }): Promise<string> {
    const root = await ensureSmartFileReadCacheRoot(input.workingDirectory)
    const digest = createHash('sha256')
      .update([
        SMART_FILE_READ_CACHE_VERSION,
        input.mode,
        input.file.path,
        String(input.file.size),
        String(input.file.modifiedAtMs),
        input.worker?.modelId ?? '',
        input.worker?.runtimeId ?? '',
      ].join('\n'))
      .digest('hex')
    const directory = path.join(root, digest)
    await fs.mkdir(directory, { recursive: true })
    return directory
  }

  function renderReadWindow(input: {
    sourcePath: string
    displayPath: string
    text: string
    offset?: number
    limit?: number
    maxBytes?: number
  }): {
    content: string
    numberedContent: string
    lines: Array<{ line: number; text: string }>
    truncated: boolean
    nextOffset?: number
    totalLines: number
  } {
    const allLines = input.text.replace(/\r\n/g, '\n').split('\n')
    const offset = Math.max(input.offset ?? 1, 1)
    const limit = Math.max(input.limit ?? SMART_READ_DEFAULT_LINE_LIMIT, 1)
    const maxBytes = Math.max(input.maxBytes ?? SMART_READ_DEFAULT_MAX_BYTES, 256)
    const lines: Array<{ line: number; text: string }> = []
    let truncated = false
    let nextOffset: number | undefined
    let renderedBytes = 0

    for (let index = offset - 1; index < allLines.length; index += 1) {
      const lineNumber = index + 1
      if (lines.length >= limit) {
        truncated = true
        nextOffset = lineNumber
        break
      }

      const line = allLines[index] ?? ''
      const renderedLine = `${lineNumber}: ${line}`
      const renderedLineBytes = Buffer.byteLength(
        `${lines.length === 0 ? '' : '\n'}${renderedLine}`,
        'utf8',
      )
      if (renderedBytes + renderedLineBytes > maxBytes) {
        truncated = true
        nextOffset = lineNumber
        break
      }

      lines.push({ line: lineNumber, text: line })
      renderedBytes += renderedLineBytes
    }

    return {
      content: lines.map((line) => line.text).join('\n'),
      numberedContent: lines.map((line) => `${line.line}: ${line.text}`).join('\n'),
      lines,
      truncated,
      nextOffset,
      totalLines: allLines.length,
    }
  }

  function displayPathForToolOutput(
    sourcePath: string,
    workingDirectory: string,
  ): string {
    const relative = path.relative(workingDirectory, sourcePath)
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : sourcePath
  }

  function emitSmartFileReadProgress(
    callback: ((progress: SmartFileReadProgress) => void) | undefined,
    progress: SmartFileReadProgress,
  ): void {
    callback?.(progress)
  }

  function hasUsefulEmbeddedPdfText(input: {
    pageCount: number
    extractedCharCount: number
    pages: Array<{ charCount: number }>
  }): boolean {
    if (input.extractedCharCount >= Math.max(
      PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS,
      input.pageCount * PDF_EMBEDDED_TEXT_MIN_CHARS_PER_PAGE,
    )) {
      return true
    }

    return input.pages.some((page) => page.charCount >= PDF_EMBEDDED_TEXT_MIN_TOTAL_CHARS)
  }

  function buildEmbeddedPdfMarkdown(
    pages: Array<{ pageNumber: number; text: string }>,
  ): string {
    return pages
      .filter((page) => page.text.trim().length > 0)
      .map((page) => `## Page ${page.pageNumber}\n\n${page.text.trim()}`)
      .join('\n\n')
  }

  function formatInspectFileOutput(input: {
    file: ResolvedInspectableFile
    displayPath: string
    canReadWithReadFile: boolean
    suggestedTool?: string
    suggestedStrategy: string
    reasoning: string
    warnings: string[]
    pageCount?: number
  }): string {
    return [
      `File: ${input.file.name}`,
      `Path: ${input.displayPath}`,
      `Kind: ${input.file.kind}`,
      `Media type: ${input.file.mediaType ?? 'unknown'}`,
      `Bytes: ${input.file.size}`,
      typeof input.pageCount === 'number' ? `PDF pages: ${input.pageCount}` : '',
      `Can read with read_file: ${input.canReadWithReadFile ? 'yes' : 'no'}`,
      input.suggestedTool ? `Suggested tool: ${input.suggestedTool}` : '',
      `Suggested strategy: ${input.suggestedStrategy}`,
      `Why: ${input.reasoning}`,
      input.warnings.length > 0 ? `Warnings:\n- ${input.warnings.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  async function inspectFileForReadStrategy(input: {
    file: ResolvedInspectableFile
    workingDirectory: string
  }): Promise<{
    file: ResolvedInspectableFile
    displayPath: string
    canReadWithReadFile: boolean
    suggestedTool?: 'read_file'
    suggestedStrategy: string
    reasoning: string
    warnings: string[]
    pageCount?: number
  }> {
    const warnings: string[] = []
    const displayPath = displayPathForToolOutput(
      input.file.path,
      input.workingDirectory,
    )
    let pageCount: number | undefined

    switch (input.file.kind) {
      case 'text': {
        if (input.file.size > 256 * 1024) {
          warnings.push(
            'Large text file. Prefer one broader read_file window instead of many tiny slices.',
          )
        }
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: true,
          suggestedTool: 'read_file',
          suggestedStrategy: 'direct_text',
          reasoning: 'This looks like a text-like file, so read_file can paginate it directly.',
          warnings,
        }
      }
      case 'pdf': {
        try {
          const pdfInfo = await inspectPdfDocument(input.file.path)
          pageCount = pdfInfo.pageCount
          if (pdfInfo.pageCount > 40) {
            warnings.push(
              `Large PDF (${pdfInfo.pageCount} pages). Expect extraction to take longer the first time.`,
            )
          }
        } catch (error) {
          warnings.push(
            error instanceof Error
              ? `Could not inspect PDF page count: ${error.message}`
              : 'Could not inspect PDF page count.',
          )
        }
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: true,
          suggestedTool: 'read_file',
          suggestedStrategy: 'pdf_to_text',
          reasoning:
            'Use read_file. Gemma Desktop will convert the PDF into cached text with a helper model, then return a paginated text window.',
          warnings,
          pageCount,
        }
      }
      case 'image':
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: true,
          suggestedTool: 'read_file',
          suggestedStrategy: 'image_to_text',
          reasoning:
            'Use read_file. Gemma Desktop will run image reading once, cache the extracted text or description, and return text.',
          warnings,
        }
      case 'audio':
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: true,
          suggestedTool: 'read_file',
          suggestedStrategy: 'audio_to_text',
          reasoning:
            'Use read_file. Gemma Desktop will transcribe or describe the audio once, cache the text, and return a paginated text window.',
          warnings,
        }
      case 'video':
        warnings.push(
          'Raw video is not readable through read_file yet. Attach it or prepare keyframes first.',
        )
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: false,
          suggestedStrategy: 'unsupported_video',
          reasoning:
            'read_file does not currently extract raw video into text. The model needs prepared frames or an attached video path.',
          warnings,
        }
      case 'unknown':
      default:
        warnings.push(
          'This file does not look safely text-readable. Inspect the format before trying shell or ad-hoc parsing.',
        )
        return {
          file: input.file,
          displayPath,
          canReadWithReadFile: false,
          suggestedStrategy: 'unknown_binary',
          reasoning:
            'Gemma Desktop could not classify this file as text, PDF, image, or audio, so read_file may not be safe or useful.',
          warnings,
        }
    }
  }

  function buildReadWindowResult(input: {
    file: ResolvedInspectableFile
    displayPath: string
    offset?: number
    limit?: number
    maxBytes?: number
    text: string
    strategy: SmartReadStrategy
    helperModelId?: string
    helperRuntimeId?: string
    cacheHit?: boolean
  }) {
    const window = renderReadWindow({
      sourcePath: input.file.path,
      displayPath: input.displayPath,
      text: input.text,
      offset: input.offset,
      limit: input.limit,
      maxBytes: input.maxBytes,
    })
    const offset = Math.max(input.offset ?? 1, 1)
    const limit = Math.max(input.limit ?? SMART_READ_DEFAULT_LINE_LIMIT, 1)
    const maxBytes = Math.max(input.maxBytes ?? SMART_READ_DEFAULT_MAX_BYTES, 256)
    const lineEnd =
      window.lines.at(-1)?.line ?? Math.max(0, offset - 1)

    return {
      path: input.displayPath,
      absolutePath: input.file.path,
      offset,
      limit,
      maxBytes,
      content: window.content,
      numberedContent: window.numberedContent,
      lines: window.lines,
      truncated: window.truncated,
      nextOffset: window.nextOffset,
      lineEnd,
      totalLinesScanned: window.totalLines,
      mediaType: input.file.mediaType,
      kind: input.file.kind,
      strategy: input.strategy,
      helperModelId: input.helperModelId,
      helperRuntimeId: input.helperRuntimeId,
      cacheHit: input.cacheHit,
    }
  }

  function countMaterializedTextLines(text: string): number {
    return text.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length
  }

  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async function writeMaterializedTextOutput(input: {
    outputPath: string
    text: string
    createDirectories?: boolean
    overwrite?: boolean
  }): Promise<void> {
    if (input.createDirectories) {
      await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
    }

    if (input.overwrite !== true && await fileExists(input.outputPath)) {
      throw new Error(
        `Refusing to overwrite existing content artifact: ${input.outputPath}. Retry with overwrite=true if replacing it is intentional.`,
      )
    }

    await fs.writeFile(input.outputPath, input.text, 'utf8')
    const verified = await fs.readFile(input.outputPath, 'utf8')
    if (verified !== input.text) {
      throw new Error(
        `Write verification failed for ${input.outputPath}. Re-read the artifact before continuing.`,
      )
    }
  }

  function materializedContentForStructuredOutput(
    input: MaterializedContentInternal,
  ): Omit<MaterializedContentInternal, 'text'> {
    const structured: Partial<MaterializedContentInternal> = { ...input }
    delete structured.text
    return structured as Omit<MaterializedContentInternal, 'text'>
  }

  function formatMaterializedContentOutput(input: MaterializedContentInternal): string {
    return [
      'Materialized content artifact.',
      `Source: ${input.displaySourcePath}`,
      `Artifact path: ${input.displayArtifactPath}`,
      input.displayOutputPath ? `Output path: ${input.displayOutputPath}` : '',
      input.cachePath && input.cachePath !== input.artifactPath
        ? `Cache path: ${input.cachePath}`
        : '',
      `Kind: ${input.kind}`,
      `Target: ${input.target}`,
      `Strategy: ${input.strategy}`,
      input.helperModelId ? `Helper model: ${input.helperModelId}` : '',
      input.cacheHit != null ? `Cache hit: ${input.cacheHit ? 'yes' : 'no'}` : '',
      `Bytes: ${input.bytes}`,
      `Lines: ${input.lineCount}`,
      `Next: use read_content or search_content with path "${input.displayArtifactPath}".`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  async function materializeInspectableContent(input: {
    path: string
    mediaType?: string
    outputPath?: string
    target?: ContentMaterializeTarget
    createDirectories?: boolean
    overwrite?: boolean
    workingDirectory: string
    sessionId: string
    signal?: AbortSignal
    onProgress?: (progress: SmartFileReadProgress) => void
  }): Promise<MaterializedContentInternal> {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'resolve-file',
      label: 'Resolving content source',
    })
    const file = await resolveInspectableFile(
      { path: input.path, mediaType: input.mediaType },
      input.workingDirectory,
    )
    const displaySourcePath = displayPathForToolOutput(file.path, input.workingDirectory)
    const target = input.target ?? 'auto'
    let textPath: string
    let text: string
    let strategy: SmartReadStrategy
    let helperModelId: string | undefined
    let helperRuntimeId: string | undefined
    let cacheHit: boolean | undefined

    if (file.kind === 'text') {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'read-text',
        label: 'Materializing text file',
      })
      textPath = file.path
      text = await fs.readFile(file.path, 'utf8')
      if (text.includes('\u0000')) {
        throw new Error(`Refusing to materialize binary-looking file: ${file.path}`)
      }
      strategy = 'direct_text'
      cacheHit = true
    } else if (file.kind === 'pdf') {
      const extracted = await extractPdfToCachedText({
        file,
        workingDirectory: input.workingDirectory,
        sessionId: input.sessionId,
        signal: input.signal,
        onProgress: input.onProgress,
      })
      textPath = extracted.textPath
      text = await fs.readFile(textPath, 'utf8')
      strategy = 'pdf_to_text'
      helperModelId = extracted.helperModelId
      helperRuntimeId = extracted.helperRuntimeId
      cacheHit = extracted.cacheHit
    } else if (file.kind === 'image' || file.kind === 'audio') {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'select-helper',
        label: `Selecting ${file.kind} helper model`,
      })
      const worker = await resolvePreferredFileReadWorker({
        sessionId: input.sessionId,
        kind: file.kind,
      })
      const extracted = await extractMultimodalFileToCachedText({
        file,
        worker,
        workingDirectory: input.workingDirectory,
        kind: file.kind,
        signal: input.signal,
        onProgress: input.onProgress,
      })
      textPath = extracted.textPath
      text = await fs.readFile(textPath, 'utf8')
      strategy = file.kind === 'image' ? 'image_to_text' : 'audio_to_text'
      helperModelId = extracted.helperModelId
      helperRuntimeId = extracted.helperRuntimeId
      cacheHit = extracted.cacheHit
    } else if (file.kind === 'video') {
      throw new Error(
        `${file.name} is a video file. materialize_content does not currently extract raw video into text.`,
      )
    } else {
      throw new Error(
        `${file.name} is not safely materializable as text. Use inspect_file first and avoid shell-based parsing guesses.`,
      )
    }

    let artifactPath = textPath
    let outputPath: string | undefined
    if (input.outputPath?.trim()) {
      outputPath = normalizeInspectableInputPath(
        input.outputPath,
        input.workingDirectory,
      )
      emitSmartFileReadProgress(input.onProgress, {
        id: 'write-artifact',
        label: 'Writing content artifact',
      })
      await writeMaterializedTextOutput({
        outputPath,
        text,
        createDirectories: input.createDirectories,
        overwrite: input.overwrite,
      })
      artifactPath = outputPath
    }

    return {
      artifactId: artifactPath,
      artifactPath,
      displayArtifactPath: displayPathForToolOutput(artifactPath, input.workingDirectory),
      sourcePath: file.path,
      displaySourcePath,
      cachePath: textPath,
      outputPath,
      displayOutputPath: outputPath
        ? displayPathForToolOutput(outputPath, input.workingDirectory)
        : undefined,
      target,
      kind: file.kind,
      mediaType: file.mediaType,
      strategy,
      bytes: Buffer.byteLength(text, 'utf8'),
      lineCount: countMaterializedTextLines(text),
      helperModelId,
      helperRuntimeId,
      cacheHit,
      text,
    }
  }

  function buildMaterializedReadResult(input: {
    materialized: MaterializedContentInternal
    offset?: number
    limit?: number
    maxBytes?: number
  }) {
    return buildReadWindowResult({
      file: {
        path: input.materialized.artifactPath,
        fileUrl: pathToFileURL(input.materialized.artifactPath).toString(),
        name: path.basename(input.materialized.artifactPath),
        mediaType: 'text/markdown',
        kind: 'text',
        size: input.materialized.bytes,
        modifiedAtMs: Date.now(),
      },
      displayPath: input.materialized.displayArtifactPath,
      offset: input.offset,
      limit: input.limit,
      maxBytes: input.maxBytes,
      text: input.materialized.text,
      strategy: input.materialized.strategy,
      helperModelId: input.materialized.helperModelId,
      helperRuntimeId: input.materialized.helperRuntimeId,
      cacheHit: input.materialized.cacheHit,
    })
  }

  function searchMaterializedText(input: {
    text: string
    path: string
    query: string
    regex?: boolean
    caseSensitive?: boolean
    wholeWord?: boolean
    before?: number
    after?: number
    limit?: number
  }): {
    matches: ContentSearchMatch[]
    truncated: boolean
    regex: boolean
  } {
    const query = input.query.trim()
    if (!query) {
      throw new Error('search_content requires a non-empty query.')
    }

    const lines = input.text.replace(/\r\n/g, '\n').split('\n')
    const before = Math.max(0, Math.min(Math.floor(input.before ?? 0), 20))
    const after = Math.max(0, Math.min(Math.floor(input.after ?? 0), 20))
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 500))
    const matches: ContentSearchMatch[] = []
    const flags = input.caseSensitive ? 'g' : 'gi'
    const pattern = input.regex === true
      ? new RegExp(query, flags)
      : new RegExp(
          query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          flags,
        )
    const finalPattern = input.wholeWord === true
      ? new RegExp(`\\b(?:${pattern.source})\\b`, flags)
      : pattern

    for (const [index, line] of lines.entries()) {
      finalPattern.lastIndex = 0
      const submatches = [...line.matchAll(finalPattern)].map((match) => ({
        text: match[0],
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      }))
      if (submatches.length === 0) {
        continue
      }

      const lineNumber = index + 1
      matches.push({
        path: input.path,
        line: lineNumber,
        text: line,
        submatches,
        beforeContext: before > 0
          ? lines
              .slice(Math.max(0, index - before), index)
              .map((text, contextIndex) => ({
                line: Math.max(0, index - before) + contextIndex + 1,
                text,
              }))
          : undefined,
        afterContext: after > 0
          ? lines
              .slice(index + 1, Math.min(lines.length, index + after + 1))
              .map((text, contextIndex) => ({
                line: index + contextIndex + 2,
                text,
              }))
          : undefined,
      })

      if (matches.length >= limit) {
        return {
          matches,
          truncated: true,
          regex: input.regex === true,
        }
      }
    }

    return {
      matches,
      truncated: false,
      regex: input.regex === true,
    }
  }

  function formatContentSearchOutput(input: {
    path: string
    query: string
    matches: ContentSearchMatch[]
    truncated: boolean
  }): string {
    if (input.matches.length === 0) {
      return `[search_content] No matches for ${JSON.stringify(input.query)} in ${input.path}.`
    }

    const lines = [
      `[search_content] ${input.truncated ? 'First ' : ''}${input.matches.length} match${input.matches.length === 1 ? '' : 'es'} for ${JSON.stringify(input.query)} in ${input.path}${input.truncated ? ' (truncated)' : ''}.`,
    ]

    for (const match of input.matches) {
      lines.push(`${match.path}:${match.line}: ${match.text}`)
      for (const context of match.beforeContext ?? []) {
        lines.push(`${match.path}:${context.line}- ${context.text}`)
      }
      for (const context of match.afterContext ?? []) {
        lines.push(`${match.path}:${context.line}+ ${context.text}`)
      }
    }

    if (input.truncated) {
      lines.push(
        'Narrow the query or raise limit if you need more matches before reading targeted windows.',
      )
    }

    return lines.join('\n')
  }

  async function readInspectableFileForTool(input: {
    path: string
    mediaType?: string
    offset?: number
    limit?: number
    maxBytes?: number
    workingDirectory: string
    sessionId: string
    signal?: AbortSignal
    onProgress?: (progress: SmartFileReadProgress) => void
  }) {
    emitSmartFileReadProgress(input.onProgress, {
      id: 'resolve-file',
      label: 'Resolving file path',
    })
    const file = await resolveInspectableFile(
      { path: input.path, mediaType: input.mediaType },
      input.workingDirectory,
    )
    const displayPath = displayPathForToolOutput(file.path, input.workingDirectory)

    if (file.kind === 'text') {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'read-text',
        label: 'Reading text window',
      })
      const backend = createWorkspaceSearchBackend({
        workingDirectory: input.workingDirectory,
        signal: input.signal,
      })
      const result = await backend.readFile({
        path: displayPath,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
      })
      return {
        ...result,
        mediaType: file.mediaType,
        kind: file.kind,
        strategy: 'direct_text' as const,
        cacheHit: true,
      }
    }

    if (file.kind === 'pdf') {
      const extracted = await extractPdfToCachedText({
        file,
        workingDirectory: input.workingDirectory,
        sessionId: input.sessionId,
        signal: input.signal,
        onProgress: input.onProgress,
      })
      emitSmartFileReadProgress(input.onProgress, {
        id: 'load-cached-text',
        label: 'Loading extracted PDF text',
      })
      const text = await fs.readFile(extracted.textPath, 'utf8')
      return buildReadWindowResult({
        file,
        displayPath,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
        text,
        strategy: 'pdf_to_text',
        helperModelId: extracted.helperModelId,
        helperRuntimeId: extracted.helperRuntimeId,
        cacheHit: extracted.cacheHit,
      })
    }

    if (file.kind === 'image' || file.kind === 'audio') {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'select-helper',
        label: `Selecting ${file.kind} helper model`,
      })
      const worker = await resolvePreferredFileReadWorker({
        sessionId: input.sessionId,
        kind: file.kind,
      })
      const extracted = await extractMultimodalFileToCachedText({
        file,
        worker,
        workingDirectory: input.workingDirectory,
        kind: file.kind,
        signal: input.signal,
        onProgress: input.onProgress,
      })
      emitSmartFileReadProgress(input.onProgress, {
        id: 'load-cached-text',
        label: `Loading extracted ${file.kind} text`,
      })
      const text = await fs.readFile(extracted.textPath, 'utf8')
      return buildReadWindowResult({
        file,
        displayPath,
        offset: input.offset,
        limit: input.limit,
        maxBytes: input.maxBytes,
        text,
        strategy: file.kind === 'image' ? 'image_to_text' : 'audio_to_text',
        helperModelId: extracted.helperModelId,
        helperRuntimeId: extracted.helperRuntimeId,
        cacheHit: extracted.cacheHit,
      })
    }

    if (file.kind === 'video') {
      throw new Error(
        `${file.name} is a video file. read_file does not currently extract raw video into text.`,
      )
    }

    throw new Error(
      `${file.name} is not safely readable as text. Use inspect_file first and avoid shell-based parsing guesses.`,
    )
  }

  async function extractPdfToCachedText(input: {
    file: ResolvedInspectableFile
    workingDirectory: string
    sessionId: string
    signal?: AbortSignal
    onProgress?: (progress: SmartFileReadProgress) => void
  }): Promise<{
    textPath: string
    helperModelId?: string
    helperRuntimeId?: string
    cacheHit: boolean
  }> {
    const directCacheDir = await buildSmartFileReadCacheDirectory({
      workingDirectory: input.workingDirectory,
      file: input.file,
      mode: 'pdf-text-direct',
    })
    const directTextPath = path.join(directCacheDir, 'content.md')
    const directMetaPath = path.join(directCacheDir, 'meta.json')
    try {
      await fs.access(directTextPath)
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-cache',
        label: 'Using cached PDF text',
        tone: 'success',
      })
      return {
        textPath: directTextPath,
        cacheHit: true,
      }
    } catch {
      // Cache miss; continue with PDF extraction.
    }

    let pageCount: number | undefined

    try {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-embedded-text',
        label: 'Checking embedded PDF text',
      })
      const extractedText = await extractPdfText({
        path: input.file.path,
      })
      pageCount = extractedText.pageCount

      if (hasUsefulEmbeddedPdfText(extractedText)) {
        emitSmartFileReadProgress(input.onProgress, {
          id: 'pdf-embedded-text',
          label: 'Using embedded PDF text',
          tone: 'success',
        })
        emitSmartFileReadProgress(input.onProgress, {
          id: 'pdf-write-cache',
          label: 'Caching extracted PDF text',
        })
        await fs.writeFile(
          directTextPath,
          buildEmbeddedPdfMarkdown(extractedText.pages),
          'utf8',
        )
        await fs.writeFile(
          directMetaPath,
          JSON.stringify({
            version: SMART_FILE_READ_CACHE_VERSION,
            sourcePath: input.file.path,
            pageCount: extractedText.pageCount,
            extractionMode: 'embedded_text',
          }, null, 2),
          'utf8',
        )

        return {
          textPath: directTextPath,
          cacheHit: false,
        }
      }

      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-embedded-text',
        label: 'Embedded PDF text was sparse, falling back to page reading',
        tone: 'warning',
      })
    } catch (error) {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-embedded-text',
        label:
          error instanceof Error
            ? `Embedded PDF text extraction failed: ${error.message}`
            : 'Embedded PDF text extraction failed, falling back to page reading',
        tone: 'warning',
      })
    }

    emitSmartFileReadProgress(input.onProgress, {
      id: 'select-helper',
      label: 'Selecting PDF helper model',
    })
    const worker = await resolvePreferredFileReadWorker({
      sessionId: input.sessionId,
      kind: 'pdf',
    })
    const workerCacheDir = await buildSmartFileReadCacheDirectory({
      workingDirectory: input.workingDirectory,
      file: input.file,
      worker,
      mode: 'pdf-text-ocr',
    })
    const textPath = path.join(workerCacheDir, 'content.md')
    const metaPath = path.join(workerCacheDir, 'meta.json')
    try {
      await fs.access(textPath)
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-cache',
        label: 'Using cached PDF text',
        tone: 'success',
      })
      return {
        textPath,
        helperModelId: worker.modelId,
        helperRuntimeId: worker.runtimeId,
        cacheHit: true,
      }
    } catch {
      // Cache miss; continue with OCR extraction.
    }

    const resolvedPageCount = pageCount ?? (await inspectPdfDocument(input.file.path)).pageCount
    const renderedDir = path.join(workerCacheDir, 'rendered-pages')
    await fs.mkdir(renderedDir, { recursive: true })
    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-render',
      label: `Rendering ${resolvedPageCount} PDF page${resolvedPageCount === 1 ? '' : 's'}`,
    })
    const renderedPages = await renderPdfPages({
      path: input.file.path,
      startPage: 1,
      endPage: resolvedPageCount,
      scale: PDF_RENDER_SCALE,
      outputDir: renderedDir,
      filenamePrefix: 'page',
    })
    const pageMarkdown: string[] = []
    const totalPages = renderedPages.length
    for (const page of renderedPages) {
      emitSmartFileReadProgress(input.onProgress, {
        id: 'pdf-extract',
        label: `Reading page ${page.pageNumber} of ${totalPages}`,
      })
      const extracted = await runPdfPageExtractionSession({
        fileName: input.file.name,
        pageNumber: page.pageNumber,
        pageImageUrl: pathToFileURL(page.path).toString(),
        worker,
        workingDirectory: path.dirname(input.file.path),
        signal: input.signal,
      })
      pageMarkdown.push(`## Page ${extracted.pageNumber}\n\n${extracted.markdown}`)
    }

    emitSmartFileReadProgress(input.onProgress, {
      id: 'pdf-write-cache',
      label: 'Caching extracted PDF text',
    })
    await fs.writeFile(textPath, pageMarkdown.join('\n\n'), 'utf8')
    await fs.writeFile(
      metaPath,
      JSON.stringify({
          version: SMART_FILE_READ_CACHE_VERSION,
          sourcePath: input.file.path,
          helperModelId: worker.modelId,
          helperRuntimeId: worker.runtimeId,
          pageCount: resolvedPageCount,
          extractionMode: 'page_ocr',
        }, null, 2),
      'utf8',
    )

    return {
      textPath,
      helperModelId: worker.modelId,
      helperRuntimeId: worker.runtimeId,
      cacheHit: false,
    }
  }

  async function extractMultimodalFileToCachedText(input: {
    file: ResolvedInspectableFile
    worker: FileWorkerCapabilitySnapshot
    workingDirectory: string
    kind: 'audio' | 'image'
    signal?: AbortSignal
    onProgress?: (progress: SmartFileReadProgress) => void
  }): Promise<{
    textPath: string
    helperModelId: string
    helperRuntimeId: string
    cacheHit: boolean
  }> {
    const cacheDir = await buildSmartFileReadCacheDirectory({
      workingDirectory: input.workingDirectory,
      file: input.file,
      worker: input.worker,
      mode: `${input.kind}-text`,
    })
    const textPath = path.join(cacheDir, 'content.txt')
    const metaPath = path.join(cacheDir, 'meta.json')
    try {
      await fs.access(textPath)
      emitSmartFileReadProgress(input.onProgress, {
        id: `${input.kind}-cache`,
        label: `Using cached ${input.kind} text`,
        tone: 'success',
      })
      return {
        textPath,
        helperModelId: input.worker.modelId,
        helperRuntimeId: input.worker.runtimeId,
        cacheHit: true,
      }
    } catch {
      // Cache miss; continue with multimodal extraction.
    }

    emitSmartFileReadProgress(input.onProgress, {
      id: `${input.kind}-helper`,
      label:
        input.kind === 'audio'
          ? 'Listening with helper model'
          : 'Reading image with helper model',
    })
    const workerResult = await runMultimodalFileWorkerSession({
      worker: input.worker,
      workingDirectory: path.dirname(input.file.path),
      signal: input.signal,
      responseFormat: FILE_TEXT_EXTRACTION_RESPONSE_FORMAT,
      systemInstructions:
        input.kind === 'audio'
          ? [
              'You are Gemma Desktop\'s internal audio-to-text reader.',
              'Listen faithfully and return the spoken content as plain text.',
              'If there is no speech, describe the important audible content briefly as plain text.',
            ].join('\n')
          : [
              'You are Gemma Desktop\'s internal image-to-text reader.',
              'Read visible text faithfully.',
              'If the image has little text, return a concise plain-text description of the important visible content.',
            ].join('\n'),
      sessionInput: input.kind === 'audio'
        ? [
            { type: 'text', text: `Audio file: ${input.file.name}\nRead this file into plain text.` },
            { type: 'audio_url', url: input.file.fileUrl, mediaType: input.file.mediaType },
          ]
        : [
            { type: 'text', text: `Image file: ${input.file.name}\nRead this image into plain text.` },
            { type: 'image_url', url: input.file.fileUrl, mediaType: input.file.mediaType },
          ],
    })
    const extractedText =
      toTrimmedString(workerResult.structuredOutput.text)
      ?? toTrimmedString(workerResult.outputText)
      ?? ''
    if (!extractedText) {
      throw new Error(`Gemma Desktop could not extract readable text from ${input.file.name}.`)
    }

    emitSmartFileReadProgress(input.onProgress, {
      id: `${input.kind}-write-cache`,
      label: `Caching ${input.kind} text`,
    })
    await fs.writeFile(textPath, extractedText, 'utf8')
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: SMART_FILE_READ_CACHE_VERSION,
        sourcePath: input.file.path,
        helperModelId: input.worker.modelId,
        helperRuntimeId: input.worker.runtimeId,
        kind: input.kind,
      }, null, 2),
      'utf8',
    )

    return {
      textPath,
      helperModelId: input.worker.modelId,
      helperRuntimeId: input.worker.runtimeId,
      cacheHit: false,
    }
  }


  async function runMultimodalFileWorkerSession(input: {
    worker: FileWorkerCapabilitySnapshot
    workingDirectory: string
    systemInstructions: string
    sessionInput: SessionInput
    responseFormat?: StructuredOutputSpec
    signal?: AbortSignal
    sessionMetadata?: Record<string, unknown>
  }): Promise<MultimodalFileWorkerResult> {
    const leaseId = `file-worker-${Date.now()}-${randomUUID()}`
    const releaseLease = await acquirePrimaryModelLease(leaseId, {
      modelId: input.worker.modelId,
      runtimeId: input.worker.runtimeId,
    })

    try {
      const workerSession = await dependencies.getGemmaDesktop().sessions.create({
        runtime: input.worker.runtimeId,
        model: input.worker.modelId,
        mode: 'minimal',
        workingDirectory: input.workingDirectory,
        systemInstructions: input.systemInstructions,
        metadata: {
          ...(await buildPdfWorkerSessionMetadata({
            modelId: input.worker.modelId,
            runtimeId: input.worker.runtimeId,
          })),
          ...(input.sessionMetadata ?? {}),
        },
      })
      const result = await workerSession.run(input.sessionInput, {
        maxSteps: 1,
        responseFormat: input.responseFormat,
        signal: input.signal,
      })
      return {
        structuredOutput:
          result.structuredOutput && typeof result.structuredOutput === 'object'
            ? result.structuredOutput as Record<string, unknown>
            : {},
        outputText: result.text,
      }
    } finally {
      releaseLease()
    }
  }


  function toTrimmedString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined
  }

  function toTrimmedStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : []
  }

  function estimateTextTokens(text: string): number {
    return Math.max(Math.ceil(text.trim().length / 4), 0)
  }

  function truncateTextToApproxTokens(text: string, tokenBudget: number): string {
    const trimmed = text.trim()
    if (!trimmed || tokenBudget <= 0) {
      return ''
    }

    if (estimateTextTokens(trimmed) <= tokenBudget) {
      return trimmed
    }

    const charBudget = Math.max(tokenBudget * 4, 512)
    const truncated = trimmed.slice(0, charBudget)
    const breakCandidates = [
      truncated.lastIndexOf('\n\n'),
      truncated.lastIndexOf('\n'),
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf(' '),
    ].filter((value) => value >= Math.floor(charBudget * 0.6))
    const cutIndex = breakCandidates.length > 0
      ? Math.max(...breakCandidates)
      : truncated.length

    return `${truncated.slice(0, cutIndex).trim()}\n\n[Truncated by Gemma Desktop to stay within the current model context budget.]`
  }

  function chunkPdfPagesByTokenBudget(
    pages: PdfDerivedPageRecord[],
    maxTokensPerChunk: number,
  ): PdfDerivedPageRecord[][] {
    if (pages.length === 0) {
      return []
    }

    const safeBudget = Math.max(maxTokensPerChunk, 1_500)
    const chunks: PdfDerivedPageRecord[][] = []
    let currentChunk: PdfDerivedPageRecord[] = []
    let currentTokens = 0

    for (const page of pages) {
      const pageTokens = Math.max(estimateTextTokens(page.markdown), 200)
      if (currentChunk.length > 0 && currentTokens + pageTokens > safeBudget) {
        chunks.push(currentChunk)
        currentChunk = []
        currentTokens = 0
      }
      currentChunk.push(page)
      currentTokens += pageTokens
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk)
    }

    return chunks
  }

  async function runPdfPageExtractionSession(input: {
    fileName: string
    pageNumber: number
    pageImageUrl: string
    worker: FileWorkerCapabilitySnapshot
    sessionMetadata?: Record<string, unknown>
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<PdfDerivedPageRecord> {
    const result = await runMultimodalFileWorkerSession({
      worker: input.worker,
      workingDirectory: input.workingDirectory,
      sessionMetadata: input.sessionMetadata,
      signal: input.signal,
      responseFormat: PDF_PAGE_EXTRACTION_RESPONSE_FORMAT,
      systemInstructions: [
        'You are Gemma Desktop\'s internal PDF page extraction worker.',
        'You will receive exactly one rendered PDF page image.',
        'Extract the visible content faithfully into markdown.',
        'Preserve headings, lists, tables, labels, formulas, and figure captions when they are visible.',
        'Do not summarize across pages and do not omit text just because it looks repetitive.',
        'If the page is mostly visual or has little readable text, say that plainly in the markdown.',
      ].join('\n'),
      sessionInput: [
        {
          type: 'text',
          text: [
            `PDF: ${input.fileName}`,
            `Page: ${input.pageNumber}`,
            'Extract this page into faithful markdown.',
          ].join('\n'),
        },
        {
          type: 'image_url',
          url: input.pageImageUrl,
          mediaType: 'image/png',
        },
      ],
    })

    const markdown =
      toTrimmedString(result.structuredOutput.markdown)
      ?? toTrimmedString(result.outputText)
      ?? 'No readable content could be extracted from this page.'

    return {
      pageNumber: input.pageNumber,
      markdown,
      warnings: toTrimmedStringArray(result.structuredOutput.warnings),
    }
  }

  async function runPdfChunkSummarySession(input: {
    fileName: string
    goal: string
    chunkPages: PdfDerivedPageRecord[]
    worker: FileWorkerCapabilitySnapshot
    sessionMetadata?: Record<string, unknown>
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<{
    summary: string
    evidence: string[]
    warnings: string[]
  }> {
    const chunkText = input.chunkPages
      .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown}`)
      .join('\n\n')
    const result = await runMultimodalFileWorkerSession({
      worker: input.worker,
      workingDirectory: input.workingDirectory,
      sessionMetadata: input.sessionMetadata,
      signal: input.signal,
      responseFormat: PDF_CHUNK_SUMMARY_RESPONSE_FORMAT,
      systemInstructions: [
        'You are Gemma Desktop\'s internal PDF chunk synthesis worker.',
        'You will receive extracted markdown from a contiguous chunk of PDF pages.',
        'Produce a compact chunk summary grounded only in the provided text.',
        'Surface important facts, labels, and caveats that later synthesis should keep.',
      ].join('\n'),
      sessionInput: [
        {
          type: 'text',
          text: [
            `PDF: ${input.fileName}`,
            `Goal: ${input.goal}`,
            `Chunk page range: ${input.chunkPages[0]?.pageNumber ?? 0}-${input.chunkPages[input.chunkPages.length - 1]?.pageNumber ?? 0}`,
            'Chunk markdown:',
            chunkText,
          ].join('\n\n'),
        },
      ],
    })

    return {
      summary:
        toTrimmedString(result.structuredOutput.summary)
        ?? toTrimmedString(result.outputText)
        ?? 'Chunk processed.',
      evidence: toTrimmedStringArray(result.structuredOutput.evidence),
      warnings: toTrimmedStringArray(result.structuredOutput.warnings),
    }
  }

  async function runPdfAttachmentSynthesisSession(input: {
    fileName: string
    goal: string
    pageCount: number
    promptTokenBudget: number
    synthesisSourceText: string
    worker: FileWorkerCapabilitySnapshot
    sessionMetadata?: Record<string, unknown>
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<{
    summary: string
    promptText: string
    evidence: string[]
    warnings: string[]
  }> {
    const result = await runMultimodalFileWorkerSession({
      worker: input.worker,
      workingDirectory: input.workingDirectory,
      sessionMetadata: input.sessionMetadata,
      signal: input.signal,
      responseFormat: PDF_ATTACHMENT_SYNTHESIS_RESPONSE_FORMAT,
      systemInstructions: [
        'You are Gemma Desktop\'s internal PDF attachment synthesis worker.',
        'You will receive extracted PDF content or chunk summaries.',
        'Prepare a compact, high-signal payload for a parent chat turn.',
        'The promptText must stay within the requested token budget and should preserve the most relevant details for later conversation.',
        'Prefer faithful compression over broad paraphrase.',
      ].join('\n'),
      sessionInput: [
        {
          type: 'text',
          text: [
            `PDF: ${input.fileName}`,
            `Goal: ${input.goal}`,
            `Total pages: ${input.pageCount}`,
            `Maximum prompt budget: about ${input.promptTokenBudget} tokens.`,
            'Return:',
            '- summary: a short user-facing overview',
            '- promptText: a compact parent-turn payload within budget',
            '- evidence: short bullets for key supporting facts',
            '- warnings: any important caveats',
            '',
            'Source material:',
            input.synthesisSourceText,
          ].join('\n'),
        },
      ],
    })

    return {
      summary:
        toTrimmedString(result.structuredOutput.summary)
        ?? 'PDF prepared.',
      promptText:
        truncateTextToApproxTokens(
          toTrimmedString(result.structuredOutput.promptText)
          ?? toTrimmedString(result.outputText)
          ?? '',
          input.promptTokenBudget,
        ),
      evidence: toTrimmedStringArray(result.structuredOutput.evidence),
      warnings: toTrimmedStringArray(result.structuredOutput.warnings),
    }
  }

  async function derivePdfArtifact(input: {
    file: ResolvedInspectableFile
    goal: string
    worker: FileWorkerCapabilitySnapshot
    contextLength: number
    promptTokenBudget: number
    processedRange?: { startPage: number; endPage: number }
    renderedPages?: Array<{ path: string; fileUrl?: string; pageNumber?: number }>
    pageCount?: number
    batchCount?: number
    artifactDirectory?: string
    sessionMetadata?: Record<string, unknown>
    signal?: AbortSignal
    onProgress?: (progress:
      | { stage: 'start'; pageCount: number; renderedPageCount: number }
      | { stage: 'page'; pageNumber: number; totalPages: number }
      | { stage: 'chunk'; chunkIndex: number; chunkCount: number }
      | { stage: 'synthesis' }
      | { stage: 'complete'; promptTokenEstimate: number }) => void
  }): Promise<PdfDerivationResult> {
    if (!input.worker.imageSupported) {
      throw new Error('This session model is not marked as vision-capable, so PDF preparation is unavailable.')
    }

    const pageCount = input.pageCount ?? (await inspectPdfDocument(input.file.path)).pageCount
    const processedRange = input.processedRange ?? {
      startPage: 1,
      endPage: pageCount,
    }

    let renderedPages = input.renderedPages?.map((page, index) => ({
      pageNumber: page.pageNumber ?? (processedRange.startPage + index),
      fileUrl: page.fileUrl ?? pathToFileURL(page.path).toString(),
      path: page.path,
    }))
    let temporaryRenderDirectory: string | undefined

    if (!renderedPages || renderedPages.length === 0) {
      temporaryRenderDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-pdf-derive-'))
      const rendered = await renderPdfPages({
        path: input.file.path,
        startPage: processedRange.startPage,
        endPage: processedRange.endPage,
        scale: PDF_RENDER_SCALE,
        outputDir: temporaryRenderDirectory,
        filenamePrefix: 'page',
      })
      renderedPages = rendered.map((page) => ({
        pageNumber: page.pageNumber,
        fileUrl: pathToFileURL(page.path).toString(),
        path: page.path,
      }))
    }

    try {
      input.onProgress?.({
        stage: 'start',
        pageCount,
        renderedPageCount: renderedPages.length,
      })

      const pages: PdfDerivedPageRecord[] = []
      for (const renderedPage of renderedPages) {
        const page = await runPdfPageExtractionSession({
          fileName: input.file.name,
          pageNumber: renderedPage.pageNumber,
          pageImageUrl: renderedPage.fileUrl,
          worker: input.worker,
          sessionMetadata: input.sessionMetadata,
          workingDirectory: path.dirname(input.file.path),
          signal: input.signal,
        })
        pages.push(page)
        input.onProgress?.({
          stage: 'page',
          pageNumber: renderedPage.pageNumber,
          totalPages: renderedPages.length,
        })
      }

      const combinedMarkdown = pages
        .map((page) => `## Page ${page.pageNumber}\n\n${page.markdown}`)
        .join('\n\n')

      const synthesisInputTokenBudget = Math.max(
        Math.floor(input.contextLength * 0.5),
        8_000,
      )
      const pageWarnings = pages.flatMap((page) => page.warnings)
      let synthesisSourceText = combinedMarkdown
      let synthesisWarnings = [...pageWarnings]
      let synthesisEvidence: string[] = []

      if (estimateTextTokens(combinedMarkdown) > synthesisInputTokenBudget) {
        const chunks = chunkPdfPagesByTokenBudget(
          pages,
          Math.max(Math.floor(synthesisInputTokenBudget * 0.7), 4_000),
        )
        const chunkSummaries: string[] = []

        for (const [index, chunkPages] of chunks.entries()) {
          input.onProgress?.({
            stage: 'chunk',
            chunkIndex: index + 1,
            chunkCount: chunks.length,
          })
          const chunkResult = await runPdfChunkSummarySession({
            fileName: input.file.name,
            goal: input.goal,
            chunkPages,
            worker: input.worker,
            sessionMetadata: input.sessionMetadata,
            workingDirectory: path.dirname(input.file.path),
            signal: input.signal,
          })
          chunkSummaries.push(
            [
              `### Pages ${chunkPages[0]?.pageNumber ?? 0}-${chunkPages[chunkPages.length - 1]?.pageNumber ?? 0}`,
              chunkResult.summary,
              chunkResult.evidence.length > 0
                ? ['Evidence:', ...chunkResult.evidence.map((entry) => `- ${entry}`)].join('\n')
                : '',
            ].filter(Boolean).join('\n\n'),
          )
          synthesisWarnings = [...synthesisWarnings, ...chunkResult.warnings]
          synthesisEvidence = [...synthesisEvidence, ...chunkResult.evidence]
        }

        synthesisSourceText = [
          'Full extracted text was larger than one clean synthesis pass, so Gemma Desktop summarized it in chunks first.',
          ...chunkSummaries,
        ].join('\n\n')
      }

      input.onProgress?.({ stage: 'synthesis' })
      const synthesis = await runPdfAttachmentSynthesisSession({
        fileName: input.file.name,
        goal: input.goal,
        pageCount,
        promptTokenBudget: input.promptTokenBudget,
        synthesisSourceText,
        worker: input.worker,
        sessionMetadata: input.sessionMetadata,
        workingDirectory: path.dirname(input.file.path),
        signal: input.signal,
      })

      const promptTokenEstimate = estimateTextTokens(synthesis.promptText)
      input.onProgress?.({
        stage: 'complete',
        promptTokenEstimate,
      })

      let artifactPath: string | undefined
      let textPath: string | undefined

      if (input.artifactDirectory) {
        await fs.mkdir(input.artifactDirectory, { recursive: true })
        textPath = path.join(input.artifactDirectory, 'document.md')
        artifactPath = path.join(input.artifactDirectory, 'document.json')

        const artifactRecord: PdfDerivedArtifactRecord = {
          sourceName: input.file.name,
          sourcePath: input.file.path,
          pageCount,
          processedRange,
          derivedAt: new Date().toISOString(),
          worker: {
            modelId: input.worker.modelId,
            runtimeId: input.worker.runtimeId,
          },
          goal: input.goal,
          summary: synthesis.summary,
          promptText: synthesis.promptText,
          promptTokenEstimate,
          evidence: synthesis.evidence,
          warnings: [...synthesisWarnings, ...synthesis.warnings],
          pages,
        }

        await fs.writeFile(
          textPath,
          [
            `# ${input.file.name}`,
            '',
            `Processed pages: ${processedRange.startPage}-${processedRange.endPage} of ${pageCount}`,
            '',
            '## Summary',
            '',
            synthesis.summary,
            '',
            '## Extracted Content',
            '',
            ...pages.map((page) => `### Page ${page.pageNumber}\n\n${page.markdown}`),
          ].join('\n'),
          'utf8',
        )
        await fs.writeFile(
          artifactPath,
          JSON.stringify(artifactRecord, null, 2),
          'utf8',
        )
      }

      return {
        artifactPath,
        textPath,
        summary: synthesis.summary,
        promptText: synthesis.promptText,
        promptTokenEstimate,
        evidence: synthesisEvidence.length > 0
          ? synthesisEvidence
          : synthesis.evidence,
        warnings: [...synthesisWarnings, ...synthesis.warnings],
        pageCount,
        batchCount: input.batchCount ?? 1,
        pages,
      }
    } finally {
      if (temporaryRenderDirectory) {
        await removePathBestEffort(temporaryRenderDirectory, { recursive: true, force: true })
      }
    }
  }



  async function derivePersistedPdfAttachmentForTurn(input: {
    attachment: PersistedPdfAttachment
    goal: string
    worker: FileWorkerCapabilitySnapshot
    contextLength: number
    promptTokenBudget: number
    sessionMetadata?: Record<string, unknown>
    signal?: AbortSignal
    onProgress?: Parameters<typeof derivePdfArtifact>[0]['onProgress']
  }): Promise<PersistedPdfAttachment> {
    await assertHelperModelEnabledForSmartContent()

    const artifactDirectory = path.join(
      path.dirname(input.attachment.path),
      `${path.basename(input.attachment.path, path.extname(input.attachment.path))}-derived-${Date.now()}`,
    )

    try {
      const attachmentStats = await fs.stat(input.attachment.path)
      const derived = await derivePdfArtifact({
        file: {
          path: input.attachment.path,
          fileUrl: input.attachment.fileUrl,
          name: input.attachment.name,
          mediaType: input.attachment.mediaType,
          kind: 'pdf',
          size: input.attachment.size,
          modifiedAtMs: attachmentStats.mtimeMs,
        },
        goal: input.goal,
        worker: input.worker,
        contextLength: input.contextLength,
        promptTokenBudget: input.promptTokenBudget,
        processedRange: input.attachment.processedRange,
        renderedPages: input.attachment.renderedPages.map((page, index) => ({
          path: page.path,
          fileUrl: page.fileUrl,
          pageNumber: input.attachment.processedRange.startPage + index,
        })),
        pageCount: input.attachment.pageCount,
        batchCount: input.attachment.batchCount,
        artifactDirectory,
        sessionMetadata: input.sessionMetadata,
        signal: input.signal,
        onProgress: input.onProgress,
      })

      return {
        ...input.attachment,
        derivedArtifactPath: derived.artifactPath,
        derivedTextPath: derived.textPath,
        derivedSummary: derived.summary,
        derivedPromptText: derived.promptText,
        derivedPromptTokenEstimate: derived.promptTokenEstimate,
        derivedByModelId: input.worker.modelId,
        derivedByRuntimeId: input.worker.runtimeId,
        batchCount: derived.batchCount,
      }
    } catch (error) {
      await removePathBestEffort(artifactDirectory, { recursive: true, force: true })
      throw error
    }
  }



  return {
    resolveInspectableFile,
    inspectFileForReadStrategy,
    formatInspectFileOutput,
    materializeInspectableContent,
    materializedContentForStructuredOutput,
    formatMaterializedContentOutput,
    buildMaterializedReadResult,
    searchMaterializedText,
    formatContentSearchOutput,
    readInspectableFileForTool,
    resolveSessionFileWorkerCapabilitySnapshot,
    derivePersistedPdfAttachmentForTurn,
    truncateTextToApproxTokens,
    SMART_MULTI_READ_DEFAULT_MAX_BYTES,
  }
}
