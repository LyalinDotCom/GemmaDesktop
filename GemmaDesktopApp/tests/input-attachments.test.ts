import { describe, expect, it } from 'vitest'
import {
  buildVideoSampleTimes,
  detectAttachmentKind,
  dataTransferMayContainFiles,
  fileToAttachment,
  filePathToPreviewUrl,
  filesToAttachments,
  type InputAttachmentFile,
  isAudioFileLike,
  isImageFileLike,
  isPdfFileLike,
  isVideoFileLike,
  resolveVideoTargetFrameCount,
  resolveAttachmentPreviewUrl,
  selectVideoKeyframeIndices,
} from '../src/renderer/src/lib/inputAttachments'

describe('input attachments', () => {
  it('detects image files by media type or filename', () => {
    expect(isImageFileLike({ name: 'capture.png', type: '' } as File)).toBe(true)
    expect(isImageFileLike({ name: 'capture', type: 'image/jpeg' } as File)).toBe(true)
    expect(isImageFileLike({ name: 'notes.txt', type: 'text/plain' } as File)).toBe(false)
    expect(isPdfFileLike({ name: 'guide.pdf', type: '' } as File)).toBe(true)
    expect(isPdfFileLike({ name: 'guide', type: 'application/pdf' } as File)).toBe(true)
    expect(isAudioFileLike({ name: 'meeting.wav', type: '' } as File)).toBe(true)
    expect(isAudioFileLike({ name: 'meeting', type: 'audio/mpeg' } as File)).toBe(true)
    expect(isVideoFileLike({ name: 'demo.mp4', type: '' } as File)).toBe(true)
    expect(isVideoFileLike({ name: 'demo', type: 'video/mp4' } as File)).toBe(true)
    expect(detectAttachmentKind({ name: 'demo.mp4', type: 'video/mp4' } as File)).toBe('video')
  })

  it('builds file-backed attachments when Electron file paths are available', async () => {
    const file = new File(['pixel'], 'capture.png', { type: 'image/png' }) as InputAttachmentFile
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: '/tmp/capture.png',
    })

    await expect(fileToAttachment(file)).resolves.toEqual({
      kind: 'image',
      name: 'capture.png',
      path: '/tmp/capture.png',
      size: 5,
      mediaType: 'image/png',
      previewUrl: 'gemma-desktop-file:///tmp/capture.png',
      source: 'file',
    })
  })

  it('ignores non-image files when converting a batch', async () => {
    const image = new File(['pixel'], 'capture.png', { type: 'image/png' }) as InputAttachmentFile
    Object.defineProperty(image, 'path', {
      configurable: true,
      value: '/tmp/capture.png',
    })
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' }) as InputAttachmentFile

    await expect(filesToAttachments([image, text])).resolves.toEqual([
      {
        kind: 'image',
        name: 'capture.png',
        path: '/tmp/capture.png',
        size: 5,
        mediaType: 'image/png',
        previewUrl: 'gemma-desktop-file:///tmp/capture.png',
        source: 'file',
      },
    ])
  })

  it('builds file-backed PDF attachments when Electron file paths are available', async () => {
    const file = new File(['%PDF-1.7'], 'guide.pdf', {
      type: 'application/pdf',
    }) as InputAttachmentFile
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: '/tmp/guide.pdf',
    })

    await expect(fileToAttachment(file)).resolves.toEqual({
      kind: 'pdf',
      name: 'guide.pdf',
      path: '/tmp/guide.pdf',
      size: 8,
      mediaType: 'application/pdf',
      source: 'file',
    })
  })

  it('builds file-backed audio attachments when Electron file paths are available', async () => {
    const file = new File(['RIFF'], 'meeting.wav', {
      type: 'audio/wav',
    }) as InputAttachmentFile
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: '/tmp/meeting.wav',
    })

    await expect(fileToAttachment(file)).resolves.toEqual({
      kind: 'audio',
      name: 'meeting.wav',
      path: '/tmp/meeting.wav',
      size: 4,
      mediaType: 'audio/wav',
      source: 'file',
    })
  })

  it('builds file-backed video attachments and preserves sampled-frame metadata when available', async () => {
    const file = new File(['video'], 'demo.mp4', {
      type: 'video/mp4',
    }) as InputAttachmentFile
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: '/tmp/demo.mp4',
    })

    const attachment = await fileToAttachment(file)
    expect(attachment).toEqual(
      expect.objectContaining({
        kind: 'video',
        name: 'demo.mp4',
        path: '/tmp/demo.mp4',
        size: 5,
        mediaType: 'video/mp4',
        source: 'file',
      }),
    )
    expect(attachment?.kind === 'video' ? Array.isArray(attachment.sampledFrames) : false).toBe(true)
  })

  it('budgets more local video keyframes for longer clips', () => {
    expect(resolveVideoTargetFrameCount()).toBe(8)
    expect(resolveVideoTargetFrameCount(10_000)).toBe(8)
    expect(resolveVideoTargetFrameCount(30_000)).toBe(12)
    expect(resolveVideoTargetFrameCount(60_000)).toBe(18)
  })

  it('spreads video sample times across the clip duration', () => {
    expect(buildVideoSampleTimes(60, 18)).toEqual([
      0.5, 3.971, 7.441, 10.912, 14.382, 17.853,
      21.324, 24.794, 28.265, 31.735, 35.206, 38.676,
      42.147, 45.618, 49.088, 52.559, 56.029, 59.5,
    ])
  })

  it('keeps important change points when selecting local video keyframes', () => {
    const selected = selectVideoKeyframeIndices([
      { timeMs: 0, fingerprint: [0, 0, 0] },
      { timeMs: 1_000, fingerprint: [0, 0, 0] },
      { timeMs: 2_000, fingerprint: [64, 64, 64] },
      { timeMs: 3_000, fingerprint: [64, 64, 64] },
      { timeMs: 4_000, fingerprint: [192, 192, 192] },
      { timeMs: 5_000, fingerprint: [192, 192, 192] },
    ], 4)

    expect(selected).toEqual([0, 2, 4, 5])
  })

  it('normalizes file paths into previewable file URLs', () => {
    expect(filePathToPreviewUrl('/tmp/hello world.png')).toBe(
      'gemma-desktop-file:///tmp/hello%20world.png',
    )
    expect(filePathToPreviewUrl('C:\\Users\\gemma-desktop\\capture.png')).toBe(
      'gemma-desktop-file:///C:/Users/gemma-desktop/capture.png',
    )
  })

  it('upgrades stale raw-path preview URLs for existing attachments', () => {
    expect(
      resolveAttachmentPreviewUrl({
        previewUrl: '/tmp/existing.png',
      }),
    ).toBe('gemma-desktop-file:///tmp/existing.png')

    expect(
      resolveAttachmentPreviewUrl({
        previewUrl: 'data:image/png;base64,abc',
      }),
    ).toBe('data:image/png;base64,abc')

    expect(
      resolveAttachmentPreviewUrl({
        path: '/tmp/from-path.png',
      }),
    ).toBe('gemma-desktop-file:///tmp/from-path.png')
  })

  it('recognizes file drags before files are materialized', () => {
    expect(
      dataTransferMayContainFiles({
        files: { length: 0 },
        types: ['Files'],
      } as Parameters<typeof dataTransferMayContainFiles>[0]),
    ).toBe(true)

    expect(
      dataTransferMayContainFiles({
        files: { length: 0 },
        types: ['text/plain'],
      } as Parameters<typeof dataTransferMayContainFiles>[0]),
    ).toBe(false)
  })
})
