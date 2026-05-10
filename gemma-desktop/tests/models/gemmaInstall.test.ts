import { describe, expect, it, vi } from 'vitest'
import {
  createGemmaInstallManager,
} from '../../src/main/gemmaInstall'
import { getDefaultGemmaCatalogEntry } from '../../src/shared/gemmaCatalog'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('Gemma install manager', () => {
  it('requires confirmation before starting a download', async () => {
    const entry = getDefaultGemmaCatalogEntry()
    const pullModel = vi.fn(async () => {})
    const manager = createGemmaInstallManager({
      confirmDownload: async () => false,
      isModelInstalled: async () => false,
      pullModel,
    })

    const result = await manager.ensureModel(entry)

    expect(result).toEqual({
      ok: false,
      tag: entry.tag,
      installed: false,
      cancelled: true,
    })
    expect(pullModel).not.toHaveBeenCalled()
  })

  it('deduplicates in-flight pulls for the same Gemma tag', async () => {
    const entry = getDefaultGemmaCatalogEntry()
    const pendingPull = deferred<void>()
    const confirmDownload = vi.fn(async () => true)
    const pullModel = vi.fn(async (_tag: string, onProgress: (line: string) => void) => {
      onProgress('pulling manifest')
      await pendingPull.promise
    })
    const manager = createGemmaInstallManager({
      confirmDownload,
      isModelInstalled: async () => false,
      pullModel,
    })

    const first = manager.ensureModel(entry)
    const second = manager.ensureModel(entry)
    pendingPull.resolve()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(confirmDownload).toHaveBeenCalledTimes(1)
    expect(pullModel).toHaveBeenCalledTimes(1)
    expect(firstResult).toEqual({
      ok: true,
      tag: entry.tag,
      installed: true,
    })
    expect(secondResult).toEqual(firstResult)
    expect(manager.getStates()).toEqual([
      expect.objectContaining({
        tag: entry.tag,
        status: 'completed',
      }),
    ])
  })

  it('records failed pulls without pretending the model is ready', async () => {
    const entry = getDefaultGemmaCatalogEntry()
    const manager = createGemmaInstallManager({
      confirmDownload: async () => true,
      isModelInstalled: async () => false,
      pullModel: async () => {
        throw new Error('network timeout')
      },
    })

    const result = await manager.ensureModel(entry)

    expect(result).toEqual({
      ok: false,
      tag: entry.tag,
      installed: false,
      error: 'network timeout',
    })
    expect(manager.getStates()).toEqual([
      expect.objectContaining({
        tag: entry.tag,
        status: 'failed',
        error: 'network timeout',
      }),
    ])
  })
})
