import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { app } from 'electron'
import {
  SPEECH_MODEL_ID,
  SPEECH_MODEL_LABEL,
  SPEECH_PROVIDER_ID,
  SPEECH_PROVIDER_LABEL,
  type SpeechInspection,
  type SpeechInstallState,
} from '../shared/speech'
import { WhisperCppServer } from './speechServer'

const execFileAsync = promisify(execFile)
const WHISPER_CPP_REPOSITORY_URL = 'https://github.com/ggml-org/whisper.cpp'
const DEFAULT_COMMUNITY_BOOTSTRAP_REF = 'v1.8.4'
const DEFAULT_COMMUNITY_BOOTSTRAP_ARCHIVE_URL = `${WHISPER_CPP_REPOSITORY_URL}/archive/refs/tags/${DEFAULT_COMMUNITY_BOOTSTRAP_REF}.tar.gz`
const DEFAULT_RUNTIME_VERSION = 'whisper-cpp-dev-bootstrap'
const DEFAULT_MODEL_FILENAME = `ggml-${SPEECH_MODEL_ID}.bin`
const DEFAULT_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL_FILENAME}`
const DEFAULT_MODEL_SHA1 = 'e050f7970618a659205450ad97eb95a18d69c9ee'
const DEFAULT_VAD_MODEL_ID = 'silero-v6.2.0'
const DEFAULT_VAD_MODEL_FILENAME = `ggml-${DEFAULT_VAD_MODEL_ID}.bin`
const DEFAULT_VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${DEFAULT_VAD_MODEL_FILENAME}`
const DEFAULT_VAD_MODEL_SHA256 = '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'

interface SpeechArtifactManifest {
  version: string
  provider: typeof SPEECH_PROVIDER_ID
  model: typeof SPEECH_MODEL_ID
  artifacts: Record<string, {
    url: string
    sha256: string
    format: 'zip' | 'tar.gz'
    sizeBytes?: number
    binaryRelativePath?: string
    libraryRelativePath?: string | null
  }>
}

interface SpeechRuntimeRecord {
  version: 3
  installSource: 'managed-download' | 'dev-bootstrap' | 'community-bootstrap'
  runtimeVersion: string
  provider: typeof SPEECH_PROVIDER_ID
  model: typeof SPEECH_MODEL_ID
  binaryRelativePath: string
  modelRelativePath: string
  vadModelRelativePath: string
  libraryRelativePath: string | null
  networkDownloadBytes: number | null
  diskUsageBytes: number | null
  manifestUrl: string | null
  installedAt: string
  lastError: string | null
}

export interface SpeechRuntimeLaunchConfig {
  binaryPath: string
  modelPath: string
  vadModelPath: string
  libraryDir: string | null
  runtimeVersion: string
}

interface DevBootstrapSource {
  referenceDir: string
}

interface CommunityBootstrapSource {
  archiveUrl: string
  runtimeVersion: string
}

interface StagedRuntimeLayout {
  binaryRelativePath: string
  libraryRelativePath: string | null
}

interface InspectOptions {
  enabled: boolean
}

type RuntimeChangeListener = () => void

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function removeIfExists(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true })
}

async function ensureDir(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true })
}

async function computePathSize(targetPath: string): Promise<number> {
  const stats = await fs.stat(targetPath)
  if (!stats.isDirectory()) {
    return stats.size
  }

  let total = 0
  const entries = await fs.readdir(targetPath)
  for (const entry of entries) {
    total += await computePathSize(path.join(targetPath, entry))
  }
  return total
}

async function hashFile(
  targetPath: string,
  algorithm: 'sha1' | 'sha256',
): Promise<string> {
  const hash = createHash(algorithm)
  const handle = await fs.open(targetPath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function describeNetworkFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'network request failed.'
  }

  const messages = [error.message.trim()]
  const cause = error.cause
  if (cause instanceof Error) {
    const causeMessage = cause.message.trim()
    if (causeMessage && !messages.includes(causeMessage)) {
      messages.push(causeMessage)
    }
  }

  return messages.filter(Boolean).join(': ') || 'network request failed.'
}

async function readJsonFromLocation(location: string): Promise<unknown> {
  if (/^https?:\/\//i.test(location)) {
    let response: Response
    try {
      response = await fetch(location)
    } catch (error) {
      throw new Error(
        `Speech manifest fetch failed for ${location}: ${describeNetworkFailure(error)}`,
      )
    }

    if (!response.ok) {
      throw new Error(`Speech manifest request failed: ${response.status} ${response.statusText}`)
    }
    return await response.json()
  }

  const targetPath = location.startsWith('file://')
    ? new URL(location)
    : resolve(location)
  const raw = await fs.readFile(targetPath, 'utf8')
  return JSON.parse(raw) as unknown
}

async function downloadToFile(source: string, destinationPath: string): Promise<void> {
  if (/^https?:\/\//i.test(source)) {
    let response: Response
    try {
      response = await fetch(source)
    } catch (error) {
      throw new Error(
        `Speech download failed for ${source}: ${describeNetworkFailure(error)}`,
      )
    }

    if (!response.ok) {
      throw new Error(`Speech download failed: ${response.status} ${response.statusText}`)
    }
    if (!response.body) {
      throw new Error('Speech download returned an empty response body.')
    }

    await ensureDir(path.dirname(destinationPath))
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(destinationPath),
    )
    return
  }

  const sourcePath = source.startsWith('file://')
    ? new URL(source)
    : resolve(source)
  await fs.copyFile(sourcePath, destinationPath)
}

async function extractArchive(input: {
  archivePath: string
  destinationPath: string
  format: 'zip' | 'tar.gz'
}): Promise<void> {
  await ensureDir(input.destinationPath)

  if (input.format === 'zip') {
    await execFileAsync('ditto', ['-x', '-k', input.archivePath, input.destinationPath], {
      maxBuffer: 1024 * 1024 * 16,
    })
    return
  }

  await execFileAsync('tar', ['-xzf', input.archivePath, '-C', input.destinationPath], {
    maxBuffer: 1024 * 1024 * 16,
  })
}

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stderrLines: string[] = []
    const stdoutLines: string[] = []

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (!text.trim()) {
        return
      }
      stdoutLines.push(...text.trim().split('\n'))
      while (stdoutLines.length > 20) {
        stdoutLines.shift()
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (!text.trim()) {
        return
      }
      stderrLines.push(...text.trim().split('\n'))
      while (stderrLines.length > 20) {
        stderrLines.shift()
      }
    })

    child.on('error', (error) => {
      rejectCommand(error)
    })

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand()
        return
      }

      const tail = stderrLines.at(-1) ?? stdoutLines.at(-1)
      rejectCommand(new Error(
        tail
          ? `${command} ${args.join(' ')} failed: ${tail}`
          : `${command} ${args.join(' ')} failed${signal ? ` (${signal})` : ''}.`,
      ))
    })
  })
}

async function ensureCmakeAvailable(cmakePath: string): Promise<void> {
  try {
    await execFileAsync(cmakePath, ['--version'], {
      maxBuffer: 1024 * 256,
    })
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: string }).code === 'ENOENT'
    ) {
      throw new Error(
        'Speech bootstrap requires CMake to build whisper.cpp. Install CMake on this machine, for example with `brew install cmake`, or provide GEMMA_DESKTOP_SPEECH_MANIFEST_URL.',
      )
    }

    throw error
  }
}

async function copyRuntimeFile(
  sourcePath: string,
  destinationPath: string,
  mode?: number,
): Promise<void> {
  await ensureDir(path.dirname(destinationPath))
  await fs.copyFile(sourcePath, destinationPath)
  if (typeof mode === 'number') {
    await fs.chmod(destinationPath, mode)
  }
}

function resolveSpeechManifestUrl(): string {
  return process.env['GEMMA_DESKTOP_SPEECH_MANIFEST_URL']?.trim() ?? ''
}

function findWhisperCppReferenceDir(): string | null {
  const candidatePaths = [
    process.env['GEMMA_DESKTOP_SPEECH_DEV_REFERENCE_DIR'],
    '/Users/dmitrylyalin/Source/Reference_Projects/whisper.cpp',
    '/Users/dmitrylyalin/sOurce/Reference_Projects/whisper.cpp',
    resolve(process.cwd(), '../../../Reference_Projects/whisper.cpp'),
    resolve(process.cwd(), '../../../../Reference_Projects/whisper.cpp'),
  ].filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0,
  )

  for (const candidatePath of candidatePaths) {
    if (
      existsSync(join(candidatePath, 'CMakeLists.txt'))
      && existsSync(join(candidatePath, 'examples', 'server', 'server.cpp'))
      && existsSync(join(candidatePath, 'models', 'download-ggml-model.sh'))
    ) {
      return candidatePath
    }
  }

  return null
}

function findCmakeBinary(): string {
  const candidatePaths = [
    process.env['GEMMA_DESKTOP_SPEECH_DEV_CMAKE'],
    '/opt/homebrew/bin/cmake',
    '/usr/local/bin/cmake',
    'cmake',
  ].filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0,
  )

  for (const candidatePath of candidatePaths) {
    if (candidatePath === 'cmake' || existsSync(candidatePath)) {
      return candidatePath
    }
  }

  return 'cmake'
}

function findDevBootstrapSource(): DevBootstrapSource | null {
  const referenceDir = findWhisperCppReferenceDir()
  if (!referenceDir) {
    return null
  }

  return {
    referenceDir,
  }
}

function resolveCommunityBootstrapSource(): CommunityBootstrapSource {
  const archiveUrl = process.env['GEMMA_DESKTOP_SPEECH_SOURCE_ARCHIVE_URL']?.trim()
    || DEFAULT_COMMUNITY_BOOTSTRAP_ARCHIVE_URL
  const runtimeVersion = process.env['GEMMA_DESKTOP_SPEECH_SOURCE_VERSION']?.trim()
    || `whisper.cpp-${DEFAULT_COMMUNITY_BOOTSTRAP_REF}`

  return {
    archiveUrl,
    runtimeVersion,
  }
}

function resolveArtifactKey(): string {
  return `${process.platform}-${process.arch}`
}

function normalizeInspection(input: {
  enabled: boolean
  supported: boolean
  installState: SpeechInstallState
  detail: string
  installed: boolean
  healthy: boolean
  busy: boolean
  lastError: string | null
  runtimeVersion?: string | null
  networkDownloadBytes?: number | null
  diskUsageBytes?: number | null
  installLocation?: string | null
}): SpeechInspection {
  return {
    supported: input.supported,
    enabled: input.enabled,
    provider: SPEECH_PROVIDER_ID,
    providerLabel: SPEECH_PROVIDER_LABEL,
    model: SPEECH_MODEL_ID,
    modelLabel: SPEECH_MODEL_LABEL,
    installState: input.installState,
    installed: input.installed,
    healthy: input.healthy,
    busy: input.busy,
    detail: input.detail,
    lastError: input.lastError,
    runtimeVersion: input.runtimeVersion ?? null,
    networkDownloadBytes: input.networkDownloadBytes ?? null,
    diskUsageBytes: input.diskUsageBytes ?? null,
    installLocation: input.installLocation ?? null,
    checkedAt: new Date().toISOString(),
  }
}

export class SpeechRuntimeManager {
  private readonly rootDir = join(app.getPath('userData'), 'speech')
  private readonly runtimeDir = join(this.rootDir, 'runtime')
  private readonly modelDir = join(this.rootDir, 'models')
  private readonly metadataPath = join(this.rootDir, 'install.json')
  private readonly listeners = new Set<RuntimeChangeListener>()
  private currentOperation: SpeechInstallState | null = null
  private lastError: string | null = null

  public onChanged(listener: RuntimeChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public async inspect(options: InspectOptions): Promise<SpeechInspection> {
    if (process.platform !== 'darwin') {
      return normalizeInspection({
        enabled: options.enabled,
        supported: false,
        installState: 'unsupported',
        detail: 'Speech input is currently available on macOS builds only.',
        installed: false,
        healthy: false,
        busy: false,
        lastError: null,
      })
    }

    const metadata = await this.readMetadata()
    if (this.currentOperation) {
      return normalizeInspection({
        enabled: options.enabled,
        supported: true,
        installState: this.currentOperation,
        detail: this.describeBusyState(this.currentOperation),
        installed: metadata !== null,
        healthy: false,
        busy: true,
        lastError: this.lastError ?? metadata?.lastError ?? null,
        runtimeVersion: metadata?.runtimeVersion ?? null,
        networkDownloadBytes: metadata?.networkDownloadBytes ?? null,
        diskUsageBytes: metadata?.diskUsageBytes ?? null,
        installLocation: metadata ? this.rootDir : null,
      })
    }

    if (!metadata) {
      const configuredManifestUrl = resolveSpeechManifestUrl()
      const devBootstrap =
        !app.isPackaged && !configuredManifestUrl
          ? findDevBootstrapSource()
          : null
      const communityBootstrap = !configuredManifestUrl
        ? resolveCommunityBootstrapSource()
        : null
      return normalizeInspection({
        enabled: options.enabled,
        supported: true,
        installState: this.lastError ? 'error' : 'not_installed',
        detail: this.lastError
          ? 'Speech install needs attention before the microphone can be used.'
          : devBootstrap
            ? 'Speech runtime is not installed yet. Gemma Desktop can build whisper.cpp locally for development.'
            : configuredManifestUrl
              ? 'Speech runtime is not installed yet. Install Managed whisper.cpp from the configured manifest to use microphone dictation.'
              : communityBootstrap
                ? `Speech runtime is not installed yet. Gemma Desktop can build whisper.cpp from the official community source (${communityBootstrap.runtimeVersion}).`
                : 'Speech runtime is not installed yet. This build has no managed speech installer configured.',
        installed: false,
        healthy: false,
        busy: false,
        lastError: this.lastError,
        networkDownloadBytes: null,
        diskUsageBytes: null,
        installLocation: null,
      })
    }

    const launchConfig = await this.resolveLaunchConfig(metadata)
    if (!launchConfig) {
      return normalizeInspection({
        enabled: options.enabled,
        supported: true,
        installState: 'error',
        detail: 'Speech runtime metadata exists, but the installed files are incomplete.',
        installed: false,
        healthy: false,
        busy: false,
        lastError: metadata.lastError ?? 'Speech runtime files are incomplete.',
        runtimeVersion: metadata.runtimeVersion,
        networkDownloadBytes: metadata.networkDownloadBytes,
        diskUsageBytes: metadata.diskUsageBytes,
        installLocation: this.rootDir,
      })
    }

    try {
      await this.probeRuntime(launchConfig)
      return normalizeInspection({
        enabled: options.enabled,
        supported: true,
        installState: 'installed',
        detail: `Managed whisper.cpp is ready with ${SPEECH_MODEL_LABEL}.`,
        installed: true,
        healthy: true,
        busy: false,
        lastError: null,
        runtimeVersion: metadata.runtimeVersion,
        networkDownloadBytes: metadata.networkDownloadBytes,
        diskUsageBytes: metadata.diskUsageBytes,
        installLocation: this.rootDir,
      })
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Managed whisper.cpp failed to start.'
      return normalizeInspection({
        enabled: options.enabled,
        supported: true,
        installState: 'error',
        detail: 'Managed whisper.cpp is installed, but the runtime health check failed.',
        installed: true,
        healthy: false,
        busy: false,
        lastError: message,
        runtimeVersion: metadata.runtimeVersion,
        networkDownloadBytes: metadata.networkDownloadBytes,
        diskUsageBytes: metadata.diskUsageBytes,
        installLocation: this.rootDir,
      })
    }
  }

  public async install(options: InspectOptions): Promise<SpeechInspection> {
    return await this.runOperation('installing', options, async () => {
      if (process.platform !== 'darwin') {
        throw new Error('Speech input can only be installed on macOS right now.')
      }

      const configuredManifestUrl = resolveSpeechManifestUrl()
      const devBootstrap =
        !app.isPackaged && !configuredManifestUrl
          ? findDevBootstrapSource()
          : null
      const communityBootstrap = !configuredManifestUrl
        ? resolveCommunityBootstrapSource()
        : null

      if (devBootstrap) {
        await this.installFromDevBootstrap(devBootstrap)
        return
      }

      if (configuredManifestUrl) {
        await this.installFromManifest(configuredManifestUrl)
        return
      }

      if (communityBootstrap) {
        await this.installFromCommunityBootstrap(communityBootstrap)
        return
      }

      throw new Error(
        `Speech install is not configured for this build. There is no default Gemma Desktop-hosted speech service. Provide GEMMA_DESKTOP_SPEECH_MANIFEST_URL or a local whisper.cpp checkout for development (${WHISPER_CPP_REPOSITORY_URL}).`,
      )
    })
  }

  public async repair(options: InspectOptions): Promise<SpeechInspection> {
    return await this.runOperation('repairing', options, async () => {
      await removeIfExists(this.rootDir)
      this.lastError = null

      const configuredManifestUrl = resolveSpeechManifestUrl()
      const devBootstrap =
        !app.isPackaged && !configuredManifestUrl
          ? findDevBootstrapSource()
          : null
      const communityBootstrap = !configuredManifestUrl
        ? resolveCommunityBootstrapSource()
        : null

      if (devBootstrap) {
        await this.installFromDevBootstrap(devBootstrap)
        return
      }

      if (configuredManifestUrl) {
        await this.installFromManifest(configuredManifestUrl)
        return
      }

      if (communityBootstrap) {
        await this.installFromCommunityBootstrap(communityBootstrap)
        return
      }

      throw new Error(
        `Speech repair is not configured for this build. There is no default Gemma Desktop-hosted speech service. Provide GEMMA_DESKTOP_SPEECH_MANIFEST_URL or a local whisper.cpp checkout for development (${WHISPER_CPP_REPOSITORY_URL}).`,
      )
    })
  }

  public async remove(options: InspectOptions): Promise<SpeechInspection> {
    return await this.runOperation('removing', options, async () => {
      await removeIfExists(this.rootDir)
      this.lastError = null
    })
  }

  public async getLaunchConfig(): Promise<SpeechRuntimeLaunchConfig> {
    const metadata = await this.readMetadata()
    if (!metadata) {
      throw new Error('Speech runtime is not installed yet.')
    }

    const launchConfig = await this.resolveLaunchConfig(metadata)
    if (!launchConfig) {
      throw new Error('Speech runtime files are incomplete.')
    }

    return launchConfig
  }

  private async runOperation(
    operation: SpeechInstallState,
    options: InspectOptions,
    runner: () => Promise<void>,
  ): Promise<SpeechInspection> {
    if (this.currentOperation) {
      throw new Error('Speech runtime is already busy.')
    }

    this.currentOperation = operation
    this.emitChanged()

    try {
      await runner()
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Speech runtime operation failed.'
      const metadata = await this.readMetadata()
      if (metadata) {
        metadata.lastError = this.lastError
        await this.writeMetadata(metadata)
      }
    } finally {
      this.currentOperation = null
      this.emitChanged()
    }

    return await this.inspect(options)
  }

  private async installFromDevBootstrap(source: DevBootstrapSource): Promise<void> {
    await removeIfExists(this.rootDir)
    await ensureDir(this.rootDir)

    const runtimeInstall = await this.buildWhisperCppRuntime(source.referenceDir)
    const modelInstall = await this.installPinnedModels()
    const diskUsageBytes = await computePathSize(this.rootDir)

    await this.writeMetadata({
      version: 3,
      installSource: 'dev-bootstrap',
      runtimeVersion: DEFAULT_RUNTIME_VERSION,
      provider: SPEECH_PROVIDER_ID,
      model: SPEECH_MODEL_ID,
      binaryRelativePath: runtimeInstall.binaryRelativePath,
      modelRelativePath: modelInstall.speechModelRelativePath,
      vadModelRelativePath: modelInstall.vadModelRelativePath,
      libraryRelativePath: runtimeInstall.libraryRelativePath,
      networkDownloadBytes: modelInstall.networkDownloadBytes,
      diskUsageBytes,
      manifestUrl: null,
      installedAt: new Date().toISOString(),
      lastError: null,
    })
  }

  private async installFromCommunityBootstrap(
    source: CommunityBootstrapSource,
  ): Promise<void> {
    await removeIfExists(this.rootDir)
    await ensureDir(this.rootDir)

    const tempDir = await fs.mkdtemp(join(tmpdir(), 'gemma-desktop-whispercpp-source-'))

    try {
      const archivePath = join(tempDir, 'whisper.cpp.tar.gz')
      const extractDir = join(tempDir, 'extract')

      await downloadToFile(source.archiveUrl, archivePath)
      const archiveStats = await fs.stat(archivePath)
      await extractArchive({
        archivePath,
        destinationPath: extractDir,
        format: 'tar.gz',
      })

      const referenceDir = await this.findExtractedWhisperCppSourceDir(extractDir)
      const runtimeInstall = await this.buildWhisperCppRuntime(referenceDir)
      const modelInstall = await this.installPinnedModels()
      const diskUsageBytes = await computePathSize(this.rootDir)

      await this.writeMetadata({
        version: 3,
        installSource: 'community-bootstrap',
        runtimeVersion: source.runtimeVersion,
        provider: SPEECH_PROVIDER_ID,
        model: SPEECH_MODEL_ID,
        binaryRelativePath: runtimeInstall.binaryRelativePath,
        modelRelativePath: modelInstall.speechModelRelativePath,
        vadModelRelativePath: modelInstall.vadModelRelativePath,
        libraryRelativePath: runtimeInstall.libraryRelativePath,
        networkDownloadBytes: archiveStats.size + (modelInstall.networkDownloadBytes ?? 0),
        diskUsageBytes,
        manifestUrl: source.archiveUrl,
        installedAt: new Date().toISOString(),
        lastError: null,
      })
    } finally {
      await removeIfExists(tempDir)
    }
  }

  private async installFromManifest(manifestUrl: string): Promise<void> {
    await removeIfExists(this.rootDir)
    await ensureDir(this.rootDir)
    await ensureDir(this.runtimeDir)

    const manifest = await readJsonFromLocation(manifestUrl) as SpeechArtifactManifest
    const artifactKey = resolveArtifactKey()
    const runtimeArtifact = manifest.artifacts[artifactKey]
    if (!runtimeArtifact) {
      throw new Error(`Speech runtime does not publish an artifact for ${artifactKey}.`)
    }

    const tempDir = await fs.mkdtemp(join(tmpdir(), 'gemma-desktop-speech-runtime-'))
    try {
      const runtimeArchivePath = join(
        tempDir,
        `runtime.${runtimeArtifact.format === 'zip' ? 'zip' : 'tar.gz'}`,
      )
      await downloadToFile(runtimeArtifact.url, runtimeArchivePath)

      const runtimeSha = await hashFile(runtimeArchivePath, 'sha256')
      if (runtimeSha !== runtimeArtifact.sha256) {
        throw new Error('Speech runtime archive checksum verification failed.')
      }

      await extractArchive({
        archivePath: runtimeArchivePath,
        destinationPath: this.runtimeDir,
        format: runtimeArtifact.format,
      })
    } finally {
      await removeIfExists(tempDir)
    }

    const modelInstall = await this.installPinnedModels()
    const binaryPath = runtimeArtifact.binaryRelativePath
      ? join(this.runtimeDir, runtimeArtifact.binaryRelativePath)
      : await this.findInstalledBinary(this.runtimeDir)
    if (!binaryPath) {
      throw new Error('Speech runtime archive did not contain whisper-server.')
    }

    const libraryDir = runtimeArtifact.libraryRelativePath
      ? join(this.runtimeDir, runtimeArtifact.libraryRelativePath)
      : (await pathExists(join(this.runtimeDir, 'lib')) ? join(this.runtimeDir, 'lib') : null)

    const diskUsageBytes = await computePathSize(this.rootDir)
    await this.writeMetadata({
      version: 3,
      installSource: 'managed-download',
      runtimeVersion: manifest.version,
      provider: SPEECH_PROVIDER_ID,
      model: SPEECH_MODEL_ID,
      binaryRelativePath: path.relative(this.rootDir, binaryPath),
      modelRelativePath: modelInstall.speechModelRelativePath,
      vadModelRelativePath: modelInstall.vadModelRelativePath,
      libraryRelativePath: libraryDir ? path.relative(this.rootDir, libraryDir) : null,
      networkDownloadBytes: (runtimeArtifact.sizeBytes ?? 0) + (modelInstall.networkDownloadBytes ?? 0),
      diskUsageBytes,
      manifestUrl,
      installedAt: new Date().toISOString(),
      lastError: null,
    })
  }

  private async buildWhisperCppRuntime(referenceDir: string): Promise<{
    binaryRelativePath: string
    libraryRelativePath: string | null
  }> {
    const buildDir = await fs.mkdtemp(join(tmpdir(), 'gemma-desktop-whispercpp-build-'))
    const cmakePath = findCmakeBinary()
    await ensureCmakeAvailable(cmakePath)

    try {
      await runCommand(cmakePath, [
        '-S',
        referenceDir,
        '-B',
        buildDir,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_SDL2=OFF',
      ])
      await runCommand(cmakePath, [
        '--build',
        buildDir,
        '--config',
        'Release',
        '--target',
        'whisper-server',
      ])
      return await this.stageWhisperCppRuntimeFromBuild(buildDir)
    } finally {
      await removeIfExists(buildDir)
    }
  }

  private async stageWhisperCppRuntimeFromBuild(buildDir: string): Promise<StagedRuntimeLayout> {
    const binaryOutputPath = join(this.runtimeDir, 'bin', 'whisper-server')
    const libraryOutputDir = join(this.runtimeDir, 'lib')

    const sources = {
      binary: join(buildDir, 'bin', 'whisper-server'),
      libs: [
        join(buildDir, 'src', 'libwhisper.1.dylib'),
        join(buildDir, 'ggml', 'src', 'libggml.0.dylib'),
        join(buildDir, 'ggml', 'src', 'libggml-base.0.dylib'),
        join(buildDir, 'ggml', 'src', 'libggml-cpu.0.dylib'),
        join(buildDir, 'ggml', 'src', 'ggml-blas', 'libggml-blas.0.dylib'),
        join(buildDir, 'ggml', 'src', 'ggml-metal', 'libggml-metal.0.dylib'),
      ],
    }

    if (!(await pathExists(sources.binary))) {
      throw new Error('whisper.cpp build did not produce whisper-server.')
    }

    for (const libraryPath of sources.libs) {
      if (!(await pathExists(libraryPath))) {
        throw new Error(`whisper.cpp build did not produce ${path.basename(libraryPath)}.`)
      }
    }

    await removeIfExists(this.runtimeDir)
    await ensureDir(join(this.runtimeDir, 'bin'))
    await ensureDir(libraryOutputDir)

    await copyRuntimeFile(sources.binary, binaryOutputPath, 0o755)
    for (const libraryPath of sources.libs) {
      await copyRuntimeFile(
        libraryPath,
        join(libraryOutputDir, path.basename(libraryPath)),
      )
    }

    const runtimeLibraries = {
      whisper: join(libraryOutputDir, 'libwhisper.1.dylib'),
      ggml: join(libraryOutputDir, 'libggml.0.dylib'),
      ggmlBase: join(libraryOutputDir, 'libggml-base.0.dylib'),
      ggmlCpu: join(libraryOutputDir, 'libggml-cpu.0.dylib'),
      ggmlBlas: join(libraryOutputDir, 'libggml-blas.0.dylib'),
      ggmlMetal: join(libraryOutputDir, 'libggml-metal.0.dylib'),
    }

    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libwhisper.1.dylib', '@executable_path/../lib/libwhisper.1.dylib')
    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libggml.0.dylib', '@executable_path/../lib/libggml.0.dylib')
    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libggml-base.0.dylib', '@executable_path/../lib/libggml-base.0.dylib')
    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libggml-cpu.0.dylib', '@executable_path/../lib/libggml-cpu.0.dylib')
    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libggml-blas.0.dylib', '@executable_path/../lib/libggml-blas.0.dylib')
    await this.rewriteBinaryDependency(binaryOutputPath, '@rpath/libggml-metal.0.dylib', '@executable_path/../lib/libggml-metal.0.dylib')

    for (const libraryPath of Object.values(runtimeLibraries)) {
      const baseName = path.basename(libraryPath)
      await runCommand('/usr/bin/install_name_tool', ['-id', `@loader_path/${baseName}`, libraryPath])
    }

    await this.rewriteBinaryDependency(runtimeLibraries.whisper, '@rpath/libggml.0.dylib', '@loader_path/libggml.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.whisper, '@rpath/libggml-base.0.dylib', '@loader_path/libggml-base.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.whisper, '@rpath/libggml-cpu.0.dylib', '@loader_path/libggml-cpu.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.whisper, '@rpath/libggml-blas.0.dylib', '@loader_path/libggml-blas.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.whisper, '@rpath/libggml-metal.0.dylib', '@loader_path/libggml-metal.0.dylib')

    await this.rewriteBinaryDependency(runtimeLibraries.ggml, '@rpath/libggml-base.0.dylib', '@loader_path/libggml-base.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.ggml, '@rpath/libggml-cpu.0.dylib', '@loader_path/libggml-cpu.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.ggml, '@rpath/libggml-blas.0.dylib', '@loader_path/libggml-blas.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.ggml, '@rpath/libggml-metal.0.dylib', '@loader_path/libggml-metal.0.dylib')

    await this.rewriteBinaryDependency(runtimeLibraries.ggmlCpu, '@rpath/libggml-base.0.dylib', '@loader_path/libggml-base.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.ggmlBlas, '@rpath/libggml-base.0.dylib', '@loader_path/libggml-base.0.dylib')
    await this.rewriteBinaryDependency(runtimeLibraries.ggmlMetal, '@rpath/libggml-base.0.dylib', '@loader_path/libggml-base.0.dylib')

    return {
      binaryRelativePath: path.relative(this.rootDir, binaryOutputPath),
      libraryRelativePath: path.relative(this.rootDir, libraryOutputDir),
    }
  }

  private async rewriteBinaryDependency(
    targetPath: string,
    sourceDependency: string,
    replacementDependency: string,
  ): Promise<void> {
    await runCommand('/usr/bin/install_name_tool', [
      '-change',
      sourceDependency,
      replacementDependency,
      targetPath,
    ])
  }

  private async findExtractedWhisperCppSourceDir(rootDir: string): Promise<string> {
    const directMatch =
      existsSync(join(rootDir, 'CMakeLists.txt'))
      && existsSync(join(rootDir, 'examples', 'server', 'server.cpp'))

    if (directMatch) {
      return rootDir
    }

    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const candidateDir = join(rootDir, entry.name)
      if (
        existsSync(join(candidateDir, 'CMakeLists.txt'))
        && existsSync(join(candidateDir, 'examples', 'server', 'server.cpp'))
      ) {
        return candidateDir
      }
    }

    throw new Error('Downloaded whisper.cpp source archive did not contain the expected project files.')
  }

  private async findInstalledBinary(rootDir: string): Promise<string | null> {
    const candidatePaths = [
      join(rootDir, 'bin', 'whisper-server'),
      join(rootDir, 'whisper-server'),
    ]

    for (const candidatePath of candidatePaths) {
      if (await pathExists(candidatePath)) {
        return candidatePath
      }
    }

    return null
  }

  private async installPinnedModels(): Promise<{
    speechModelRelativePath: string
    vadModelRelativePath: string
    networkDownloadBytes: number | null
  }> {
    await ensureDir(this.modelDir)
    const speechModelPath = join(this.modelDir, DEFAULT_MODEL_FILENAME)
    await downloadToFile(DEFAULT_MODEL_URL, speechModelPath)

    const speechModelSha = await hashFile(speechModelPath, 'sha1')
    if (speechModelSha !== DEFAULT_MODEL_SHA1) {
      throw new Error('Speech model checksum verification failed.')
    }

    const vadModelPath = join(this.modelDir, DEFAULT_VAD_MODEL_FILENAME)
    await downloadToFile(DEFAULT_VAD_MODEL_URL, vadModelPath)

    const vadModelSha = await hashFile(vadModelPath, 'sha256')
    if (vadModelSha !== DEFAULT_VAD_MODEL_SHA256) {
      throw new Error('Speech VAD model checksum verification failed.')
    }

    const speechModelStats = await fs.stat(speechModelPath)
    const vadModelStats = await fs.stat(vadModelPath)
    return {
      speechModelRelativePath: path.relative(this.rootDir, speechModelPath),
      vadModelRelativePath: path.relative(this.rootDir, vadModelPath),
      networkDownloadBytes: speechModelStats.size + vadModelStats.size,
    }
  }

  private async probeRuntime(config: SpeechRuntimeLaunchConfig): Promise<void> {
    const probe = new WhisperCppServer(config)
    try {
      await probe.start()
    } finally {
      await probe.shutdown()
    }
  }

  private async readMetadata(): Promise<SpeechRuntimeRecord | null> {
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<SpeechRuntimeRecord>
      if (
        parsed.version !== 3
        || typeof parsed.binaryRelativePath !== 'string'
        || typeof parsed.modelRelativePath !== 'string'
        || typeof parsed.vadModelRelativePath !== 'string'
        || typeof parsed.runtimeVersion !== 'string'
      ) {
        return null
      }

      return {
        version: 3,
        installSource:
          parsed.installSource === 'managed-download'
            ? 'managed-download'
            : parsed.installSource === 'community-bootstrap'
              ? 'community-bootstrap'
              : 'dev-bootstrap',
        runtimeVersion: parsed.runtimeVersion,
        provider: SPEECH_PROVIDER_ID,
        model: SPEECH_MODEL_ID,
        binaryRelativePath: parsed.binaryRelativePath,
        modelRelativePath: parsed.modelRelativePath,
        vadModelRelativePath: parsed.vadModelRelativePath,
        libraryRelativePath:
          typeof parsed.libraryRelativePath === 'string'
            ? parsed.libraryRelativePath
            : null,
        networkDownloadBytes:
          typeof parsed.networkDownloadBytes === 'number'
            ? parsed.networkDownloadBytes
            : null,
        diskUsageBytes:
          typeof parsed.diskUsageBytes === 'number'
            ? parsed.diskUsageBytes
            : null,
        manifestUrl:
          typeof parsed.manifestUrl === 'string'
            ? parsed.manifestUrl
            : null,
        installedAt:
          typeof parsed.installedAt === 'string'
            ? parsed.installedAt
            : new Date(0).toISOString(),
        lastError:
          typeof parsed.lastError === 'string'
            ? parsed.lastError
            : null,
      }
    } catch {
      return null
    }
  }

  private async writeMetadata(metadata: SpeechRuntimeRecord): Promise<void> {
    await ensureDir(path.dirname(this.metadataPath))
    await fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
  }

  private async resolveLaunchConfig(
    metadata: SpeechRuntimeRecord,
  ): Promise<SpeechRuntimeLaunchConfig | null> {
    const binaryPath = join(this.rootDir, metadata.binaryRelativePath)
    const modelPath = join(this.rootDir, metadata.modelRelativePath)
    const vadModelPath = join(this.rootDir, metadata.vadModelRelativePath)
    const libraryDir = metadata.libraryRelativePath
      ? join(this.rootDir, metadata.libraryRelativePath)
      : null

    if (!(await pathExists(binaryPath)) || !(await pathExists(modelPath)) || !(await pathExists(vadModelPath))) {
      return null
    }

    if (libraryDir && !(await pathExists(libraryDir))) {
      return null
    }

    return {
      binaryPath,
      modelPath,
      vadModelPath,
      libraryDir,
      runtimeVersion: metadata.runtimeVersion,
    }
  }

  private describeBusyState(operation: SpeechInstallState): string {
    if (operation === 'installing') {
      return 'Installing Managed whisper.cpp into app-managed storage…'
    }
    if (operation === 'repairing') {
      return 'Repairing Managed whisper.cpp…'
    }
    if (operation === 'removing') {
      return 'Removing Managed whisper.cpp from local app storage…'
    }
    return 'Speech runtime is busy.'
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
