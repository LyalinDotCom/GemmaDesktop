import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/gemma-desktop-read-aloud-tests',
    getAppPath: () => '/tmp/gemma-desktop-read-aloud-tests/app',
    isPackaged: false,
  },
}))

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowRemoteModels: false,
    localModelPath: '',
    cacheDir: '',
  },
  RawAudio: class {
    constructor(
      private readonly audio: Float32Array,
      private readonly sampleRate: number,
    ) {}

    toWav() {
      const byteLength = Math.max(4, this.audio.length * 2)
      const output = new Uint8Array(byteLength)
      output[0] = this.sampleRate & 0xff
      return output
    }
  },
}))

import {
  ReadAloudService,
  buildReadAloudCacheKey,
  pruneReadAloudCache,
  resolveReadAloudAssetRoot,
} from '../src/main/readAloud'
import {
  READ_ALOUD_MODEL_DTYPE,
  READ_ALOUD_MODEL_ID,
  READ_ALOUD_DEFAULT_SPEED,
  READ_ALOUD_DEFAULT_VOICE,
  clampReadAloudSpeed,
  normalizeReadAloudVoice,
} from '../src/shared/readAloud'
import {
  buildReadAloudSelectionPlaybackId,
  extractSpeakableTextFromContent,
  normalizeSelectedReadAloudText,
  stripMarkdownForReadAloud,
} from '../src/renderer/src/lib/readAloudText'
import type { MessageContent } from '../src/renderer/src/types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) =>
      fs.rm(dirPath, { recursive: true, force: true })),
  )
})

async function makeTempDir() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-read-aloud-'))
  tempDirs.push(tempDir)
  return tempDir
}

async function makePreparedAssetRoot(cacheRoot: string) {
  const assetRoot = path.join(cacheRoot, 'Kokoro-82M-v1.0-ONNX')
  await fs.mkdir(path.join(assetRoot, 'onnx'), { recursive: true })
  await fs.writeFile(path.join(assetRoot, 'config.json'), '{}')
  await fs.writeFile(path.join(assetRoot, 'tokenizer.json'), '{}')
  await fs.writeFile(path.join(assetRoot, 'tokenizer_config.json'), '{}')
  await fs.writeFile(path.join(assetRoot, 'onnx', 'model_quantized.onnx'), Buffer.alloc(16))
  return assetRoot
}

function makeTestWavBuffer(durationMs: number, sampleRate = 24_000) {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const channelCount = 1
  const bitsPerSample = 16
  const blockAlign = channelCount * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const dataSize = sampleCount * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channelCount, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  return buffer
}

describe('read aloud shared helpers', () => {
  it('normalizes invalid voices and clamps speed', () => {
    expect(normalizeReadAloudVoice('not-a-voice')).toBe(READ_ALOUD_DEFAULT_VOICE)
    expect(normalizeReadAloudVoice('bf_emma')).toBe('bf_emma')
    expect(clampReadAloudSpeed('fast')).toBe(READ_ALOUD_DEFAULT_SPEED)
    expect(clampReadAloudSpeed(0.2)).toBe(0.7)
    expect(clampReadAloudSpeed(1.8)).toBe(1.3)
    expect(clampReadAloudSpeed(1.05)).toBe(1.05)
  })
})

describe('read aloud text extraction', () => {
  it('strips markdown, links, and code from spoken text', () => {
    expect(
      stripMarkdownForReadAloud(
        '# Hello\nVisit [Gemma Desktop](https://gemmadesktop.app) and ignore `const x = 1`.\n\n```ts\nconsole.log(1)\n```',
      ),
    ).toBe('Hello\nVisit Gemma Desktop and ignore const x = 1.')
  })

  it('uses assistant prose first and falls back to warnings or errors', () => {
    const assistantFirstContent = [
      { type: 'thinking', text: 'private chain of thought' },
      { type: 'tool_call', toolName: 'search', input: {}, status: 'success' },
      { type: 'text', text: 'Primary **answer** text.' },
      { type: 'code', language: 'ts', code: 'console.log("hi")' },
    ] satisfies MessageContent[]
    expect(extractSpeakableTextFromContent(assistantFirstContent)).toBe('Primary answer text.')

    const fallbackContent = [
      { type: 'warning', message: 'Something needs attention.' },
      { type: 'error', message: 'Fallback error.', details: 'More detail.' },
    ] satisfies MessageContent[]
    expect(extractSpeakableTextFromContent(fallbackContent)).toBe(
      'Something needs attention.\n\nFallback error. More detail.',
    )
  })

  it('normalizes selected text and builds stable playback ids', () => {
    const normalized = normalizeSelectedReadAloudText('  Hello \n\n there   ')

    expect(normalized).toBe('Hello\n\nthere')
    expect(buildReadAloudSelectionPlaybackId(normalized)).toBe(
      buildReadAloudSelectionPlaybackId('Hello\n\nthere'),
    )
    expect(buildReadAloudSelectionPlaybackId(normalized)).not.toBe(
      buildReadAloudSelectionPlaybackId('Different text'),
    )
  })
})

describe('read aloud cache helpers', () => {
  it('builds cache keys from message, text, and voice settings', () => {
    const first = buildReadAloudCacheKey({
      messageId: 'message-1',
      text: 'Hello there',
      voice: 'af_heart',
      speed: 1,
      modelVersion: 'Kokoro:q8',
    })
    const second = buildReadAloudCacheKey({
      messageId: 'message-1',
      text: 'Hello there',
      voice: 'bf_emma',
      speed: 1,
      modelVersion: 'Kokoro:q8',
    })

    expect(first.textHash).toHaveLength(64)
    expect(first.cacheKey).toHaveLength(64)
    expect(first.cacheKey).not.toBe(second.cacheKey)
  })

  it('prunes the oldest files once the cache exceeds its byte limit', async () => {
    const cacheDir = await makeTempDir()
    const oldFile = path.join(cacheDir, 'old.wav')
    const newFile = path.join(cacheDir, 'new.wav')

    await fs.writeFile(oldFile, Buffer.alloc(6))
    await fs.writeFile(newFile, Buffer.alloc(6))
    await fs.utimes(oldFile, new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z'))
    await fs.utimes(newFile, new Date('2024-01-02T00:00:00.000Z'), new Date('2024-01-02T00:00:00.000Z'))

    await pruneReadAloudCache(cacheDir, 7)

    await expect(fs.access(oldFile)).rejects.toThrow()
    await expect(fs.access(newFile)).resolves.toBeUndefined()
  })

  it('finds a prepared local asset bundle in development mode', async () => {
    const cacheRoot = await makeTempDir()
    const assetRoot = await makePreparedAssetRoot(cacheRoot)

    const resolved = await resolveReadAloudAssetRoot([cacheRoot], path.join(cacheRoot, 'read-aloud'))

    expect(resolved).toEqual(expect.objectContaining({
      assetRoot,
      cacheDir: path.join(cacheRoot, 'read-aloud', 'cache'),
      bundledBytes: 22,
    }))
  })
})

describe('ReadAloudService warmup', () => {
  it('yields before heavy warmup work so loading state can propagate first', async () => {
    const cacheRoot = await makeTempDir()
    const assetRoot = await makePreparedAssetRoot(cacheRoot)

    let releaseBeforeHeavyWork!: () => void
    const beforeHeavyWork = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBeforeHeavyWork = resolve
        }),
    )
    const modelLoader = {
      load: vi.fn(async () => ({
        generate: vi.fn(async () => ({
          audio: new Float32Array(0),
          sampling_rate: 24_000,
        })),
      })),
    }

    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot: path.join(cacheRoot, 'read-aloud-state'),
      assetRootCandidates: [cacheRoot],
      modelLoader,
      beforeHeavyWork,
    })

    const loadingStatus = await service.inspect({ enabled: true })

    expect(loadingStatus).toEqual(expect.objectContaining({
      state: 'loading',
      healthy: false,
      busy: true,
      assetRoot,
    }))
    await vi.waitFor(() => {
      expect(beforeHeavyWork).toHaveBeenCalledTimes(1)
    })
    expect(modelLoader.load).not.toHaveBeenCalled()

    releaseBeforeHeavyWork()
    await vi.waitFor(() => {
      expect(modelLoader.load).toHaveBeenCalledTimes(1)
    })
  })

  it('starts warming during inspect and reports loading until the model is ready', async () => {
    const cacheRoot = await makeTempDir()
    const assetRoot = await makePreparedAssetRoot(cacheRoot)

    let resolveLoad!: (value: {
      generate: () => Promise<{ audio: Float32Array; sampling_rate: number }>
    }) => void
    const modelLoader = {
      load: vi.fn(
        () =>
          new Promise<{
            generate: () => Promise<{ audio: Float32Array; sampling_rate: number }>
          }>((resolve) => {
            resolveLoad = resolve
          }),
      ),
    }

    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot: path.join(cacheRoot, 'read-aloud-state'),
      assetRootCandidates: [cacheRoot],
      modelLoader,
    })

    const loadingStatus = await service.inspect({ enabled: true })

    expect(loadingStatus).toEqual(expect.objectContaining({
      state: 'loading',
      healthy: false,
      busy: true,
      assetRoot,
    }))
    await vi.waitFor(() => {
      expect(modelLoader.load).toHaveBeenCalledTimes(1)
    })

    resolveLoad({
      generate: vi.fn(async () => ({
        audio: new Float32Array(0),
        sampling_rate: 24_000,
      })),
    })
    await Promise.resolve()
    await Promise.resolve()

    const readyStatus = await service.inspect({ enabled: true })

    expect(readyStatus).toEqual(expect.objectContaining({
      state: 'ready',
      healthy: true,
      busy: false,
      assetRoot,
    }))
    expect(modelLoader.load).toHaveBeenCalledTimes(1)
  })

  it('keeps reporting ready while generating audio after warmup has completed', async () => {
    const cacheRoot = await makeTempDir()
    const assetRoot = await makePreparedAssetRoot(cacheRoot)

    let resolveGenerate!: (value: {
      audio: Float32Array
      sampling_rate: number
    }) => void
    const model = {
      generate: vi.fn(
        () =>
          new Promise<{
            audio: Float32Array
            sampling_rate: number
          }>((resolve) => {
            resolveGenerate = resolve
          }),
      ),
    }
    const modelLoader = {
      load: vi.fn(async () => model),
    }

    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot: path.join(cacheRoot, 'read-aloud-state'),
      assetRootCandidates: [cacheRoot],
      modelLoader,
    })

    await service.warmup({ enabled: true })

    const synthesizePromise = service.synthesize(
      {
        messageId: 'message-1',
        text: 'Hello there',
        voice: 'af_heart',
        speed: 1,
        purpose: 'message',
        useCache: false,
      },
      {
        enabled: true,
      },
    )

    await vi.waitFor(() => {
      expect(model.generate).toHaveBeenCalledTimes(1)
    })

    const busyStatus = await service.inspect({ enabled: true })

    expect(busyStatus).toEqual(expect.objectContaining({
      state: 'ready',
      healthy: true,
      busy: true,
      assetRoot,
    }))
    expect(modelLoader.load).toHaveBeenCalledTimes(1)

    resolveGenerate({
      audio: new Float32Array([0, 0, 0, 0]),
      sampling_rate: 24_000,
    })
    await synthesizePromise

    const readyStatus = await service.inspect({ enabled: true })

    expect(readyStatus).toEqual(expect.objectContaining({
      state: 'ready',
      healthy: true,
      busy: false,
      assetRoot,
    }))
  })

  it('returns cached wav duration immediately so the player can seek on first frame', async () => {
    const cacheRoot = await makeTempDir()
    await makePreparedAssetRoot(cacheRoot)
    const cacheStateRoot = path.join(cacheRoot, 'read-aloud-state')
    const cacheDir = path.join(cacheStateRoot, 'cache')
    await fs.mkdir(cacheDir, { recursive: true })

    const modelLoader = {
      load: vi.fn(),
    }
    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot: cacheStateRoot,
      assetRootCandidates: [cacheRoot],
      modelLoader,
    })

    const cacheKey = buildReadAloudCacheKey({
      messageId: 'message-1',
      text: 'Hello there',
      voice: 'af_heart',
      speed: 1,
      modelVersion: `${READ_ALOUD_MODEL_ID}:${READ_ALOUD_MODEL_DTYPE}`,
    })
    const cachePath = path.join(cacheDir, `${cacheKey.cacheKey}.wav`)
    await fs.writeFile(cachePath, makeTestWavBuffer(1_250))

    const result = await service.synthesize(
      {
        messageId: 'message-1',
        text: 'Hello there',
        voice: 'af_heart',
        speed: 1,
        purpose: 'message',
        useCache: true,
      },
      {
        enabled: true,
      },
    )

    expect(result).toEqual(expect.objectContaining({
      audioPath: cachePath,
      fromCache: true,
      durationMs: 1250,
    }))
    expect(modelLoader.load).not.toHaveBeenCalled()
  })
})
