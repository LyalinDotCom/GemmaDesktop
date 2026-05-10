interface ModelOptimizationBadgesProps {
  tags?: string[]
  selected?: boolean
  compact?: boolean
  className?: string
}

export function ModelOptimizationBadges({
  tags,
  selected = false,
  compact = false,
  className = '',
}: ModelOptimizationBadgesProps) {
  const visibleTags = Array.from(
    new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
  )

  if (visibleTags.length === 0) {
    return null
  }

  const baseClassName = compact
    ? 'px-1 py-px text-[8px] tracking-[0.1em]'
    : 'px-1.5 py-0.5 text-[9px] tracking-[0.12em]'
  const toneClassName = selected
    ? 'border-white/25 bg-white/15 text-white'
    : 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800/70 dark:bg-cyan-950/40 dark:text-cyan-300'

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 ${className}`.trim()}
      aria-label={visibleTags.map((tag) => `${tag} optimized`).join(', ')}
    >
      {visibleTags.map((tag) => (
        <span
          key={tag}
          title={`${tag} optimized`}
          className={`inline-flex shrink-0 items-center rounded-[4px] border font-semibold uppercase leading-none ${baseClassName} ${toneClassName}`}
        >
          {tag}
        </span>
      ))}
    </span>
  )
}
