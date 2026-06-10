import { describe, expect, it, vi } from 'vitest'
import type { LiveServerMessage } from '@google/genai'
import {
  VoiceLiveSession,
  type VoiceLiveSessionEvent,
  type VoiceLiveSessionOptions,
  type VoiceLiveTransport,
  type VoiceLiveTransportCallbacks,
} from '../../src/renderer/src/lib/voiceLiveSession'
import type {
  VoiceLiveMicrophone,
  VoiceLivePlayback,
} from '../../src/renderer/src/lib/voiceLiveAudio'

interface Harness {
  session: VoiceLiveSession
  events: VoiceLiveSessionEvent[]
  transport: {
    sendRealtimeInput: ReturnType<typeof vi.fn>
    sendClientContent: ReturnType<typeof vi.fn>
    sendToolResponse: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  callbacks: () => VoiceLiveTransportCallbacks
  // Server messages are plain JSON over the wire; the SDK type is a class
  // with extra getters, so the harness owns the cast.
  emitMessage: (message: Record<string, unknown>) => void
  mic: {
    started: boolean
    stopped: boolean
    emitChunk: (base64: string) => void
  }
  playback: {
    enqueued: Array<{ data: string; mimeType: string }>
    interrupts: number
    closed: boolean
    setPlaying: (playing: boolean) => void
  }
}

function createHarness(overrides?: {
  onToolCall?: VoiceLiveSessionOptions['onToolCall']
  failMicrophone?: boolean
}): Harness {
  const events: VoiceLiveSessionEvent[] = []
  let callbacks: VoiceLiveTransportCallbacks | null = null
  let micChunkHandler: ((base64: string) => void) | null = null
  let playingChange: ((playing: boolean) => void) | null = null

  const transport = {
    sendRealtimeInput: vi.fn(),
    sendClientContent: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  }

  const mic = {
    started: false,
    stopped: false,
    emitChunk: (base64: string) => micChunkHandler?.(base64),
  }

  const playback = {
    enqueued: [] as Array<{ data: string; mimeType: string }>,
    interrupts: 0,
    closed: false,
    setPlaying: (playing: boolean) => playingChange?.(playing),
  }

  const session = new VoiceLiveSession({
    apiKey: 'test-key',
    model: 'test-live-model',
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onEvent: (event) => events.push(event),
    onToolCall: overrides?.onToolCall ?? (() => ({ ok: true })),
    connect: async (options) => {
      callbacks = options.callbacks
      return transport as VoiceLiveTransport
    },
    createMicrophone: (): VoiceLiveMicrophone => ({
      start: async (onChunk) => {
        if (overrides?.failMicrophone) {
          throw new Error('NotAllowedError: Permission dismissed')
        }
        mic.started = true
        micChunkHandler = onChunk
      },
      stop: async () => {
        mic.stopped = true
      },
    }),
    createPlayback: (onPlayingChange): VoiceLivePlayback => {
      playingChange = onPlayingChange
      return {
        enqueue: (data, mimeType) => playback.enqueued.push({ data, mimeType }),
        interrupt: () => {
          playback.interrupts += 1
        },
        close: async () => {
          playback.closed = true
        },
      }
    },
  })

  return {
    session,
    events,
    transport,
    callbacks: () => {
      if (!callbacks) throw new Error('transport callbacks not captured')
      return callbacks
    },
    emitMessage: (message) => {
      if (!callbacks) throw new Error('transport callbacks not captured')
      callbacks.onmessage(message as unknown as LiveServerMessage)
    },
    mic,
    playback,
  }
}

describe('VoiceLiveSession lifecycle', () => {
  it('connects, starts the microphone, and emits open', async () => {
    const harness = createHarness()
    await harness.session.start()

    expect(harness.mic.started).toBe(true)
    expect(harness.events).toContainEqual({ type: 'open' })
  })

  it('forwards microphone chunks as 16kHz PCM realtime input', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.mic.emitChunk('AAAA')
    expect(harness.transport.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
    })
  })

  it('rejects start and cleans up when the microphone fails', async () => {
    const harness = createHarness({ failMicrophone: true })

    await expect(harness.session.start()).rejects.toThrow('NotAllowedError')
    expect(harness.transport.close).toHaveBeenCalled()
    expect(harness.events).not.toContainEqual({ type: 'open' })
    expect(harness.events).toContainEqual({ type: 'close', reason: undefined })
  })

  it('stops everything exactly once and emits a single close', async () => {
    const harness = createHarness()
    await harness.session.start()

    await harness.session.stop()
    await harness.session.stop()

    expect(harness.transport.close).toHaveBeenCalledTimes(1)
    expect(harness.mic.stopped).toBe(true)
    expect(harness.playback.closed).toBe(true)
    expect(harness.events.filter((event) => event.type === 'close')).toHaveLength(1)
  })

  it('surfaces transport errors and close reasons when not stopping', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.callbacks().onerror?.({ message: 'socket exploded' })
    harness.callbacks().onclose?.({ reason: 'server going away' })

    expect(harness.events).toContainEqual({ type: 'error', message: 'socket exploded' })
    expect(harness.events).toContainEqual({ type: 'close', reason: 'server going away' })
  })
})

describe('VoiceLiveSession message handling', () => {
  it('queues model audio parts into playback and reports speaking state', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: 'BBBB', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
    })

    expect(harness.playback.enqueued).toEqual([
      { data: 'BBBB', mimeType: 'audio/pcm;rate=24000' },
    ])

    harness.playback.setPlaying(true)
    harness.playback.setPlaying(false)
    expect(harness.events).toContainEqual({ type: 'speaking', speaking: true })
    expect(harness.events).toContainEqual({ type: 'speaking', speaking: false })
  })

  it('interrupts playback when the user barges in', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.emitMessage({
      serverContent: { interrupted: true },
    })

    expect(harness.playback.interrupts).toBe(1)
  })

  it('accumulates transcripts and finalizes them on turn completion', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.emitMessage({
      serverContent: { inputTranscription: { text: 'build me ' } },
    })
    harness.emitMessage({
      serverContent: { inputTranscription: { text: 'an app' } },
    })
    harness.emitMessage({
      serverContent: { outputTranscription: { text: 'On it.' } },
    })
    harness.emitMessage({
      serverContent: { turnComplete: true },
    })

    expect(harness.events).toContainEqual({
      type: 'inputTranscript',
      text: 'build me an app',
      final: true,
    })
    expect(harness.events).toContainEqual({
      type: 'outputTranscript',
      text: 'On it.',
      final: true,
    })
    expect(harness.events).toContainEqual({ type: 'turnComplete' })

    // The next turn starts from an empty transcript.
    harness.emitMessage({
      serverContent: { inputTranscription: { text: 'thanks' } },
    })
    expect(harness.events).toContainEqual({
      type: 'inputTranscript',
      text: 'thanks',
      final: false,
    })
  })

  it('dispatches tool calls and sends the handler result back', async () => {
    const onToolCall = vi.fn(() => ({ ok: true, status: 'sent' }))
    const harness = createHarness({ onToolCall })
    await harness.session.start()

    harness.emitMessage({
      toolCall: {
        functionCalls: [
          { id: 'call-1', name: 'send_chat_message', args: { prompt: 'do the thing' } },
        ],
      },
    })

    expect(onToolCall).toHaveBeenCalledWith({
      name: 'send_chat_message',
      args: { prompt: 'do the thing' },
    })
    expect(harness.transport.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: 'call-1',
          name: 'send_chat_message',
          response: { ok: true, status: 'sent' },
        },
      ],
    })
    expect(harness.events).toContainEqual({
      type: 'toolCall',
      name: 'send_chat_message',
      args: { prompt: 'do the thing' },
    })
  })

  it('sends app updates as complete client-content turns', async () => {
    const harness = createHarness()
    await harness.session.start()

    harness.session.sendSystemUpdate('[chat_response] done')

    expect(harness.transport.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: '[chat_response] done' }] }],
      turnComplete: true,
    })
  })

  it('ignores messages and updates after stop', async () => {
    const harness = createHarness()
    await harness.session.start()
    await harness.session.stop()

    harness.emitMessage({
      serverContent: { inputTranscription: { text: 'late' } },
    })
    harness.session.sendSystemUpdate('late update')

    expect(harness.transport.sendClientContent).not.toHaveBeenCalled()
    expect(
      harness.events.filter((event) => event.type === 'inputTranscript'),
    ).toHaveLength(0)
  })
})
