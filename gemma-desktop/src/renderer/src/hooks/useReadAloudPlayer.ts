import { useCallback, useEffect, useRef, useState } from 'react'
import { filePathToPreviewUrl } from '@/lib/inputAttachments'
import {
  clampPlaybackTime,
  resolveDisplayedPlaybackTime,
  resolveSeekableDurationSec,
} from '@/lib/readAloudPlayback'
import {
  buildReadAloudSelectionPlaybackId,
  extractSpeakableTextFromContent,
  normalizeSelectedReadAloudText,
} from '@/lib/readAloudText'
import type {
  ChatMessage,
  ReadAloudInspection,
  ReadAloudSynthesisResult,
  ReadAloudTestInput,
  ReadAloudVoiceId,
} from '@/types'
import type { ReadAloudStreamEvent } from '@shared/readAloud'

export type PlaybackPhase = 'idle' | 'preparing' | 'playing' | 'paused'

interface UseReadAloudPlayerInput {
  enabled: boolean
  defaultVoice: ReadAloudVoiceId
  speed: number
  status: ReadAloudInspection | null
}

interface PlaybackTarget {
  playbackKey: string
  label: string
  loadAudio: () => Promise<ReadAloudSynthesisResult>
}

interface StreamingPlaybackTarget {
  playbackKey: string
  label: string
  input: {
    messageId: string
    text: string
    voice: ReadAloudVoiceId
    speed: number
    purpose: 'message' | 'preview'
    useCache: boolean
  }
}

interface StreamSegment {
  index: number
  audioPath: string
  durationSec: number
  offsetSec: number
}

export interface ReadAloudNarrationPlaybackInput {
  playbackKey: string
  text: string
  label?: string
}

export interface ReadAloudButtonState {
  visible: boolean
  ariaLabel: string
  title: string
  disabled: boolean
  active: boolean
  icon: 'volume' | 'loader' | 'stop'
  onClick?: () => void
}

export interface ReadAloudPlaybackControls {
  visible: boolean
  phase: PlaybackPhase
  label: string
  currentTimeSec: number
  durationSec: number
  canSeek: boolean
  generating: boolean
  togglePlayPause: () => void
  seekTo: (nextTimeSec: number) => void
  dismiss: () => void
}

const DEFAULT_PLAYBACK_LABEL = 'Read aloud'

function createReadAloudStreamId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `read-aloud-${randomId.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function safeAudioDuration(audio: HTMLAudioElement | null): number {
  if (!audio) {
    return 0
  }

  return Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : 0
}

function safeAudioCurrentTime(audio: HTMLAudioElement | null): number {
  if (!audio) {
    return 0
  }

  return Number.isFinite(audio.currentTime) && audio.currentTime >= 0
    ? audio.currentTime
    : 0
}

export function useReadAloudPlayer(input: UseReadAloudPlayerInput) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const knownDurationSecRef = useRef(0)
  const pendingSeekTargetSecRef = useRef<number | null>(null)
  const requestTokenRef = useRef(0)
  const phaseRef = useRef<PlaybackPhase>('idle')
  const activeStreamIdRef = useRef<string | null>(null)
  const streamUnsubscribeRef = useRef<(() => void) | null>(null)
  const streamSegmentsRef = useRef<StreamSegment[]>([])
  const streamGeneratedDurationSecRef = useRef(0)
  const streamActiveSegmentIndexRef = useRef<number | null>(null)
  const streamActiveSegmentOffsetSecRef = useRef(0)
  const streamFinalReadyRef = useRef<{
    result: ReadAloudSynthesisResult
    temporaryFinal: boolean
  } | null>(null)
  const streamFinalSwappedRef = useRef(false)
  const streamPlaybackWantedRef = useRef(false)
  const suppressPauseRef = useRef(false)
  const [activePlaybackKey, setActivePlaybackKey] = useState<string | null>(null)
  const [activeLabel, setActiveLabel] = useState(DEFAULT_PLAYBACK_LABEL)
  const [phase, setPhase] = useState<PlaybackPhase>('idle')
  const [currentTimeSec, setCurrentTimeSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const stopPlayback = useCallback(async (cancelSynthesis = true) => {
    requestTokenRef.current += 1
    const readAloudBridge = window.gemmaDesktopBridge.readAloud

    const streamId = activeStreamIdRef.current
    activeStreamIdRef.current = null
    streamUnsubscribeRef.current?.()
    streamUnsubscribeRef.current = null
    streamSegmentsRef.current = []
    streamGeneratedDurationSecRef.current = 0
    streamActiveSegmentIndexRef.current = null
    streamActiveSegmentOffsetSecRef.current = 0
    streamFinalReadyRef.current = null
    streamFinalSwappedRef.current = false
    streamPlaybackWantedRef.current = false

    const audio = audioRef.current
    pendingSeekTargetSecRef.current = null
    if (audio) {
      suppressPauseRef.current = true
      audio.pause()
      audio.currentTime = 0
      suppressPauseRef.current = false
      audio.onended = null
      audio.onpause = null
      audio.onplay = null
      audio.onseeked = null
      audio.onseeking = null
      audio.ontimeupdate = null
      audio.ondurationchange = null
      audio.onloadedmetadata = null
    }

    if (cancelSynthesis) {
      await readAloudBridge.cancelCurrent().catch(() => {})
    }
    if (streamId) {
      await readAloudBridge.cleanupStream(streamId).catch(() => {})
    }

    setActivePlaybackKey(null)
    setActiveLabel(DEFAULT_PLAYBACK_LABEL)
    setCurrentTimeSec(0)
    setDurationSec(0)
    setGenerating(false)
    setPhase('idle')
  }, [])

  useEffect(() => {
    knownDurationSecRef.current = durationSec
  }, [durationSec])

  useEffect(() => {
    if (input.enabled) {
      return
    }

    void stopPlayback()
  }, [input.enabled, stopPlayback])

  useEffect(() => {
    return () => {
      void stopPlayback()
    }
  }, [stopPlayback])

  const startPlayback = useCallback(async (
    target: PlaybackTarget,
  ) => {
    if (activePlaybackKey === target.playbackKey && phase !== 'idle') {
      await stopPlayback()
      return
    }

    await stopPlayback()

    const nextToken = requestTokenRef.current + 1
    requestTokenRef.current = nextToken
    setActivePlaybackKey(target.playbackKey)
    setActiveLabel(target.label)
    setCurrentTimeSec(0)
    setDurationSec(0)
    setPhase('preparing')

    try {
      const result = await target.loadAudio()

      if (requestTokenRef.current !== nextToken) {
        return
      }

      const nextAudio = audioRef.current ?? new Audio()
      audioRef.current = nextAudio

      const syncTransport = () => {
        if (requestTokenRef.current !== nextToken) {
          return
        }
        const nextActualTimeSec = safeAudioCurrentTime(nextAudio)
        const pendingSeekTimeSec = pendingSeekTargetSecRef.current
        if (
          pendingSeekTimeSec != null
          && !nextAudio.seeking
          && Math.abs(nextActualTimeSec - pendingSeekTimeSec) <= 0.25
        ) {
          pendingSeekTargetSecRef.current = null
        }

        setCurrentTimeSec(resolveDisplayedPlaybackTime({
          actualTimeSec: nextActualTimeSec,
          pendingSeekTimeSec: pendingSeekTargetSecRef.current,
          isSeeking: nextAudio.seeking,
        }))
        setDurationSec((current) => {
          const mediaDuration = safeAudioDuration(nextAudio)
          const nextDuration = mediaDuration > 0 ? Math.max(current, mediaDuration) : current
          knownDurationSecRef.current = nextDuration
          return nextDuration
        })
      }

      nextAudio.onloadedmetadata = syncTransport
      nextAudio.ondurationchange = syncTransport
      nextAudio.ontimeupdate = syncTransport
      nextAudio.onseeking = syncTransport
      nextAudio.onseeked = syncTransport
      nextAudio.onplay = () => {
        if (requestTokenRef.current !== nextToken) {
          return
        }
        syncTransport()
        setPhase('playing')
      }
      nextAudio.onpause = () => {
        if (requestTokenRef.current !== nextToken) {
          return
        }
        syncTransport()
        if (!nextAudio.ended) {
          setPhase((current) => current === 'playing' ? 'paused' : current)
        }
      }
      nextAudio.onended = () => {
        if (requestTokenRef.current !== nextToken) {
          return
        }
        setActivePlaybackKey((current) =>
          current === target.playbackKey ? null : current,
        )
        setActiveLabel(DEFAULT_PLAYBACK_LABEL)
        setCurrentTimeSec(0)
        setDurationSec(0)
        setPhase('idle')
      }

      nextAudio.pause()
      nextAudio.currentTime = 0
      nextAudio.preload = 'auto'
      nextAudio.src = filePathToPreviewUrl(result.audioPath)
      setDurationSec(
        typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
          ? Math.max(result.durationMs / 1000, 0)
          : 0,
      )
      knownDurationSecRef.current =
        typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
          ? Math.max(result.durationMs / 1000, 0)
          : 0
      nextAudio.load()

      try {
        await nextAudio.play()
      } catch (error) {
        if (requestTokenRef.current !== nextToken) {
          nextAudio.pause()
          nextAudio.currentTime = 0
          return
        }

        console.warn('Read aloud audio is ready but playback did not start:', error)
        syncTransport()
        setPhase('paused')
        return
      }

      if (requestTokenRef.current !== nextToken) {
        nextAudio.pause()
        nextAudio.currentTime = 0
        return
      }
      syncTransport()
      setPhase('playing')
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      if (messageText !== 'Read aloud cancelled.') {
        console.error('Read aloud failed:', error)
      }

      setActivePlaybackKey(null)
      setActiveLabel(DEFAULT_PLAYBACK_LABEL)
      setCurrentTimeSec(0)
      setDurationSec(0)
      setPhase('idle')
    }
  }, [
    activePlaybackKey,
    phase,
    stopPlayback,
  ])

  const startStreamingPlayback = useCallback(async (
    target: StreamingPlaybackTarget,
  ) => {
    if (activePlaybackKey === target.playbackKey && phase !== 'idle') {
      await stopPlayback()
      return
    }

    await stopPlayback()

    const nextToken = requestTokenRef.current + 1
    requestTokenRef.current = nextToken
    const streamId = createReadAloudStreamId()
    activeStreamIdRef.current = streamId
    streamSegmentsRef.current = []
    streamGeneratedDurationSecRef.current = 0
    streamActiveSegmentIndexRef.current = null
    streamActiveSegmentOffsetSecRef.current = 0
    streamFinalReadyRef.current = null
    streamFinalSwappedRef.current = false
    streamPlaybackWantedRef.current = true
    pendingSeekTargetSecRef.current = null

    setActivePlaybackKey(target.playbackKey)
    setActiveLabel(target.label)
    setCurrentTimeSec(0)
    setDurationSec(0)
    setGenerating(true)
    setPhase('preparing')

    const nextAudio = audioRef.current ?? new Audio()
    audioRef.current = nextAudio

    const currentAbsoluteTimeSec = () =>
      streamFinalSwappedRef.current
        ? safeAudioCurrentTime(nextAudio)
        : streamActiveSegmentOffsetSecRef.current + safeAudioCurrentTime(nextAudio)

    const syncTransport = () => {
      if (requestTokenRef.current !== nextToken) {
        return
      }

      const nextActualTimeSec = currentAbsoluteTimeSec()
      const pendingSeekTimeSec = pendingSeekTargetSecRef.current
      if (
        pendingSeekTimeSec != null
        && !nextAudio.seeking
        && Math.abs(nextActualTimeSec - pendingSeekTimeSec) <= 0.25
      ) {
        pendingSeekTargetSecRef.current = null
      }

      setCurrentTimeSec(resolveDisplayedPlaybackTime({
        actualTimeSec: nextActualTimeSec,
        pendingSeekTimeSec: pendingSeekTargetSecRef.current,
        isSeeking: nextAudio.seeking,
      }))
      setDurationSec((current) => {
        const finalDurationSec = streamFinalReadyRef.current?.result.durationMs
          ? Math.max(streamFinalReadyRef.current.result.durationMs / 1000, 0)
          : 0
        const mediaDuration = streamFinalSwappedRef.current ? safeAudioDuration(nextAudio) : 0
        const nextDuration = Math.max(
          current,
          streamGeneratedDurationSecRef.current,
          finalDurationSec,
          mediaDuration,
          nextActualTimeSec,
        )
        knownDurationSecRef.current = nextDuration
        return nextDuration
      })
    }

    const playCurrentAudio = async () => {
      if (requestTokenRef.current !== nextToken) {
        return
      }

      if (!streamPlaybackWantedRef.current) {
        setPhase('paused')
        return
      }

      try {
        await nextAudio.play()
      } catch (error) {
        if (requestTokenRef.current !== nextToken) {
          nextAudio.pause()
          nextAudio.currentTime = 0
          return
        }

        console.warn('Read aloud audio is ready but playback did not start:', error)
        streamPlaybackWantedRef.current = false
        syncTransport()
        setPhase('paused')
      }
    }

    const playSegment = async (segment: StreamSegment) => {
      if (requestTokenRef.current !== nextToken || streamFinalSwappedRef.current) {
        return
      }

      streamActiveSegmentIndexRef.current = segment.index
      streamActiveSegmentOffsetSecRef.current = segment.offsetSec
      suppressPauseRef.current = true
      nextAudio.pause()
      nextAudio.currentTime = 0
      suppressPauseRef.current = false
      nextAudio.preload = 'auto'
      nextAudio.src = filePathToPreviewUrl(segment.audioPath)
      nextAudio.load()
      syncTransport()
      await playCurrentAudio()
    }

    const playNextAvailableSegment = async () => {
      if (requestTokenRef.current !== nextToken || streamFinalSwappedRef.current) {
        return
      }

      const currentIndex = streamActiveSegmentIndexRef.current
      const nextSegment = streamSegmentsRef.current.find((segment) =>
        currentIndex == null ? segment.index === 0 : segment.index === currentIndex + 1,
      )
      if (nextSegment) {
        await playSegment(nextSegment)
        return
      }

      if (streamFinalReadyRef.current) {
        return
      }

      setPhase('preparing')
    }

    const swapToFinalAudio = async (
      result: ReadAloudSynthesisResult,
      temporaryFinal: boolean,
    ) => {
      if (
        requestTokenRef.current !== nextToken
        || streamFinalSwappedRef.current
      ) {
        return
      }

      const wasPlaying =
        streamPlaybackWantedRef.current
        && (phaseRef.current === 'playing' || phaseRef.current === 'preparing')
      const targetTimeSec = Math.min(
        currentAbsoluteTimeSec(),
        typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
          ? Math.max(result.durationMs / 1000, 0)
          : currentAbsoluteTimeSec(),
      )

      streamFinalSwappedRef.current = true
      streamActiveSegmentIndexRef.current = null
      streamActiveSegmentOffsetSecRef.current = 0
      setGenerating(false)

      suppressPauseRef.current = true
      nextAudio.pause()
      nextAudio.currentTime = 0
      suppressPauseRef.current = false
      nextAudio.preload = 'auto'
      nextAudio.src = filePathToPreviewUrl(result.audioPath)
      nextAudio.load()
      if (targetTimeSec > 0) {
        nextAudio.currentTime = targetTimeSec
      }

      const finalDurationSec =
        typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
          ? Math.max(result.durationMs / 1000, 0)
          : safeAudioDuration(nextAudio)
      setDurationSec(finalDurationSec)
      knownDurationSecRef.current = finalDurationSec
      syncTransport()

      if (!temporaryFinal) {
        const cleanupStreamId = activeStreamIdRef.current
        activeStreamIdRef.current = null
        if (cleanupStreamId) {
          await window.gemmaDesktopBridge.readAloud.cleanupStream(cleanupStreamId).catch(() => {})
        }
      }

      if (wasPlaying) {
        await playCurrentAudio()
      } else {
        setPhase('paused')
      }
    }

    nextAudio.onloadedmetadata = syncTransport
    nextAudio.ondurationchange = syncTransport
    nextAudio.ontimeupdate = syncTransport
    nextAudio.onseeking = syncTransport
    nextAudio.onseeked = syncTransport
    nextAudio.onplay = () => {
      if (requestTokenRef.current !== nextToken) {
        return
      }
      streamPlaybackWantedRef.current = true
      syncTransport()
      setPhase('playing')
    }
    nextAudio.onpause = () => {
      if (requestTokenRef.current !== nextToken || suppressPauseRef.current) {
        return
      }
      syncTransport()
      if (!nextAudio.ended) {
        streamPlaybackWantedRef.current = false
        setPhase((current) => current === 'playing' ? 'paused' : current)
      }
    }
    nextAudio.onended = () => {
      if (requestTokenRef.current !== nextToken) {
        return
      }

      syncTransport()
      if (!streamFinalSwappedRef.current) {
        void playNextAvailableSegment()
        return
      }

      void stopPlayback(false)
    }

    const handleStreamEvent = (event: ReadAloudStreamEvent) => {
      if (requestTokenRef.current !== nextToken || event.streamId !== streamId) {
        return
      }

      if (event.type === 'segment-ready') {
        const durationSec =
          typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
            ? Math.max(event.durationMs / 1000, 0)
            : 0
        const offsetSec = streamSegmentsRef.current.reduce(
          (sum, segment) => sum + segment.durationSec,
          0,
        )
        const nextSegment: StreamSegment = {
          index: event.index,
          audioPath: event.audioPath,
          durationSec,
          offsetSec,
        }
        streamSegmentsRef.current = [...streamSegmentsRef.current, nextSegment]
          .sort((left, right) => left.index - right.index)
        streamGeneratedDurationSecRef.current =
          typeof event.generatedDurationMs === 'number' && Number.isFinite(event.generatedDurationMs)
            ? Math.max(event.generatedDurationMs / 1000, streamGeneratedDurationSecRef.current)
            : streamSegmentsRef.current.reduce((sum, segment) => sum + segment.durationSec, 0)
        setDurationSec((current) =>
          Math.max(current, streamGeneratedDurationSecRef.current),
        )

        if (
          streamPlaybackWantedRef.current
          && streamActiveSegmentIndexRef.current == null
          && !streamFinalSwappedRef.current
        ) {
          void playSegment(nextSegment)
        }
        return
      }

      if (event.type === 'final-ready') {
        streamFinalReadyRef.current = {
          result: event.result,
          temporaryFinal: event.temporaryFinal,
        }
        void swapToFinalAudio(event.result, event.temporaryFinal)
        return
      }

      if (event.type === 'cancelled') {
        void stopPlayback(false)
        return
      }

      if (event.type === 'error') {
        console.error('Read aloud failed:', event.message)
        void stopPlayback(false)
      }
    }

    streamUnsubscribeRef.current =
      window.gemmaDesktopBridge.readAloud.onStreamEvent(streamId, handleStreamEvent)

    try {
      const result = await window.gemmaDesktopBridge.readAloud.startStream({
        ...target.input,
        streamId,
      })
      if (result.streamId !== streamId) {
        activeStreamIdRef.current = result.streamId
      }
    } catch (error) {
      if (requestTokenRef.current !== nextToken) {
        return
      }

      console.error('Read aloud failed:', error)
      await stopPlayback(false)
    }
  }, [
    activePlaybackKey,
    phase,
    stopPlayback,
  ])

  const toggleMessage = useCallback(async (message: ChatMessage) => {
    const speakableText = extractSpeakableTextFromContent(message.content)
    if (speakableText.length === 0) {
      return
    }

    await startStreamingPlayback({
      playbackKey: `message:${message.id}`,
      label: 'Reading response aloud',
      input: {
        messageId: message.id,
        text: speakableText,
        voice: input.defaultVoice,
        speed: input.speed,
        purpose: 'message',
        useCache: true,
      },
    })
  }, [
    input.defaultVoice,
    input.speed,
    startStreamingPlayback,
  ])

  const playTest = useCallback(async (testInput?: ReadAloudTestInput) => {
    await startPlayback({
      playbackKey: 'preview:test',
      label: 'Read aloud preview',
      loadAudio: async () => await window.gemmaDesktopBridge.readAloud.test(testInput),
    })
  }, [startPlayback])

  const toggleSelectedText = useCallback(async (selectedText: string) => {
    const normalized = normalizeSelectedReadAloudText(selectedText)
    if (normalized.length === 0) {
      return
    }

    const playbackKey = buildReadAloudSelectionPlaybackId(normalized)
    await startStreamingPlayback({
      playbackKey,
      label: 'Reading selected text aloud',
      input: {
        messageId: playbackKey,
        text: normalized,
        voice: input.defaultVoice,
        speed: input.speed,
        purpose: 'message',
        useCache: true,
      },
    })
  }, [
    input.defaultVoice,
    input.speed,
    startStreamingPlayback,
  ])

  const playNarration = useCallback(async (narration: ReadAloudNarrationPlaybackInput) => {
    const normalized = normalizeSelectedReadAloudText(narration.text)
    if (normalized.length === 0) {
      return
    }

    await startStreamingPlayback({
      playbackKey: narration.playbackKey,
      label: narration.label ?? 'Gemma speaking',
      input: {
        messageId: narration.playbackKey,
        text: normalized,
        voice: input.defaultVoice,
        speed: input.speed,
        purpose: 'preview',
        useCache: false,
      },
    })
  }, [
    input.defaultVoice,
    input.speed,
    startStreamingPlayback,
  ])

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current
    if (!audio || phase === 'idle' || phase === 'preparing') {
      return
    }

    if (phase === 'playing') {
      audio.pause()
      return
    }

    void audio.play().catch((error) => {
      console.error('Failed to resume read aloud playback:', error)
    })
  }, [phase])

  const seekTo = useCallback((nextTimeSec: number) => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    if (activeStreamIdRef.current && !streamFinalSwappedRef.current) {
      return
    }

    const maxDuration = resolveSeekableDurationSec({
      mediaDurationSec: safeAudioDuration(audio),
      fallbackDurationSec: knownDurationSecRef.current,
    })
    if (maxDuration <= 0) {
      return
    }

    const targetTimeSec = clampPlaybackTime(nextTimeSec, maxDuration)
    pendingSeekTargetSecRef.current = targetTimeSec
    setCurrentTimeSec(targetTimeSec)
    audio.currentTime = targetTimeSec

    const actualTimeSec = safeAudioCurrentTime(audio)
    if (!audio.seeking && Math.abs(actualTimeSec - targetTimeSec) <= 0.25) {
      pendingSeekTargetSecRef.current = null
      setCurrentTimeSec(actualTimeSec)
    }
  }, [])

  const buildButtonState = useCallback((
    message: ChatMessage,
    options?: {
      isStreaming?: boolean
    },
  ): ReadAloudButtonState => {
    if (message.role !== 'assistant') {
      return {
        visible: false,
        ariaLabel: 'Read aloud',
        title: '',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    if (input.status?.supported === false) {
      return {
        visible: false,
        ariaLabel: 'Read aloud',
        title: '',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    const active = activePlaybackKey === `message:${message.id}` && phase !== 'idle'
    const speakableText = extractSpeakableTextFromContent(message.content)

    if (active) {
      const activeTitle = phase === 'preparing'
        ? (
            input.status?.state === 'installing'
              ? input.status.detail
              : input.status?.state === 'loading'
                ? input.status.detail
                : generating
                  ? 'Generating read aloud audio'
                  : 'Preparing read aloud audio'
          )
        : 'Stop read aloud playback'

      return {
        visible: true,
        ariaLabel: phase === 'preparing' ? activeTitle : 'Stop read aloud playback',
        title: activeTitle,
        disabled: false,
        active: true,
        icon: phase === 'preparing' ? 'loader' : 'stop',
        onClick: () => {
          void toggleMessage(message)
        },
      }
    }

    if (options?.isStreaming) {
      return {
        visible: false,
        ariaLabel: 'Read aloud',
        title: '',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    if (!input.enabled || input.status?.enabled === false) {
      return {
        visible: true,
        ariaLabel: 'Read aloud',
        title: 'Read aloud is disabled in Voice settings.',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    if (!input.status) {
      return {
        visible: true,
        ariaLabel: 'Read aloud',
        title: 'Checking read aloud status…',
        disabled: true,
        active: false,
        icon: 'loader',
      }
    }

    if (input.status.state === 'installing' || input.status.state === 'loading') {
      return {
        visible: true,
        ariaLabel: 'Installing read aloud voice assets',
        title: input.status.detail,
        disabled: true,
        active: false,
        icon: 'loader',
      }
    }

    if (input.status.state === 'missing_assets') {
      return {
        visible: true,
        ariaLabel: 'Read this response aloud',
        title: 'Read this response aloud. Gemma Desktop will install the voice assets automatically the first time.',
        disabled: false,
        active: false,
        icon: 'volume',
        onClick: () => {
          void toggleMessage(message)
        },
      }
    }

    if (!input.status.healthy) {
      return {
        visible: true,
        ariaLabel: 'Read aloud',
        title: input.status.lastError ?? 'Retry read aloud playback',
        disabled: false,
        active: false,
        icon: 'volume',
        onClick: () => {
          void toggleMessage(message)
        },
      }
    }

    if (speakableText.length === 0) {
      return {
        visible: true,
        ariaLabel: 'Read aloud',
        title: 'This response does not have readable prose yet.',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    return {
      visible: true,
      ariaLabel: 'Read this response aloud',
      title: 'Read this response aloud',
      disabled: false,
      active: false,
      icon: 'volume',
      onClick: () => {
        void toggleMessage(message)
      },
    }
  }, [
    activePlaybackKey,
    generating,
    input.enabled,
    input.status,
    phase,
    toggleMessage,
  ])

  const buildSelectedTextButtonState = useCallback((
    selectedText: string,
  ): ReadAloudButtonState => {
    const normalized = normalizeSelectedReadAloudText(selectedText)
    if (normalized.length === 0) {
      return {
        visible: false,
        ariaLabel: 'Read aloud',
        title: '',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    if (input.status?.supported === false) {
      return {
        visible: false,
        ariaLabel: 'Read aloud',
        title: '',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    const playbackKey = buildReadAloudSelectionPlaybackId(normalized)
    const active = activePlaybackKey === playbackKey && phase !== 'idle'

    if (active) {
      const activeTitle = phase === 'preparing'
        ? (
            input.status?.state === 'installing'
              ? input.status.detail
              : input.status?.state === 'loading'
                ? input.status.detail
                : generating
                  ? 'Generating read aloud audio'
                  : 'Preparing read aloud audio'
          )
        : phase === 'paused'
          ? 'Resume or dismiss read aloud playback from the composer controls.'
          : 'Stop read aloud playback'

      return {
        visible: true,
        ariaLabel: 'Stop read aloud playback',
        title: activeTitle,
        disabled: false,
        active: true,
        icon: phase === 'preparing' ? 'loader' : 'stop',
        onClick: () => {
          void toggleSelectedText(normalized)
        },
      }
    }

    if (!input.enabled || input.status?.enabled === false) {
      return {
        visible: true,
        ariaLabel: 'Read selected text aloud',
        title: 'Read aloud is disabled in Voice settings.',
        disabled: true,
        active: false,
        icon: 'volume',
      }
    }

    if (!input.status) {
      return {
        visible: true,
        ariaLabel: 'Read selected text aloud',
        title: 'Checking read aloud status…',
        disabled: true,
        active: false,
        icon: 'loader',
      }
    }

    if (input.status.state === 'installing' || input.status.state === 'loading') {
      return {
        visible: true,
        ariaLabel: 'Read selected text aloud',
        title: input.status.detail,
        disabled: true,
        active: false,
        icon: 'loader',
      }
    }

    if (input.status.state === 'missing_assets') {
      return {
        visible: true,
        ariaLabel: 'Read selected text aloud',
        title: 'Read selected text aloud. Gemma Desktop will install the voice assets automatically the first time.',
        disabled: false,
        active: false,
        icon: 'volume',
        onClick: () => {
          void toggleSelectedText(normalized)
        },
      }
    }

    if (!input.status.healthy) {
      return {
        visible: true,
        ariaLabel: 'Read selected text aloud',
        title: input.status.lastError ?? 'Retry reading selected text aloud',
        disabled: false,
        active: false,
        icon: 'volume',
        onClick: () => {
          void toggleSelectedText(normalized)
        },
      }
    }

    return {
      visible: true,
      ariaLabel: 'Read selected text aloud',
      title: 'Read selected text aloud',
      disabled: false,
      active: false,
      icon: 'volume',
      onClick: () => {
        void toggleSelectedText(normalized)
      },
    }
  }, [
    activePlaybackKey,
    generating,
    input.enabled,
    input.status,
    phase,
    toggleSelectedText,
  ])

  const playbackControls: ReadAloudPlaybackControls = {
    visible: phase !== 'idle',
    phase,
    label: activeLabel,
    currentTimeSec,
    durationSec,
    canSeek: phase !== 'preparing' && !generating && durationSec > 0,
    generating,
    togglePlayPause,
    seekTo,
    dismiss: () => {
      void stopPlayback()
    },
  }

  return {
    activePlaybackKey,
    phase,
    stopPlayback,
    buildButtonState,
    buildSelectedTextButtonState,
    playbackControls,
    playNarration,
    playTest,
  }
}
