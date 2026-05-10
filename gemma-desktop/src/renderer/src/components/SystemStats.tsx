import { Activity, Cpu, HardDrive } from 'lucide-react'
import type { SystemStats as SystemStatsType, SessionContext } from '@/types'

interface SystemStatsProps {
  stats: SystemStatsType
  context: SessionContext
}

function ProgressBar({
  value,
  max,
  color,
}: {
  value: number
  max: number
  color: string
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="h-1 w-12 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function mixColor(start: number[], end: number[], amount: number) {
  return start.map((channel, index) =>
    Math.round(channel + ((end[index] ?? channel) - channel) * amount),
  )
}

function getContextMeterColor(percent: number) {
  const clamped = Math.max(0, Math.min(percent, 100))
  const gray = [161, 161, 170]
  const yellow = [245, 158, 11]
  const red = [239, 68, 68]

  if (clamped <= 60) {
    const [r, g, b] = mixColor(gray, yellow, clamped / 60)
    return `rgb(${r}, ${g}, ${b})`
  }

  const [r, g, b] = mixColor(yellow, red, (clamped - 60) / 40)
  return `rgb(${r}, ${g}, ${b})`
}

function CircularProgress({
  value,
  max,
  color,
  title,
}: {
  value: number
  max: number
  color: string
  title: string
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (pct / 100) * circumference

  return (
    <div
      className="flex h-5 w-5 items-center justify-center"
      title={title}
      aria-label={title.replace(/\n/g, ' ')}
      role="img"
    >
      <svg
        className="-rotate-90 overflow-visible"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="2"
          className="stroke-zinc-300 dark:stroke-zinc-700"
        />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-all duration-200"
          style={{ stroke: color }}
        />
      </svg>
    </div>
  )
}

export function SystemStats({ stats, context }: SystemStatsProps) {
  const memPct =
    stats.memoryTotalGB > 0
      ? Math.round((stats.memoryUsedGB / stats.memoryTotalGB) * 100)
      : 0

  const ctxPct =
    context.contextLength > 0
      ? Math.round((context.tokensUsed / context.contextLength) * 100)
      : 0

  const contextTitle = [
    `Context: ~${Math.round(context.tokensUsed)} / ${context.contextLength} tokens (${ctxPct}%)`,
    context.source === 'request-preview'
      ? 'Based on the current session request preview, including system prompt, history, and active tool schemas.'
      : 'Based on the visible session history because the session request preview is not loaded yet.',
  ].join('\n')
  const contextColor = getContextMeterColor(ctxPct)

  const tpsTitle = context.speed.recentTps != null
    ? [
        `TPS: ${context.speed.recentTps.toFixed(1)} tok/s recent average`,
        `Recent turns: ${context.speed.recentSampleCount}`,
        `Session average: ${context.speed.averageTps?.toFixed(1) ?? 'n/a'} tok/s`,
        `Fastest: ${context.speed.fastestTps?.toFixed(1) ?? 'n/a'} tok/s`,
        `Slowest: ${context.speed.slowestTps?.toFixed(1) ?? 'n/a'} tok/s`,
        `Measured turns: ${context.speed.sampleCount}`,
        context.speed.hasEstimatedSamples
          ? 'Some samples were estimated when the runtime did not report token usage.'
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    : 'TPS: no completed turns with measurable output yet'

  return (
    <div className="flex items-center gap-3 text-[11px] text-zinc-500">
      {/* RAM */}
      <div className="flex items-center gap-1.5" title={`RAM: ${stats.memoryUsedGB}/${stats.memoryTotalGB} GB`}>
        <HardDrive size={11} />
        <span>
          {stats.memoryUsedGB}/{stats.memoryTotalGB}GB
        </span>
        <ProgressBar
          value={stats.memoryUsedGB}
          max={stats.memoryTotalGB}
          color={memPct > 85 ? 'bg-red-500' : memPct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}
        />
      </div>

      {/* GPU */}
      <div className="flex items-center gap-1.5" title={`GPU: ${stats.gpuUsagePercent}%`}>
        <Cpu size={11} />
        <span>GPU {stats.gpuUsagePercent}%</span>
      </div>

      {/* Context */}
      <div className="flex items-center">
        <CircularProgress
          value={context.tokensUsed}
          max={context.contextLength}
          color={contextColor}
          title={contextTitle}
        />
      </div>

      <div className="flex items-center gap-1.5" title={tpsTitle}>
        <Activity size={11} />
        <span>
          TPS {context.speed.recentTps != null ? context.speed.recentTps.toFixed(1) : '--'}
        </span>
      </div>
    </div>
  )
}
