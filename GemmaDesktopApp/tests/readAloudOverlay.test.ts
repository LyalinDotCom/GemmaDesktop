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

  it('renders the equalizer indicator and pulsing thumb while playing', () => {
    const html = renderToStaticMarkup(
      createElement(ReadAloudPlaybackOverlay, {
        controls: {
          visible: true,
          phase: 'playing',
          label: 'Reading response aloud',
          currentTimeSec: 5,
          durationSec: 20,
          canSeek: true,
          togglePlayPause: vi.fn(),
          seekTo: vi.fn(),
          dismiss: vi.fn(),
        },
      }),
    )

    expect(html).toContain('Now playing')
    expect(html).toContain('read-aloud-equalizer-bar')
    expect(html).toContain('read-aloud-thumb-pulse')
    expect(html).toContain('aria-label="Pause read aloud playback"')
  })

  it('uses the cosmic variant styling when requested', () => {
    const html = renderToStaticMarkup(
      createElement(ReadAloudPlaybackOverlay, {
        variant: 'cosmic',
        controls: {
          visible: true,
          phase: 'playing',
          label: 'Gemma speaking',
          currentTimeSec: 4,
          durationSec: 16,
          canSeek: true,
          togglePlayPause: vi.fn(),
          seekTo: vi.fn(),
          dismiss: vi.fn(),
        },
      }),
    )

    expect(html).toContain('data-variant="cosmic"')
    expect(html).toContain('bg-cyan-300')
    expect(html).toContain('read-aloud-thumb-pulse-cosmic')
    expect(html).not.toContain('bg-indigo-500')
  })

  it('defaults to the chat variant when no variant is provided', () => {
    const html = renderToStaticMarkup(
      createElement(ReadAloudPlaybackOverlay, {
        controls: {
          visible: true,
          phase: 'paused',
          label: 'Reading selected text aloud',
          currentTimeSec: 1,
          durationSec: 10,
          canSeek: true,
          togglePlayPause: vi.fn(),
          seekTo: vi.fn(),
          dismiss: vi.fn(),
        },
      }),
    )

    expect(html).toContain('data-variant="chat"')
    expect(html).toContain('bg-indigo-600')
    expect(html).not.toContain('bg-cyan-300')
  })
})
