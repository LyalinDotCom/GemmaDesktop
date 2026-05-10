/**
 * Circular gauge showing the share of the active session's context window
 * that is currently in use. Replaces the small horizontal progress bar that
 * used to live in the status row. The arc color shifts through a gradient
 * (emerald → sky → violet → amber → red) as the gauge fills so the state
 * is readable at a glance. Exact token counts are available in the tooltip.
 */

interface ContextGaugeProps {
  tokensUsed: number
  contextLength: number
  /** Outer size in pixels. Defaults to 20 (status bar size). */
  size?: number
}

const STROKE_WIDTH = 3
const VIEWBOX = 40
const RADIUS = (VIEWBOX - STROKE_WIDTH) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function tierColor(percent: number): { stroke: string; text: string } {
  if (percent >= 90) {
    return {
      stroke: 'text-red-500 dark:text-red-400',
      text: 'text-red-600 dark:text-red-400',
    }
  }
  if (percent >= 75) {
    return {
      stroke: 'text-amber-500 dark:text-amber-400',
      text: 'text-amber-600 dark:text-amber-400',
    }
  }
  if (percent >= 50) {
    return {
      stroke: 'text-violet-500 dark:text-violet-400',
      text: 'text-violet-600 dark:text-violet-400',
    }
  }
  if (percent >= 25) {
    return {
      stroke: 'text-sky-500 dark:text-sky-400',
      text: 'text-sky-600 dark:text-sky-400',
    }
  }
  return {
    stroke: 'text-emerald-500 dark:text-emerald-400',
    text: 'text-emerald-600 dark:text-emerald-400',
  }
}

export function ContextGauge({
  tokensUsed,
  contextLength,
  size = 20,
}: ContextGaugeProps) {
  const rawPercent =
    contextLength > 0 ? (tokensUsed / contextLength) * 100 : 0
  const percent = Math.min(100, Math.max(0, rawPercent))
  const displayPercent = Math.round(percent)
  const { stroke, text } = tierColor(percent)
  const dashFilled = (percent / 100) * CIRCUMFERENCE
  const dashEmpty = CIRCUMFERENCE - dashFilled

  const title = `Context: ~${Math.round(tokensUsed)} / ${contextLength} tokens (${displayPercent}%)`

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={title}
      aria-label={title}
    >
      <span className="relative inline-flex" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          className="block"
          role="presentation"
        >
          {/* background ring */}
          <circle
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            className="stroke-zinc-200 dark:stroke-zinc-800"
          />
          {/* filled arc — starts at 12 o'clock via rotation */}
          <circle
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={`${dashFilled} ${dashEmpty}`}
            className={`${stroke} transition-[stroke-dasharray,color] duration-500 ease-out`}
            style={{
              transform: 'rotate(-90deg)',
              transformOrigin: '50% 50%',
            }}
          />
        </svg>
      </span>
      <span className={`text-[11px] font-medium tabular-nums ${text}`}>
        {displayPercent}%
      </span>
    </span>
  )
}
