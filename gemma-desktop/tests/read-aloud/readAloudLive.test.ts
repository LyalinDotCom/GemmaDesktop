import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'userData'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Gemma Desktop')
        : os.tmpdir(),
    getAppPath: () => path.resolve(__dirname, '../..'),
    isPackaged: false,
  },
}))

import { ReadAloudService } from '../../src/main/readAloud'

const runLiveReadAloud = process.env.GEMMA_DESKTOP_RUN_READ_ALOUD_LIVE === '1'
const describeLive = runLiveReadAloud ? describe : describe.skip
const tempDirs: string[] = []

async function makeTempDir() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-read-aloud-live-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) =>
      fs.rm(dirPath, { recursive: true, force: true })),
  )
})

describeLive('read aloud live Kokoro validation', () => {
  it('synthesizes a playable wav from the installed app assets', async () => {
    const userDataRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Gemma Desktop')
    const installedAssetRoot = path.join(
      userDataRoot,
      'read-aloud',
      'assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const preparedAssetRoot = path.resolve(
      __dirname,
      '../..',
      '.cache',
      'read-aloud-assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const cacheRoot = await makeTempDir()
    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot,
      assetRootCandidates: [installedAssetRoot, preparedAssetRoot],
    })

    const status = await service.inspect({ enabled: true })
    expect(status).toEqual(expect.objectContaining({
      state: 'loading',
    }))
    expect([installedAssetRoot, preparedAssetRoot]).toContain(status.assetRoot)

    await service.warmup({ enabled: true })
    const result = await service.synthesize(
      {
        messageId: `live-read-aloud-${Date.now()}`,
        text: 'Gemma Desktop read aloud live validation.',
        voice: 'af_heart',
        speed: 1,
        purpose: 'preview',
        useCache: false,
      },
      { enabled: true },
    )

    const stat = await fs.stat(result.audioPath)
    expect(stat.size).toBeGreaterThan(44)
    expect(result.durationMs).toEqual(expect.any(Number))
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('streams playable segment wavs before producing the final wav', async () => {
    const userDataRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Gemma Desktop')
    const installedAssetRoot = path.join(
      userDataRoot,
      'read-aloud',
      'assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const preparedAssetRoot = path.resolve(
      __dirname,
      '../..',
      '.cache',
      'read-aloud-assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const cacheRoot = await makeTempDir()
    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot,
      assetRootCandidates: [installedAssetRoot, preparedAssetRoot],
    })
    const events: unknown[] = []
    const streamId = `live-stream-${Date.now()}`

    await service.startStreaming(
      {
        streamId,
        messageId: `live-read-aloud-stream-${Date.now()}`,
        text: 'Gemma Desktop is streaming this first read aloud sentence. The final audio file should arrive afterward.',
        voice: 'af_heart',
        speed: 1,
        purpose: 'preview',
        useCache: false,
      },
      {
        enabled: true,
        emit: (event) => events.push(event),
      },
    )

    await vi.waitFor(() => {
      expect(events.some((event) =>
        typeof event === 'object'
        && event !== null
        && 'type' in event
        && event.type === 'segment-ready',
      )).toBe(true)
    }, { timeout: 30_000 })

    const segmentEvent = events.find((event) =>
      typeof event === 'object'
      && event !== null
      && 'type' in event
      && event.type === 'segment-ready',
    ) as { audioPath: string; durationMs: number | null } | undefined
    const segmentStat = await fs.stat(segmentEvent!.audioPath)
    expect(segmentStat.size).toBeGreaterThan(44)
    expect(segmentEvent!.durationMs).toEqual(expect.any(Number))

    await vi.waitFor(() => {
      expect(events.some((event) =>
        typeof event === 'object'
        && event !== null
        && 'type' in event
        && event.type === 'final-ready',
      )).toBe(true)
    }, { timeout: 30_000 })

    const finalEvent = events.find((event) =>
      typeof event === 'object'
      && event !== null
      && 'type' in event
      && event.type === 'final-ready',
    ) as { result: { audioPath: string; durationMs: number | null }; temporaryFinal: boolean } | undefined
    const finalStat = await fs.stat(finalEvent!.result.audioPath)
    expect(finalStat.size).toBeGreaterThan(44)
    expect(finalEvent!.temporaryFinal).toBe(true)
    expect(finalEvent!.result.durationMs).toEqual(expect.any(Number))

    await service.cleanupStream(streamId)
    await expect(fs.access(finalEvent!.result.audioPath)).rejects.toThrow()
  }, 30_000)

  it('cancels streaming playback while worker synthesis is in flight', async () => {
    const userDataRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Gemma Desktop')
    const installedAssetRoot = path.join(
      userDataRoot,
      'read-aloud',
      'assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const preparedAssetRoot = path.resolve(
      __dirname,
      '../..',
      '.cache',
      'read-aloud-assets',
      'Kokoro-82M-v1.0-ONNX',
    )
    const cacheRoot = await makeTempDir()
    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot,
      assetRootCandidates: [installedAssetRoot, preparedAssetRoot],
    })
    const events: unknown[] = []
    const streamId = `live-cancel-stream-${Date.now()}`

    await service.startStreaming(
      {
        streamId,
        messageId: `live-read-aloud-cancel-${Date.now()}`,
        text: [
          'Gemma Desktop should be able to stop this first generated sentence.',
          `The second sentence is deliberately longer so cancellation can happen while worker synthesis is still busy ${'responsive '.repeat(80)}.`,
        ].join(' '),
        voice: 'af_heart',
        speed: 1,
        purpose: 'preview',
        useCache: false,
      },
      {
        enabled: true,
        emit: (event) => events.push(event),
      },
    )

    await vi.waitFor(() => {
      expect(events.some((event) =>
        typeof event === 'object'
        && event !== null
        && 'type' in event
        && event.type === 'segment-ready',
      )).toBe(true)
    }, { timeout: 30_000 })

    await expect(service.cancelCurrent()).resolves.toEqual({ ok: true })
    await vi.waitFor(() => {
      expect(events.some((event) =>
        typeof event === 'object'
        && event !== null
        && 'type' in event
        && event.type === 'cancelled',
      )).toBe(true)
    }, { timeout: 30_000 })

    await service.cleanupStream(streamId)
  }, 45_000)
})
