import type {
  ToolProgressEntry,
  ToolWorkerDetail,
} from '@/types'

export interface WorkerMetricItem {
  label: string
  value: string
}

export interface WorkerResultSection {
  label: string
  values: string[]
}

export function summarizeToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ''

  for (const [, value] of entries) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 80 ? `${value.slice(0, 77)}...` : value
    }
  }

  const [key, value] = entries[0]!
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}: ${serialized.length > 60 ? `${serialized.slice(0, 57)}...` : serialized}`
}

export function buildToolBlockCollapsedSummary(args: {
  worker?: ToolWorkerDetail
  progressEntries?: ToolProgressEntry[]
  summary?: string
  input: Record<string, unknown>
}): string | undefined {
  const { worker, progressEntries = [], summary, input } = args
  return (
    worker?.currentAction
    ?? progressEntries[progressEntries.length - 1]?.label
    ?? worker?.resultSummary
    ?? summary
    ?? summarizeToolInput(input)
  )
}

export function deriveToolBlockAutoExpansion(args: {
  expanded: boolean
  fullHeight: boolean
  isActive: boolean
  autoExpandWhenActive: boolean
  userToggled: boolean
}): { expanded: boolean; fullHeight: boolean } | null {
  const {
    expanded,
    fullHeight,
    isActive,
    autoExpandWhenActive,
    userToggled,
  } = args

  if (userToggled) {
    return null
  }

  if (!autoExpandWhenActive) {
    return !isActive && expanded
      ? { expanded: false, fullHeight: false }
      : null
  }

  if (isActive && !expanded) {
    return { expanded: true, fullHeight }
  }

  if (!isActive && expanded) {
    return { expanded: false, fullHeight: false }
  }

  return null
}

export function buildWorkerMetricItems(worker?: ToolWorkerDetail): WorkerMetricItem[] {
  const counters = worker?.counters ?? {}
  const metrics: WorkerMetricItem[] = []

  const pushMetric = (label: string, value: number | undefined) => {
    if (typeof value !== 'number' || value <= 0) {
      return
    }
    metrics.push({
      label,
      value: String(value),
    })
  }

  pushMetric('Searches', counters.searchQueries)
  pushMetric('Fetched', counters.fetchedSources)
  pushMetric('Sources', counters.sourcesUsed)
  pushMetric('Evidence', counters.evidenceCount)
  pushMetric('Files', counters.filesChanged)
  pushMetric('Commands', counters.commandsRun)
  pushMetric('Tool calls', counters.toolCalls)
  pushMetric('Tool results', counters.toolResults)
  pushMetric('Assistant', counters.assistantUpdates)
  pushMetric('Reasoning', counters.reasoningUpdates)
  pushMetric('Runtime', counters.lifecycleEvents)

  return metrics
}

export function buildWorkerResultSections(worker?: ToolWorkerDetail): WorkerResultSection[] {
  if (!worker?.resultData) {
    return []
  }

  const sections: WorkerResultSection[] = []

  if (worker.resultData.sources && worker.resultData.sources.length > 0) {
    sections.push({
      label: 'Sources',
      values: worker.resultData.sources,
    })
  }

  if (worker.resultData.evidence && worker.resultData.evidence.length > 0) {
    sections.push({
      label: 'Evidence',
      values: worker.resultData.evidence,
    })
  }

  if (worker.resultData.filesChanged && worker.resultData.filesChanged.length > 0) {
    sections.push({
      label: 'Files changed',
      values: worker.resultData.filesChanged,
    })
  }

  if (worker.resultData.commands && worker.resultData.commands.length > 0) {
    sections.push({
      label: 'Commands',
      values: worker.resultData.commands.map((entry) =>
        entry.cwd ? `${entry.command} (${entry.cwd})` : entry.command,
      ),
    })
  }

  return sections
}

export function buildWorkerTechnicalDetails(worker?: ToolWorkerDetail): Array<{
  label: string
  value: string
}> {
  if (!worker) {
    return []
  }

  return [
    worker.childSessionId
      ? { label: 'Child session', value: worker.childSessionId }
      : null,
    worker.childTurnId
      ? { label: 'Child turn', value: worker.childTurnId }
      : null,
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry))
}
