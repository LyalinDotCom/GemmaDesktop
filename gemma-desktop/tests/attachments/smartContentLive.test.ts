import { deflateSync } from 'node:zlib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGemmaDesktop } from '@gemma-sdk/node'
import { describe, expect, it } from 'vitest'
import { createSmartContentService, type SmartContentServiceDependencies } from '../../src/main/smartContent'
import {
  createLiveRuntimeAdapters,
  withLiveRuntimeModel,
} from '../helpers/ollama-live.js'

const itIfLive = process.env.GEMMA_DESKTOP_RUN_IMAGE_EXTRACTION_LIVE === '1' ? it : it.skip
const LIVE_IMAGE_EXTRACTION_REQUEST_TIMEOUT_MS =
  Number(process.env.GEMMA_DESKTOP_IMAGE_EXTRACTION_REQUEST_TIMEOUT_MS?.trim() || '')
  || 2 * 60_000
const LIVE_IMAGE_EXTRACTION_TIMEOUT_MS =
  Number(process.env.GEMMA_DESKTOP_IMAGE_EXTRACTION_TIMEOUT_MS?.trim() || '')
  || LIVE_IMAGE_EXTRACTION_REQUEST_TIMEOUT_MS + 60_000

function configuredEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function resolveConfiguredRuntime(): string {
  return configuredEnvValue(
    'GEMMA_DESKTOP_IMAGE_EXTRACTION_RUNTIME_ID',
    'GEMMA_DESKTOP_LIVE_RUNTIME_ID',
  ) ?? 'ollama-native'
}

function resolveConfiguredModel(): string {
  return configuredEnvValue(
    'GEMMA_DESKTOP_IMAGE_EXTRACTION_MODEL_ID',
    'GEMMA_DESKTOP_LIVE_MODEL_ID',
    'GEMMA_DESKTOP_OLLAMA_LIVE_MODEL_ID',
  ) ?? 'gemma4:26b'
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

function createBridgeDioramaPng(): Buffer {
  const width = 320
  const height = 220
  const pixels = Buffer.alloc(width * height * 4)

  const fillRect = (
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
    color: readonly [number, number, number, number],
  ) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + rectHeight); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + rectWidth); xx += 1) {
        const index = (yy * width + xx) * 4
        pixels[index] = color[0]
        pixels[index + 1] = color[1]
        pixels[index + 2] = color[2]
        pixels[index + 3] = color[3]
      }
    }
  }

  const drawLine = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: readonly [number, number, number, number],
  ) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    for (let step = 0; step <= steps; step += 1) {
      const t = steps === 0 ? 0 : step / steps
      const x = Math.round(x1 + (x2 - x1) * t)
      const y = Math.round(y1 + (y2 - y1) * t)
      fillRect(x - 1, y - 1, 3, 3, color)
    }
  }

  fillRect(0, 0, width, height, [232, 244, 255, 255])
  fillRect(0, 118, width, 102, [64, 143, 210, 255])
  fillRect(0, 142, 92, 78, [75, 143, 69, 255])
  fillRect(228, 142, 92, 78, [75, 143, 69, 255])
  fillRect(0, 202, width, 18, [150, 112, 76, 255])

  const bridge = [190, 54, 44, 255] as const
  fillRect(38, 112, 244, 14, bridge)
  fillRect(78, 48, 18, 86, bridge)
  fillRect(224, 48, 18, 86, bridge)
  fillRect(70, 76, 34, 8, bridge)
  fillRect(216, 76, 34, 8, bridge)
  drawLine(86, 50, 160, 96, bridge)
  drawLine(234, 50, 160, 96, bridge)
  drawLine(38, 112, 86, 50, bridge)
  drawLine(282, 112, 234, 50, bridge)
  fillRect(122, 116, 16, 8, [242, 199, 62, 255])
  fillRect(182, 116, 16, 8, [245, 245, 245, 255])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rawRows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    rawRows[rowStart] = 0
    pixels.copy(rawRows, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rawRows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function withTimeout<T>(input: {
  label: string
  timeoutMs: number
  controller: AbortController
  task: Promise<T>
}): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      input.controller.abort()
      reject(new Error(`${input.label} did not finish within ${input.timeoutMs}ms.`))
    }, input.timeoutMs)
  })

  try {
    return await Promise.race([input.task, timeoutPromise])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

const mapLiveModels: SmartContentServiceDependencies['mapModels'] = (inspectionResults) =>
  inspectionResults.flatMap((runtimeInspection) => {
    const loadedStatusByModel = new Map(
      runtimeInspection.loadedInstances.map((instance) => [instance.modelId, instance.status]),
    )

    return runtimeInspection.models.map((model) => ({
      id: model.id,
      runtimeId: model.runtimeId,
      status: loadedStatusByModel.get(model.id) ?? 'available',
      attachmentSupport: {
        image: model.capabilities.some(
          (capability) =>
            capability.id === 'model.input.image'
            && capability.status === 'supported',
        ),
        audio: model.capabilities.some(
          (capability) =>
            capability.id === 'model.input.audio'
            && capability.status === 'supported',
        ),
      },
    }))
  })

describe.sequential('smart content live image extraction', () => {
  itIfLive(
    'extracts enough visual detail from a generated bridge image with the configured vision model',
    async () => {
      const runtimeId = resolveConfiguredRuntime()
      const modelId = resolveConfiguredModel()
      const adapters = createLiveRuntimeAdapters()

      await withLiveRuntimeModel({
        runtimeId,
        modelId,
        adapters,
        loadOptions: { num_ctx: 8192 },
      }, async () => {
        const workingDirectory = await mkdtemp(
          path.join(os.tmpdir(), 'gemma-desktop-live-image-extraction-'),
        )
        const workspaceFixturePath = path.join(workingDirectory, 'bridge-diorama.png')
        await writeFile(workspaceFixturePath, createBridgeDioramaPng())
        const gemmaDesktop = await createGemmaDesktop({
          workingDirectory,
          adapters,
        })
        const session = await gemmaDesktop.sessions.create({
          runtime: runtimeId,
          model: modelId,
          mode: 'minimal',
          workingDirectory,
          metadata: {
            requestPreferences: {
              reasoningMode: 'off',
              ollamaOptions: { num_ctx: 8192 },
            },
          },
        })
        const service = createSmartContentService({
          getGemmaDesktop: () => gemmaDesktop,
          getOrResumeLiveSession: async () => ({ session }),
          mapModels: mapLiveModels,
          acquireFileWorkerModelLease: async () => () => {},
          buildWorkerSessionMetadata: async () => ({}),
          isHelperModelEnabled: async () => true,
          removePathBestEffort: async (targetPath, options) => {
            await rm(targetPath, options)
          },
        })

        const controller = new AbortController()
        const result = await withTimeout({
          label: 'Live image extraction',
          timeoutMs: LIVE_IMAGE_EXTRACTION_REQUEST_TIMEOUT_MS,
          controller,
          task: service.readInspectableFileForTool({
            path: workspaceFixturePath,
            workingDirectory,
            sessionId: 'live-image-extraction',
            maxBytes: 20_000,
            signal: controller.signal,
          }),
        })
        const text = result.content.toLowerCase()
        const detailTerms = [
          'blue',
          'bridge',
          'green',
          'red',
          'tower',
          'water',
        ]
        const hitCount = detailTerms.filter((term) => text.includes(term)).length

        console.log('[live-image-extraction] runtime:', runtimeId)
        console.log('[live-image-extraction] model:', modelId)
        if (result.strategy === 'image_to_text') {
          console.log('[live-image-extraction] helper:', `${result.helperRuntimeId} / ${result.helperModelId}`)
        }
        console.log('[live-image-extraction] preview:', result.content.slice(0, 600))

        expect(result.strategy).toBe('image_to_text')
        expect(result.content.length).toBeGreaterThan(180)
        expect(hitCount).toBeGreaterThanOrEqual(3)
      })
    },
    LIVE_IMAGE_EXTRACTION_TIMEOUT_MS,
  )
})
