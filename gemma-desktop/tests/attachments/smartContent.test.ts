import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSmartContentService, type SmartContentModelRecord, type SmartContentModelTarget } from '../../src/main/smartContent'

function createService(input: {
  current: SmartContentModelTarget
  models: SmartContentModelRecord[]
  runText?: string
}) {
  const acquired: SmartContentModelTarget[] = []
  const createdSessions: SmartContentModelTarget[] = []
  const snapshot = {
    modelId: input.current.modelId,
    runtimeId: input.current.runtimeId,
  }

  const service = createSmartContentService({
    getGemmaDesktop: () => ({
      inspectEnvironment: vi.fn(async () => ({ runtimes: [] })),
      sessions: {
        create: vi.fn(async (options: { model: string; runtime: string }) => {
          createdSessions.push({
            modelId: options.model,
            runtimeId: options.runtime,
          })
          return {
            run: vi.fn(async () => ({
              structuredOutput: { text: input.runText ?? 'A stylized bridge diorama.' },
              text: input.runText ?? 'A stylized bridge diorama.',
            })),
          }
        }),
      },
    }) as never,
    getOrResumeLiveSession: vi.fn(async () => ({
      session: {
        snapshot: () => snapshot,
      },
    })) as never,
    mapModels: vi.fn(() => input.models),
    acquireFileWorkerModelLease: vi.fn(async (_leaseId: string, target: SmartContentModelTarget) => {
      acquired.push(target)
      return () => {}
    }),
    buildWorkerSessionMetadata: vi.fn(async () => ({})),
    isHelperModelEnabled: vi.fn(async () => true),
    removePathBestEffort: vi.fn(async () => {}),
  })

  return { service, acquired, createdSessions }
}

describe('smart content model selection', () => {
  it('uses the current primary model for image reading when it is vision-capable', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-smart-content-'))
    const imagePath = path.join(workingDirectory, 'bridge.jpeg')
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const current = { modelId: 'google/gemma-4-31b', runtimeId: 'lmstudio-native' }
    const { service, acquired, createdSessions } = createService({
      current,
      models: [
        {
          id: current.modelId,
          runtimeId: current.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: true, audio: false },
        },
        {
          id: 'gemma4:e4b',
          runtimeId: 'ollama-native',
          status: 'loaded',
          attachmentSupport: { image: true, audio: true },
        },
      ],
    })

    const result = await service.readInspectableFileForTool({
      path: imagePath,
      workingDirectory,
      sessionId: 'session-image',
    })

    expect(result.strategy).toBe('image_to_text')
    expect(result).toMatchObject({ helperModelId: current.modelId })
    expect(acquired).toEqual([current])
    expect(createdSessions).toEqual([current])
  })

  it('uses a resident vision-capable helper when the current primary is text-only', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-smart-content-'))
    const imagePath = path.join(workingDirectory, 'bridge.jpeg')
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const current = { modelId: 'gemma4:31b-coding-mtp-bf16', runtimeId: 'ollama-native' }
    const helper = { modelId: 'gemma4:e4b', runtimeId: 'ollama-native' }
    const { service, acquired, createdSessions } = createService({
      current,
      models: [
        {
          id: current.modelId,
          runtimeId: current.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: false, audio: false },
        },
        {
          id: helper.modelId,
          runtimeId: helper.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: true, audio: true },
        },
      ],
    })

    const result = await service.readInspectableFileForTool({
      path: imagePath,
      workingDirectory,
      sessionId: 'session-image',
    })

    expect(result.strategy).toBe('image_to_text')
    expect(result).toMatchObject({ helperModelId: helper.modelId })
    expect(acquired).toEqual([helper])
    expect(createdSessions).toEqual([helper])
  })
})
