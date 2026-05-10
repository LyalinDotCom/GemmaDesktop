import { randomUUID } from 'node:crypto'
import type {
  SpeechChunkInput,
  SpeechEvent,
  SpeechSessionState,
  SpeechSessionStartInput,
  SpeechSessionStartResult,
} from '../shared/speech'
import { mergeSpeechTranscriptChunks } from '../shared/speech'
import type { SpeechRuntimeManager } from './speechRuntime'
import { WhisperCppServer } from './speechServer'

interface SpeechEventSink {
  emit(sessionId: string, event: SpeechEvent): void
}

interface SessionState {
  id: string
  transcript: string
  queue: SpeechChunkInput[]
  activeSequence: number | null
  processing: boolean
  stopping: boolean
  cancelled: boolean
}

interface SpeechTranscriber {
  transcribe(input: {
    audioBase64: string
    mimeType: string
    durationMs: number
    signalMetrics?: SpeechChunkInput['signalMetrics']
  }): Promise<string>
  shutdown(): Promise<void>
}

class ManagedWhisperCppTranscriber implements SpeechTranscriber {
  private server: WhisperCppServer | null = null
  private currentConfigKey: string | null = null

  public constructor(
    private readonly runtimeManager: SpeechRuntimeManager,
  ) {}

  public async transcribe(input: {
    audioBase64: string
    mimeType: string
    durationMs: number
    signalMetrics?: SpeechChunkInput['signalMetrics']
  }): Promise<string> {
    const config = await this.runtimeManager.getLaunchConfig()
    const configKey = [
      config.runtimeVersion,
      config.binaryPath,
      config.modelPath,
      config.libraryDir ?? '',
    ].join(':')

    if (this.currentConfigKey && this.currentConfigKey !== configKey) {
      await this.shutdown()
    }

    if (!this.server) {
      this.server = new WhisperCppServer(config)
    }

    this.currentConfigKey = configKey
    return await this.server.transcribe(input)
  }

  public async shutdown(): Promise<void> {
    this.currentConfigKey = null
    if (!this.server) {
      return
    }

    const server = this.server
    this.server = null
    await server.shutdown()
  }
}

export class SpeechService {
  private readonly sessions = new Map<string, SessionState>()
  private readonly worker: SpeechTranscriber

  public constructor(
    private readonly runtimeManager: SpeechRuntimeManager,
    private readonly sink: SpeechEventSink,
  ) {
    this.worker = new ManagedWhisperCppTranscriber(runtimeManager)
  }

  public async startSession(
    input: SpeechSessionStartInput,
  ): Promise<SpeechSessionStartResult> {
    await this.runtimeManager.getLaunchConfig()

    const sessionId = input.sessionId || randomUUID()
    this.sessions.set(sessionId, {
      id: sessionId,
      transcript: '',
      queue: [],
      activeSequence: null,
      processing: false,
      stopping: false,
      cancelled: false,
    })
    this.sink.emit(sessionId, {
      type: 'state',
      sessionId,
      state: 'idle',
      queueDepth: 0,
      activeSequence: null,
    })

    return { sessionId }
  }

  public async enqueueChunk(input: SpeechChunkInput): Promise<{ ok: true }> {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.cancelled) {
      throw new Error('Speech session not found.')
    }

    session.queue.push(input)
    this.sink.emit(input.sessionId, {
      type: 'chunk',
      sessionId: input.sessionId,
      sequence: input.sequence,
      status: 'queued',
      final: input.final,
    })
    this.emitState(session, session.processing ? 'processing' : 'idle')
    void this.processQueue(session)
    return { ok: true }
  }

  public async stopSession(sessionId: string): Promise<{ ok: true }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { ok: true }
    }

    session.cancelled = true
    session.stopping = false
    session.queue.length = 0
    session.activeSequence = null
    this.sessions.delete(sessionId)
    this.emitState(session, 'stopped')

    return { ok: true }
  }

  public async finishSession(sessionId: string): Promise<{ ok: true }> {
    const session = this.sessions.get(sessionId)
    if (!session || session.cancelled) {
      return { ok: true }
    }

    session.stopping = true

    if (!session.processing && session.queue.length === 0) {
      this.emitState(session, 'stopped')
      this.sessions.delete(sessionId)
      return { ok: true }
    }

    this.emitState(session, 'stopping')
    return { ok: true }
  }

  private emitState(session: SessionState, state: SpeechSessionState): void {
    this.sink.emit(session.id, {
      type: 'state',
      sessionId: session.id,
      state,
      queueDepth: session.queue.length,
      activeSequence: session.activeSequence,
    })
  }

  private async processQueue(session: SessionState): Promise<void> {
    if (session.processing) {
      return
    }

    session.processing = true

    while (session.queue.length > 0) {
      if (session.cancelled) {
        break
      }

      const job = session.queue.shift()
      if (!job) {
        continue
      }

      session.activeSequence = job.sequence
      this.sink.emit(session.id, {
        type: 'chunk',
        sessionId: session.id,
        sequence: job.sequence,
        status: 'processing',
        final: job.final,
      })
      this.emitState(session, session.stopping ? 'stopping' : 'processing')

      try {
        const text = await this.worker.transcribe({
          audioBase64: job.audioBase64,
          mimeType: job.mimeType,
          durationMs: job.durationMs,
          signalMetrics: job.signalMetrics,
        })
        if (session.cancelled) {
          break
        }
        const merged = mergeSpeechTranscriptChunks(session.transcript, text)
        session.transcript = merged.transcript

        this.sink.emit(session.id, {
          type: 'transcript',
          sessionId: session.id,
          sequence: job.sequence,
          final: job.final,
          transcript: session.transcript,
          appendedText: merged.appendedText,
        })
        this.sink.emit(session.id, {
          type: 'chunk',
          sessionId: session.id,
          sequence: job.sequence,
          status: 'completed',
          final: job.final,
        })
      } catch (error) {
        if (session.cancelled) {
          break
        }
        const message = error instanceof Error
          ? error.message
          : 'Unable to transcribe the current audio chunk.'
        this.sink.emit(session.id, {
          type: 'chunk',
          sessionId: session.id,
          sequence: job.sequence,
          status: 'error',
          final: job.final,
          errorMessage: message,
        })
        this.sink.emit(session.id, {
          type: 'error',
          sessionId: session.id,
          stage: 'transcription',
          message,
          sequence: job.sequence,
        })
      } finally {
        session.activeSequence = null
      }
    }

    session.processing = false
    if (session.cancelled) {
      return
    }

    const finalState = session.stopping ? 'stopped' : 'idle'
    this.emitState(session, finalState)

    if (session.stopping) {
      this.sessions.delete(session.id)
    }
  }
}
