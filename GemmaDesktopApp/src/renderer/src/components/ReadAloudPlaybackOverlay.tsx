import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Loader2, Pause, Play, X } from 'lucide-react'
import {
  type ReadAloudPlaybackControls,
} from '@/hooks/useReadAloudPlayer'
import {
  resolveKeyboardSeekTarget,
  resolvePlaybackTimeFromPointer,
} from '@/lib/readAloudPlayback'
import { formatElapsedClock } from '@/lib/turnStatus'

export type ReadAloudPlaybackOverlayVariant = 'chat' | 'cosmic'

interface ReadAloudPlaybackOverlayProps {
  controls: ReadAloudPlaybackControls
  variant?: ReadAloudPlaybackOverlayVariant
  className?: string
}

function buildStatusLabel(phase: ReadAloudPlaybackControls['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Read aloud'
    case 'preparing':
      return 'Preparing'
    case 'playing':
      return 'Now playing'
    case 'paused':
      return 'Paused'
  }
}

interface VariantStyles {
  shell: string
  playButton: string
  closeButton: string
  primaryText: string
  statusText: string
  timeText: string
  trackBase: string
  trackFill: string
  trackFillPlaying: string
  thumbActive: string
  thumbInactive: string
  thumbPlaying: string
  equalizerBar: string
}

const CHAT_STYLES: VariantStyles = {
  shell:
    'rounded-2xl border border-zinc-200 bg-white/90 px-3 py-2.5 shadow-[0_22px_48px_-28px_rgba(24,24,27,0.45)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/90',
  playButton:
    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white shadow-[0_14px_30px_-22px_rgba(79,70,229,0.65)] transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-indigo-500 dark:hover:bg-indigo-400',
  closeButton:
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200',
  primaryText: 'truncate text-sm font-medium text-zinc-900 dark:text-zinc-100',
  statusText: 'shrink-0 text-[11px] font-medium text-zinc-500 dark:text-zinc-400',
  timeText: 'font-mono tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400',
  trackBase: 'absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-200 transition-[height] duration-150 group-hover:h-1.5 group-data-[scrubbing=true]:h-1.5 dark:bg-zinc-800',
  trackFill: 'absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-indigo-500 transition-[height] duration-150 group-hover:h-1.5 group-data-[scrubbing=true]:h-1.5 dark:bg-indigo-400',
  trackFillPlaying: 'shadow-[0_0_14px_rgba(99,102,241,0.55)] dark:shadow-[0_0_14px_rgba(129,140,248,0.55)]',
  thumbActive:
    'border-indigo-500 bg-white dark:border-indigo-300 dark:bg-zinc-950',
  thumbInactive:
    'border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900',
  thumbPlaying: 'read-aloud-thumb-pulse',
  equalizerBar: 'bg-indigo-500 dark:bg-indigo-400',
}

const COSMIC_STYLES: VariantStyles = {
  shell:
    'rounded-full border border-white/12 bg-white/[0.06] px-3 py-2 shadow-[0_28px_64px_-30px_rgba(34,211,238,0.45)] backdrop-blur-xl',
  playButton:
    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-300 text-zinc-950 shadow-[0_18px_42px_-22px_rgba(34,211,238,0.85)] transition-[filter,background-color] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60',
  closeButton:
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white',
  primaryText: 'truncate text-sm font-medium text-white',
  statusText: 'shrink-0 text-[11px] font-medium text-cyan-100/70',
  timeText: 'font-mono tabular-nums text-[11px] text-white/55',
  trackBase: 'absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15 transition-[height] duration-150 group-hover:h-1.5 group-data-[scrubbing=true]:h-1.5',
  trackFill: 'absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-cyan-300 transition-[height] duration-150 group-hover:h-1.5 group-data-[scrubbing=true]:h-1.5',
  trackFillPlaying: 'shadow-[0_0_16px_rgba(34,211,238,0.7)]',
  thumbActive: 'border-cyan-200 bg-white',
  thumbInactive: 'border-white/30 bg-white/30',
  thumbPlaying: 'read-aloud-thumb-pulse-cosmic',
  equalizerBar: 'bg-cyan-300',
}

function PlaybackIndicator({
  phase,
  barClassName,
}: {
  phase: ReadAloudPlaybackControls['phase']
  barClassName: string
}) {
  if (phase === 'playing') {
    return (
      <span
        aria-hidden="true"
        className="read-aloud-equalizer flex h-3 shrink-0 items-end gap-[3px]"
      >
        <span className={`read-aloud-equalizer-bar ${barClassName}`} />
        <span className={`read-aloud-equalizer-bar ${barClassName}`} />
        <span className={`read-aloud-equalizer-bar ${barClassName}`} />
      </span>
    )
  }

  if (phase === 'preparing') {
    return (
      <span
        aria-hidden="true"
        className={`block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${barClassName}`}
      />
    )
  }

  return null
}

export function ReadAloudPlaybackOverlay({
  controls,
  variant = 'chat',
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

  const styles = variant === 'cosmic' ? COSMIC_STYLES : CHAT_STYLES
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
  const isPlaying = controls.phase === 'playing'

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
    <div className={className} data-variant={variant}>
      <div className={styles.shell}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={controls.togglePlayPause}
            disabled={controls.phase === 'preparing'}
            className={styles.playButton}
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
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" className="ml-0.5" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <PlaybackIndicator
                  phase={controls.phase}
                  barClassName={styles.equalizerBar}
                />
                <span className={styles.primaryText}>{controls.label}</span>
                <span className={styles.statusText}>· {statusLabel}</span>
              </div>
              <button
                type="button"
                onClick={controls.dismiss}
                className={styles.closeButton}
                aria-label="Stop read aloud playback"
                title="Stop read aloud playback"
              >
                <X size={14} />
              </button>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <span className={`w-10 text-right ${styles.timeText}`}>
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
                className="group relative h-6 min-w-0 flex-1 touch-none select-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed"
              >
                <div className={styles.trackBase} />
                <div
                  className={`${styles.trackFill} ${isPlaying ? styles.trackFillPlaying : ''}`}
                  style={{ width: `${progressPercent}%` }}
                />
                <div
                  className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm transition-transform ${
                    controls.canSeek ? styles.thumbActive : styles.thumbInactive
                  } ${scrubbing ? 'scale-125' : 'group-hover:scale-110'} ${
                    isPlaying && controls.canSeek ? styles.thumbPlaying : ''
                  }`}
                  style={{ left: `${progressPercent}%` }}
                />
              </div>
              <span className={`w-10 text-left ${styles.timeText}`}>
                {durationLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
