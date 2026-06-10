import {
  GoogleGenAI,
  Modality,
  type FunctionDeclaration,
  type LiveServerMessage,
} from '@google/genai'
import {
  VOICE_LIVE_INPUT_MIME_TYPE,
  createVoiceLiveMicrophone,
  createVoiceLivePlayback,
  type VoiceLiveMicrophone,
  type VoiceLivePlayback,
} from '@/lib/voiceLiveAudio'

export type VoiceLiveSessionEvent =
  | { type: 'open' }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'inputTranscript'; text: string; final: boolean }
  | { type: 'outputTranscript'; text: string; final: boolean }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> }
  | { type: 'turnComplete' }
  | { type: 'error'; message: string }
  | { type: 'close'; reason?: string }

export interface VoiceLiveToolCall {
  name: string
  args: Record<string, unknown>
}

// Narrow structural view of the @google/genai live Session methods we use, so
// tests can inject a fake transport.
export interface VoiceLiveTransport {
  sendRealtimeInput: (params: {
    audio: { data: string; mimeType: string }
  }) => void
  sendClientContent: (params: {
    turns: Array<{ role: string; parts: Array<{ text: string }> }>
    turnComplete: boolean
  }) => void
  sendToolResponse: (params: {
    functionResponses: Array<{
      id?: string
      name: string
      response: Record<string, unknown>
    }>
  }) => void
  close: () => void
}

export interface VoiceLiveTransportCallbacks {
  onopen?: () => void
  onmessage: (message: LiveServerMessage) => void
  onerror?: (event: { message?: string }) => void
  onclose?: (event: { reason?: string }) => void
}

export type VoiceLiveConnect = (options: {
  apiKey: string
  model: string
  systemInstruction: string
  functionDeclarations: FunctionDeclaration[]
  callbacks: VoiceLiveTransportCallbacks
}) => Promise<VoiceLiveTransport>

const connectWithGenAi: VoiceLiveConnect = async (options) => {
  const client = new GoogleGenAI({ apiKey: options.apiKey })
  return client.live.connect({
    model: options.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: options.systemInstruction,
      tools: [{ functionDeclarations: options.functionDeclarations }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: options.callbacks,
  })
}

export interface VoiceLiveSessionOptions {
  apiKey: string
  model: string
  systemInstruction: string
  functionDeclarations: FunctionDeclaration[]
  onEvent: (event: VoiceLiveSessionEvent) => void
  // Synchronous tool dispatch: the returned object is sent back as the
  // function response. Keep handlers fast; long work should be acknowledged
  // here and completed later via sendSystemUpdate().
  onToolCall: (call: VoiceLiveToolCall) => Record<string, unknown>
  connect?: VoiceLiveConnect
  createMicrophone?: () => VoiceLiveMicrophone
  createPlayback?: (onPlayingChange: (playing: boolean) => void) => VoiceLivePlayback
}

// One conversation with the Gemini Live API: a WebSocket session plus
// microphone capture and audio playback. Single-use — construct a new
// instance for every voice-mode activation so each start is a clean slate.
export class VoiceLiveSession {
  private readonly options: VoiceLiveSessionOptions
  private transport: VoiceLiveTransport | null = null
  private microphone: VoiceLiveMicrophone | null = null
  private playback: VoiceLivePlayback | null = null
  private partialInput = ''
  private partialOutput = ''
  private stopping = false
  private closeEmitted = false

  constructor(options: VoiceLiveSessionOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    const connect = this.options.connect ?? connectWithGenAi
    this.transport = await connect({
      apiKey: this.options.apiKey,
      model: this.options.model,
      systemInstruction: this.options.systemInstruction,
      functionDeclarations: this.options.functionDeclarations,
      callbacks: {
        onmessage: (message) => this.handleMessage(message),
        onerror: (event) => {
          if (this.stopping) return
          this.options.onEvent({
            type: 'error',
            message: String(event?.message ?? 'Live connection error'),
          })
        },
        onclose: (event) => {
          if (this.stopping) return
          this.emitClose(event?.reason)
        },
      },
    })

    if (this.stopping) {
      // stop() raced the connection setup; tear the socket down again.
      try {
        this.transport.close()
      } catch {
        // already closed
      }
      return
    }

    this.playback = (this.options.createPlayback ?? createVoiceLivePlayback)(
      (playing) => this.options.onEvent({ type: 'speaking', speaking: playing }),
    )

    this.microphone = (this.options.createMicrophone ?? createVoiceLiveMicrophone)()
    try {
      await this.microphone.start((base64Pcm) => {
        if (this.stopping) return
        try {
          this.transport?.sendRealtimeInput({
            audio: { data: base64Pcm, mimeType: VOICE_LIVE_INPUT_MIME_TYPE },
          })
        } catch {
          // The socket can close between chunks; the onclose callback owns
          // surfacing that.
        }
      })
    } catch (error) {
      await this.stop()
      throw error
    }

    this.options.onEvent({ type: 'open' })
  }

  // Inject an app-originated update (for example a finished chat-model turn)
  // into the live conversation so the model can narrate it.
  sendSystemUpdate(text: string): void {
    if (this.stopping || !this.transport) return
    try {
      this.transport.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      })
    } catch (error) {
      this.options.onEvent({
        type: 'error',
        message: String(error instanceof Error ? error.message : error),
      })
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    try {
      this.transport?.close()
    } catch {
      // already closed
    }
    try {
      await this.microphone?.stop()
    } catch {
      // already stopped
    }
    try {
      await this.playback?.close()
    } catch {
      // already closed
    }
    this.transport = null
    this.microphone = null
    this.playback = null
    this.emitClose()
  }

  private emitClose(reason?: string): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.options.onEvent({ type: 'close', reason })
  }

  private handleMessage(message: LiveServerMessage): void {
    if (this.stopping) return

    const serverContent = message.serverContent

    // Barge-in: the user spoke over the model, so drop queued audio at once.
    if (serverContent?.interrupted) {
      this.playback?.interrupt()
    }

    for (const part of serverContent?.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (data) {
        this.playback?.enqueue(data, part.inlineData?.mimeType ?? '')
      }
    }

    if (serverContent?.inputTranscription?.text) {
      this.partialInput += serverContent.inputTranscription.text
      this.options.onEvent({
        type: 'inputTranscript',
        text: this.partialInput,
        final: false,
      })
    }
    if (serverContent?.outputTranscription?.text) {
      this.partialOutput += serverContent.outputTranscription.text
      this.options.onEvent({
        type: 'outputTranscript',
        text: this.partialOutput,
        final: false,
      })
    }

    if (serverContent?.turnComplete) {
      if (this.partialInput) {
        this.options.onEvent({
          type: 'inputTranscript',
          text: this.partialInput,
          final: true,
        })
        this.partialInput = ''
      }
      if (this.partialOutput) {
        this.options.onEvent({
          type: 'outputTranscript',
          text: this.partialOutput,
          final: true,
        })
        this.partialOutput = ''
      }
      this.options.onEvent({ type: 'turnComplete' })
    }

    const functionCalls = message.toolCall?.functionCalls ?? []
    if (functionCalls.length > 0) {
      const functionResponses = functionCalls.map((call) => {
        const name = call.name ?? ''
        const args = (call.args ?? {}) as Record<string, unknown>
        this.options.onEvent({ type: 'toolCall', name, args })
        return {
          id: call.id,
          name,
          response: this.options.onToolCall({ name, args }),
        }
      })
      try {
        this.transport?.sendToolResponse({ functionResponses })
      } catch {
        // Socket closed mid-dispatch; onclose owns surfacing it.
      }
    }
  }
}
