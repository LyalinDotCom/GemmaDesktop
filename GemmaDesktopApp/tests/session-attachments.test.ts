import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  inspectPdfDocumentMock,
  renderPdfPagesMock,
} = vi.hoisted(() => ({
  inspectPdfDocumentMock: vi.fn(),
  renderPdfPagesMock: vi.fn(),
}))

vi.mock('@gemma-desktop/sdk-node', () => ({
  PDF_RENDERER_INFO: {
    name: 'pdf-to-img',
    version: '5.0.0',
  },
  inspectPdfDocument: inspectPdfDocumentMock,
  renderPdfPages: renderPdfPagesMock,
}))

import {
  buildOptimisticUserMessageContent,
  buildSessionInputFromUserMessage,
  buildUnsupportedAttachmentErrorMessage,
  buildUserMessageContent,
  findUnsupportedAttachmentKinds,
  isKnownVisionUnsupported,
  PDF_MAX_WORKER_BATCH_BYTES,
  PdfAttachmentConversionError,
  planPdfAttachmentProcessing,
  persistIncomingAttachments,
} from '../src/main/sessionAttachments'

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k0uoAAAAASUVORK5CYII='

function createTinyWavDataUrl(): string {
  const sampleRate = 16_000
  const channelCount = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataBytes = bytesPerSample
  const byteRate = sampleRate * channelCount * bytesPerSample
  const blockAlign = channelCount * bytesPerSample
  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
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
  buffer.writeUInt32LE(dataBytes, 40)
  buffer.writeInt16LE(0, 44)

  return `data:audio/wav;base64,${buffer.toString('base64')}`
}

describe('session attachment pipeline', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    inspectPdfDocumentMock.mockReset()
    renderPdfPagesMock.mockReset()

    while (cleanup.length > 0) {
      const directory = cleanup.pop()
      if (directory) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('keeps images direct and injects prepared PDF text instead of page images', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-pdf-attachments-'))
    cleanup.push(tempDir)
    const sourceCapturePath = path.join(tempDir, 'source-capture.png')
    const sourceDiagramPath = path.join(tempDir, 'source-diagram.png')
    await writeFile(sourceCapturePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'))
    await writeFile(sourceDiagramPath, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'))

    inspectPdfDocumentMock.mockResolvedValue({ pageCount: 12 })
    renderPdfPagesMock.mockResolvedValue([
      {
        pageNumber: 1,
        path: path.join(tempDir, 'rendered', 'page-0001.png'),
        bytes: 1200,
      },
      {
        pageNumber: 2,
        path: path.join(tempDir, 'rendered', 'page-0002.png'),
        bytes: 1500,
      },
    ])
    const result = await persistIncomingAttachments({
      attachments: [
        {
          kind: 'image',
          name: 'capture.png',
          size: 5,
          path: sourceCapturePath,
          mediaType: 'image/png',
          source: 'file',
        },
        {
          kind: 'pdf',
          name: 'guide.pdf',
          size: 9,
          mediaType: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,JVBERi0xLjc=',
          source: 'file',
        },
        {
          kind: 'image',
          name: 'diagram.png',
          size: 5,
          path: sourceDiagramPath,
          mediaType: 'image/png',
          source: 'file',
        },
      ],
      getAssetDirectory: async () => tempDir,
    })

    expect(result.pdfDebugRecords).toEqual([
      expect.objectContaining({
        sourceName: 'guide.pdf',
        pageCount: 12,
        processedRange: {
          startPage: 1,
          endPage: 12,
        },
        processingMode: 'full_document',
        fitStatus: 'ready',
        batchCount: 1,
        renderedPageCount: 2,
        renderedBytes: 2700,
        parser: {
          name: 'pdf-to-img',
          version: '5.0.0',
        },
      }),
    ])

    const content = buildUserMessageContent('Summarize this.', result.attachments)
    expect(content.map((entry) => entry.type)).toEqual([
      'text',
      'image',
      'pdf',
      'image',
    ])
    expect(content[2]).toEqual(
      expect.objectContaining({
        type: 'pdf',
        filename: 'guide.pdf',
        pageCount: 12,
        processingMode: 'full_document',
        batchCount: 1,
        fitStatus: 'ready',
        processedRange: {
          startPage: 1,
          endPage: 12,
        },
        previewThumbnails: [
          expect.stringContaining('page-0001.png'),
          expect.stringContaining('page-0002.png'),
        ],
      }),
    )

    const preparedAttachments = result.attachments.map((attachment) =>
      attachment.kind === 'pdf'
        ? {
            ...attachment,
            derivedSummary: 'A prepared summary of the attached PDF.',
            derivedTextPath: path.join(tempDir, 'guide-derived', 'document.md'),
            derivedPromptText: 'Page 1 introduces the paper and lists the authors.',
            derivedPromptTokenEstimate: 14,
          }
        : attachment,
    )

    const preparedContent = buildUserMessageContent('Summarize this.', preparedAttachments)
    expect(preparedContent[2]).toMatchObject({
      type: 'pdf',
      derivedSummary: 'A prepared summary of the attached PDF.',
    })
    const preparedPdfContent = preparedContent[2]
    expect(preparedPdfContent).toBeDefined()
    expect(preparedPdfContent?.derivedTextPath).toEqual(expect.stringContaining('document.md'))

    const sessionInput = buildSessionInputFromUserMessage({
      text: 'Summarize this.',
      attachments: preparedAttachments,
      capabilityContext: {
        runtime: {
          id: 'ollama',
          displayName: 'Ollama',
          family: 'ollama',
          kind: 'native',
        },
        modelId: 'vision-model',
        runtimeCapabilities: [],
        modelCapabilities: [
          {
            id: 'model.vision',
            status: 'supported',
            scope: 'model',
            source: 'test',
          },
        ],
      },
    })
    expect(Array.isArray(sessionInput)).toBe(true)
    expect((sessionInput as Array<{ type: string }>).map((entry) => entry.type)).toEqual([
      'text',
      'image_url',
      'text',
      'image_url',
    ])
    expect((sessionInput as Array<{ type: 'image_url'; url: string }>)[1]?.url).toContain(
      'capture',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[2]?.text).toContain(
      'Attached PDF: guide.pdf',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[2]?.text).toContain(
      'Processed pages: 1-12 of 12',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[2]?.text).toContain(
      'Prepared PDF context:',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[2]?.text).not.toContain(
      'Derived text artifact path:',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[2]?.text).not.toContain(
      'Attached local files for this turn are available on disk.',
    )
    expect((sessionInput as Array<{ type: 'image_url'; url: string }>)[3]?.url).toContain(
      'diagram',
    )
  })

  it('keeps audio and video grouped in chat content while flattening video frames into session input', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-audio-video-attachments-'))
    cleanup.push(tempDir)
    const sourceVideoPath = path.join(tempDir, 'source-demo.mp4')
    await writeFile(sourceVideoPath, Buffer.from('demo-video'))

    const result = await persistIncomingAttachments({
      attachments: [
        {
          kind: 'audio',
          name: 'meeting.wav',
          size: 46,
          mediaType: 'audio/wav',
          dataUrl: createTinyWavDataUrl(),
          source: 'file',
        },
        {
          kind: 'video',
          name: 'demo.mp4',
          size: 9,
          path: sourceVideoPath,
          mediaType: 'video/mp4',
          source: 'file',
          durationMs: 4_200,
          sampledFrames: [
            {
              kind: 'image',
              name: 'demo-frame-1.jpg',
              size: 68,
              mediaType: 'image/png',
              dataUrl: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
              source: 'file',
              timestampMs: 500,
            },
            {
              kind: 'image',
              name: 'demo-frame-2.jpg',
              size: 68,
              mediaType: 'image/png',
              dataUrl: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
              source: 'file',
              timestampMs: 3_700,
            },
          ],
        },
      ],
      getAssetDirectory: async () => tempDir,
    })

    const content = buildUserMessageContent('Review these.', result.attachments)
    expect(content.map((entry) => entry.type)).toEqual([
      'text',
      'audio',
      'video',
    ])
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: 'audio',
        filename: 'meeting.wav',
        normalizedMediaType: 'audio/wav',
      }),
    )
    expect(content[2]).toEqual(
      expect.objectContaining({
        type: 'video',
        filename: 'demo.mp4',
        sampledFrameCount: 2,
        sampledFrameTimestampsMs: [500, 3_700],
      }),
    )

    const sessionInput = buildSessionInputFromUserMessage({
      text: 'Review these.',
      attachments: result.attachments,
      capabilityContext: {
        runtime: {
          id: 'ollama',
          displayName: 'Ollama',
          family: 'ollama',
          kind: 'native',
        },
        modelId: 'text-only-model',
        runtimeCapabilities: [],
        modelCapabilities: [
          {
            id: 'model.vision',
            status: 'unsupported',
            scope: 'model',
            source: 'test',
          },
          {
            id: 'model.audio',
            status: 'unsupported',
            scope: 'model',
            source: 'test',
          },
        ],
      },
    })
    expect(Array.isArray(sessionInput)).toBe(true)
    expect((sessionInput as Array<{ type: string }>).map((entry) => entry.type)).toEqual([
      'text',
      'text',
    ])
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[0]?.text).toContain(
      'Review these.',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[1]?.text).toContain(
      'Attached local files for this turn are available on disk.',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[1]?.text).toContain(
      'AUDIO: meeting.wav',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[1]?.text).toContain(
      'VIDEO: demo.mp4',
    )
    expect((sessionInput as Array<{ type: 'text'; text: string }>)[1]?.text).toContain(
      'Derived keyframe paths:',
    )
  })

  it('builds optimistic chat content from incoming attachment previews before persistence finishes', () => {
    const content = buildOptimisticUserMessageContent('Review this.', [
      {
        kind: 'image',
        name: 'capture.png',
        size: 5,
        previewUrl: 'gemma-desktop-file:///tmp/capture.png',
        mediaType: 'image/png',
        source: 'file',
      },
      {
        kind: 'audio',
        name: 'meeting.wav',
        size: 46,
        path: '/tmp/meeting.wav',
        mediaType: 'audio/wav',
        source: 'file',
        durationMs: 1_250,
        normalizedMediaType: 'audio/wav',
      },
      {
        kind: 'video',
        name: 'demo.mp4',
        size: 9,
        previewUrl: 'gemma-desktop-file:///tmp/demo.mp4',
        mediaType: 'video/mp4',
        source: 'file',
        durationMs: 4_200,
        sampledFrames: [
          {
            kind: 'image',
            name: 'demo-frame-1.jpg',
            size: 68,
            previewUrl: 'gemma-desktop-file:///tmp/demo-frame-1.jpg',
            mediaType: 'image/jpeg',
            source: 'file',
            timestampMs: 500,
          },
          {
            kind: 'image',
            name: 'demo-frame-2.jpg',
            size: 68,
            path: '/tmp/demo-frame-2.jpg',
            mediaType: 'image/jpeg',
            source: 'file',
            timestampMs: 3_700,
          },
        ],
      },
      {
        kind: 'pdf',
        name: 'guide.pdf',
        size: 9,
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjc=',
        source: 'file',
        pageCount: 12,
        batchCount: 2,
        fitStatus: 'too_large',
        previewThumbnails: [
          'gemma-desktop-file:///tmp/guide-page-1.png',
          'gemma-desktop-file:///tmp/guide-page-2.png',
        ],
      },
    ])

    expect(content).toEqual([
      {
        type: 'text',
        text: 'Review this.',
      },
      expect.objectContaining({
        type: 'image',
        url: 'gemma-desktop-file:///tmp/capture.png',
        filename: 'capture.png',
      }),
      expect.objectContaining({
        type: 'audio',
        url: 'file:///tmp/meeting.wav',
        filename: 'meeting.wav',
        normalizedMediaType: 'audio/wav',
      }),
      expect.objectContaining({
        type: 'video',
        url: 'gemma-desktop-file:///tmp/demo.mp4',
        filename: 'demo.mp4',
        sampledFrameCount: 2,
        sampledFrameTimestampsMs: [500, 3_700],
        thumbnails: [
          'gemma-desktop-file:///tmp/demo-frame-1.jpg',
          'file:///tmp/demo-frame-2.jpg',
        ],
      }),
      expect.objectContaining({
        type: 'pdf',
        url: 'data:application/pdf;base64,JVBERi0xLjc=',
        filename: 'guide.pdf',
        pageCount: 12,
        processingMode: 'full_document',
        processedRange: {
          startPage: 1,
          endPage: 12,
        },
        batchCount: 2,
        fitStatus: 'too_large',
        previewThumbnails: [
          'gemma-desktop-file:///tmp/guide-page-1.png',
          'gemma-desktop-file:///tmp/guide-page-2.png',
        ],
      }),
    ])
  })

  it('fails fast when rendered PDF pages exceed the byte budget', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemma-desktop-pdf-oversize-'))
    cleanup.push(tempDir)

    inspectPdfDocumentMock.mockResolvedValue({ pageCount: 3 })
    renderPdfPagesMock.mockResolvedValue([
      {
        pageNumber: 1,
        path: path.join(tempDir, 'rendered', 'page-0001.png'),
        bytes: PDF_MAX_WORKER_BATCH_BYTES + 1,
      },
    ])
    await expect(
      persistIncomingAttachments({
        attachments: [
          {
            kind: 'pdf',
            name: 'too-large.pdf',
            size: 9,
            mediaType: 'application/pdf',
            dataUrl: 'data:application/pdf;base64,JVBERi0xLjc=',
            source: 'file',
            processedRange: {
              startPage: 1,
              endPage: 1,
            },
          },
        ],
        getAssetDirectory: async () => tempDir,
      }),
    ).rejects.toBeInstanceOf(PdfAttachmentConversionError)
  })

  it('keeps small custom page ranges eligible even when the full PDF file is very large', async () => {
    inspectPdfDocumentMock.mockResolvedValue({ pageCount: 240 })

    const plan = await planPdfAttachmentProcessing({
      name: 'large-reference.pdf',
      size: PDF_MAX_WORKER_BATCH_BYTES * 24,
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjc=',
      processedRange: {
        startPage: 1,
        endPage: 2,
      },
      workerModelId: 'gemma-31b',
    })

    expect(plan.fitStatus).toBe('ready')
    expect(plan.estimatedBatchCount).toBe(1)
    expect(plan.reason).toBeUndefined()
  })

  it('detects known non-vision model capability snapshots', () => {
    expect(
      isKnownVisionUnsupported({
        runtime: {
          id: 'ollama',
          displayName: 'Ollama',
          family: 'ollama',
          kind: 'native',
        },
        modelId: 'llama3',
        runtimeCapabilities: [],
        modelCapabilities: [
          {
            id: 'model.vision',
            scope: 'model',
            status: 'unsupported',
            source: 'test',
          },
        ],
      }),
    ).toBe(true)
  })

  it('rejects unsupported attachment kinds using the shared capability snapshot', () => {
    const unsupportedKinds = findUnsupportedAttachmentKinds(
      [
        { kind: 'audio' },
        { kind: 'pdf' },
      ],
      {
        runtime: {
          id: 'ollama-native',
          displayName: 'Ollama Native',
          family: 'ollama',
          kind: 'native',
        },
        modelId: 'gemma4:26b',
        runtimeCapabilities: [],
        modelCapabilities: [
          {
            id: 'model.input.image',
            scope: 'model',
            status: 'supported',
            source: 'test',
          },
          {
            id: 'model.input.audio',
            scope: 'model',
            status: 'unsupported',
            source: 'test',
          },
        ],
      },
    )

    expect(unsupportedKinds).toEqual(['audio', 'pdf'])
    expect(
      findUnsupportedAttachmentKinds(
        [
          { kind: 'audio' },
          { kind: 'pdf' },
        ],
        {
          runtime: {
            id: 'ollama-native',
            displayName: 'Ollama Native',
            family: 'ollama',
            kind: 'native',
          },
          modelId: 'gemma4:26b',
          runtimeCapabilities: [],
          modelCapabilities: [
            {
              id: 'model.input.image',
              scope: 'model',
              status: 'supported',
              source: 'test',
            },
            {
              id: 'model.input.audio',
              scope: 'model',
              status: 'unsupported',
              source: 'test',
            },
          ],
        },
        {
          allowPdf: true,
        },
      ),
    ).toEqual(['audio'])
    expect(
      buildUnsupportedAttachmentErrorMessage({
        modelId: 'gemma4:26b',
        unsupportedKinds,
      }),
    ).toContain('audio files')
  })
})
