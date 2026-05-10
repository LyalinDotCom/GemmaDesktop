import { execFile } from 'child_process'
import { stat, mkdir } from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { systemPreferences } from 'electron'

export type MacOSScreenPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export type MacOSScreenshotTarget = 'full_screen' | 'window'

export interface CaptureMacOSScreenshotInput {
  target: MacOSScreenshotTarget
  destinationDirectory: string
  fileName?: string
  includeWindowShadow?: boolean
}

export interface CaptureMacOSScreenshotResult {
  permissionStatus: MacOSScreenPermissionStatus
  target: MacOSScreenshotTarget
  path: string
  fileUrl: string
  markdownImageTag: string
}

const DEFAULT_CAPTURE_FORMAT = '.png'

function sanitizeCaptureName(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const safe = trimmed.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.length > 0 ? safe : 'capture'
}

function formatTimestampForFileName(now = new Date()): string {
  const iso = now.toISOString()
  return iso.replace(/[:]/g, '-').replace(/\..+$/, '')
}

function getScreenPermissionStatus(): MacOSScreenPermissionStatus {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }

  return systemPreferences.getMediaAccessStatus('screen')
}

function runScreencapture(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'screencapture',
      args,
      {
        maxBuffer: 1024 * 1024 * 4,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = `${stdout}\n${stderr}`.trim()
          reject(new Error(details.length > 0 ? details : error.message))
          return
        }

        resolve()
      },
    )
  })
}

async function ensureCaptureDirectory(target: string): Promise<string> {
  const resolved = path.resolve(target)
  await mkdir(resolved, { recursive: true })
  return resolved
}

function buildCapturePath(
  destinationDirectory: string,
  input: Pick<CaptureMacOSScreenshotInput, 'target' | 'fileName'>,
): string {
  const baseName = input.fileName?.trim().length
    ? input.fileName.trim()
    : input.target === 'window'
      ? `window-${formatTimestampForFileName()}`
      : `screen-${formatTimestampForFileName()}`

  const sanitizedBaseName = sanitizeCaptureName(baseName)
  const fileName = sanitizedBaseName.endsWith(DEFAULT_CAPTURE_FORMAT)
    ? sanitizedBaseName
    : `${sanitizedBaseName}${DEFAULT_CAPTURE_FORMAT}`

  return path.join(destinationDirectory, fileName)
}

export function buildMacOSScreencaptureArgs(
  input: Pick<CaptureMacOSScreenshotInput, 'target' | 'includeWindowShadow'>,
  capturePath: string,
): string[] {
  if (input.target === 'full_screen') {
    return ['-x', '-m', capturePath]
  }

  const args = ['-x', '-i', '-w', '-W']

  if (input.includeWindowShadow === false) {
    args.push('-o')
  }

  args.push(capturePath)
  return args
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function isLikelyUserCancelled(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''

  return /\bcancel(?:led)?\b/i.test(message) || /\b-128\b/.test(message)
}

function buildPermissionError(permissionStatus: MacOSScreenPermissionStatus): Error | null {
  if (permissionStatus === 'denied' || permissionStatus === 'restricted') {
    return new Error(
      'macOS Screen Recording access must be granted to Gemma Desktop before screenshots can succeed.',
    )
  }

  return null
}

export async function captureMacOSScreenshot(
  input: CaptureMacOSScreenshotInput,
): Promise<CaptureMacOSScreenshotResult | null> {
  if (process.platform !== 'darwin') {
    throw new Error('macOS screenshots are only available on macOS.')
  }

  const permissionStatus = getScreenPermissionStatus()
  const permissionError = buildPermissionError(permissionStatus)
  if (permissionError) {
    throw permissionError
  }

  const destinationDirectory = await ensureCaptureDirectory(input.destinationDirectory)
  const capturePath = buildCapturePath(destinationDirectory, input)
  const args = buildMacOSScreencaptureArgs(input, capturePath)

  try {
    await runScreencapture(args)
  } catch (error) {
    if (
      input.target === 'window'
      && isLikelyUserCancelled(error)
      && !(await fileExists(capturePath))
    ) {
      return null
    }

    throw error
  }

  if (!(await fileExists(capturePath))) {
    if (input.target === 'window') {
      return null
    }

    throw new Error('Screenshot capture completed without producing a file.')
  }

  return {
    permissionStatus,
    target: input.target,
    path: capturePath,
    fileUrl: pathToFileURL(capturePath).toString(),
    markdownImageTag:
      input.target === 'window'
        ? `![Window screenshot](${capturePath})`
        : `![Full screen screenshot](${capturePath})`,
  }
}
