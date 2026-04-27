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
    getAppPath: () => path.resolve(__dirname, '..'),
    isPackaged: false,
  },
}))

import { ReadAloudService } from '../src/main/readAloud'

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
    const cacheRoot = await makeTempDir()
    const service = new ReadAloudService({
      supportedPlatform: 'darwin',
      cacheRoot,
      assetRootCandidates: [installedAssetRoot],
    })

    const status = await service.inspect({ enabled: true })
    expect(status).toEqual(expect.objectContaining({
      state: 'loading',
      assetRoot: installedAssetRoot,
    }))

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
})
