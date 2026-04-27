import { describe, expect, it, vi } from 'vitest'
import { SpeechService } from '../src/main/speechService'
import type { SpeechChunkInput, SpeechEvent } from '../src/shared/speech'

function createChunk(sequence: number): SpeechChunkInput {
  return {
    sessionId: 'speech-session',
    sequence,
    audioBase64: 'UklGRg==',
    mimeType: 'audio/wav',
    durationMs: 1_000,
    final: false,
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('SpeechService', () => {
  it('drops queued and in-flight transcription work after stopSession', async () => {
    const events: SpeechEvent[] = []
    const sink = {
      emit: (_sessionId: string, event: SpeechEvent) => {
        events.push(event)
      },
    }

    const service = new SpeechService(
      {
        getLaunchConfig: vi.fn(async () => ({
          binaryPath: '/tmp/whisper-server',
          modelPath: '/tmp/ggml-large-v3-turbo-q5_0.bin',
          vadModelPath: '/tmp/ggml-silero-v6.2.0.bin',
          libraryDir: null,
          runtimeVersion: 'test-runtime',
        })),
      } as never,
      sink,
    )

    let resolveTranscribe: ((text: string) => void) | null = null
    const transcribe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscribe = resolve
        }),
    )

    Reflect.set(service as object, 'worker', {
      transcribe,
      shutdown: vi.fn(async () => {}),
    })

    await service.startSession({
      sessionId: 'speech-session',
      baseText: '',
      selectionStart: 0,
      selectionEnd: 0,
    })

    await service.enqueueChunk(createChunk(1))
    await tick()
    await service.enqueueChunk(createChunk(2))

    await service.stopSession('speech-session')
    expect(resolveTranscribe).not.toBeNull()
    const completeTranscription: (text: string) => void =
      resolveTranscribe
      ?? ((_: string) => {
        throw new Error('Transcription resolver was not initialized.')
      })
    completeTranscription('hello world')
    await tick()
    await tick()

    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(
      events.some(
        (event) =>
          event.type === 'transcript'
          || (event.type === 'chunk'
            && event.sequence === 1
            && (event.status === 'completed' || event.status === 'error')),
      ),
    ).toBe(false)
    expect(
      events.some(
        (event) =>
          event.type === 'chunk'
          && event.sequence === 2
          && event.status === 'processing',
      ),
    ).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      sessionId: 'speech-session',
      state: 'stopped',
      queueDepth: 0,
      activeSequence: null,
    })
  })

  it('finishes queued transcription work after finishSession', async () => {
    const events: SpeechEvent[] = []
    const sink = {
      emit: (_sessionId: string, event: SpeechEvent) => {
        events.push(event)
      },
    }

    const service = new SpeechService(
      {
        getLaunchConfig: vi.fn(async () => ({
          binaryPath: '/tmp/whisper-server',
          modelPath: '/tmp/ggml-large-v3-turbo-q5_0.bin',
          vadModelPath: '/tmp/ggml-silero-v6.2.0.bin',
          libraryDir: null,
          runtimeVersion: 'test-runtime',
        })),
      } as never,
      sink,
    )

    let resolveTranscribe: ((text: string) => void) | null = null
    Reflect.set(service as object, 'worker', {
      transcribe: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveTranscribe = resolve
          }),
      ),
      shutdown: vi.fn(async () => {}),
    })

    await service.startSession({
      sessionId: 'speech-session',
      baseText: '',
      selectionStart: 0,
      selectionEnd: 0,
    })

    await service.enqueueChunk(createChunk(1))
    await tick()
    await service.finishSession('speech-session')

    expect(resolveTranscribe).not.toBeNull()
    const completeTranscription: (text: string) => void =
      resolveTranscribe
      ?? ((_: string) => {
        throw new Error('Transcription resolver was not initialized.')
      })
    completeTranscription('hello world')
    await tick()
    await tick()

    expect(
      events.some(
        (event) =>
          event.type === 'transcript'
          && event.sessionId === 'speech-session'
          && event.transcript === 'hello world',
      ),
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      sessionId: 'speech-session',
      state: 'stopped',
      queueDepth: 0,
      activeSequence: null,
    })
  })
})
