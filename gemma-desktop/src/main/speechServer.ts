import { spawn, type ChildProcessByStdio } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { shouldFilterLikelySpeechHallucination, type SpeechSignalMetrics } from '../shared/speech'
import type { SpeechRuntimeLaunchConfig } from './speechRuntime'

const DEFAULT_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 60_000
const HEALTHCHECK_INTERVAL_MS = 250
const MIN_TRANSCRIBE_TIMEOUT_MS = 45_000
const NO_SPEECH_THRESHOLD = '0.85'

type SpeechServerChild = ChildProcessByStdio<null, Readable, Readable>

interface WhisperVerboseJsonWord {
  probability?: number
}

interface WhisperVerboseJsonSegment {
  text?: string
  avg_logprob?: number
  no_speech_prob?: number
  words?: WhisperVerboseJsonWord[]
}

interface WhisperVerboseJsonResponse {
  text?: string
  segments?: WhisperVerboseJsonSegment[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function reserveTcpPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve a speech server port.')))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })
}

function buildSpeechServerEnvironment(
  config: SpeechRuntimeLaunchConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  }

  if (config.libraryDir) {
    env['DYLD_LIBRARY_PATH'] = [
      config.libraryDir,
      process.env['DYLD_LIBRARY_PATH'],
    ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(':')
  }

  return env
}

function buildSpeechServerArgs(
  config: SpeechRuntimeLaunchConfig,
  port: number,
): string[] {
  return [
    '--host',
    DEFAULT_HOST,
    '--port',
    String(port),
    '-m',
    config.modelPath,
    '--vad',
    '-vm',
    config.vadModelPath,
    '-l',
    'auto',
    '-sns',
    '-nth',
    NO_SPEECH_THRESHOLD,
    '-nt',
    '-nlp',
  ]
}

export class WhisperCppServer {
  private child: SpeechServerChild | null = null
  private port: number | null = null
  private startingPromise: Promise<void> | null = null
  private readonly stderrLines: string[] = []
  private readonly stdoutLines: string[] = []

  public constructor(
    private readonly config: SpeechRuntimeLaunchConfig,
  ) {}

  public async start(timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return
    }

    if (!this.startingPromise) {
      this.startingPromise = this.startInternal(timeoutMs).finally(() => {
        this.startingPromise = null
      })
    }

    await this.startingPromise
  }

  public async transcribe(input: {
    audioBase64: string
    mimeType: string
    durationMs: number
    signalMetrics?: SpeechSignalMetrics | null
  }): Promise<string> {
    await this.start()

    const controller = new AbortController()
    const timeoutMs = Math.max(MIN_TRANSCRIBE_TIMEOUT_MS, input.durationMs * 20)
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const response = await fetch(`${this.getBaseUrl()}/inference`, {
        method: 'POST',
        body: this.buildMultipartBody(input),
        signal: controller.signal,
      })
      const body = (await response.text()).trim()

      if (!response.ok) {
        throw new Error(
          body.length > 0
            ? `whisper.cpp transcription failed: ${body}`
            : `whisper.cpp transcription failed: ${response.status} ${response.statusText}`,
        )
      }

      return this.parseTranscriptionResponse(body, input.signalMetrics ?? null)
    } catch (error) {
      await this.shutdown()

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Speech transcription timed out after ${timeoutMs}ms.`)
      }

      if (error instanceof Error) {
        throw error
      }

      throw new Error('whisper.cpp transcription request failed.')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  public async shutdown(): Promise<void> {
    const child = this.child
    this.child = null
    this.port = null

    if (!child || child.killed || child.exitCode !== null) {
      return
    }

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })

    child.kill('SIGTERM')
    await Promise.race([exitPromise, delay(1_000)])

    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL')
      await Promise.race([exitPromise, delay(1_000)])
    }
  }

  private buildMultipartBody(input: {
    audioBase64: string
    mimeType: string
  }): FormData {
    const audioBuffer = Buffer.from(input.audioBase64, 'base64')
    const form = new FormData()
    form.set(
      'file',
      new Blob([audioBuffer], {
        type: input.mimeType || 'audio/wav',
      }),
      'speech.wav',
    )
    form.set('response_format', 'verbose_json')
    form.set('temperature', '0.0')
    form.set('temperature_inc', '0.0')
    form.set('no_timestamps', 'true')
    form.set('language', 'auto')
    form.set('no_language_probabilities', 'true')
    form.set('suppress_non_speech', 'true')
    form.set('vad', 'true')
    return form
  }

  private parseTranscriptionResponse(
    body: string,
    signalMetrics: SpeechSignalMetrics | null,
  ): string {
    if (!body) {
      return ''
    }

    let parsed: WhisperVerboseJsonResponse | null = null
    try {
      parsed = JSON.parse(body) as WhisperVerboseJsonResponse
    } catch {
      return body
    }

    const segments = Array.isArray(parsed.segments) ? parsed.segments : []
    if (segments.length === 0) {
      return typeof parsed.text === 'string' ? parsed.text.trim() : ''
    }

    const keptSegments = segments
      .map((segment) => this.extractSegmentText(segment, signalMetrics))
      .filter((value): value is string => value.length > 0)

    if (keptSegments.length === 0) {
      return ''
    }

    return keptSegments.join(' ').replace(/\s+/g, ' ').trim()
  }

  private extractSegmentText(
    segment: WhisperVerboseJsonSegment,
    signalMetrics: SpeechSignalMetrics | null,
  ): string {
    const text = typeof segment.text === 'string' ? segment.text.trim() : ''
    if (!text) {
      return ''
    }

    const words = Array.isArray(segment.words) ? segment.words : []
    const probabilities = words
      .map((word) => word.probability)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const averageWordProbability = probabilities.length > 0
      ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length
      : 1

    if (shouldFilterLikelySpeechHallucination({
      text,
      avgLogprob:
        typeof segment.avg_logprob === 'number' && Number.isFinite(segment.avg_logprob)
          ? segment.avg_logprob
          : 0,
      noSpeechProb:
        typeof segment.no_speech_prob === 'number' && Number.isFinite(segment.no_speech_prob)
          ? segment.no_speech_prob
          : 0,
      averageWordProbability,
      signalMetrics,
    })) {
      return ''
    }

    return text
  }

  private getBaseUrl(): string {
    if (this.port === null) {
      throw new Error('Speech server is not running.')
    }

    return `http://${DEFAULT_HOST}:${this.port}`
  }

  private async startInternal(timeoutMs: number): Promise<void> {
    const port = await reserveTcpPort()
    let startupError: Error | null = null
    const child = spawn(
      this.config.binaryPath,
      buildSpeechServerArgs(this.config, port),
      {
        cwd: path.dirname(this.config.binaryPath),
        env: buildSpeechServerEnvironment(this.config),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.child = child
    this.port = port
    this.stderrLines.length = 0
    this.stdoutLines.length = 0

    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })
    stdout.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return
      }

      this.stdoutLines.push(trimmed)
      while (this.stdoutLines.length > 20) {
        this.stdoutLines.shift()
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (!text) {
        return
      }

      this.stderrLines.push(...text.split('\n').map((line) => line.trim()).filter(Boolean))
      while (this.stderrLines.length > 20) {
        this.stderrLines.shift()
      }
    })

    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.port = null
      }
    })

    child.on('error', (error) => {
      startupError = error instanceof Error
        ? error
        : new Error('Managed whisper.cpp failed to launch.')
    })

    try {
      await this.waitForHealth(timeoutMs, child, () => startupError)
    } catch (error) {
      await this.shutdown()
      throw error
    }
  }

  private async waitForHealth(
    timeoutMs: number,
    child: SpeechServerChild,
    getStartupError: () => Error | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const healthUrl = `${this.getBaseUrl()}/health`

    while (Date.now() < deadline) {
      const startupError = getStartupError()
      if (startupError) {
        throw startupError
      }

      if (this.child !== child || child.killed || child.exitCode !== null) {
        throw new Error(this.formatProcessFailure('Managed whisper.cpp exited during startup.'))
      }

      try {
        const response = await fetch(healthUrl)
        if (response.ok) {
          return
        }
      } catch {
        // Keep polling while the model loads.
      }

      await delay(HEALTHCHECK_INTERVAL_MS)
    }

    throw new Error(
      this.formatProcessFailure(`Managed whisper.cpp did not become ready within ${timeoutMs}ms.`),
    )
  }

  private formatProcessFailure(fallback: string): string {
    const detail = this.stderrLines.at(-1) ?? this.stdoutLines.at(-1)
    return detail ? `${fallback} ${detail}` : fallback
  }
}
