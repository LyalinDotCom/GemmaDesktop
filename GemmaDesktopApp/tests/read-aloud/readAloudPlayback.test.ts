import { describe, expect, it } from 'vitest'
import {
  clampPlaybackTime,
  resolveDisplayedPlaybackTime,
  resolveKeyboardSeekTarget,
  resolvePlaybackTimeFromPointer,
  resolveSeekableDurationSec,
} from '../../src/renderer/src/lib/readAloudPlayback'

describe('read aloud playback helpers', () => {
  it('maps pointer position to a clamped playback time', () => {
    expect(resolvePlaybackTimeFromPointer({
      clientX: 75,
      trackLeft: 25,
      trackWidth: 100,
      durationSec: 60,
    })).toBe(30)
    expect(resolvePlaybackTimeFromPointer({
      clientX: 300,
      trackLeft: 25,
      trackWidth: 100,
      durationSec: 60,
    })).toBe(60)
  })

  it('keeps the pending seek target visible while media is still seeking', () => {
    expect(resolveDisplayedPlaybackTime({
      actualTimeSec: 12,
      pendingSeekTimeSec: 42,
      isSeeking: true,
    })).toBe(42)
  })

  it('falls back to the actual playback time after the seek has settled', () => {
    expect(resolveDisplayedPlaybackTime({
      actualTimeSec: 41.9,
      pendingSeekTimeSec: 42,
      isSeeking: false,
    })).toBe(41.9)
  })

  it('uses the known clip duration when media metadata is still catching up', () => {
    expect(resolveSeekableDurationSec({
      mediaDurationSec: 0,
      fallbackDurationSec: 42,
    })).toBe(42)
  })

  it('resolves keyboard seek shortcuts like a traditional media timeline', () => {
    expect(resolveKeyboardSeekTarget({
      key: 'ArrowRight',
      currentTimeSec: 10,
      durationSec: 120,
    })).toBe(15)
    expect(resolveKeyboardSeekTarget({
      key: 'End',
      currentTimeSec: 10,
      durationSec: 120,
    })).toBe(120)
  })

  it('clamps playback times to the known duration', () => {
    expect(clampPlaybackTime(80, 60)).toBe(60)
    expect(clampPlaybackTime(-5, 60)).toBe(0)
  })
})
