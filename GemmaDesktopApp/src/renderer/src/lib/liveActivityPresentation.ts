import type { LiveActivitySnapshot } from '@/types'

export const STALE_ACTIVITY_MS = 45_000

export interface LiveActivityMetric {
  label: string
  value: string
}

export interface LiveActivityPresentation {
  label: string
  detail: string
  note: string
  elapsedLabel: string
  stale: boolean
  tone: 'streaming' | 'thinking' | 'working' | 'starting'
  metrics: LiveActivityMetric[]
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function formatElapsedShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
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
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function formatStageLabel(stage: LiveActivitySnapshot['stage']): string | null {
  switch (stage) {
    case 'planning':
      return 'Planning'
    case 'discovery':
      return 'Discovering'
    case 'workers':
      return 'Researching'
    case 'synthesis':
      return 'Synthesizing'
    case undefined:
      return null
    default:
      return null
  }
}

export function deriveLiveActivityLabel(
  activity: LiveActivitySnapshot,
  now: number,
): string {
  const referenceTimestamp = activity.lastEventAt ?? activity.startedAt
  const stale = Math.max(now - referenceTimestamp, 0) >= STALE_ACTIVITY_MS

  if (stale) {
    return 'Still working'
  }

  if (activity.activeToolLabel) {
    return activity.activeToolLabel
  }

  if (activity.state === 'streaming') {
    return 'Streaming reply'
  }

  if (activity.state === 'thinking') {
    return 'Thinking'
  }

  if (activity.state === 'waiting') {
    return 'Starting'
  }

  return formatStageLabel(activity.stage) ?? 'Working'
}

function buildDetail(activity: LiveActivitySnapshot): string {
  if (activity.activeToolName) {
    return activity.activeToolName.replace(/[._-]+/g, ' ')
  }

  if (activity.source === 'research') {
    return 'deep research'
  }

  return 'session turn'
}

function buildNote(
  activity: LiveActivitySnapshot,
  now: number,
  stale: boolean,
): string {
  const referenceTimestamp = activity.lastEventAt ?? activity.startedAt
  const sinceLastVisible = Math.max(now - referenceTimestamp, 0)

  if (stale) {
    return `No visible update for ${formatElapsedShort(sinceLastVisible)}, still active.`
  }

  if (activity.activeToolLabel) {
    return `${activity.activeToolLabel} is in progress.`
  }

  if (activity.state === 'streaming') {
    return 'Visible output is arriving.'
  }

  if (activity.state === 'thinking') {
    return 'Reasoning updates are still arriving.'
  }

  return 'The run is active and waiting on the next visible update.'
}

function buildTone(
  activity: LiveActivitySnapshot,
  label: string,
): LiveActivityPresentation['tone'] {
  if (label === 'Streaming reply') {
    return 'streaming'
  }

  if (activity.state === 'thinking') {
    return 'thinking'
  }

  if (label === 'Starting') {
    return 'starting'
  }

  return 'working'
}

export function buildLiveActivityMetrics(
  activity: LiveActivitySnapshot,
  now: number,
  label: string,
): LiveActivityMetric[] {
  const metrics: LiveActivityMetric[] = [
    {
      label: 'Status',
      value: label,
    },
    {
      label: 'Elapsed',
      value: formatElapsedShort(Math.max(now - activity.startedAt, 0)),
    },
    {
      label: 'Last visible',
      value: activity.lastEventAt != null
        ? `${formatElapsedShort(Math.max(now - activity.lastEventAt, 0))} ago`
        : 'No visible events yet',
    },
    {
      label: 'First token',
      value: activity.firstTokenAt != null
        ? formatElapsedShort(Math.max(activity.firstTokenAt - activity.startedAt, 0))
        : 'Not yet',
    },
    {
      label: 'Assistant updates',
      value: formatCount(activity.assistantUpdates, 'chunk'),
    },
    {
      label: 'Reasoning updates',
      value: formatCount(activity.reasoningUpdates, 'chunk'),
    },
    {
      label: 'Running tools',
      value: formatCount(activity.runningToolCount, 'tool'),
    },
    {
      label: 'Completed tools',
      value: formatCount(activity.completedToolCount, 'tool'),
    },
    {
      label: 'Progress events',
      value: formatCount(activity.recentProgressCount, 'event'),
    },
  ]

  if (activity.activeToolLabel) {
    metrics.splice(4, 0, {
      label: 'Active tool',
      value: activity.activeToolName
        ? `${activity.activeToolLabel} (${activity.activeToolName})`
        : activity.activeToolLabel,
    })
  }

  if (activity.lastProgressAt != null) {
    metrics.push({
      label: 'Last progress',
      value: `${formatElapsedShort(Math.max(now - activity.lastProgressAt, 0))} ago`,
    })
  }

  return metrics
}

export function buildLiveActivityPresentation(
  activity: LiveActivitySnapshot,
  now: number,
): LiveActivityPresentation {
  const label = deriveLiveActivityLabel(activity, now)
  const stale = label === 'Still working'

  return {
    label,
    detail: buildDetail(activity),
    note: buildNote(activity, now, stale),
    elapsedLabel: formatElapsedShort(Math.max(now - activity.startedAt, 0)),
    stale,
    tone: buildTone(activity, label),
    metrics: buildLiveActivityMetrics(activity, now, label),
  }
}
