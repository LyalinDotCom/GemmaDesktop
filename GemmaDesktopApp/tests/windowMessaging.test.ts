import { describe, expect, it, vi } from 'vitest'
import {
  broadcastToWindows,
  isRendererUnavailableError,
  sendToWindow,
} from '../src/main/windowMessaging'

function createWindow(options?: {
  windowDestroyed?: boolean
  contentsDestroyed?: boolean
  frameDestroyed?: boolean
  crashed?: boolean
  sendImpl?: (channel: string, payload: unknown) => void
}) {
  const send = vi.fn(options?.sendImpl ?? (() => {}))

  return {
    isDestroyed: () => options?.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options?.contentsDestroyed ?? false,
      isCrashed: () => options?.crashed ?? false,
      mainFrame: {
        isDestroyed: () => options?.frameDestroyed ?? false,
      },
      send,
    },
  }
}

describe('window messaging', () => {
  it('recognizes renderer disposal errors', () => {
    expect(
      isRendererUnavailableError(
        new Error('Render frame was disposed before WebFrameMain could be accessed'),
      ),
    ).toBe(true)
    expect(isRendererUnavailableError(new Error('Object has been destroyed'))).toBe(
      true,
    )
    expect(isRendererUnavailableError(new Error('Something else happened'))).toBe(
      false,
    )
  })

  it('skips windows whose renderer frame is already gone', () => {
    const win = createWindow({ frameDestroyed: true })

    expect(sendToWindow(win, 'session:event:test', { ok: true }, 'test event')).toBe(
      false,
    )
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('swallows disposed-frame send failures', () => {
    const win = createWindow({
      sendImpl: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    })

    expect(sendToWindow(win, 'session:event:test', { ok: true }, 'test event')).toBe(
      false,
    )
  })

  it('continues broadcasting after one dead renderer', () => {
    const dead = createWindow({
      sendImpl: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
    })
    const live = createWindow()

    const delivered = broadcastToWindows(
      [dead, live],
      'session:event:test',
      { ok: true },
      'test broadcast',
    )

    expect(delivered).toBe(1)
    expect(live.webContents.send).toHaveBeenCalledWith('session:event:test', {
      ok: true,
    })
  })
})
