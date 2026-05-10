export function clampPlaybackTime(nextTimeSec: number, durationSec: number): number {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const safeTime = Number.isFinite(nextTimeSec) ? nextTimeSec : 0
  return Math.max(0, Math.min(safeTime, safeDuration))
}

export function resolveSeekableDurationSec(input: {
  mediaDurationSec: number
  fallbackDurationSec: number
}): number {
  if (Number.isFinite(input.mediaDurationSec) && input.mediaDurationSec > 0) {
    return input.mediaDurationSec
  }

  if (Number.isFinite(input.fallbackDurationSec) && input.fallbackDurationSec > 0) {
    return input.fallbackDurationSec
  }

  return 0
}

export function resolveDisplayedPlaybackTime(input: {
  actualTimeSec: number
  pendingSeekTimeSec: number | null
  isSeeking: boolean
}): number {
  const actualTimeSec =
    Number.isFinite(input.actualTimeSec) && input.actualTimeSec >= 0
      ? input.actualTimeSec
      : 0
  const pendingSeekTimeSec =
    typeof input.pendingSeekTimeSec === 'number' && Number.isFinite(input.pendingSeekTimeSec)
      ? Math.max(0, input.pendingSeekTimeSec)
      : null

  if (pendingSeekTimeSec == null) {
    return actualTimeSec
  }

  if (input.isSeeking) {
    return pendingSeekTimeSec
  }

  return Math.abs(actualTimeSec - pendingSeekTimeSec) <= 0.25
    ? actualTimeSec
    : pendingSeekTimeSec
}

export function resolvePlaybackTimeFromPointer(input: {
  clientX: number
  trackLeft: number
  trackWidth: number
  durationSec: number
}): number {
  const safeDuration = Number.isFinite(input.durationSec) && input.durationSec > 0
    ? input.durationSec
    : 0
  const safeWidth = Number.isFinite(input.trackWidth) && input.trackWidth > 0
    ? input.trackWidth
    : 0

  if (safeDuration <= 0 || safeWidth <= 0) {
    return 0
  }

  const ratio = (input.clientX - input.trackLeft) / safeWidth
  return clampPlaybackTime(ratio * safeDuration, safeDuration)
}

export function resolveKeyboardSeekTarget(input: {
  key: string
  currentTimeSec: number
  durationSec: number
}): number | null {
  const durationSec =
    Number.isFinite(input.durationSec) && input.durationSec > 0
      ? input.durationSec
      : 0

  if (durationSec <= 0) {
    return null
  }

  const currentTimeSec = clampPlaybackTime(input.currentTimeSec, durationSec)
  const fineStepSec = durationSec <= 30 ? 1 : durationSec <= 300 ? 5 : 10
  const coarseStepSec = Math.max(fineStepSec * 3, 15)

  switch (input.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampPlaybackTime(currentTimeSec - fineStepSec, durationSec)
    case 'ArrowRight':
    case 'ArrowUp':
      return clampPlaybackTime(currentTimeSec + fineStepSec, durationSec)
    case 'PageDown':
      return clampPlaybackTime(currentTimeSec - coarseStepSec, durationSec)
    case 'PageUp':
      return clampPlaybackTime(currentTimeSec + coarseStepSec, durationSec)
    case 'Home':
      return 0
    case 'End':
      return durationSec
    default:
      return null
  }
}
