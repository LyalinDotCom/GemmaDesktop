import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import {
  READ_ALOUD_BACKEND,
  READ_ALOUD_CACHE_FORMAT_VERSION,
  READ_ALOUD_MODEL_DTYPE,
  READ_ALOUD_MODEL_ID,
  READ_ALOUD_MODEL_LABEL,
  READ_ALOUD_PROVIDER_ID,
  READ_ALOUD_PROVIDER_LABEL,
  READ_ALOUD_SAMPLE_RATE,
  READ_ALOUD_TEST_PHRASE,
  clampReadAloudSpeed,
  normalizeReadAloudVoice,
  type ReadAloudInstallProgress,
  type ReadAloudInspection,
  type ReadAloudSynthesisInput,
  type ReadAloudSynthesisResult,
  type ReadAloudTestInput,
  type ReadAloudVoiceId,
} from '../shared/readAloud'

const READ_ALOUD_CACHE_LIMIT_BYTES = 256 * 1024 * 1024
const READ_ALOUD_PREVIEW_MESSAGE_ID = '__read_aloud_preview__'
const READ_ALOUD_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const READ_ALOUD_MODEL_BASE_URL =
  `https://huggingface.co/onnx-community/${READ_ALOUD_MODEL_ID}/resolve/${READ_ALOUD_MODEL_REVISION}`

const READ_ALOUD_REMOTE_ASSETS = [
  {
    path: 'config.json',
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
    sizeBytes: 44,
  },
  {
    path: 'tokenizer.json',
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
    sizeBytes: 3497,
  },
  {
    path: 'tokenizer_config.json',
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    sizeBytes: 113,
  },
  {
    path: path.join('onnx', 'model_quantized.onnx'),
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
    sizeBytes: 92361116,
  },
] as const

interface ReadAloudManifest {
  version: number
  modelId: string
  modelLabel: string
  dtype: string
  bundledBytes?: number
  files: Array<{
    path: string
    sha256: string
    sizeBytes?: number
    url: string
  }>
}

interface ReadAloudModelChunk {
  audio: {
    audio: Float32Array
    sampling_rate: number
  }
}

interface ReadAloudModel {
  generate(
    text: string,
    options: {
      voice: ReadAloudVoiceId
      speed: number
    },
  ): Promise<ReadAloudModelChunk['audio']>
}

interface ReadAloudModelLoader {
  load(assetRoot: string, cacheDir: string): Promise<ReadAloudModel>
}

interface ReadAloudStreamReadResult {
  done: boolean
  value?: Uint8Array
}

interface ReadAloudServiceOptions {
  supportedPlatform?: NodeJS.Platform
  cacheRoot?: string
  assetRootCandidates?: string[]
  modelLoader?: ReadAloudModelLoader
  beforeHeavyWork?: () => Promise<void>
}

type ReadAloudChangeListener = () => void

interface ReadAloudAssetResolution {
  assetRoot: string
  cacheDir: string
  bundledBytes: number | null
}

function defaultAssetRootCandidates(cacheRoot: string): string[] {
  const envPath = process.env['GEMMA_DESKTOP_READ_ALOUD_ASSET_ROOT']?.trim()
  const modelFolderName = READ_ALOUD_MODEL_ID
  const candidates = [
    envPath,
    path.join(process.resourcesPath, 'read-aloud-assets', modelFolderName),
    path.join(process.resourcesPath, 'read-aloud-assets'),
    path.join(cacheRoot, 'assets', modelFolderName),
    path.join(cacheRoot, 'assets'),
    path.resolve(__dirname, '..', '..', '.cache', 'read-aloud-assets', modelFolderName),
    path.resolve(__dirname, '..', '..', '.cache', 'read-aloud-assets'),
    path.join(app.getAppPath(), '.cache', 'read-aloud-assets', modelFolderName),
    path.join(app.getAppPath(), '.cache', 'read-aloud-assets'),
    path.join(process.cwd(), '.cache', 'read-aloud-assets', modelFolderName),
    path.join(process.cwd(), '.cache', 'read-aloud-assets'),
  ]

  return candidates.filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0,
  )
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true })
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function describeLoadingState(): string {
  return `Preparing ${READ_ALOUD_PROVIDER_LABEL} read aloud output…`
}

function describeInstallingState(): string {
  return `Installing ${READ_ALOUD_PROVIDER_LABEL} voice assets for first use…`
}

function formatByteCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function describeInstallProgress(input: {
  assetPath: string
  assetIndex: number
  assetCount: number
  downloadedBytes: number
  totalBytes: number
}): string {
  const assetLabel = path.basename(input.assetPath)
  const downloaded = formatByteCount(input.downloadedBytes) ?? '0 B'
  const total = formatByteCount(input.totalBytes) ?? 'unknown size'
  return `Installing ${READ_ALOUD_PROVIDER_LABEL} voice assets (${input.assetIndex}/${input.assetCount} · ${assetLabel} · ${downloaded} / ${total})…`
}

function describeReadyState(): string {
  return `${READ_ALOUD_PROVIDER_LABEL} voice output is ready with ${READ_ALOUD_MODEL_LABEL}.`
}

function describeMissingAssetsState(): string {
  return 'Voice assets are not installed yet. Gemma Desktop will download them automatically the first time you use Read Aloud.'
}

async function readManifest(
  assetRoot: string,
): Promise<ReadAloudManifest | null> {
  const manifestPath = path.join(assetRoot, 'manifest.json')
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ReadAloudManifest>
    if (
      typeof parsed.version !== 'number'
      || typeof parsed.modelId !== 'string'
      || !Array.isArray(parsed.files)
    ) {
      return null
    }
    return {
      version: parsed.version,
      modelId: parsed.modelId,
      modelLabel:
        typeof parsed.modelLabel === 'string'
          ? parsed.modelLabel
          : READ_ALOUD_MODEL_LABEL,
      dtype:
        typeof parsed.dtype === 'string'
          ? parsed.dtype
          : READ_ALOUD_MODEL_DTYPE,
      bundledBytes:
        typeof parsed.bundledBytes === 'number'
          ? parsed.bundledBytes
          : undefined,
      files: parsed.files
        .filter((entry): entry is ReadAloudManifest['files'][number] =>
          Boolean(
            entry
            && typeof entry === 'object'
            && typeof entry.path === 'string'
            && typeof entry.sha256 === 'string'
            && typeof entry.url === 'string',
          ),
        )
        .map((entry) => ({
          path: entry.path,
          sha256: entry.sha256,
          sizeBytes:
            typeof entry.sizeBytes === 'number'
              ? entry.sizeBytes
              : undefined,
          url: entry.url,
        })),
    }
  } catch {
    return null
  }
}

async function resolveBundledBytes(
  assetRoot: string,
  manifest: ReadAloudManifest | null,
): Promise<number | null> {
  if (typeof manifest?.bundledBytes === 'number' && manifest.bundledBytes > 0) {
    return manifest.bundledBytes
  }

  const requiredFiles = [
    path.join(assetRoot, 'config.json'),
    path.join(assetRoot, 'tokenizer.json'),
    path.join(assetRoot, 'tokenizer_config.json'),
    path.join(assetRoot, 'onnx', 'model_quantized.onnx'),
  ]

  let total = 0
  for (const filePath of requiredFiles) {
    try {
      const stats = await fs.stat(filePath)
      total += stats.size
    } catch {
      return null
    }
  }

  return total > 0 ? total : null
}

async function hashFile(
  filePath: string,
): Promise<{
  sha256: string
  sizeBytes: number
}> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let sizeBytes = 0
    const stream = fsSync.createReadStream(filePath)

    stream.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      hash.update(buffer)
      sizeBytes += buffer.length
    })
    stream.on('error', reject)
    stream.on('end', () => {
      resolve({
        sha256: hash.digest('hex'),
        sizeBytes,
      })
    })
  })
}

async function verifyInstalledAsset(
  assetRoot: string,
  asset: (typeof READ_ALOUD_REMOTE_ASSETS)[number],
): Promise<boolean> {
  const targetPath = path.join(assetRoot, asset.path)
  if (!(await pathExists(targetPath))) {
    return false
  }

  const actual = await hashFile(targetPath)
  return actual.sha256 === asset.sha256 && actual.sizeBytes === asset.sizeBytes
}

async function downloadReadAloudAsset(
  assetRoot: string,
  asset: (typeof READ_ALOUD_REMOTE_ASSETS)[number],
  options?: {
    onProgress?: (downloadedBytes: number, totalBytes: number) => void
  },
): Promise<void> {
  const destinationPath = path.join(assetRoot, asset.path)
  const tempPath = `${destinationPath}.download-${process.pid}`

  await ensureDir(path.dirname(destinationPath))

  const response = await fetch(`${READ_ALOUD_MODEL_BASE_URL}/${asset.path}`)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${asset.path}: HTTP ${response.status}.`)
  }

  const hash = createHash('sha256')
  const stream = fsSync.createWriteStream(tempPath)
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  let downloadedBytes = 0

  try {
    while (true) {
      const readResult = await reader.read() as ReadAloudStreamReadResult
      if (readResult.done) {
        break
      }
      if (!(readResult.value instanceof Uint8Array)) {
        throw new Error(`Failed to download ${asset.path}: received an invalid response chunk.`)
      }

      const buffer = Buffer.from(readResult.value)
      hash.update(buffer)
      downloadedBytes += buffer.length
      options?.onProgress?.(downloadedBytes, asset.sizeBytes)

      if (!stream.write(buffer)) {
        await once(stream, 'drain')
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  } catch (error) {
    await reader.cancel().catch(() => {})
    stream.destroy()
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }

  const sha256 = hash.digest('hex')
  if (sha256 !== asset.sha256 || downloadedBytes !== asset.sizeBytes) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw new Error(
      `Downloaded ${asset.path}, but its checksum did not match the pinned Kokoro asset manifest.`,
    )
  }

  await fs.rename(tempPath, destinationPath)
}

async function writeInstalledManifest(assetRoot: string): Promise<void> {
  const files = READ_ALOUD_REMOTE_ASSETS.map((asset) => ({
    path: asset.path,
    sha256: asset.sha256,
    sizeBytes: asset.sizeBytes,
    url: `${READ_ALOUD_MODEL_BASE_URL}/${asset.path}`,
  }))

  const manifest: ReadAloudManifest & {
    providerId: typeof READ_ALOUD_PROVIDER_ID
    providerLabel: string
    revision: string
    preparedAt: string
  } = {
    version: 1,
    providerId: READ_ALOUD_PROVIDER_ID,
    providerLabel: READ_ALOUD_PROVIDER_LABEL,
    modelId: READ_ALOUD_MODEL_ID,
    modelLabel: READ_ALOUD_MODEL_LABEL,
    dtype: READ_ALOUD_MODEL_DTYPE,
    revision: READ_ALOUD_MODEL_REVISION,
    preparedAt: new Date().toISOString(),
    bundledBytes: files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    files,
  }

  await fs.writeFile(
    path.join(assetRoot, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
}

async function resolveAssetRoot(
  candidates: string[],
  cacheRoot: string,
): Promise<ReadAloudAssetResolution | null> {
  const requiredRelativePaths = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    path.join('onnx', 'model_quantized.onnx'),
  ]

  for (const candidate of candidates) {
    const normalizedCandidate = path.resolve(candidate)
    const candidateModelRoot = path.basename(normalizedCandidate) === READ_ALOUD_MODEL_ID
      ? normalizedCandidate
      : path.join(normalizedCandidate, READ_ALOUD_MODEL_ID)

    const hasAllFiles = await Promise.all(
      requiredRelativePaths.map((relativePath) =>
        pathExists(path.join(candidateModelRoot, relativePath))),
    )

    if (hasAllFiles.every(Boolean)) {
      const manifest = await readManifest(candidateModelRoot)
      return {
        assetRoot: candidateModelRoot,
        cacheDir: path.join(cacheRoot, 'cache'),
        bundledBytes: await resolveBundledBytes(candidateModelRoot, manifest),
      }
    }
  }

  return null
}

function concatAudioBuffers(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

function splitTextForReadAloud(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  const sentences = normalized.flatMap((part) => {
    const pieces = part
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/g)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0)

    return pieces.length > 0 ? pieces : [part]
  })

  return sentences.length > 0 ? sentences : [text.trim()].filter(Boolean)
}

function parseWavDurationMs(buffer: Buffer): number | null {
  if (buffer.length < 44) {
    return null
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }

  let offset = 12
  let byteRate: number | null = null
  let dataBytes: number | null = null

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

  if (byteRate == null || dataBytes == null || byteRate <= 0) {
    return null
  }

  return Math.round((dataBytes / byteRate) * 1000)
}

async function parseWavDurationFromFile(filePath: string): Promise<number | null> {
  try {
    return parseWavDurationMs(await fs.readFile(filePath))
  } catch {
    return null
  }
}

function resolveDurationMs(
  sampleCount: number,
  sampleRate: number,
): number | null {
  if (!Number.isFinite(sampleCount) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null
  }

  return Math.max(0, Math.round((sampleCount / sampleRate) * 1000))
}

export function buildReadAloudCacheKey(input: {
  messageId: string
  text: string
  voice: ReadAloudVoiceId
  speed: number
  modelVersion: string
}): {
  cacheKey: string
  textHash: string
} {
  const textHash = hashValue(input.text.trim())
  const cacheKey = hashValue(
    [
      READ_ALOUD_CACHE_FORMAT_VERSION,
      input.messageId,
      textHash,
      input.voice,
      input.speed.toFixed(2),
      input.modelVersion,
    ].join(':'),
  )

  return { cacheKey, textHash }
}

export async function pruneReadAloudCache(
  cacheDir: string,
  maxBytes = READ_ALOUD_CACHE_LIMIT_BYTES,
): Promise<void> {
  if (!(await pathExists(cacheDir))) {
    return
  }

  const entries = await fs.readdir(cacheDir, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(cacheDir, entry.name)
        const stats = await fs.stat(filePath)
        return {
          filePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        }
      }),
  )

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes <= maxBytes) {
    return
  }

  const sorted = [...files].sort((left, right) => left.mtimeMs - right.mtimeMs)
  for (const file of sorted) {
    await fs.rm(file.filePath, { force: true })
    totalBytes -= file.size
    if (totalBytes <= maxBytes) {
      break
    }
  }
}

class TransformersKokoroLoader implements ReadAloudModelLoader {
  public async load(
    assetRoot: string,
    cacheDir: string,
  ): Promise<ReadAloudModel> {
    const [{ env }, { KokoroTTS }] = await Promise.all([
      import('@huggingface/transformers'),
      import('kokoro-js'),
    ])

    env.allowRemoteModels = false
    env.localModelPath = `${path.dirname(assetRoot)}${path.sep}`
    env.cacheDir = cacheDir

    return await KokoroTTS.from_pretrained(READ_ALOUD_MODEL_ID, {
      dtype: READ_ALOUD_MODEL_DTYPE,
      device: READ_ALOUD_BACKEND,
    }) as ReadAloudModel
  }
}

export class ReadAloudService {
  private readonly listeners = new Set<ReadAloudChangeListener>()
  private readonly supportedPlatform: NodeJS.Platform
  private readonly cacheRoot: string
  private readonly managedAssetRoot: string
  private readonly assetRootCandidates: string[]
  private readonly modelLoader: ReadAloudModelLoader
  private readonly beforeHeavyWork: () => Promise<void>
  private tts: ReadAloudModel | null = null
  private loadedAssetRoot: string | null = null
  private loadingPromise: Promise<ReadAloudModel> | null = null
  private warmupPromise: Promise<void> | null = null
  private installationPromise: Promise<ReadAloudAssetResolution> | null = null
  private currentAbortController: AbortController | null = null
  private warming = false
  private busy = false
  private lastError: string | null = null
  private installDetail: string | null = null
  private installProgress: ReadAloudInstallProgress | null = null
  private lastInstallEmitAt = 0
  private autoWarmupAttempted = false

  public constructor(options: ReadAloudServiceOptions = {}) {
    this.supportedPlatform = options.supportedPlatform ?? process.platform
    this.cacheRoot =
      options.cacheRoot
      ?? path.join(app.getPath('userData'), 'read-aloud')
    this.managedAssetRoot = path.join(this.cacheRoot, 'assets', READ_ALOUD_MODEL_ID)
    this.assetRootCandidates = options.assetRootCandidates ?? defaultAssetRootCandidates(this.cacheRoot)
    this.modelLoader = options.modelLoader ?? new TransformersKokoroLoader()
    this.beforeHeavyWork = options.beforeHeavyWork ?? yieldToEventLoop
  }

  public onChanged(listener: ReadAloudChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async inspect(options: {
    enabled: boolean
  }): Promise<ReadAloudInspection> {
    if (!options.enabled) {
      this.autoWarmupAttempted = false
    }

    if (this.supportedPlatform !== 'darwin') {
      return this.buildInspection({
        enabled: options.enabled,
        supported: false,
        state: 'unsupported',
        healthy: false,
        detail: 'Read aloud is currently supported on macOS builds only.',
        assetRoot: null,
        cacheDir: null,
        bundledBytes: null,
        installProgress: null,
      })
    }

    if (
      options.enabled
      && !this.autoWarmupAttempted
      && !this.warming
      && !this.warmupPromise
      && !this.installationPromise
      && !this.loadingPromise
      && !this.tts
      && !this.busy
    ) {
      this.autoWarmupAttempted = true
      void this.warmup({ enabled: true }).catch((error) => {
        console.error('[gemma-desktop] Read aloud warmup failed:', error)
      })
    }

    if (this.installationPromise) {
      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'installing',
        healthy: false,
        detail: this.installDetail ?? describeInstallingState(),
        assetRoot: this.managedAssetRoot,
        cacheDir: path.join(this.cacheRoot, 'cache'),
        bundledBytes: null,
        installProgress: this.installProgress,
      })
    }

    const resolution = await resolveAssetRoot(this.assetRootCandidates, this.cacheRoot)
    if (this.installationPromise) {
      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'installing',
        healthy: false,
        detail: this.installDetail ?? describeInstallingState(),
        assetRoot: this.managedAssetRoot,
        cacheDir: path.join(this.cacheRoot, 'cache'),
        bundledBytes: null,
        installProgress: this.installProgress,
      })
    }

    if (!resolution) {
      if (this.warming) {
        return this.buildInspection({
          enabled: options.enabled,
          supported: true,
          state: 'loading',
          healthy: false,
          detail: this.installDetail ?? describeLoadingState(),
          assetRoot: this.managedAssetRoot,
          cacheDir: path.join(this.cacheRoot, 'cache'),
          bundledBytes: null,
          installProgress: this.installProgress,
        })
      }

      if (this.lastError) {
        return this.buildInspection({
          enabled: options.enabled,
          supported: true,
          state: 'error',
          healthy: false,
          detail: this.lastError,
          assetRoot: null,
          cacheDir: path.join(this.cacheRoot, 'cache'),
          bundledBytes: null,
          installProgress: null,
        })
      }

      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'missing_assets',
        healthy: false,
        detail: describeMissingAssetsState(),
        assetRoot: null,
        cacheDir: path.join(this.cacheRoot, 'cache'),
        bundledBytes: null,
        installProgress: null,
      })
    }

    if (this.busy && this.tts && !this.warming && !this.loadingPromise) {
      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'ready',
        healthy: true,
        detail: describeReadyState(),
        assetRoot: resolution.assetRoot,
        cacheDir: resolution.cacheDir,
        bundledBytes: resolution.bundledBytes,
        installProgress: null,
      })
    }

    if (this.busy || this.warming || this.loadingPromise) {
      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'loading',
        healthy: false,
        detail: describeLoadingState(),
        assetRoot: resolution.assetRoot,
        cacheDir: resolution.cacheDir,
        bundledBytes: resolution.bundledBytes,
        installProgress: null,
      })
    }

    if (this.lastError && !this.tts) {
      return this.buildInspection({
        enabled: options.enabled,
        supported: true,
        state: 'error',
        healthy: false,
        detail: this.lastError,
        assetRoot: resolution.assetRoot,
        cacheDir: resolution.cacheDir,
        bundledBytes: resolution.bundledBytes,
        installProgress: null,
      })
    }

    return this.buildInspection({
      enabled: options.enabled,
      supported: true,
      state: 'ready',
      healthy: true,
      detail: describeReadyState(),
      assetRoot: resolution.assetRoot,
      cacheDir: resolution.cacheDir,
      bundledBytes: resolution.bundledBytes,
      installProgress: null,
    })
  }

  public async warmup(options: {
    enabled: boolean
  }): Promise<void> {
    if (this.supportedPlatform !== 'darwin' || !options.enabled) {
      return
    }

    if (this.tts) {
      return
    }

    if (this.warmupPromise) {
      return await this.warmupPromise
    }

    this.lastError = null
    this.warming = true
    this.warmupPromise = (async () => {
      try {
        const resolution = await this.ensureAssetsReady()
        await this.beforeHeavyWork()
        await this.getModel(resolution.assetRoot, resolution.cacheDir)
      } catch (error) {
        this.lastError = error instanceof Error
          ? error.message
          : 'Read aloud warmup failed.'
        throw error
      } finally {
        this.warming = false
        this.warmupPromise = null
        this.emitChanged()
      }
    })()
    this.emitChanged()

    return await this.warmupPromise
  }

  public async synthesize(
    input: ReadAloudSynthesisInput,
    options: {
      enabled: boolean
    },
  ): Promise<ReadAloudSynthesisResult> {
    if (this.supportedPlatform !== 'darwin') {
      throw new Error('Read aloud is currently available on macOS builds only.')
    }

    if (!options.enabled) {
      throw new Error('Read aloud is disabled in Settings.')
    }

    const text = input.text.trim()
    if (text.length === 0) {
      throw new Error('There is no readable text in this message.')
    }

    const resolution = await this.ensureAssetsReady()

    const voice = normalizeReadAloudVoice(input.voice)
    const speed = clampReadAloudSpeed(input.speed)
    const { cacheKey, textHash } = buildReadAloudCacheKey({
      messageId: input.messageId || READ_ALOUD_PREVIEW_MESSAGE_ID,
      text,
      voice,
      speed,
      modelVersion: `${READ_ALOUD_MODEL_ID}:${READ_ALOUD_MODEL_DTYPE}`,
    })
    const cachePath = path.join(resolution.cacheDir, `${cacheKey}.wav`)

    await ensureDir(resolution.cacheDir)
    await pruneReadAloudCache(resolution.cacheDir)

    if (input.useCache !== false && await pathExists(cachePath)) {
      const now = new Date()
      await fs.utimes(cachePath, now, now).catch(() => {})
      const cachedDurationMs = await parseWavDurationFromFile(cachePath)
      return {
        audioPath: cachePath,
        fromCache: true,
        durationMs: cachedDurationMs,
        voice,
        speed,
        textHash,
      }
    }

    await this.cancelCurrent()
    const controller = new AbortController()
    this.currentAbortController = controller
    this.busy = true
    this.lastError = null
    this.emitChanged()

    try {
      const needsModelLoad = !this.tts || this.loadedAssetRoot !== resolution.assetRoot
      if (needsModelLoad) {
        await this.beforeHeavyWork()
      }

      const tts = await this.getModel(resolution.assetRoot, resolution.cacheDir)
      if (controller.signal.aborted) {
        throw new Error('Read aloud cancelled.')
      }

      const chunks: Float32Array[] = []
      let sampleRate = READ_ALOUD_SAMPLE_RATE
      const segments = splitTextForReadAloud(text)

      for (const segmentText of segments) {
        if (controller.signal.aborted) {
          throw new Error('Read aloud cancelled.')
        }

        const audio = await tts.generate(segmentText, { voice, speed })
        chunks.push(audio.audio)
        sampleRate = audio.sampling_rate
      }

      if (chunks.length === 0) {
        throw new Error('Read aloud did not produce any audio.')
      }

      const [{ RawAudio }] = await Promise.all([
        import('@huggingface/transformers'),
      ])
      const wav = new RawAudio(
        concatAudioBuffers(chunks),
        sampleRate,
      ).toWav()
      await fs.writeFile(cachePath, Buffer.from(wav))
      await pruneReadAloudCache(resolution.cacheDir)

      return {
        audioPath: cachePath,
        fromCache: false,
        durationMs: resolveDurationMs(
          chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          sampleRate,
        ),
        voice,
        speed,
        textHash,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Read aloud failed.'
      if (errorMessage !== 'Read aloud cancelled.') {
        this.lastError = errorMessage
      }
      throw error
    } finally {
      if (this.currentAbortController === controller) {
        this.currentAbortController = null
      }
      this.busy = false
      this.emitChanged()
    }
  }

  public async test(
    input: ReadAloudTestInput | undefined,
    options: {
      enabled: boolean
      defaultVoice: ReadAloudVoiceId
      defaultSpeed: number
    },
  ): Promise<ReadAloudSynthesisResult> {
    return await this.synthesize(
      {
        messageId: READ_ALOUD_PREVIEW_MESSAGE_ID,
        text: READ_ALOUD_TEST_PHRASE,
        voice: normalizeReadAloudVoice(input?.voice ?? options.defaultVoice),
        speed: clampReadAloudSpeed(input?.speed ?? options.defaultSpeed),
        purpose: 'preview',
      },
      {
        enabled: options.enabled,
      },
    )
  }

  public async cancelCurrent(): Promise<{ ok: true }> {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
      this.busy = false
      this.emitChanged()
    }

    return { ok: true }
  }

  private async ensureAssetsReady(): Promise<ReadAloudAssetResolution> {
    const existing = await resolveAssetRoot(this.assetRootCandidates, this.cacheRoot)
    if (existing) {
      return existing
    }

    if (!this.installationPromise) {
      this.installationPromise = this.installAssets()
        .finally(() => {
          this.installationPromise = null
          this.installDetail = null
          this.installProgress = null
          this.emitChanged()
        })
      this.emitChanged()
    }

    return await this.installationPromise
  }

  private async installAssets(): Promise<ReadAloudAssetResolution> {
    this.lastError = null
    this.installDetail = describeInstallingState()
    this.installProgress = null
    this.lastInstallEmitAt = 0

    try {
      for (const [index, asset] of READ_ALOUD_REMOTE_ASSETS.entries()) {
        if (await verifyInstalledAsset(this.managedAssetRoot, asset)) {
          continue
        }

        this.installDetail = describeInstallProgress({
          assetPath: asset.path,
          assetIndex: index + 1,
          assetCount: READ_ALOUD_REMOTE_ASSETS.length,
          downloadedBytes: 0,
          totalBytes: asset.sizeBytes,
        })
        this.installProgress = {
          assetPath: asset.path,
          assetIndex: index + 1,
          assetCount: READ_ALOUD_REMOTE_ASSETS.length,
          downloadedBytes: 0,
          totalBytes: asset.sizeBytes,
          percent: 0,
        }
        this.emitChanged()

        await downloadReadAloudAsset(this.managedAssetRoot, asset, {
          onProgress: (downloadedBytes, totalBytes) => {
            this.installDetail = describeInstallProgress({
              assetPath: asset.path,
              assetIndex: index + 1,
              assetCount: READ_ALOUD_REMOTE_ASSETS.length,
              downloadedBytes,
              totalBytes,
            })
            this.installProgress = {
              assetPath: asset.path,
              assetIndex: index + 1,
              assetCount: READ_ALOUD_REMOTE_ASSETS.length,
              downloadedBytes,
              totalBytes,
              percent:
                totalBytes > 0
                  ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)))
                  : null,
            }
            const now = Date.now()
            if (now - this.lastInstallEmitAt >= 250 || downloadedBytes === totalBytes) {
              this.lastInstallEmitAt = now
              this.emitChanged()
            }
          },
        })
      }

      await writeInstalledManifest(this.managedAssetRoot)

      const installed = await resolveAssetRoot(this.assetRootCandidates, this.cacheRoot)
      if (!installed) {
        throw new Error('Read aloud assets finished downloading, but Gemma Desktop could not verify the installed files.')
      }

      return installed
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Read aloud asset installation failed.'
      this.lastError = errorMessage
      throw new Error(errorMessage)
    }
  }

  private async getModel(assetRoot: string, cacheDir: string): Promise<ReadAloudModel> {
    if (this.tts && this.loadedAssetRoot === assetRoot) {
      return this.tts
    }

    if (!this.loadingPromise || this.loadedAssetRoot !== assetRoot) {
      this.loadingPromise = this.modelLoader.load(assetRoot, cacheDir)
        .then((tts) => {
          this.tts = tts
          this.loadedAssetRoot = assetRoot
          return tts
        })
        .finally(() => {
          this.loadingPromise = null
        })
    }

    return await this.loadingPromise
  }

  private buildInspection(input: {
    enabled: boolean
    supported: boolean
    state: ReadAloudInspection['state']
    healthy: boolean
    detail: string
    assetRoot: string | null
    cacheDir: string | null
    bundledBytes: number | null
    installProgress: ReadAloudInstallProgress | null
  }): ReadAloudInspection {
    return {
      supported: input.supported,
      enabled: input.enabled,
      provider: READ_ALOUD_PROVIDER_ID,
      providerLabel: READ_ALOUD_PROVIDER_LABEL,
      model: READ_ALOUD_MODEL_ID,
      modelLabel: READ_ALOUD_MODEL_LABEL,
      dtype: READ_ALOUD_MODEL_DTYPE,
      backend: READ_ALOUD_BACKEND,
      state: input.state,
      healthy: input.healthy,
      busy:
        this.busy
        || this.warming
        || Boolean(this.loadingPromise)
        || Boolean(this.installationPromise),
      detail: input.detail,
      lastError: this.lastError,
      assetRoot: input.assetRoot,
      cacheDir: input.cacheDir,
      bundledBytes: input.bundledBytes,
      installProgress: input.installProgress,
      checkedAt: new Date().toISOString(),
    }
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export {
  READ_ALOUD_CACHE_LIMIT_BYTES,
  resolveAssetRoot as resolveReadAloudAssetRoot,
}
