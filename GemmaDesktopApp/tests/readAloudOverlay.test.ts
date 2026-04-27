import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReadAloudPlaybackOverlay } from '../src/renderer/src/components/ReadAloudPlaybackOverlay'

describe('read aloud playback overlay', () => {
  it('renders transport controls for active playback', () => {
    const html = renderToStaticMarkup(
      createElement(ReadAloudPlaybackOverlay, {
        controls: {
          visible: true,
          phase: 'paused',
          label: 'Reading selected text aloud',
          currentTimeSec: 12,
          durationSec: 34,
          canSeek: true,
          togglePlayPause: vi.fn(),
          seekTo: vi.fn(),
          dismiss: vi.fn(),
        },
      }),
    )

    expect(html).toContain('Paused')
    expect(html).toContain('Reading selected text aloud')
    expect(html).toContain('aria-label="Resume read aloud playback"')
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-label="Read aloud playback position"')
    expect(html).toContain('aria-label="Stop read aloud playback"')
  })

  it('renders nothing when playback is hidden', () => {
    const html = renderToStaticMarkup(
      createElement(ReadAloudPlaybackOverlay, {
        controls: {
          visible: false,
          phase: 'idle',
          label: 'Read aloud',
          currentTimeSec: 0,
          durationSec: 0,
          canSeek: false,
          togglePlayPause: vi.fn(),
          seekTo: vi.fn(),
          dismiss: vi.fn(),
        },
      }),
    )

    expect(html).toBe('')
  })
})
