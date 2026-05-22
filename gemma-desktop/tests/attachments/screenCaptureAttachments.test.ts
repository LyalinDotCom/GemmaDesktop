import { describe, expect, it } from 'vitest'
import {
  captureScreenAttachment,
  type ScreenCaptureWindow,
} from '../../src/main/screenCaptureAttachments'

class FakeWindow implements ScreenCaptureWindow {
  public calls: string[] = []

  constructor(
    private visible = true,
    private destroyed = false,
  ) {}

  isVisible(): boolean {
    return this.visible
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  hide(): void {
    this.calls.push('hide')
    this.visible = false
  }

  show(): void {
    this.calls.push('show')
    this.visible = true
  }

  focus(): void {
    this.calls.push('focus')
  }
}

describe('screen capture attachments', () => {
  it('hides visible app windows, captures the screen, and restores focus', async () => {
    const visibleWindow = new FakeWindow(true)
    const hiddenWindow = new FakeWindow(false)
    const destroyedWindow = new FakeWindow(true, true)
    const events: string[] = []

    const result = await captureScreenAttachment({
      assetDirectory: '/tmp/project/.gemma/session-state/session-1/assets',
      platform: 'darwin',
      hideDelayMs: 5,
      now: () => new Date('2026-05-21T12:34:56.789Z'),
      getWindows: () => [visibleWindow, hiddenWindow, destroyedWindow],
      wait: async (durationMs) => {
        events.push(`wait:${durationMs}`)
      },
      capture: async (input) => {
        events.push(input.target)
        expect(visibleWindow.isVisible()).toBe(false)
        expect(input.destinationDirectory).toBe(
          '/tmp/project/.gemma/session-state/session-1/assets/screenshots',
        )
        expect(input.fileName).toBe('screen-2026-05-21T12-34-56-789Z')
        return {
          permissionStatus: 'granted',
          target: 'full_screen',
          path: '/tmp/project/.gemma/session-state/session-1/assets/screenshots/screen.png',
          fileUrl:
            'file:///tmp/project/.gemma/session-state/session-1/assets/screenshots/screen.png',
          markdownImageTag:
            '![](/tmp/project/.gemma/session-state/session-1/assets/screenshots/screen.png)',
        }
      },
      statFile: async () => ({ size: 4096 }),
    })

    expect(events).toEqual(['wait:5', 'full_screen'])
    expect(visibleWindow.calls).toEqual(['hide', 'show', 'focus'])
    expect(hiddenWindow.calls).toEqual([])
    expect(destroyedWindow.calls).toEqual([])
    expect(result).toEqual({
      kind: 'image',
      name: 'screen.png',
      size: 4096,
      path: '/tmp/project/.gemma/session-state/session-1/assets/screenshots/screen.png',
      previewUrl:
        'file:///tmp/project/.gemma/session-state/session-1/assets/screenshots/screen.png',
      mediaType: 'image/png',
      source: 'file',
    })
  })

  it('restores hidden windows when capture fails', async () => {
    const visibleWindow = new FakeWindow(true)

    await expect(
      captureScreenAttachment({
        assetDirectory: '/tmp/project/.gemma/session-state/session-1/assets',
        platform: 'darwin',
        hideDelayMs: 0,
        getWindows: () => [visibleWindow],
        capture: async () => {
          throw new Error('capture failed')
        },
      }),
    ).rejects.toThrow('capture failed')

    expect(visibleWindow.calls).toEqual(['hide', 'show', 'focus'])
  })

  it('rejects unsupported platforms before hiding any windows', async () => {
    const visibleWindow = new FakeWindow(true)

    await expect(
      captureScreenAttachment({
        assetDirectory: '/tmp/project/.gemma/session-state/session-1/assets',
        platform: 'linux',
        getWindows: () => [visibleWindow],
      }),
    ).rejects.toThrow('only available on macOS')

    expect(visibleWindow.calls).toEqual([])
  })
})
