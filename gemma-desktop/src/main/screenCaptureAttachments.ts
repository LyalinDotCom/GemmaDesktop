import fs from 'fs/promises'
import path from 'path'
import {
  captureMacOSScreenshot,
  type CaptureMacOSScreenshotInput,
  type CaptureMacOSScreenshotResult,
} from './macosScreenshot'

export const SCREEN_CAPTURE_ATTACHMENT_HIDE_DELAY_MS = 250

export interface ScreenCaptureAttachment {
  kind: 'image'
  name: string
  size: number
  path: string
  previewUrl: string
  mediaType: 'image/png'
  source: 'file'
}

export interface ScreenCaptureWindow {
  isVisible(): boolean
  isDestroyed(): boolean
  hide(): void
  show(): void
  focus(): void
}

interface FileStatsLike {
  size: number
}

type CaptureFunction = (
  input: CaptureMacOSScreenshotInput,
) => Promise<CaptureMacOSScreenshotResult | null>

export interface CaptureScreenAttachmentInput {
  assetDirectory: string
  getWindows: () => ScreenCaptureWindow[]
  capture?: CaptureFunction
  statFile?: (targetPath: string) => Promise<FileStatsLike>
  wait?: (durationMs: number) => Promise<void>
  hideDelayMs?: number
  now?: () => Date
  platform?: NodeJS.Platform
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}

function buildScreenCaptureFileName(now: Date): string {
  return `screen-${now.toISOString().replace(/[:.]/g, '-')}`
}

function collectVisibleWindows(windows: ScreenCaptureWindow[]): ScreenCaptureWindow[] {
  return windows.filter((window) => !window.isDestroyed() && window.isVisible())
}

function restoreHiddenWindows(windows: ScreenCaptureWindow[]): void {
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.show()
    }
  }

  const focusTarget = windows.find((window) => !window.isDestroyed())
  focusTarget?.focus()
}

export async function captureScreenAttachment(
  input: CaptureScreenAttachmentInput,
): Promise<ScreenCaptureAttachment | null> {
  const platform = input.platform ?? process.platform
  if (platform !== 'darwin') {
    throw new Error('Screen capture attachments are only available on macOS.')
  }

  const capture = input.capture ?? captureMacOSScreenshot
  const statFile = input.statFile ?? fs.stat
  const wait = input.wait ?? defaultWait
  const hideDelayMs = input.hideDelayMs ?? SCREEN_CAPTURE_ATTACHMENT_HIDE_DELAY_MS
  const now = input.now ?? (() => new Date())
  const visibleWindows = collectVisibleWindows(input.getWindows())
  const hiddenWindows: ScreenCaptureWindow[] = []

  try {
    for (const window of visibleWindows) {
      if (!window.isDestroyed()) {
        window.hide()
        hiddenWindows.push(window)
      }
    }

    if (hiddenWindows.length > 0 && hideDelayMs > 0) {
      await wait(hideDelayMs)
    }

    const result = await capture({
      target: 'full_screen',
      destinationDirectory: path.join(input.assetDirectory, 'screenshots'),
      fileName: buildScreenCaptureFileName(now()),
    })

    if (!result) {
      return null
    }

    const stats = await statFile(result.path)
    return {
      kind: 'image',
      name: path.basename(result.path),
      size: stats.size,
      path: result.path,
      previewUrl: result.fileUrl,
      mediaType: 'image/png',
      source: 'file',
    }
  } finally {
    restoreHiddenWindows(hiddenWindows)
  }
}
