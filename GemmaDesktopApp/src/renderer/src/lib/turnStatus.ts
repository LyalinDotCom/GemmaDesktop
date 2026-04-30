import type { MessageContent } from '@/types'

function clampDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) {
    return 0
  }

  return Math.max(durationMs, 0)
}

export function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.floor(clampDurationMs(durationMs) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.floor(clampDurationMs(durationMs) / 1000)

  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`
}

export interface TurnDurationLabelParts {
  label: string
  statusLabel?: 'Failed' | 'Stopped'
  modelLabel?: string
  elapsedLabel: string
}

export function buildTurnDurationLabelParts(
  content: MessageContent[],
  durationMs?: number,
  modelLabel?: string | null,
): TurnDurationLabelParts | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return null
  }

  const elapsedLabel = formatCompactDuration(durationMs)
  const normalizedModelLabel = modelLabel?.trim() || undefined
  const durationText = normalizedModelLabel
    ? `${normalizedModelLabel} in ${elapsedLabel}`
    : elapsedLabel
  const failed = content.some((block) => block.type === 'error')
  const stopped = content.some(
    (block) =>
      block.type === 'warning'
      && block.message === 'Generation stopped before completion.',
  )

  const statusLabel = failed ? 'Failed' : stopped ? 'Stopped' : undefined
  const label = statusLabel ? `${statusLabel} · ${durationText}` : durationText

  return {
    label,
    ...(statusLabel ? { statusLabel } : {}),
    ...(normalizedModelLabel ? { modelLabel: normalizedModelLabel } : {}),
    elapsedLabel,
  }
}

export function buildTurnDurationLabel(
  content: MessageContent[],
  durationMs?: number,
  modelLabel?: string | null,
): string | null {
  const parts = buildTurnDurationLabelParts(content, durationMs, modelLabel)
  if (!parts) {
    return null
  }

  return parts.label
}
