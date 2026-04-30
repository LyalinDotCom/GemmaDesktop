import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeMediaPermissionRequest,
  requestBrowserMediaPermission,
} from '../src/renderer/src/components/DoctorPanel'

describe('Doctor media permission requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as { navigator?: unknown }).navigator
  })

  it('tells the user to open Settings after macOS reports a denied microphone request', () => {
    expect(describeMediaPermissionRequest('microphone', {
      granted: false,
      status: 'denied',
      previousStatus: 'not-determined',
      prompted: true,
      requiresSettings: true,
    })).toBe(
      'Microphone access is blocked. Open System Settings > Privacy & Security > Microphone and enable Gemma Desktop, then try again.',
    )
  })

  it('explains the no-prompt camera case when browser media access cannot be requested', () => {
    expect(describeMediaPermissionRequest('camera', {
      granted: false,
      status: 'not-determined',
      previousStatus: 'not-determined',
      prompted: true,
      requiresSettings: false,
    }, 'media devices are unavailable in this window')).toBe(
      'Camera access was not granted (media devices are unavailable in this window). If no macOS prompt appeared, open System Settings > Privacy & Security > Camera and check whether Gemma Desktop is listed.',
    )
  })

  it('explains when the native camera request timed out before browser media could prompt', () => {
    expect(describeMediaPermissionRequest('camera', {
      granted: false,
      status: 'not-determined',
      previousStatus: 'not-determined',
      prompted: true,
      timedOut: true,
      requiresSettings: false,
    }, 'Permission dismissed')).toBe(
      'Camera access did not finish through macOS (Permission dismissed). Open System Settings > Privacy & Security > Camera and check whether Gemma Desktop is listed.',
    )
  })

  it('requests microphone access through getUserMedia and stops the temporary stream', async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }))
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia,
        },
      },
    })

    await expect(requestBrowserMediaPermission('microphone')).resolves.toEqual({
      granted: true,
    })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('requests camera access through getUserMedia and reports failures', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('Permission dismissed')
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia,
        },
      },
    })

    await expect(requestBrowserMediaPermission('camera')).resolves.toEqual({
      granted: false,
      error: 'Permission dismissed',
    })
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false })
  })

  it('times out a hanging browser camera prompt', async () => {
    vi.useFakeTimers()
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}))
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia,
        },
      },
    })

    const pending = requestBrowserMediaPermission('camera')
    await vi.advanceTimersByTimeAsync(4000)

    await expect(pending).resolves.toEqual({
      granted: false,
      error: 'camera prompt timed out',
    })
    vi.useRealTimers()
  })
})
