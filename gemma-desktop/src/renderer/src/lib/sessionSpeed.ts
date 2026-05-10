import type { DebugLogEntry, SessionSpeedStats } from '@/types'

const RECENT_SAMPLE_SIZE = 5

interface SessionTurnMetricLog {
  tokensPerSecond?: unknown
  estimated?: unknown
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

export function buildSessionSpeedStats(
  logs: DebugLogEntry[],
): SessionSpeedStats {
  const metricLogs = logs
    .filter((log) => log.event === 'sessions.turn.metrics')
    .map((log) => log.data as SessionTurnMetricLog)

  const samples = metricLogs
    .map((metric) => ({
      tps: metric.tokensPerSecond,
      estimated: Boolean(metric.estimated),
    }))
    .filter(
      (metric): metric is { tps: number; estimated: boolean } =>
        isFiniteNumber(metric.tps) && metric.tps > 0,
    )

  if (samples.length === 0) {
    return {
      recentTps: null,
      averageTps: null,
      slowestTps: null,
      fastestTps: null,
      sampleCount: 0,
      recentSampleCount: 0,
      hasEstimatedSamples: false,
    }
  }

  const values = samples.map((sample) => sample.tps)
  const recentValues = values.slice(-RECENT_SAMPLE_SIZE)

  return {
    recentTps: roundToSingleDecimal(average(recentValues)),
    averageTps: roundToSingleDecimal(average(values)),
    slowestTps: roundToSingleDecimal(Math.min(...values)),
    fastestTps: roundToSingleDecimal(Math.max(...values)),
    sampleCount: values.length,
    recentSampleCount: recentValues.length,
    hasEstimatedSamples: samples.some((sample) => sample.estimated),
  }
}
