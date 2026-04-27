import { useEffect, useState } from 'react'
import type { SystemStats } from '@/types'

const SAMPLE_COUNT = 32
const SVG_WIDTH = 60
const SVG_HEIGHT = 14
const VERTICAL_PADDING = 1

interface GpuWaveProps {
  stats: SystemStats
}

export function GpuWave({ stats }: GpuWaveProps) {
  const [samples, setSamples] = useState<number[]>(() =>
    Array.from({ length: SAMPLE_COUNT }, () => 0),
  )

  useEffect(() => {
    const raw = stats.gpuUsagePercent
    const clamped = Math.max(
      0,
      Math.min(100, Number.isFinite(raw) ? raw : 0),
    )
    setSamples((prev) => {
      const next = prev.slice(1)
      next.push(clamped)
      return next
    })
  }, [stats])

  const innerHeight = SVG_HEIGHT - VERTICAL_PADDING * 2
  const toX = (index: number) => (index / (SAMPLE_COUNT - 1)) * SVG_WIDTH
  const toY = (value: number) =>
    SVG_HEIGHT - VERTICAL_PADDING - (value / 100) * innerHeight

  const segments: string[] = []
  if (samples.length > 0) {
    segments.push(`M ${toX(0).toFixed(2)} ${toY(samples[0] ?? 0).toFixed(2)}`)
    for (let i = 0; i < samples.length - 1; i += 1) {
      const x0 = toX(i)
      const y0 = toY(samples[i] ?? 0)
      const x1 = toX(i + 1)
      const y1 = toY(samples[i + 1] ?? 0)
      const mx = (x0 + x1) / 2
      const my = (y0 + y1) / 2
      segments.push(
        `Q ${x0.toFixed(2)} ${y0.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`,
      )
    }
    const lastIndex = samples.length - 1
    segments.push(
      `T ${toX(lastIndex).toFixed(2)} ${toY(samples[lastIndex] ?? 0).toFixed(2)}`,
    )
  }
  const linePath = segments.join(' ')
  const fillPath = linePath
    ? `${linePath} L ${SVG_WIDTH} ${SVG_HEIGHT} L 0 ${SVG_HEIGHT} Z`
    : ''

  const currentPct = Math.round(samples[samples.length - 1] ?? 0)
  const peakPct = Math.round(Math.max(...samples, 0))
  const windowSeconds = SAMPLE_COUNT * 2
  const title = `GPU ${currentPct}% (peak ${peakPct}% over last ~${windowSeconds}s)`

  return (
    <div
      className="pointer-events-none flex select-none"
      title={title}
      aria-label={title}
      role="img"
    >
      <svg
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        aria-hidden="true"
      >
        {fillPath && (
          <path
            d={fillPath}
            className="fill-sky-500/20 dark:fill-sky-300/20"
          />
        )}
        {linePath && (
          <path
            d={linePath}
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="fill-none stroke-sky-500 dark:stroke-sky-300"
          />
        )}
      </svg>
    </div>
  )
}
