// Renderer-side audio plumbing for Gemini Live voice mode: microphone capture
// downsampled to 16kHz PCM16 chunks, and sequential playback of the 24kHz
// PCM16 audio the live API streams back.

export const VOICE_LIVE_INPUT_SAMPLE_RATE = 16_000
export const VOICE_LIVE_OUTPUT_SAMPLE_RATE = 24_000
export const VOICE_LIVE_INPUT_MIME_TYPE = `audio/pcm;rate=${VOICE_LIVE_INPUT_SAMPLE_RATE}`

const PCM_RECORDER_WORKLET_NAME = 'gemma-voice-pcm-recorder'

// AudioWorklet source, registered via a Blob URL so no bundler asset wiring is
// needed. Downsampling advances a fractional read cursor so non-integer ratios
// such as 44.1kHz→16kHz (2.75625) stay rate-accurate, and emits ~100ms PCM16
// chunks (1600 samples at 16kHz) per message.
const PCM_RECORDER_WORKLET_SOURCE = `
class GemmaVoicePcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this._chunkSamples = 1600
    this._targetRate = ${VOICE_LIVE_INPUT_SAMPLE_RATE}
    this._ratio = sampleRate / this._targetRate
    this._inAccum = []
    this._readPos = 0
    this._out = []
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) this._inAccum.push(channel[i])

    while (this._inAccum.length - this._readPos >= this._ratio) {
      const start = Math.floor(this._readPos)
      const end = Math.floor(this._readPos + this._ratio)
      let sum = 0
      let count = 0
      for (let j = start; j < end && j < this._inAccum.length; j++) {
        sum += this._inAccum[j]
        count++
      }
      this._out.push(count ? sum / count : 0)
      this._readPos += this._ratio
    }

    const consumed = Math.floor(this._readPos)
    if (consumed > 0) {
      this._inAccum.splice(0, consumed)
      this._readPos -= consumed
    }

    while (this._out.length >= this._chunkSamples) {
      const chunk = this._out.splice(0, this._chunkSamples)
      const pcm = new Int16Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('${PCM_RECORDER_WORKLET_NAME}', GemmaVoicePcmRecorder)
`

export function encodeArrayBufferBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0)
  }
  return btoa(binary)
}

export function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export interface VoiceLiveMicrophone {
  start: (onChunk: (base64Pcm: string) => void) => Promise<void>
  stop: () => Promise<void>
}

export function createVoiceLiveMicrophone(): VoiceLiveMicrophone {
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  let workletUrl: string | null = null

  return {
    async start(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      // Prefer a 16kHz context so the worklet ratio is 1:1; fall back to the
      // device default when the platform refuses the explicit rate.
      try {
        context = new AudioContext({ sampleRate: VOICE_LIVE_INPUT_SAMPLE_RATE })
      } catch {
        context = new AudioContext()
      }

      workletUrl = URL.createObjectURL(
        new Blob([PCM_RECORDER_WORKLET_SOURCE], { type: 'text/javascript' }),
      )
      await context.audioWorklet.addModule(workletUrl)

      source = context.createMediaStreamSource(stream)
      worklet = new AudioWorkletNode(context, PCM_RECORDER_WORKLET_NAME)
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        onChunk(encodeArrayBufferBase64(event.data))
      }
      // Intentionally not connected to the destination: the user should not
      // hear their own microphone.
      source.connect(worklet)
    },

    async stop() {
      try {
        worklet?.port.close()
        worklet?.disconnect()
      } catch {
        // already torn down
      }
      try {
        source?.disconnect()
      } catch {
        // already torn down
      }
      for (const track of stream?.getTracks() ?? []) {
        track.stop()
      }
      if (workletUrl) {
        URL.revokeObjectURL(workletUrl)
      }
      try {
        await context?.close()
      } catch {
        // already closed
      }
      stream = null
      context = null
      source = null
      worklet = null
      workletUrl = null
    },
  }
}

export interface VoiceLivePlayback {
  enqueue: (base64Pcm: string, mimeType: string) => void
  interrupt: () => void
  close: () => Promise<void>
}

export function createVoiceLivePlayback(
  onPlayingChange?: (playing: boolean) => void,
): VoiceLivePlayback {
  let context: AudioContext | null = null
  let queue: AudioBuffer[] = []
  let current: AudioBufferSourceNode | null = null
  let playing = false
  let closed = false

  const setPlaying = (next: boolean) => {
    if (playing === next) return
    playing = next
    onPlayingChange?.(next)
  }

  const flush = () => {
    if (closed || current || !context) return
    const next = queue.shift()
    if (!next) {
      setPlaying(false)
      return
    }
    setPlaying(true)
    const source = context.createBufferSource()
    source.buffer = next
    source.connect(context.destination)
    current = source
    source.onended = () => {
      if (current === source) current = null
      flush()
    }
    source.start()
  }

  return {
    enqueue(base64Pcm, mimeType) {
      if (closed) return
      if (!context) {
        context = new AudioContext({ sampleRate: VOICE_LIVE_OUTPUT_SAMPLE_RATE })
      }
      const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? VOICE_LIVE_OUTPUT_SAMPLE_RATE)
      const bytes = decodeBase64Bytes(base64Pcm)
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
      if (pcm.length === 0) return
      const floats = new Float32Array(pcm.length)
      for (let index = 0; index < pcm.length; index += 1) {
        floats[index] = (pcm[index] ?? 0) / 0x8000
      }
      const buffer = context.createBuffer(1, floats.length, rate)
      buffer.getChannelData(0).set(floats)
      queue.push(buffer)
      flush()
    },

    interrupt() {
      queue = []
      const source = current
      current = null
      if (source) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // already stopped
        }
      }
      setPlaying(false)
    },

    async close() {
      closed = true
      this.interrupt()
      try {
        await context?.close()
      } catch {
        // already closed
      }
      context = null
    },
  }
}
