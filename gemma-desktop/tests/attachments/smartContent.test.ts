import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSmartContentService, type SmartContentModelRecord, type SmartContentModelTarget } from '../../src/main/smartContent'

function createService(input: {
  current: SmartContentModelTarget
  models: SmartContentModelRecord[]
  runText?: string
  runTexts?: string[]
}) {
  const acquired: SmartContentModelTarget[] = []
  const createdSessions: SmartContentModelTarget[] = []
  const sessionCreateOptions: Array<{
    model: string
    runtime: string
    systemInstructions?: string
  }> = []
  const snapshot = {
    modelId: input.current.modelId,
    runtimeId: input.current.runtimeId,
  }

  const service = createSmartContentService({
    getGemmaDesktop: () => ({
      inspectEnvironment: vi.fn(async () => ({ runtimes: [] })),
      sessions: {
        create: vi.fn(async (options: { model: string; runtime: string; systemInstructions?: string }) => {
          sessionCreateOptions.push(options)
          createdSessions.push({
            modelId: options.model,
            runtimeId: options.runtime,
          })
          return {
            run: vi.fn(async () => {
              const text =
                input.runTexts?.shift()
                ?? input.runText
                ?? 'The image shows a stylized bridge diorama scene with red-orange bridge towers, a road deck, blue water, green land blocks, a clear foreground and background layout, visible block-like materials, and an angled camera view that makes the miniature scene look like a handmade model.'
              return {
                structuredOutput: { text },
                text,
              }
            }),
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

  return { service, acquired, createdSessions, sessionCreateOptions }
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

  it('asks image workers for a dense visual extraction instead of a short caption', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-smart-content-'))
    const imagePath = path.join(workingDirectory, 'bridge.jpeg')
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const current = { modelId: 'gemma4:e4b', runtimeId: 'ollama-native' }
    const { service, sessionCreateOptions } = createService({
      current,
      models: [
        {
          id: current.modelId,
          runtimeId: current.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: true, audio: true },
        },
      ],
    })

    await service.readInspectableFileForTool({
      path: imagePath,
      workingDirectory,
      sessionId: 'session-image',
    })

    expect(sessionCreateOptions).toHaveLength(1)
    const [workerSession] = sessionCreateOptions
    expect(workerSession).toBeDefined()
    const instructions = workerSession?.systemInstructions ?? ''
    expect(instructions).toContain('dense, task-neutral visual extraction')
    expect(instructions).toContain('visible text, scene type, primary subjects')
    expect(instructions).toContain('UI/chrome if present')
    expect(instructions).not.toContain('concise plain-text description')
  })

  it('retries image extraction once when the first result is only a sparse caption', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-smart-content-'))
    const imagePath = path.join(workingDirectory, 'bridge.jpeg')
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const current = { modelId: 'gemma4:e4b', runtimeId: 'ollama-native' }
    const detailedText =
      'The image shows a detailed stylized bridge diorama scene with red-orange bridge towers, a long roadway deck, blue water blocks below, green land blocks at both ends, a compact foreground and background layout, block-like materials, visible miniature model styling, and an angled camera view looking down at the scene.'
    const { service, createdSessions, sessionCreateOptions } = createService({
      current,
      models: [
        {
          id: current.modelId,
          runtimeId: current.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: true, audio: true },
        },
      ],
      runTexts: ['Remix 2: Golden Gate Diorama', detailedText],
    })

    const result = await service.readInspectableFileForTool({
      path: imagePath,
      workingDirectory,
      sessionId: 'session-image',
    })

    expect(result.content).toContain('red-orange bridge towers')
    expect(createdSessions).toHaveLength(2)
    expect(sessionCreateOptions[1]?.systemInstructions).toContain('previous attempt was too short')
  })

  it('fails image extraction clearly when the retry is still too sparse', async () => {
    const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-smart-content-'))
    const imagePath = path.join(workingDirectory, 'bridge.jpeg')
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const current = { modelId: 'gemma4:e4b', runtimeId: 'ollama-native' }
    const { service } = createService({
      current,
      models: [
        {
          id: current.modelId,
          runtimeId: current.runtimeId,
          status: 'loaded',
          attachmentSupport: { image: true, audio: true },
        },
      ],
      runTexts: ['Remix 2: Golden Gate Diorama', 'A Golden Gate diorama.'],
    })

    await expect(
      service.readInspectableFileForTool({
        path: imagePath,
        workingDirectory,
        sessionId: 'session-image',
      }),
    ).rejects.toThrow(/too little visual detail/i)
  })
})
