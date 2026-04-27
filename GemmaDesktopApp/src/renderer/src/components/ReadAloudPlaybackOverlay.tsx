import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Loader2, Pause, Play, Volume2, X } from 'lucide-react'
import {
  type ReadAloudPlaybackControls,
} from '@/hooks/useReadAloudPlayer'
import {
  resolveKeyboardSeekTarget,
  resolvePlaybackTimeFromPointer,
} from '@/lib/readAloudPlayback'
import { formatElapsedClock } from '@/lib/turnStatus'

interface ReadAloudPlaybackOverlayProps {
  controls: ReadAloudPlaybackControls
  className?: string
}

function buildStatusLabel(phase: ReadAloudPlaybackControls['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Read aloud'
    case 'preparing':
      return 'Preparing audio'
    case 'playing':
      return 'Playing now'
    case 'paused':
      return 'Paused'
  }
}

export function ReadAloudPlaybackOverlay({
  controls,
  className = '',
}: ReadAloudPlaybackOverlayProps) {
  const [scrubValue, setScrubValue] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  const activePointerIdRef = useRef<number | null>(null)
  const scrubbingRef = useRef(false)
  const scrubValueRef = useRef(0)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const setScrubbingState = (nextScrubbing: boolean) => {
    scrubbingRef.current = nextScrubbing
    setScrubbing(nextScrubbing)
  }

  useEffect(() => {
    if (!scrubbing) {
      scrubValueRef.current = controls.currentTimeSec
      setScrubValue(controls.currentTimeSec)
    }
  }, [controls.currentTimeSec, scrubbing])

  if (!controls.visible) {
    return null
  }

  const rangeMax = controls.durationSec > 0 ? controls.durationSec : 0
  const displayedTimeSec = scrubbing ? scrubValue : controls.currentTimeSec
  const progressPercent = rangeMax > 0
    ? Math.max(0, Math.min((displayedTimeSec / rangeMax) * 100, 100))
    : 0
  const currentLabel = formatElapsedClock(Math.round(displayedTimeSec * 1000))
  const durationLabel = controls.durationSec > 0
    ? formatElapsedClock(Math.round(controls.durationSec * 1000))
    : '--:--'
  const statusLabel = buildStatusLabel(controls.phase)
  const sliderValueText = `${currentLabel} of ${durationLabel}`

  const updateScrubValueFromPointer = (clientX: number) => {
    const track = trackRef.current
    if (!track || rangeMax <= 0) {
      return
    }

    const rect = track.getBoundingClientRect()
    const nextValue = resolvePlaybackTimeFromPointer({
      clientX,
      trackLeft: rect.left,
      trackWidth: rect.width,
      durationSec: rangeMax,
    })
    scrubValueRef.current = nextValue
    setScrubValue(nextValue)
  }

  const finishScrub = (commit: boolean) => {
    activePointerIdRef.current = null
    if (!scrubbingRef.current) {
      return
    }

    const finalValue = scrubValueRef.current
    setScrubbingState(false)
    setScrubValue(finalValue)
    if (commit) {
      controls.seekTo(finalValue)
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!controls.canSeek || rangeMax <= 0) {
      return
    }

    event.preventDefault()
    activePointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    setScrubbingState(true)
    updateScrubValueFromPointer(event.clientX)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current || activePointerIdRef.current !== event.pointerId) {
      return
    }

    updateScrubValueFromPointer(event.clientX)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) {
      return
    }

    updateScrubValueFromPointer(event.clientX)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    finishScrub(true)
  }

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== event.pointerId) {
      return
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    finishScrub(true)
  }

  const handleBlur = () => {
    finishScrub(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!controls.canSeek || rangeMax <= 0) {
      return
    }

    const nextValue = resolveKeyboardSeekTarget({
      key: event.key,
      currentTimeSec: displayedTimeSec,
      durationSec: rangeMax,
    })
    if (nextValue == null) {
      return
    }

    event.preventDefault()
    scrubValueRef.current = nextValue
    setScrubValue(nextValue)
    setScrubbingState(false)
    controls.seekTo(nextValue)
  }

  return (
    <div className={className}>
      <div className="rounded-2xl border border-zinc-200 bg-white/95 px-3 py-2 shadow-[0_24px_42px_-26px_rgba(24,24,27,0.55)] backdrop-blur dark:border-zinc-700 dark:bg-zinc-950/95">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={controls.togglePlayPause}
            disabled={controls.phase === 'preparing'}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            aria-label={
              controls.phase === 'playing'
                ? 'Pause read aloud playback'
                : controls.phase === 'paused'
                  ? 'Resume read aloud playback'
                  : 'Preparing read aloud playback'
            }
            title={
              controls.phase === 'playing'
                ? 'Pause read aloud playback'
                : controls.phase === 'paused'
                  ? 'Resume read aloud playback'
                  : 'Preparing read aloud playback'
            }
          >
            {controls.phase === 'preparing' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : controls.phase === 'playing' ? (
              <Pause size={16} />
            ) : controls.phase === 'paused' ? (
              <Play size={16} />
            ) : (
              <Volume2 size={16} />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                  {statusLabel}
                </div>
                <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {controls.label}
                </div>
              </div>
              <button
                type="button"
                onClick={controls.dismiss}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="Stop read aloud playback"
                title="Stop read aloud playback"
              >
                <X size={14} />
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <span className="w-11 text-right font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {currentLabel}
              </span>
              <div
                ref={trackRef}
                role="slider"
                tabIndex={controls.canSeek ? 0 : -1}
                aria-label="Read aloud playback position"
                aria-valuemin={0}
                aria-valuemax={rangeMax}
                aria-valuenow={displayedTimeSec}
                aria-valuetext={sliderValueText}
                aria-disabled={!controls.canSeek}
                data-scrubbing={scrubbing ? 'true' : 'false'}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className="relative h-6 min-w-0 flex-1 touch-none select-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-indigo-400/50 disabled:cursor-not-allowed"
              >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                <div
                  className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-indigo-600 dark:bg-indigo-400"
                  style={{ width: `${progressPercent}%` }}
                />
                <div
                  className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-sm transition-transform ${
                    controls.canSeek
                      ? 'border-indigo-600 bg-white dark:border-indigo-300 dark:bg-zinc-950'
                      : 'border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900'
                  } ${scrubbing ? 'scale-110' : ''}`}
                  style={{ left: `${progressPercent}%` }}
                />
              </div>
              <span className="w-11 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {durationLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
