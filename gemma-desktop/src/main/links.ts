import fs from 'fs/promises'
import path from 'path'
import { shell } from 'electron'

const SAFE_EXTERNAL_PROTOCOLS = new Set([
  'file:',
  'http:',
  'https:',
  'mailto:',
  'tel:',
])

function parseUrl(target: string): URL | null {
  try {
    return new URL(target)
  } catch {
    return null
  }
}

function normalizeTarget(target: string): string {
  return target.trim()
}

export function isAbsoluteFilePath(target: string): boolean {
  return path.isAbsolute(target)
    || /^[a-zA-Z]:[\\/]/.test(target)
    || target.startsWith('\\\\')
}

export function normalizeSafeExternalUrl(target: string): string | null {
  const normalized = normalizeTarget(target)
  if (!normalized) {
    return null
  }

  const parsed = parseUrl(normalized)
  if (!parsed || !SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return null
  }

  return parsed.toString()
}

export function shouldOpenNavigationExternally(
  targetUrl: string,
  currentUrl: string,
): boolean {
  if (!targetUrl || targetUrl === currentUrl) {
    return false
  }

  const parsedTarget = parseUrl(targetUrl)
  if (!parsedTarget) {
    return false
  }

  const parsedCurrent = parseUrl(currentUrl)
  if (
    parsedCurrent
    && (parsedTarget.protocol === 'http:' || parsedTarget.protocol === 'https:')
    && parsedTarget.origin === parsedCurrent.origin
  ) {
    return false
  }

  return SAFE_EXTERNAL_PROTOCOLS.has(parsedTarget.protocol)
}

export async function openLinkTarget(target: string): Promise<boolean> {
  const normalized = normalizeTarget(target)
  if (!normalized || normalized.startsWith('#')) {
    return false
  }

  if (isAbsoluteFilePath(normalized)) {
    try {
      const resolvedPath = path.resolve(normalized)
      await fs.access(resolvedPath)
      const error = await shell.openPath(resolvedPath)
      if (error) {
        throw new Error(error)
      }
      return true
    } catch {
      return false
    }
  }

  const externalUrl = normalizeSafeExternalUrl(normalized)
  if (!externalUrl) {
    return false
  }

  await shell.openExternal(externalUrl)
  return true
}
