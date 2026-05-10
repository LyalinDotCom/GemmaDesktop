/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useReadAloudPlayer,
  type ReadAloudButtonState,
  type ReadAloudPlaybackControls,
} from '../../src/renderer/src/hooks/useReadAloudPlayer'
import type { ChatMessage } from '../../src/renderer/src/types'

const readyReadAloudStatus = {
  supported: true,
  enabled: true,
  provider: 'kokoro-js',
  providerLabel: 'Kokoro',
  model: 'Kokoro-82M-v1.0-ONNX',
  modelLabel: 'Kokoro 82M',
  dtype: 'q8',
  backend: 'cpu',
  state: 'ready',
  healthy: true,
  busy: false,
  detail: 'Kokoro ready.',
  lastError: null,
  assetRoot: '/tmp/read-aloud-assets/Kokoro-82M-v1.0-ONNX',
  cacheDir: '/tmp/read-aloud-cache',
  bundledBytes: 1,
  installProgress: null,
  checkedAt: '2026-04-27T00:00:00.000Z',
} as const

const assistantMessage: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: [{ type: 'text', text: 'This should be spoken aloud.' }],
  timestamp: 1_700_000_000_000,
}

class MockAudio {
  currentTime = 0
  duration = 1.25
  ended = false
  ondurationchange: (() => void) | null = null
  onended: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onpause: (() => void) | null = null
  onplay: (() => void) | null = null
  onseeked: (() => void) | null = null
  onseeking: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  preload = ''
  seeking = false
  src = ''

  static playMock = vi.fn<() => Promise<void>>()
  static pauseMock = vi.fn()
  static loadMock = vi.fn()

  load() {
    MockAudio.loadMock()
    this.onloadedmetadata?.()
  }

  pause() {
    MockAudio.pauseMock()
    this.onpause?.()
  }

  play() {
    return MockAudio.playMock().then(() => {
      this.onplay?.()
    })
  }
}

function HookHarness(props: {
  onRender: (state: {
    buttonState: ReadAloudButtonState
    playbackControls: ReadAloudPlaybackControls
  }) => void
}) {
  const player = useReadAloudPlayer({
    enabled: true,
    defaultVoice: 'af_heart',
    speed: 1,
    status: readyReadAloudStatus,
  })

  props.onRender({
    buttonState: player.buildButtonState(assistantMessage),
    playbackControls: player.playbackControls,
  })

  return null
}

describe('read aloud player', () => {
  let container: HTMLDivElement
  let root: Root
  let latestState: {
    buttonState: ReadAloudButtonState
    playbackControls: ReadAloudPlaybackControls
  } | null

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    latestState = null

    MockAudio.playMock = vi.fn(async () => {})
    MockAudio.pauseMock = vi.fn()
    MockAudio.loadMock = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('Audio', MockAudio)
    vi.stubGlobal('gemmaDesktopBridge', {
      readAloud: {
        cancelCurrent: vi.fn(async () => ({ ok: true })),
        synthesize: vi.fn(async () => ({
          audioPath: '/tmp/gemma-read-aloud.wav',
          fromCache: false,
          durationMs: 1250,
          voice: 'af_heart',
          speed: 1,
          textHash: 'hash',
        })),
      },
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  })

  it('keeps synthesized audio available when autoplay is blocked', async () => {
    MockAudio.playMock = vi.fn(async () => {
      throw new DOMException('Playback requires a user gesture.', 'NotAllowedError')
    })

    await act(async () => {
      root.render(createElement(HookHarness, {
        onRender: (state) => {
          latestState = state
        },
      }))
    })

    await act(async () => {
      latestState?.buttonState.onClick?.()
    })

    await vi.waitFor(() => {
      expect(latestState?.playbackControls.phase).toBe('paused')
    })

    expect(latestState?.playbackControls.visible).toBe(true)
    expect(latestState?.playbackControls.label).toBe('Reading response aloud')
    expect(latestState?.playbackControls.durationSec).toBe(1.25)
    expect(MockAudio.loadMock).toHaveBeenCalledTimes(1)
    expect(MockAudio.playMock).toHaveBeenCalledTimes(1)
  })
})
