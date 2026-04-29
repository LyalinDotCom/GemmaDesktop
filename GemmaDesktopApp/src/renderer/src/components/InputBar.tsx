import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Send,
  Square,
  Paperclip,
  Bug,
  Copy,
  Check,
  FileDown,
  FileCode2,
  Camera,
  AudioLines,
  BookOpenText,
  Film,
  X,
  MoreHorizontal,
  Layers,
  Quote,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  VolumeX,
} from 'lucide-react'
import { CameraCaptureModal } from '@/components/CameraCaptureModal'
import { ContextGauge } from '@/components/ContextGauge'
import { ReadAloudPlaybackOverlay } from '@/components/ReadAloudPlaybackOverlay'
import {
  SpeechComposerControl,
  type SpeechComposerVisualState,
} from '@/components/SpeechComposerControl'
import type { ReadAloudPlaybackControls } from '@/hooks/useReadAloudPlayer'
import { copyText } from '@/lib/clipboard'
import {
  COMPOSER_TEXTAREA_BASE,
  COMPOSER_TEXTAREA_BASE_FLOATING,
} from '@/lib/composerStyles'
import { extractMemoryPayload } from '@/lib/memoryInput'
import { shouldOfferComposerHistoryNavigation } from '@/lib/composerHistoryNavigation'
import {
  dataTransferMayContainFiles,
  detectAttachmentKind,
  filesToAttachments,
  resolveAttachmentPreviewUrl,
} from '@/lib/inputAttachments'
import {
  clampPdfPageRange,
  defaultPdfPageRange,
  validatePdfPageRange,
} from '@/lib/pdfAttachments'
import {
  analyzeSpeechAudio,
  finalizeSpeechChunkFromBuffers,
  mergeSpeechChunkBuffers,
} from '@/lib/speechAudio'
import { ToolSelector } from '@/components/ToolSelector'
import { GemmaSizeSelector } from '@/components/GemmaSizeSelector'
import { ApprovalModeToggle } from '@/components/ApprovalModeToggle'
import { serializeSessionHistory } from '@/lib/chatCopy'
import {
  describeAssistantNarrationMode,
  type AssistantNarrationMode,
} from '@/lib/assistantNarrationMode'
import type { ChatContentLayout } from '@/lib/rightDockLayout'
import { parseShellDraft } from '@/lib/shellMode'
import {
  canQueueMessageWhileBusy,
  getBusyQueueBlockedReason,
} from '@/lib/sessionQueuePolicy'
import {
  ConversationModeToolbar,
  type ConversationRunMode,
} from '@/components/ConversationModeToolbar'
import type { PinnedQuote } from '@/lib/composeQuotedMessage'
import type {
  ChatMessage,
  ConversationKind,
  DebugLogEntry,
  DebugSessionSnapshot,
  FileAttachment,
  GemmaInstallState,
  MessageContent,
  ModelSummary,
  PendingCompaction,
  PdfAttachment,
  PdfFitStatus,
  PendingAttachmentPayload,
  SessionToolDefinition,
  SessionMode,
  SessionContext,
  LiveActivitySnapshot,
  SpeechEvent,
  SpeechInspection,
} from '@/types'
import type { ConversationApprovalMode } from '@gemma-desktop/sdk-core'
import {
  SPEECH_CHUNK_DURATION_MS,
  SPEECH_CHUNK_OVERLAP_MS,
} from '@shared/speech'
import { findGemmaCatalogEntryByTag } from '@shared/gemmaCatalog'
import { assessAttachmentBudget } from '@shared/attachmentBudget'

const DEFAULT_TEXTAREA_MAX_HEIGHT_PX = 64
const FLOATING_TEXTAREA_MAX_HEIGHT_PX = 68

export interface InputBarProps {
  sessionId: string
  presentation?: 'default' | 'floating'
  layout?: ChatContentLayout
  focusRequestKey?: number
  workingDirectory: string
  initialDraftText: string
  onSend: (message: { text: string; attachments?: FileAttachment[] }) => void | Promise<void>
  onRunShellCommand: (command: string) => void | Promise<void>
  onCompact: () => Promise<void> | void
  onClearHistory: () => Promise<void> | void
  onCancel: () => void
  isGenerating: boolean
  isCompacting: boolean
  models: ModelSummary[]
  selectedModelId: string
  selectedRuntimeId: string
  selectedMode: SessionMode
  conversationKind: ConversationKind
  planMode: boolean
  approvalMode?: ConversationApprovalMode
  onSelectConversationMode?: (mode: ConversationRunMode) => void
  onSelectApprovalMode?: (mode: ConversationApprovalMode) => void
  onSelectModel?: (selection: {
    modelId: string
    runtimeId: string
  }) => void | Promise<void>
  modeChangeDisabled?: boolean
  conversationRunDisabledReason?: string | null
  busyQueueDisabledReason?: string | null
  messages: ChatMessage[]
  streamingContent?: MessageContent[] | null
  sessionTools: SessionToolDefinition[]
  selectedToolIds: string[]
  onToggleTool?: (toolId: string, nextSelected: boolean) => void
  debugOpen?: boolean
  debugLogs?: DebugLogEntry[]
  debugSession?: DebugSessionSnapshot | null
  sessionTitle?: string
  onToggleDebug?: () => void
  onShowSystemPrompt?: () => void
  systemPromptPanelOpen?: boolean
  hasMessages?: boolean
  sessionContext: SessionContext
  liveActivity: LiveActivitySnapshot | null
  pendingCompaction: PendingCompaction | null
  enterToSend: boolean
  autoCompactEnabled: boolean
  autoCompactThresholdPercent: number
  speechStatus: SpeechInspection | null
  onInstallSpeech: () => void | Promise<unknown>
  onRepairSpeech: () => void | Promise<unknown>
  onOpenSpeechSettings: () => void
  gemmaInstallStates?: GemmaInstallState[]
  statusBarTarget?: HTMLElement | null
  /**
   * Sentences the user has pinned from previous assistant replies. Rendered
   * as a preview card above the textarea, and automatically prepended to the
   * outgoing user message text when the send pipeline runs (the composition
   * happens inside `useAppState.sendMessage`, so this component just needs to
   * display them and expose remove/clear).
   */
  pinnedQuotes: PinnedQuote[]
  onRemovePinnedQuote: (quoteId: string) => void
  onClearPinnedQuotes: () => void
  readAloudPlayback?: ReadAloudPlaybackControls
  assistantNarrationMode?: AssistantNarrationMode
  assistantNarrationAvailable?: boolean
  assistantNarrationDisabledReason?: string | null
  onToggleAssistantNarration?: () => void
}

interface SpeechCaptureRefs {
  audioContext: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  processorNode: ScriptProcessorNode | null
  silentGainNode: GainNode | null
  stream: MediaStream | null
  chunkBuffers: Float32Array[]
  chunkSampleCount: number
  sourceSampleRate: number
  nextSequence: number
  sessionId: string | null
  stopping: boolean
  flushPromise: Promise<void> | null
}

interface SpeechDraftAnchor {
  baseText: string
  selectionStart: number
  selectionEnd: number
}

interface ActiveSpeechSession {
  sessionId: string
  chatSessionId: string
  anchor: SpeechDraftAnchor
}

function formatAttachmentTimestampMs(timestampMs: number): string {
  const totalSeconds = Math.max(Math.round(timestampMs / 1000), 0)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function buildAttachmentKey(
  attachment: FileAttachment,
  index: number,
): string {
  return [
    attachment.kind,
    attachment.name,
    attachment.size,
    attachment.path ?? '',
    attachment.previewUrl ?? '',
    index,
  ].join('::')
}

function sameAttachmentIdentity(
  left: FileAttachment,
  right: FileAttachment,
): boolean {
  return (
    left.kind === right.kind
    && left.name === right.name
    && left.size === right.size
    && (left.path ?? '') === (right.path ?? '')
    && (left.previewUrl ?? '') === (right.previewUrl ?? '')
  )
}

function formatPdfFitStatusLabel(status: PdfFitStatus | undefined): string {
  switch (status) {
    case undefined:
    case 'ready':
      return 'Ready'
    case 'too_large':
      return 'Too large'
    case 'worker_unavailable':
      return 'Worker unavailable'
    case 'planning_failed':
      return 'Planning failed'
  }
}

function buildAttachmentBudgetMessage(issues: string[]): string {
  return issues.join(' ')
}

function focusComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return
  }

  textarea.focus()
  const caret = textarea.value.length
  textarea.setSelectionRange(caret, caret)
}

export function isComposerSubmitLocked(input: {
  isSubmitPending: boolean
  sessionBusy: boolean
}): boolean {
  return input.isSubmitPending && !input.sessionBusy
}

export function InputBar({
  sessionId,
  presentation = 'default',
  layout = 'centered',
  focusRequestKey = 0,
  workingDirectory,
  initialDraftText,
  onSend,
  onRunShellCommand,
  onCompact,
  onClearHistory,
  onCancel,
  isGenerating,
  isCompacting,
  models,
  selectedModelId,
  selectedRuntimeId,
  selectedMode,
  conversationKind,
  planMode,
  approvalMode,
  onSelectConversationMode,
  onSelectApprovalMode,
  onSelectModel,
  modeChangeDisabled = false,
  conversationRunDisabledReason = null,
  busyQueueDisabledReason = null,
  messages,
  streamingContent,
  sessionTools,
  selectedToolIds,
  onToggleTool,
  debugOpen,
  debugLogs = [],
  debugSession = null,
  sessionTitle,
  onToggleDebug,
  onShowSystemPrompt,
  systemPromptPanelOpen = false,
  hasMessages: _hasMessages,
  sessionContext,
  liveActivity: _liveActivity,
  pendingCompaction: _pendingCompaction,
  enterToSend,
  autoCompactEnabled: _autoCompactEnabled,
  autoCompactThresholdPercent: _autoCompactThresholdPercent,
  speechStatus,
  onInstallSpeech,
  onRepairSpeech,
  onOpenSpeechSettings,
  gemmaInstallStates = [],
  statusBarTarget = null,
  pinnedQuotes,
  onRemovePinnedQuote,
  onClearPinnedQuotes,
  readAloudPlayback,
  assistantNarrationMode = 'off',
  assistantNarrationAvailable = true,
  assistantNarrationDisabledReason = null,
  onToggleAssistantNarration,
}: InputBarProps) {
  const [text, setText] = useState(initialDraftText)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [cameraOpen, setCameraOpen] = useState(false)
  const [pdfAdvancedOpen, setPdfAdvancedOpen] = useState<Record<string, boolean>>({})
  const [copiedChat, setCopiedChat] = useState(false)
  const [exportedChat, setExportedChat] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [menuConfirm, setMenuConfirm] = useState<'none' | 'clear'>('none')
  const [escapeClearState, setEscapeClearState] = useState<'idle' | 'armed' | 'confirm'>('idle')
  const overflowRef = useRef<HTMLDivElement>(null)
const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('')
  const [sendingSessionId, setSendingSessionId] = useState<string | null>(null)
  const [speechVisualState, setSpeechVisualState] =
    useState<SpeechComposerVisualState>('idle')
  const [speechStatusLine, setSpeechStatusLine] = useState<string | null>(null)
  const [speechErrorMessage, setSpeechErrorMessage] = useState<string | null>(null)
  const [attachmentErrorMessage, setAttachmentErrorMessage] = useState<string | null>(null)
  const [memoryNotice, setMemoryNotice] = useState<
    { tone: 'info' | 'success' | 'error'; text: string } | null
  >(null)
  const memoryNoticeTimeoutRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const escapeClearTimeoutRef = useRef<number | null>(null)
  const speechStatusTimeoutRef = useRef<number | null>(null)
  const draftPersistTimeoutRef = useRef<number | null>(null)
  const draftStoreRef = useRef(
    new Map<string, { text: string; attachments: FileAttachment[] }>(),
  )
  const activeSessionIdRef = useRef(sessionId)
  const previousSessionIdRef = useRef(sessionId)
  const hydratingDraftRef = useRef(false)
  const speechCaptureRef = useRef<SpeechCaptureRefs>({
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    silentGainNode: null,
    stream: null,
    chunkBuffers: [],
    chunkSampleCount: 0,
    sourceSampleRate: 44_100,
    nextSequence: 1,
    sessionId: null,
    stopping: false,
    flushPromise: null,
  })

  const speechSessionRef = useRef<ActiveSpeechSession | null>(null)
  const speechEventCleanupRef = useRef<(() => void) | null>(null)
  const latestTextRef = useRef(initialDraftText)
  const latestAttachmentsRef = useRef<FileAttachment[]>([])
  const speechFinishingRef = useRef(false)
  const speechFinishPromiseRef = useRef<Promise<void> | null>(null)
  const speechFinishResolveRef = useRef<(() => void) | null>(null)

  const userMessageHistory = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          message.content
            .filter(
              (part): part is Extract<MessageContent, { type: 'text' }> =>
                part.type === 'text',
            )
            .map((part) => part.text)
            .join('\n')
            .trim(),
        )
        .filter(Boolean),
    [messages],
  )

  const selectedModel = useMemo(
    () =>
      models.find(
        (model) =>
          model.id === selectedModelId
          && model.runtimeId === selectedRuntimeId,
      ),
    [models, selectedModelId, selectedRuntimeId],
  )
  const selectedAttachmentSupport = selectedModel?.attachmentSupport
  const selectedContextLength = selectedModel?.contextLength ?? 32_768
  const pdfWorkerModelId = selectedAttachmentSupport?.image
    ? (selectedModel?.id ?? selectedModelId)
    : undefined
  const isResearchConversation = conversationKind === 'research'
  const floatingPresentation = presentation === 'floating'
  const contentWidthClass = layout === 'expanded'
    ? 'w-full'
    : 'mx-auto w-full max-w-chat'
  const composerPaddingClass = floatingPresentation
    ? 'px-4 pb-4 pt-4'
    : layout === 'expanded'
      ? 'px-4 pb-4 pt-3'
      : 'px-6 pb-4 pt-3'
  const textareaMaxHeightPx = floatingPresentation
    ? FLOATING_TEXTAREA_MAX_HEIGHT_PX
    : DEFAULT_TEXTAREA_MAX_HEIGHT_PX
  const parsedShellDraft = useMemo(
    () => parseShellDraft(text),
    [text],
  )
  const isShellMode = !isResearchConversation && parsedShellDraft.isShellMode
  const shellCommand = parsedShellDraft.command

  const sessionBusy = isGenerating || isCompacting
  const conversationRunBlocked = Boolean(conversationRunDisabledReason)
  const isSubmitPending = sendingSessionId === sessionId
  const submitLocked = isComposerSubmitLocked({ isSubmitPending, sessionBusy })
  const queueAllowedByPolicy = canQueueMessageWhileBusy({
    conversationKind,
    planMode,
  })
  const canQueueWhileBusy = queueAllowedByPolicy && !busyQueueDisabledReason
  const busyQueueBlockedReason = busyQueueDisabledReason
    ?? (queueAllowedByPolicy
      ? null
      : getBusyQueueBlockedReason({
        conversationKind,
        planMode,
      }))
  const speechLocked =
    speechVisualState === 'listening'
    || speechVisualState === 'processing'
    || speechVisualState === 'stopping'
  const attachmentsLocked =
    isResearchConversation
    || sessionBusy
    || conversationRunBlocked
    || submitLocked
    || speechLocked
    || isShellMode
  const showSpeechControl = speechStatus?.enabled ?? false
  const conversationModeControlDisabled =
    modeChangeDisabled || isCompacting || speechLocked || sessionBusy || conversationRunBlocked

  const attachmentAccept = useMemo(() => {
    const accepted = [
      'image/*',
      '.pdf',
      'application/pdf',
      'video/*',
      '.mp4',
      '.mov',
      '.m4v',
      '.webm',
    ]

    if (selectedAttachmentSupport?.audio) {
      accepted.push(
        'audio/*',
        '.wav',
        '.mp3',
        '.m4a',
        '.aac',
        '.flac',
        '.ogg',
        '.opus',
        '.caf',
        '.aiff',
      )
    }

    return accepted.join(',')
  }, [selectedAttachmentSupport?.audio])

  const planPdfAttachment = useCallback(async (
    attachment: PdfAttachment,
  ): Promise<PdfAttachment> => {
    try {
      const plan = await window.gemmaDesktopBridge.attachments.planPdfProcessing({
        path: attachment.path,
        dataUrl: attachment.dataUrl,
        name: attachment.name,
        size: attachment.size,
        processedRange: attachment.processedRange,
        workerModelId: pdfWorkerModelId,
      })
      const processedRange = clampPdfPageRange(
        attachment.processedRange ?? plan.defaultRange,
        plan.pageCount,
      )
      const defaultRange = defaultPdfPageRange(plan.pageCount)
      const processingMode =
        processedRange.startPage === defaultRange.startPage
        && processedRange.endPage === defaultRange.endPage
          ? 'full_document'
          : 'custom_range'

      return {
        ...attachment,
        pageCount: plan.pageCount,
        processingMode,
        processedRange,
        workerModelId: plan.workerModelId,
        batchCount: plan.estimatedBatchCount,
        fitStatus: plan.fitStatus,
        planningReason: plan.reason,
      }
    } catch (error) {
      return {
        ...attachment,
        processingMode: attachment.processingMode ?? 'full_document',
        fitStatus: 'planning_failed',
        planningReason:
          error instanceof Error
            ? error.message
            : 'Gemma Desktop could not inspect this PDF.',
      }
    }
  }, [pdfWorkerModelId])

  const refreshPdfAttachment = useCallback(async (
    targetKey: string,
    attachment: PdfAttachment,
  ) => {
    const planned = await planPdfAttachment(attachment)
    setAttachments((current) =>
      current.map((entry, index) =>
        buildAttachmentKey(entry, index) === targetKey
          ? planned
          : entry,
      ),
    )
  }, [planPdfAttachment])

  const syncTextareaHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, textareaMaxHeightPx)}px`
  }, [textareaMaxHeightPx])

  const applySpeechTranscriptToDraft = useCallback(
    (anchor: SpeechDraftAnchor, transcriptValue: string): string => {
      return `${anchor.baseText.slice(0, anchor.selectionStart)}${transcriptValue}${anchor.baseText.slice(anchor.selectionEnd)}`
    },
    [],
  )

  const syncSpeechDraft = useCallback(
    (anchor: SpeechDraftAnchor, transcriptValue: string) => {
      const nextText = applySpeechTranscriptToDraft(anchor, transcriptValue)
      latestTextRef.current = nextText
      const nextAttachments = latestAttachmentsRef.current
      draftStoreRef.current.set(activeSessionIdRef.current, {
        text: nextText,
        attachments: nextAttachments,
      })
      setText(nextText)
      window.requestAnimationFrame(() => {
        syncTextareaHeight()
        const textarea = textareaRef.current
        if (!textarea) {
          return
        }
        const caret = anchor.selectionStart + transcriptValue.length
        textarea.focus()
        textarea.setSelectionRange(caret, caret)
      })
    },
    [applySpeechTranscriptToDraft, syncTextareaHeight],
  )

  const resetEscapeClearState = useCallback(() => {
    if (escapeClearTimeoutRef.current !== null) {
      window.clearTimeout(escapeClearTimeoutRef.current)
      escapeClearTimeoutRef.current = null
    }
    setEscapeClearState('idle')
  }, [])

  const clearComposer = useCallback(() => {
    setText('')
    setAttachments([])
    setPdfAdvancedOpen({})
    setAttachmentErrorMessage(null)
    setHistoryIndex(null)
    setDraftBeforeHistory('')
    resetEscapeClearState()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [resetEscapeClearState])

  const discardPendingManagedAttachment = useCallback((attachment: FileAttachment) => {
    void window.gemmaDesktopBridge.attachments.discardPending({
      sessionId,
      path: attachment.path,
    }).catch(() => {})
  }, [sessionId])

  const clearSpeechEventSubscription = useCallback(() => {
    if (speechEventCleanupRef.current) {
      speechEventCleanupRef.current()
      speechEventCleanupRef.current = null
    }
  }, [])

  const clearSpeechStatusTimeout = useCallback(() => {
    if (speechStatusTimeoutRef.current !== null) {
      window.clearTimeout(speechStatusTimeoutRef.current)
      speechStatusTimeoutRef.current = null
    }
  }, [])

  const clearDraftPersistTimeout = useCallback(() => {
    if (draftPersistTimeoutRef.current !== null) {
      window.clearTimeout(draftPersistTimeoutRef.current)
      draftPersistTimeoutRef.current = null
    }
  }, [])

  const persistDraftText = useCallback((targetSessionId: string, draftText: string) => {
    void window.gemmaDesktopBridge.sessions.saveDraft(targetSessionId, draftText).catch((error) => {
      console.error(`Failed to persist draft for session ${targetSessionId}:`, error)
    })
  }, [])

  const resolveSpeechFinish = useCallback(() => {
    speechFinishingRef.current = false
    if (speechFinishResolveRef.current) {
      speechFinishResolveRef.current()
      speechFinishResolveRef.current = null
    }
    speechFinishPromiseRef.current = null
  }, [])

  const teardownSpeechCapture = useCallback(async () => {
    const {
      audioContext,
      processorNode,
      silentGainNode,
      sourceNode,
      stream,
    } = speechCaptureRef.current

    processorNode?.disconnect()
    silentGainNode?.disconnect()
    sourceNode?.disconnect()

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }

    if (audioContext) {
      await audioContext.close().catch(() => {})
    }

    speechCaptureRef.current = {
      audioContext: null,
      sourceNode: null,
      processorNode: null,
      silentGainNode: null,
      stream: null,
      chunkBuffers: [],
      chunkSampleCount: 0,
      sourceSampleRate: 44_100,
      nextSequence: 1,
      sessionId: null,
      stopping: false,
      flushPromise: null,
    }
  }, [])

  const flushSpeechChunk = useCallback(async function flushSpeechChunk(
    activeSpeechSessionId: string,
    final: boolean,
  ): Promise<void> {
    const existingFlush = speechCaptureRef.current.flushPromise
    if (existingFlush) {
      if (final) {
        await existingFlush
        return await flushSpeechChunk(activeSpeechSessionId, final)
      }
      return
    }

    const runFlush = async (): Promise<void> => {
      const capture = speechCaptureRef.current
      const buffers = capture.chunkBuffers
      if (buffers.length === 0) {
        return
      }

      const merged = mergeSpeechChunkBuffers(buffers)
      if (merged.length === 0) {
        capture.chunkBuffers = []
        capture.chunkSampleCount = 0
        return
      }

      const signalAnalysis = analyzeSpeechAudio(merged)
      const shouldSendChunk = signalAnalysis.hasMeaningfulSpeech

      if (final) {
        capture.chunkBuffers = []
        capture.chunkSampleCount = 0
      } else {
        const overlapSamples = Math.min(
          merged.length,
          Math.round(capture.sourceSampleRate * (SPEECH_CHUNK_OVERLAP_MS / 1000)),
        )
        const overlapTail = merged.slice(merged.length - overlapSamples)
        capture.chunkBuffers = overlapTail.length > 0 ? [overlapTail] : []
        capture.chunkSampleCount = overlapTail.length
      }

      if (!shouldSendChunk) {
        return
      }

      const payload = finalizeSpeechChunkFromBuffers({
        buffers: [merged],
        sourceRate: capture.sourceSampleRate,
      })
      if (!payload) {
        return
      }

      const sequence = capture.nextSequence
      capture.nextSequence += 1
      await window.gemmaDesktopBridge.speech.sendChunk({
        sessionId: activeSpeechSessionId,
        sequence,
        audioBase64: payload.wavBase64,
        mimeType: 'audio/wav',
        durationMs: payload.durationMs,
        final,
        signalMetrics: {
          rms: signalAnalysis.rms,
          peak: signalAnalysis.peak,
          activeRatio: signalAnalysis.activeRatio,
        },
      })
    }

    const flushPromise = runFlush()
    speechCaptureRef.current.flushPromise = flushPromise

    try {
      await flushPromise
    } finally {
      if (speechCaptureRef.current.flushPromise === flushPromise) {
        speechCaptureRef.current.flushPromise = null
      }

      const threshold = Math.round(
        speechCaptureRef.current.sourceSampleRate * (SPEECH_CHUNK_DURATION_MS / 1000),
      )
      if (
        !speechCaptureRef.current.stopping
        && !final
        && speechCaptureRef.current.chunkSampleCount >= threshold
      ) {
        void flushSpeechChunk(activeSpeechSessionId, false)
      }
    }
  }, [])

  const beginSpeechCapture = useCallback(async (activeSpeechSessionId: string) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    const audioContext = new AudioContext()
    const sourceNode = audioContext.createMediaStreamSource(stream)
    const processorNode = audioContext.createScriptProcessor(4096, sourceNode.channelCount, 1)
    const silentGainNode = audioContext.createGain()
    silentGainNode.gain.value = 0

    speechCaptureRef.current = {
      audioContext,
      sourceNode,
      processorNode,
      silentGainNode,
      stream,
      chunkBuffers: [],
      chunkSampleCount: 0,
      sourceSampleRate: audioContext.sampleRate,
      nextSequence: 1,
      sessionId: activeSpeechSessionId,
      stopping: false,
      flushPromise: null,
    }

    processorNode.onaudioprocess = (event) => {
      if (speechCaptureRef.current.stopping) {
        return
      }

      const inputBuffer = event.inputBuffer
      const mono = new Float32Array(inputBuffer.length)
      for (let sampleIndex = 0; sampleIndex < inputBuffer.length; sampleIndex += 1) {
        let sample = 0
        for (
          let channelIndex = 0;
          channelIndex < inputBuffer.numberOfChannels;
          channelIndex += 1
        ) {
          sample += inputBuffer.getChannelData(channelIndex)[sampleIndex] ?? 0
        }
        mono[sampleIndex] = sample / Math.max(1, inputBuffer.numberOfChannels)
      }

      speechCaptureRef.current.chunkBuffers.push(mono)
      speechCaptureRef.current.chunkSampleCount += mono.length

      const threshold = Math.round(
        speechCaptureRef.current.sourceSampleRate * (SPEECH_CHUNK_DURATION_MS / 1000),
      )
      if (
        !speechCaptureRef.current.flushPromise
        && speechCaptureRef.current.chunkSampleCount >= threshold
      ) {
        void flushSpeechChunk(activeSpeechSessionId, false)
      }
    }

    sourceNode.connect(processorNode)
    processorNode.connect(silentGainNode)
    silentGainNode.connect(audioContext.destination)
  }, [flushSpeechChunk])

  const forceStopSpeech = useCallback(async (nextStatusLine: string | null = null) => {
    const activeSpeech = speechSessionRef.current
    resolveSpeechFinish()
    clearSpeechEventSubscription()
    await teardownSpeechCapture()

    speechSessionRef.current = null
    setSpeechVisualState('idle')
    setSpeechStatusLine(nextStatusLine)
    setSpeechErrorMessage(null)

    if (activeSpeech) {
      await window.gemmaDesktopBridge.speech.stopSession(activeSpeech.sessionId).catch(() => {})
    }
  }, [clearSpeechEventSubscription, resolveSpeechFinish, teardownSpeechCapture])

  const stopSpeechInput = useCallback(async () => {
    const activeSpeech = speechSessionRef.current
    if (!activeSpeech) {
      return
    }

    speechCaptureRef.current.stopping = true
    setSpeechVisualState('stopping')
    setSpeechStatusLine('Microphone off. Cancelling queued audio…')
    setSpeechErrorMessage(null)
    resolveSpeechFinish()
    clearSpeechEventSubscription()
    speechSessionRef.current = null

    try {
      await teardownSpeechCapture()
    } finally {
      await window.gemmaDesktopBridge.speech.stopSession(activeSpeech.sessionId).catch(() => {})
      setSpeechVisualState('idle')
      setSpeechStatusLine('Speech input cancelled.')
    }
  }, [clearSpeechEventSubscription, resolveSpeechFinish, teardownSpeechCapture])

  const finishSpeechInputForSubmit = useCallback(async () => {
    const activeSpeech = speechSessionRef.current
    if (!activeSpeech) {
      return
    }

    if (speechFinishPromiseRef.current) {
      await speechFinishPromiseRef.current
      return
    }

    speechFinishingRef.current = true
    speechCaptureRef.current.stopping = true
    setSpeechVisualState('stopping')
    setSpeechErrorMessage(null)

    const finishPromise = new Promise<void>((resolve) => {
      speechFinishResolveRef.current = resolve
    })
    speechFinishPromiseRef.current = finishPromise

    try {
      await flushSpeechChunk(activeSpeech.sessionId, true)
      await teardownSpeechCapture()
      await window.gemmaDesktopBridge.speech.finishSession(activeSpeech.sessionId).catch(() => {})
      await Promise.race([
        finishPromise,
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 5_000)
        }),
      ])
    } finally {
      resolveSpeechFinish()
      if (speechSessionRef.current?.sessionId === activeSpeech.sessionId) {
        clearSpeechEventSubscription()
        speechSessionRef.current = null
        setSpeechVisualState('idle')
        setSpeechStatusLine(null)
      }
    }
  }, [clearSpeechEventSubscription, flushSpeechChunk, resolveSpeechFinish, teardownSpeechCapture])

  const handleSpeechEvent = useCallback((event: SpeechEvent) => {
    const activeSpeech = speechSessionRef.current
    if (!activeSpeech || activeSpeech.sessionId !== event.sessionId) {
      return
    }

    if (event.type === 'transcript') {
      setSpeechErrorMessage(null)
      syncSpeechDraft(activeSpeech.anchor, event.transcript)
      setSpeechVisualState(speechFinishingRef.current ? 'processing' : speechCaptureRef.current.stopping ? 'stopping' : 'listening')
      setSpeechStatusLine(
        speechFinishingRef.current
          ? null
          : speechCaptureRef.current.stopping
          ? 'Microphone off. Cancelling queued audio…'
          : 'Listening…',
      )
      return
    }

    if (event.type === 'chunk') {
      if (event.status === 'error') {
        setSpeechErrorMessage(event.errorMessage ?? 'Speech chunk transcription failed.')
      }
      return
    }

    if (event.type === 'error') {
      setSpeechErrorMessage(event.message)
      if (speechFinishingRef.current) {
        return
      }
      if (!speechCaptureRef.current.stream && !speechCaptureRef.current.stopping) {
        setSpeechVisualState('error')
      }
      return
    }

    if (event.state === 'stopping') {
      setSpeechVisualState(speechFinishingRef.current ? 'processing' : 'stopping')
      setSpeechStatusLine(speechFinishingRef.current ? null : 'Microphone off. Cancelling queued audio…')
      return
    }

    if (event.state === 'processing') {
      if (
        !speechFinishingRef.current
        && speechCaptureRef.current.stream
        && !speechCaptureRef.current.stopping
      ) {
        setSpeechVisualState('listening')
        setSpeechStatusLine('Listening while queued audio is transcribed…')
      } else {
        setSpeechVisualState('processing')
        setSpeechStatusLine(null)
      }
      return
    }

    if (event.state === 'idle') {
      if (
        !speechFinishingRef.current
        && speechCaptureRef.current.stream
        && !speechCaptureRef.current.stopping
      ) {
        setSpeechVisualState('listening')
        setSpeechStatusLine('Listening…')
      } else {
        setSpeechVisualState('idle')
        setSpeechStatusLine(null)
      }
      return
    }

    clearSpeechEventSubscription()
    speechSessionRef.current = null
    resolveSpeechFinish()
    setSpeechVisualState('idle')
    setSpeechStatusLine(null)
  }, [clearSpeechEventSubscription, resolveSpeechFinish, syncSpeechDraft])

  const startSpeechInput = useCallback(async () => {
    if (sessionBusy || isSubmitPending) {
      return
    }

    setSpeechErrorMessage(null)
    setSpeechStatusLine(null)

    const permission = await window.gemmaDesktopBridge.media.requestMicrophoneAccess()
    if (!permission.granted) {
      setSpeechVisualState('error')
      setSpeechErrorMessage(
        permission.status === 'denied'
          ? 'Microphone access was denied.'
          : 'Microphone access is not available yet.',
      )
      return
    }

    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? text.length
    const selectionEnd = textarea?.selectionEnd ?? text.length
    const anchor: SpeechDraftAnchor = {
      baseText: text,
      selectionStart,
      selectionEnd,
    }

    let activeSpeechSessionId: string | null = null

    try {
      const started = await window.gemmaDesktopBridge.speech.startSession({
        sessionId: `speech-${sessionId}-${Date.now()}`,
        baseText: text,
        selectionStart,
        selectionEnd,
      })
      activeSpeechSessionId = started.sessionId
      speechSessionRef.current = {
        sessionId: started.sessionId,
        chatSessionId: sessionId,
        anchor,
      }
      clearSpeechEventSubscription()
      speechEventCleanupRef.current = window.gemmaDesktopBridge.speech.onEvent(
        started.sessionId,
        (event) => {
          handleSpeechEvent(event as SpeechEvent)
        },
      )
      setSpeechVisualState('listening')
      setSpeechStatusLine('Listening…')
      await beginSpeechCapture(started.sessionId)
    } catch (error) {
      await teardownSpeechCapture()
      clearSpeechEventSubscription()
      speechSessionRef.current = null
      setSpeechVisualState('error')
      setSpeechStatusLine(null)
      setSpeechErrorMessage(
        error instanceof Error ? error.message : 'Unable to start speech input.',
      )
      if (activeSpeechSessionId) {
        await window.gemmaDesktopBridge.speech.stopSession(activeSpeechSessionId).catch(() => {})
      }
    }
  }, [
    beginSpeechCapture,
    clearSpeechEventSubscription,
    handleSpeechEvent,
    isSubmitPending,
    sessionBusy,
    sessionId,
    teardownSpeechCapture,
    text,
  ])

  const handleSpeechToggle = useCallback(() => {
    if (
      speechVisualState === 'listening'
      || speechVisualState === 'processing'
      || speechVisualState === 'stopping'
    ) {
      if (speechVisualState !== 'stopping') {
        void stopSpeechInput()
      }
      return
    }

    void startSpeechInput()
  }, [speechVisualState, startSpeechInput, stopSpeechInput])

  useEffect(() => {
    activeSessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      focusComposerTextarea(textareaRef.current)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [focusRequestKey, sessionId])

  useEffect(() => {
    return window.gemmaDesktopBridge.attachments.onPendingAttachment((payload) => {
      const next = payload as PendingAttachmentPayload
      if (next.sessionId !== activeSessionIdRef.current) {
        return
      }

      setAttachmentErrorMessage(null)
      setAttachments((current) => (
        current.some((attachment) => sameAttachmentIdentity(attachment, next.attachment))
          ? current
          : [...current, next.attachment]
      ))
    })
  }, [])

  useEffect(() => {
    if (!draftStoreRef.current.has(sessionId)) {
      draftStoreRef.current.set(sessionId, {
        text: initialDraftText,
        attachments: [],
      })
    }
  }, [initialDraftText, sessionId])

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current
    if (previousSessionId === sessionId) {
      return
    }

    draftStoreRef.current.set(previousSessionId, { text, attachments })
    persistDraftText(previousSessionId, text)
    void forceStopSpeech(null)
    previousSessionIdRef.current = sessionId
    hydratingDraftRef.current = true

    const draft = draftStoreRef.current.get(sessionId)
    setText(draft?.text ?? '')
    setAttachments(draft?.attachments ?? [])
    setHistoryIndex(null)
    setDraftBeforeHistory('')
    setCameraOpen(false)
    setPdfAdvancedOpen({})
    setCopiedChat(false)
    setExportedChat(false)
    resetEscapeClearState()
    window.requestAnimationFrame(() => {
      syncTextareaHeight()
      focusComposerTextarea(textareaRef.current)
    })
  }, [
    attachments,
    forceStopSpeech,
    persistDraftText,
    resetEscapeClearState,
    sessionId,
    syncTextareaHeight,
    text,
    selectedMode,
  ])

  useEffect(() => {
    latestTextRef.current = text
    latestAttachmentsRef.current = attachments

    if (hydratingDraftRef.current) {
      hydratingDraftRef.current = false
      return
    }

    draftStoreRef.current.set(sessionId, { text, attachments })
  }, [attachments, sessionId, text])

  useEffect(() => {
    clearDraftPersistTimeout()
    draftPersistTimeoutRef.current = window.setTimeout(() => {
      persistDraftText(sessionId, text)
      draftPersistTimeoutRef.current = null
    }, 150)

    return () => {
      clearDraftPersistTimeout()
    }
  }, [clearDraftPersistTimeout, persistDraftText, sessionId, text])

  useEffect(() => {
    if (!overflowOpen) {
      setMenuConfirm('none')
      return
    }
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [overflowOpen])

  useEffect(() => {
    return () => {
      if (escapeClearTimeoutRef.current !== null) {
        window.clearTimeout(escapeClearTimeoutRef.current)
      }
      clearSpeechStatusTimeout()
      clearDraftPersistTimeout()
      persistDraftText(activeSessionIdRef.current, draftStoreRef.current.get(activeSessionIdRef.current)?.text ?? text)
    }
  }, [clearDraftPersistTimeout, clearSpeechStatusTimeout, persistDraftText, text])

  useEffect(() => {
    clearSpeechStatusTimeout()

    if (speechVisualState !== 'idle' || !speechStatusLine) {
      return
    }

    speechStatusTimeoutRef.current = window.setTimeout(() => {
      setSpeechStatusLine((current) => current === speechStatusLine ? null : current)
      speechStatusTimeoutRef.current = null
    }, 5_000)

    return () => {
      clearSpeechStatusTimeout()
    }
  }, [clearSpeechStatusTimeout, speechStatusLine, speechVisualState])

  useEffect(() => {
    return () => {
      void forceStopSpeech(null)
    }
  }, [forceStopSpeech])

  useEffect(() => {
    if (speechStatus?.enabled === false && speechSessionRef.current) {
      void forceStopSpeech('Speech input was disabled in Settings.')
    }
  }, [forceStopSpeech, speechStatus?.enabled])

  useEffect(() => {
    if (sessionBusy && speechSessionRef.current) {
      void forceStopSpeech('Speech input stopped because the session is busy.')
    }
  }, [forceStopSpeech, sessionBusy])

  useEffect(() => {
    if (attachmentsLocked) {
      setIsDragOver(false)
    }
  }, [attachmentsLocked])

  useEffect(() => {
    if (!text.trim() && attachments.length === 0 && escapeClearState !== 'idle') {
      resetEscapeClearState()
    }
  }, [attachments.length, escapeClearState, resetEscapeClearState, text])

  const sendPreparedMessage = useCallback(async (
    outgoingText: string,
    outgoingAttachments: FileAttachment[],
  ) => {
    const targetSessionId = sessionId

    clearComposer()

    try {
      setSendingSessionId(targetSessionId)
      await Promise.resolve(onSend({
        text: outgoingText,
        attachments: outgoingAttachments,
      }))
    } catch (error) {
      console.error('Failed to send message:', error)
      draftStoreRef.current.set(targetSessionId, {
        text: outgoingText,
        attachments: outgoingAttachments,
      })
      if (activeSessionIdRef.current === targetSessionId) {
        setText(outgoingText)
        setAttachments(outgoingAttachments)
        window.requestAnimationFrame(syncTextareaHeight)
      }
      return
    } finally {
      setSendingSessionId((current) =>
        current === targetSessionId ? null : current,
      )
    }
  }, [
    clearComposer,
    onSend,
    sessionId,
    syncTextareaHeight,
  ])

  const showMemoryNotice = useCallback(
    (notice: { tone: 'info' | 'success' | 'error'; text: string }, ttlMs = 4000) => {
      if (memoryNoticeTimeoutRef.current !== null) {
        window.clearTimeout(memoryNoticeTimeoutRef.current)
        memoryNoticeTimeoutRef.current = null
      }
      setMemoryNotice(notice)
      if (ttlMs > 0) {
        memoryNoticeTimeoutRef.current = window.setTimeout(() => {
          setMemoryNotice(null)
          memoryNoticeTimeoutRef.current = null
        }, ttlMs)
      }
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (memoryNoticeTimeoutRef.current !== null) {
        window.clearTimeout(memoryNoticeTimeoutRef.current)
        memoryNoticeTimeoutRef.current = null
      }
    }
  }, [])

  const submitMemoryNote = useCallback(async (rawInput: string) => {
    const targetSessionId = sessionId
    clearComposer()
    showMemoryNotice({ tone: 'info', text: 'Saving to memory…' }, 0)
    try {
      setSendingSessionId(targetSessionId)
      const result = await window.gemmaDesktopBridge.memory.appendNote({
        sessionId: targetSessionId,
        rawInput,
      })
      const saved = result?.appendedNote?.trim()
      showMemoryNotice({
        tone: 'success',
        text: saved ? `Remembered: ${saved}` : 'Saved to memory.',
      })
    } catch (error) {
      console.error('Failed to append memory note:', error)
      draftStoreRef.current.set(targetSessionId, {
        text: `#${rawInput.startsWith(' ') ? '' : ' '}${rawInput}`,
        attachments: [],
      })
      if (activeSessionIdRef.current === targetSessionId) {
        setText(`#${rawInput.startsWith(' ') ? '' : ' '}${rawInput}`)
        window.requestAnimationFrame(syncTextareaHeight)
      }
      showMemoryNotice({
        tone: 'error',
        text:
          error instanceof Error && error.message
            ? `Could not save memory: ${error.message}`
            : 'Could not save memory.',
      })
    } finally {
      setSendingSessionId((current) =>
        current === targetSessionId ? null : current,
      )
    }
  }, [
    clearComposer,
    sessionId,
    showMemoryNotice,
    syncTextareaHeight,
  ])

  const runPreparedShellCommand = useCallback(async (
    visibleCommandText: string,
    command: string,
  ) => {
    const targetSessionId = sessionId

    clearComposer()

    try {
      setSendingSessionId(targetSessionId)
      await Promise.resolve(onRunShellCommand(command))
    } catch (error) {
      console.error('Failed to run shell command:', error)
      draftStoreRef.current.set(targetSessionId, {
        text: visibleCommandText,
        attachments: [],
      })
      if (activeSessionIdRef.current === targetSessionId) {
        setText(visibleCommandText)
        setAttachments([])
        window.requestAnimationFrame(syncTextareaHeight)
      }
      return
    } finally {
      setSendingSessionId((current) =>
        current === targetSessionId ? null : current,
      )
    }
  }, [
    clearComposer,
    onRunShellCommand,
    sessionId,
    syncTextareaHeight,
  ])

  const handleSend = useCallback(async () => {
    if (conversationRunDisabledReason) {
      setAttachmentErrorMessage(conversationRunDisabledReason)
      return
    }

    if (speechLocked && speechSessionRef.current) {
      await finishSpeechInputForSubmit()
    }

    const currentText = latestTextRef.current
    const currentAttachments = latestAttachmentsRef.current
    const trimmed = currentText.trim()
    if ((trimmed.length === 0 && currentAttachments.length === 0) || isSubmitPending) {
      return
    }
    const memoryPayload = extractMemoryPayload(currentText)
    if (memoryPayload !== null) {
      if (currentAttachments.length > 0) {
        setAttachmentErrorMessage(
          'Memory notes are text-only. Remove attachments before saving to memory.',
        )
        return
      }
      setAttachmentErrorMessage(null)
      await submitMemoryNote(memoryPayload)
      return
    }
    if (sessionBusy && !canQueueWhileBusy) {
      return
    }
    if (sessionBusy && trimmed.startsWith('/')) {
      return
    }
    if (isResearchConversation && currentAttachments.length > 0) {
      setAttachmentErrorMessage(
        'Research conversations currently support text prompts only.',
      )
      return
    }

    const nextAttachments = await Promise.all(
      currentAttachments.map(async (attachment) => {
        if (
          attachment.kind !== 'pdf'
          || (
            attachment.pageCount != null
            && attachment.processedRange != null
            && attachment.batchCount != null
            && attachment.fitStatus != null
          )
        ) {
          return attachment
        }

        return await planPdfAttachment(attachment)
      }),
    )
    latestAttachmentsRef.current = nextAttachments
    setAttachments(nextAttachments)

    const hasUnpreparedVideo = nextAttachments.some(
      (attachment) =>
        attachment.kind === 'video'
        && (attachment.sampledFrames?.length ?? 0) === 0,
    )
    if (hasUnpreparedVideo) {
      setAttachmentErrorMessage(
        'Gemma Desktop could not prepare local video keyframes from one of the attached videos. Try a smaller MP4/MOV clip or reattach it.',
      )
      return
    }

    const hasUnsupportedAudio = nextAttachments.some(
      (attachment) => attachment.kind === 'audio' && !selectedAttachmentSupport?.audio,
    )
    if (hasUnsupportedAudio) {
      setAttachmentErrorMessage(
        `Model "${selectedModel?.id ?? selectedModelId}" is not marked as supporting audio files, so Gemma Desktop cannot send those attachments in this session.`,
      )
      return
    }

    const budget = assessAttachmentBudget({
      attachments: nextAttachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        size: attachment.size,
        durationMs:
          attachment.kind === 'audio' || attachment.kind === 'video'
            ? attachment.durationMs
            : undefined,
        pageCount: attachment.kind === 'pdf' ? attachment.pageCount : undefined,
        batchCount: attachment.kind === 'pdf' ? attachment.batchCount : undefined,
        fitStatus: attachment.kind === 'pdf' ? attachment.fitStatus : undefined,
        sampledFrameCount:
          attachment.kind === 'video'
            ? attachment.sampledFrames?.length ?? 0
            : undefined,
      })),
      support: selectedAttachmentSupport,
      contextLength: selectedContextLength,
    })
    if (budget.issues.length > 0) {
      setAttachmentErrorMessage(buildAttachmentBudgetMessage(budget.issues))
      return
    }

    setAttachmentErrorMessage(null)
    await sendPreparedMessage(trimmed, [...nextAttachments])
  }, [
    canQueueWhileBusy,
    conversationRunDisabledReason,
    finishSpeechInputForSubmit,
    isResearchConversation,
    isSubmitPending,
    sessionBusy,
    planPdfAttachment,
    sendPreparedMessage,
    submitMemoryNote,
    selectedAttachmentSupport,
    selectedContextLength,
    selectedModel?.id,
    selectedModelId,
  ])

  const handleRunShellCommand = useCallback(async () => {
    const visibleCommandText = parsedShellDraft.visibleText
    if (
      !isShellMode
      || shellCommand.length === 0
      || isSubmitPending
    ) {
      return
    }

    if (latestAttachmentsRef.current.length > 0) {
      setAttachmentErrorMessage(
        'Shell commands cannot be sent with attachments. Remove them or send a normal chat message instead.',
      )
      return
    }

    setAttachmentErrorMessage(null)
    await runPreparedShellCommand(visibleCommandText, shellCommand)
  }, [
    isShellMode,
    isSubmitPending,
    parsedShellDraft.visibleText,
    runPreparedShellCommand,
    shellCommand,
  ])

  const appendFiles = useCallback(async (files: Iterable<File> | ArrayLike<File>) => {
    if (attachmentsLocked) {
      return
    }

    if (isResearchConversation) {
      setAttachmentErrorMessage(
        'Research conversations currently support text prompts only.',
      )
      return
    }

    if (isShellMode) {
      setAttachmentErrorMessage(
        'Shell mode is active. Remove the leading ! if you want to attach files instead.',
      )
      return
    }

    const fileList = Array.from(files)
    const allowedFiles: File[] = []
    let skippedUnsupportedAudio = false

    for (const file of fileList) {
      const kind = detectAttachmentKind(file)
      if (!kind) {
        continue
      }

      if (kind === 'audio' && !selectedAttachmentSupport?.audio) {
        skippedUnsupportedAudio = true
        continue
      }

      allowedFiles.push(file)
    }

    if (allowedFiles.length === 0) {
      if (skippedUnsupportedAudio) {
        setAttachmentErrorMessage(
          `Model "${selectedModel?.id ?? selectedModelId}" is not marked as supporting audio files, so Gemma Desktop cannot attach them in this session.`,
        )
      }
      return
    }

    const nextAttachments = await filesToAttachments(allowedFiles)
    const plannedAttachments = await Promise.all(
      nextAttachments.map(async (attachment) =>
        attachment.kind === 'pdf'
          ? await planPdfAttachment(attachment)
          : attachment,
      ),
    )
    const hasUnpreparedVideo = plannedAttachments.some(
      (attachment) =>
        attachment.kind === 'video'
        && (attachment.sampledFrames?.length ?? 0) === 0,
    )
    if (hasUnpreparedVideo) {
      setAttachmentErrorMessage(
        'Gemma Desktop could not prepare one of the selected videos into local keyframes. Try a smaller MP4/MOV clip.',
      )
    } else {
      const budget = assessAttachmentBudget({
        attachments: [...attachments, ...plannedAttachments].map((attachment) => ({
          kind: attachment.kind,
          name: attachment.name,
          size: attachment.size,
          durationMs:
            attachment.kind === 'audio' || attachment.kind === 'video'
              ? attachment.durationMs
              : undefined,
          pageCount: attachment.kind === 'pdf' ? attachment.pageCount : undefined,
          batchCount: attachment.kind === 'pdf' ? attachment.batchCount : undefined,
          fitStatus: attachment.kind === 'pdf' ? attachment.fitStatus : undefined,
          sampledFrameCount:
            attachment.kind === 'video'
              ? attachment.sampledFrames?.length ?? 0
              : undefined,
        })),
        support: selectedAttachmentSupport,
        contextLength: selectedContextLength,
      })
      setAttachmentErrorMessage(
        skippedUnsupportedAudio
          ? `Model "${selectedModel?.id ?? selectedModelId}" is not marked as supporting audio files, so Gemma Desktop skipped them.`
          : budget.issues.length > 0
            ? buildAttachmentBudgetMessage(budget.issues)
            : null,
      )
    }

    resetEscapeClearState()
    setAttachments((current) => [...current, ...plannedAttachments])
  }, [
    attachmentsLocked,
    attachments,
    isResearchConversation,
    isShellMode,
    planPdfAttachment,
    resetEscapeClearState,
    selectedAttachmentSupport,
    selectedContextLength,
    selectedModel?.id,
    selectedModelId,
  ])

  const updatePdfAttachment = useCallback((
    targetKey: string,
    updater: (attachment: PdfAttachment) => PdfAttachment,
  ) => {
    let nextPdfAttachment: PdfAttachment | null = null

    setAttachments((current) =>
      current.map((attachment, index) => {
        if (
          attachment.kind !== 'pdf'
          || buildAttachmentKey(attachment, index) !== targetKey
        ) {
          return attachment
        }

        nextPdfAttachment = updater(attachment)
        return nextPdfAttachment
      }),
    )

    if (nextPdfAttachment) {
      setAttachmentErrorMessage(null)
      void refreshPdfAttachment(targetKey, nextPdfAttachment)
    }
  }, [refreshPdfAttachment])

  const handleAttachButtonClick = useCallback(() => {
    if (
      attachmentsLocked
      || isSubmitPending
      || attachmentAccept.length === 0
    ) {
      return
    }

    fileInputRef.current?.click()
  }, [
    attachmentsLocked,
    attachmentAccept.length,
    isSubmitPending,
  ])

  const handleAttachInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files || files.length === 0) {
        return
      }

      try {
        await appendFiles(files)
      } finally {
        event.target.value = ''
      }
    },
    [appendFiles],
  )

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (attachmentsLocked || !dataTransferMayContainFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      setIsDragOver(true)
    },
    [attachmentsLocked],
  )

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (attachmentsLocked || !dataTransferMayContainFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (!isDragOver) {
        setIsDragOver(true)
      }
    },
    [attachmentsLocked, isDragOver],
  )

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (attachmentsLocked || !dataTransferMayContainFiles(event.dataTransfer)) {
        return
      }

      const nextTarget = event.relatedTarget
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return
      }

      setIsDragOver(false)
    },
    [attachmentsLocked],
  )

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (attachmentsLocked || !dataTransferMayContainFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      setIsDragOver(false)

      await appendFiles(event.dataTransfer.files)
    },
    [
      appendFiles,
      attachmentsLocked,
    ],
  )

  const navigateHistory = useCallback(
    (direction: 'up' | 'down') => {
      if (userMessageHistory.length === 0) {
        return false
      }

      if (direction === 'up') {
        const nextIndex =
          historyIndex == null
            ? userMessageHistory.length - 1
            : Math.max(0, historyIndex - 1)

        if (historyIndex == null) {
          setDraftBeforeHistory(text)
        }

        setHistoryIndex(nextIndex)
        setText(userMessageHistory[nextIndex] ?? '')
        window.requestAnimationFrame(syncTextareaHeight)
        return true
      }

      if (historyIndex == null) {
        return false
      }

      const nextIndex = historyIndex + 1
      if (nextIndex >= userMessageHistory.length) {
        setHistoryIndex(null)
        setText(draftBeforeHistory)
      } else {
        setHistoryIndex(nextIndex)
        setText(userMessageHistory[nextIndex] ?? '')
      }

      window.requestAnimationFrame(syncTextareaHeight)
      return true
    },
    [
      draftBeforeHistory,
      historyIndex,
      syncTextareaHeight,
      text,
      userMessageHistory,
    ],
  )

  const hasDraftContent = text.trim().length > 0 || attachments.length > 0

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (speechLocked) {
      return
    }

    const submitIntent = isShellMode
      ? 'shell'
      : isResearchConversation
        ? 'research'
        : 'chat'
    if (enterToSend && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (submitIntent === 'shell') {
        void handleRunShellCommand()
      } else if (!conversationRunDisabledReason) {
        void handleSend()
      }
      return
    }

    if (e.key === 'Escape' && hasDraftContent) {
      e.preventDefault()

      if (escapeClearState === 'armed') {
        if (escapeClearTimeoutRef.current !== null) {
          window.clearTimeout(escapeClearTimeoutRef.current)
          escapeClearTimeoutRef.current = null
        }
        setEscapeClearState('confirm')
        return
      }

      if (escapeClearState === 'confirm') {
        resetEscapeClearState()
        return
      }

      setEscapeClearState('armed')
      if (escapeClearTimeoutRef.current !== null) {
        window.clearTimeout(escapeClearTimeoutRef.current)
      }
      escapeClearTimeoutRef.current = window.setTimeout(() => {
        setEscapeClearState('idle')
        escapeClearTimeoutRef.current = null
      }, 1400)
      return
    }

    const target = e.currentTarget as HTMLTextAreaElement
    const selectionStart = target.selectionStart
    const selectionEnd = target.selectionEnd
    const offerHistoryNavigation = shouldOfferComposerHistoryNavigation({
      presentation: floatingPresentation ? 'floating' : 'default',
      key: e.key,
      text,
      selectionStart,
      selectionEnd,
    })

    if (
      e.key === 'ArrowUp'
      && offerHistoryNavigation
      && navigateHistory('up')
    ) {
      e.preventDefault()
    }

    if (
      e.key === 'ArrowDown'
      && offerHistoryNavigation
      && navigateHistory('down')
    ) {
      e.preventDefault()
    }
  }

  const handleInput = () => {
    if (historyIndex != null) {
      setHistoryIndex(null)
    }
    if (escapeClearState !== 'idle') {
      resetEscapeClearState()
    }
    syncTextareaHeight()
  }

  const messagesForCopy = streamingContent
    ? [
        ...messages,
        {
          id: 'streaming-copy',
          role: 'assistant' as const,
          content: streamingContent,
          timestamp: Date.now(),
        },
      ]
    : messages

  const handleCopyChat = useCallback(async () => {
    if (messagesForCopy.length === 0) {
      return
    }

    await copyText(
      serializeSessionHistory({
        messages: messagesForCopy,
        debugEnabled: Boolean(debugOpen),
        debugLogs,
        debugSession,
        sessionTitle,
        workingDirectory,
      }),
    )
    setCopiedChat(true)
    window.setTimeout(() => setCopiedChat(false), 1200)
  }, [debugLogs, debugOpen, debugSession, messagesForCopy, sessionTitle, workingDirectory])

  const handleExportChat = useCallback(async () => {
    if (messagesForCopy.length === 0) {
      return
    }

    const suggestedName = (sessionTitle?.trim() || 'session-history')
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()

    const result = await window.gemmaDesktopBridge.files.saveText({
      title: 'Export Session History',
      defaultPath: `${suggestedName || 'session-history'}.md`,
      content: serializeSessionHistory({
        messages: messagesForCopy,
        debugEnabled: Boolean(debugOpen),
        debugLogs,
        debugSession,
        sessionTitle,
        workingDirectory,
      }),
    })

    if (result.canceled) {
      return
    }

    setExportedChat(true)
    window.setTimeout(() => setExportedChat(false), 1200)
  }, [debugLogs, debugOpen, debugSession, messagesForCopy, sessionTitle, workingDirectory])

  const composerPlaceholder = isShellMode
    ? shellCommand.length > 0
      ? 'Run command in the active project folder'
      : 'Type ! followed by a command'
    : isCompacting
      ? 'Compacting session context...'
    : sessionBusy
      ? canQueueWhileBusy
        ? 'Queue the next message while this turn runs'
        : busyQueueBlockedReason ?? 'Wait for this turn to finish'
    : isResearchConversation
      ? 'What should we research?'
    : planMode
      ? "Let's map the implementation"
      : selectedMode === 'build'
        ? 'Ready to act'
        : 'Think, search, or write together'
  const activeComposerTone = isShellMode
    ? 'shell'
    : isResearchConversation
      ? 'research'
    : planMode
      ? 'plan'
      : selectedMode
  const composerFrameClass =
    activeComposerTone === 'shell'
      ? 'border-amber-300 bg-amber-50/70 focus-within:border-amber-400 focus-within:ring-1 focus-within:ring-amber-400/60 dark:border-amber-800/70 dark:bg-zinc-900 dark:focus-within:border-amber-600 dark:focus-within:ring-amber-600/50'
      : activeComposerTone === 'research'
        ? 'border-rose-300 bg-zinc-50 focus-within:border-rose-400 focus-within:ring-1 focus-within:ring-rose-400/60 dark:border-rose-800/70 dark:bg-zinc-900 dark:focus-within:border-rose-600 dark:focus-within:ring-rose-600/50'
      : activeComposerTone === 'plan'
        ? 'border-emerald-300 bg-zinc-50 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/60 dark:border-emerald-800/70 dark:bg-zinc-900 dark:focus-within:border-emerald-600 dark:focus-within:ring-emerald-600/50'
        : activeComposerTone === 'build'
          ? 'border-sky-300 bg-zinc-50 focus-within:border-sky-400 focus-within:ring-1 focus-within:ring-sky-400/60 dark:border-sky-800/70 dark:bg-zinc-900 dark:focus-within:border-sky-600 dark:focus-within:ring-sky-600/50'
          : 'border-violet-300 bg-zinc-50 focus-within:border-violet-400 focus-within:ring-1 focus-within:ring-violet-400/60 dark:border-violet-800/70 dark:bg-zinc-900 dark:focus-within:border-violet-600 dark:focus-within:ring-violet-600/50'
  const composerDragClass = isDragOver
    ? 'border-emerald-400 bg-emerald-50/80 ring-2 ring-emerald-300/60 dark:border-emerald-700 dark:bg-emerald-950/20 dark:ring-emerald-800/60'
    : ''
  const sendButtonClass = isShellMode
    ? `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-amber-600 text-white transition-colors hover:bg-amber-700 disabled:opacity-30 disabled:hover:bg-amber-600`
    : isResearchConversation
      ? `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-rose-600 text-white transition-colors hover:bg-rose-700 disabled:opacity-30 disabled:hover:bg-rose-600`
    : planMode
      ? `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-emerald-600 text-white transition-colors hover:bg-emerald-700 disabled:opacity-30 disabled:hover:bg-emerald-600`
      : selectedMode === 'build'
        ? `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-sky-600 text-white transition-colors hover:bg-sky-700 disabled:opacity-30 disabled:hover:bg-sky-600`
        : `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-violet-600 text-white transition-colors hover:bg-violet-700 disabled:opacity-30 disabled:hover:bg-violet-600`
  const assistantNarrationTitle = assistantNarrationDisabledReason
    ?? describeAssistantNarrationMode(assistantNarrationMode)
  const attachmentButtonTitle = isResearchConversation
    ? 'Research conversations currently support text prompts only.'
    : isShellMode
    ? 'Shell mode does not accept attachments'
    : sessionBusy
      ? isCompacting
        ? 'Wait for compaction to finish before attaching files'
        : 'Wait for this turn to finish before attaching files'
      : conversationRunDisabledReason
        ? conversationRunDisabledReason
      : speechLocked
        ? 'Finish speech input before attaching files'
      : attachmentAccept.length > 0
        ? 'Attach file'
        : 'This model does not currently accept local attachments'
  const trimmedText = text.trim()
  const canRunShellCommand =
    isShellMode
    && shellCommand.length > 0
    && attachments.length === 0
    && !submitLocked
    && !sessionBusy
  const canSubmitDraft =
    (isShellMode
      ? canRunShellCommand
      : (trimmedText.length > 0 || attachments.length > 0))
    && !submitLocked
    && (isShellMode || !isCompacting)
    && (isShellMode || !conversationRunBlocked)
    && (!sessionBusy || canQueueWhileBusy)
  const toolsDisabledForResearch = isResearchConversation
  const selectedToolIdsForRow = isResearchConversation ? [] : selectedToolIds
  const statusRow = (
    <div className={`${contentWidthClass} flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500`}>
      <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
        {/* Left: mode, model, and tool controls */}
        {isResearchConversation ? (
          <span
            className="no-drag inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-rose-700 shadow-[0_10px_24px_-20px_rgba(225,29,72,0.45)] dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-300"
            title="Deep research conversation"
          >
            <Sparkles size={10} />
            Research
          </span>
        ) : (
          <ConversationModeToolbar
            conversationKind={conversationKind}
            selectedMode={selectedMode}
            planMode={planMode}
            disabled={conversationModeControlDisabled}
            onSelectMode={onSelectConversationMode}
          />
        )}

        <GemmaSizeSelector
          models={models}
          gemmaInstallStates={gemmaInstallStates}
          selectedModelId={selectedModelId}
          selectedRuntimeId={selectedRuntimeId}
          mode={selectedMode}
          hasMessages={messages.length > 0}
          disabled={conversationModeControlDisabled}
          onSelect={onSelectModel}
        />
        {!isResearchConversation && (
          <ApprovalModeToggle
            mode={approvalMode}
            disabled={conversationModeControlDisabled}
            onChange={onSelectApprovalMode}
          />
        )}
        {sessionTools.length > 0 && (
          <ToolSelector
            tools={sessionTools}
            selectedToolIds={selectedToolIdsForRow}
            disabled={
              toolsDisabledForResearch
              || sessionBusy
              || conversationRunBlocked
              || isSubmitPending
              || speechLocked
            }
            onToggleTool={(toolId, nextSelected) => {
              if (toolsDisabledForResearch) {
                return
              }
              onToggleTool?.(toolId, nextSelected)
            }}
          />
        )}
      </div>

      {/* Spacer keeps overflow pinned to the chat-area right edge. */}
      <div className="flex-1" />

      {/* Right group: overflow menu */}
      <div className="flex flex-shrink-0 items-center gap-0">
        <div ref={overflowRef} className="relative">
          <button
            onClick={() => setOverflowOpen(!overflowOpen)}
            className="text-zinc-500 opacity-70 transition-opacity hover:opacity-100 dark:text-zinc-500 dark:opacity-60"
            title="More actions"
            aria-label="More actions"
          >
            <MoreHorizontal size={14} />
          </button>
          {overflowOpen && (
            <div className="absolute bottom-full right-0 z-50 mb-1.5 min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              <button
                onClick={() => { void handleCopyChat(); setOverflowOpen(false) }}
                disabled={messagesForCopy.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {copiedChat ? <Check size={12} /> : <Copy size={12} />}
                Copy session
              </button>
              <button
                onClick={() => { void handleExportChat(); setOverflowOpen(false) }}
                disabled={messagesForCopy.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {exportedChat ? <Check size={12} /> : <FileDown size={12} />}
                Export session
              </button>
              <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              <button
                onClick={() => {
                  void onCompact()
                  setOverflowOpen(false)
                }}
                disabled={sessionBusy || conversationRunBlocked || messagesForCopy.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title="Compact the session context before the next turn"
              >
                <Layers size={12} />
                Compact session
              </button>
              {menuConfirm === 'clear' ? (
                <div className="px-3 py-1.5">
                  <div className="mb-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    Clear chat and assets?
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setMenuConfirm('none')}
                      className="flex-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        void onClearHistory()
                        setOverflowOpen(false)
                      }}
                      className="flex-1 rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setMenuConfirm('clear')}
                  disabled={sessionBusy || messagesForCopy.length === 0}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  title="Clear chat history and assets for this session"
                >
                  <Trash2 size={12} />
                  Clear chat and assets
                </button>
              )}
              {(onToggleDebug || onShowSystemPrompt) && (
                <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              )}
              {onShowSystemPrompt && (
                <button
                  onClick={() => { onShowSystemPrompt(); setOverflowOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                    systemPromptPanelOpen
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-zinc-600 dark:text-zinc-300'
                  }`}
                  title="Open the debug side panel with the live system prompt and tool surface"
                >
                  <FileCode2 size={12} />
                  {systemPromptPanelOpen ? 'Hide system prompt' : 'Show system prompt'}
                </button>
              )}
              {onToggleDebug && (
                <button
                  onClick={() => { onToggleDebug(); setOverflowOpen(false) }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                    debugOpen
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-zinc-600 dark:text-zinc-300'
                  }`}
                >
                  <Bug size={12} />
                  {debugOpen ? 'Hide debug' : 'Show debug'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
  return (
    <>
      {statusBarTarget && createPortal(statusRow, statusBarTarget)}
      <div className={`relative ${composerPaddingClass}`}>
        <div className={contentWidthClass}>
          {/* Pinned sentence quotes — shown above the textarea, auto-prepended
              on send by useAppState.sendMessage. */}
          {pinnedQuotes.length > 0 && (
            <div className="mb-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/70">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Quote size={11} />
                  <span>
                    {pinnedQuotes.length} highlighted {pinnedQuotes.length === 1 ? 'sentence' : 'sentences'} will be sent above your message
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onClearPinnedQuotes}
                  className="rounded-md px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  Clear all
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {pinnedQuotes.map((quote) => (
                  <div
                    key={quote.id}
                    className="flex items-start gap-2 rounded-md border-l-2 border-indigo-300 bg-white/70 py-1.5 pl-2 pr-1.5 text-xs italic text-zinc-700 dark:border-indigo-700 dark:bg-zinc-950/60 dark:text-zinc-200"
                  >
                    <div className="line-clamp-2 min-w-0 flex-1">
                      {quote.text.length > 160
                        ? `${quote.text.slice(0, 160)}…`
                        : quote.text}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemovePinnedQuote(quote.id)}
                      className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      aria-label="Remove highlighted sentence"
                      title="Remove highlighted sentence"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        {/* Text input area */}
        <div className="flex items-stretch">
          <div
            className={`relative min-w-0 flex-1 border transition-colors ${floatingPresentation ? 'rounded-[30px]' : 'rounded-2xl'} ${composerFrameClass} ${composerDragClass}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={(event) => {
              void handleDrop(event)
            }}
          >
            {readAloudPlayback && !floatingPresentation && (
              <ReadAloudPlaybackOverlay
                controls={readAloudPlayback}
                className="pointer-events-auto absolute inset-x-3 top-0 z-20 -translate-y-[52%]"
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={attachmentAccept}
              multiple
              disabled={attachmentsLocked || isSubmitPending || attachmentAccept.length === 0}
              tabIndex={-1}
              className="hidden"
            onChange={(event) => {
              void handleAttachInputChange(event)
            }}
          />
          <div className={`flex items-center gap-2 ${floatingPresentation ? 'px-3 py-3' : 'px-2 py-2'}`}>
            <div className="min-w-0 flex-1">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
                placeholder={composerPlaceholder}
                rows={1}
                disabled={submitLocked || (isCompacting && !isShellMode)}
                readOnly={speechLocked}
                className={`${floatingPresentation ? COMPOSER_TEXTAREA_BASE_FLOATING : COMPOSER_TEXTAREA_BASE} ${floatingPresentation ? 'px-3 py-2.5 text-[17px]' : 'px-2 py-2 text-sm'} ${text.length === 0 ? 'truncate' : ''}`}
              />
            </div>

            <div className="flex flex-none items-center gap-1 self-center">
              <button
                onClick={handleAttachButtonClick}
                disabled={attachmentsLocked || isSubmitPending || attachmentAccept.length === 0}
                className={`${floatingPresentation ? 'rounded-xl p-2' : 'rounded-md p-1.5'} text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 dark:disabled:hover:bg-transparent dark:disabled:hover:text-zinc-400`}
                title={attachmentButtonTitle}
                aria-label={attachmentButtonTitle}
              >
                <Paperclip size={16} />
              </button>
              <button
                onClick={() => setCameraOpen(true)}
                disabled={attachmentsLocked}
                className={`${floatingPresentation ? 'rounded-xl p-2' : 'rounded-md p-1.5'} text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300`}
                title={
                  isResearchConversation
                    ? 'Research conversations currently support text prompts only.'
                    : isShellMode
                    ? 'Shell mode does not accept camera input'
                    : conversationRunDisabledReason
                      ? conversationRunDisabledReason
                    : 'Open camera'
                }
              >
                <Camera size={16} />
              </button>
              {showSpeechControl && !isShellMode && (
                <SpeechComposerControl
                  speech={speechStatus}
                  state={speechVisualState}
                  disabled={sessionBusy || conversationRunBlocked || submitLocked}
                  onToggle={handleSpeechToggle}
                  onInstall={onInstallSpeech}
                  onRepair={onRepairSpeech}
                  onOpenSettings={onOpenSpeechSettings}
                />
              )}
              {onToggleAssistantNarration && !isShellMode && (
                <button
                  type="button"
                  onClick={onToggleAssistantNarration}
                  disabled={!assistantNarrationAvailable || Boolean(assistantNarrationDisabledReason)}
                  aria-label={assistantNarrationTitle}
                  title={assistantNarrationTitle}
                  className={`${floatingPresentation ? 'rounded-xl p-2' : 'rounded-md p-1.5'} transition-colors ${
                    assistantNarrationMode === 'summary'
                      ? 'bg-cyan-500/15 text-cyan-600 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 dark:text-cyan-200'
                    : assistantNarrationMode === 'full'
                      ? 'bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-400/30 hover:bg-emerald-500/25 dark:text-emerald-200'
                      : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300'
                  } disabled:opacity-50 disabled:hover:bg-transparent`}
                >
                  {assistantNarrationMode === 'summary'
                    ? <AudioLines size={16} />
                    : assistantNarrationMode === 'full'
                      ? <BookOpenText size={16} />
                      : <VolumeX size={16} />}
                </button>
              )}

              <ContextGauge
                tokensUsed={sessionContext.tokensUsed}
                contextLength={sessionContext.contextLength}
              />

              {sessionBusy ? (
                <>
                  <button
                    onClick={onCancel}
                    className={
                      isGenerating
                        ? `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-red-500 text-white transition-colors hover:bg-red-600`
                        : `${floatingPresentation ? 'rounded-2xl p-2' : 'rounded-md p-1.5'} bg-amber-500 text-white transition-colors hover:bg-amber-600`
                    }
                    title={isGenerating ? 'Cancel generation' : 'Cancel compaction'}
                  >
                    <Square size={16} />
                  </button>
                  <button
                    onClick={() => {
                      if (isShellMode) {
                        void handleRunShellCommand()
                      } else {
                        void handleSend()
                      }
                    }}
                    disabled={!canSubmitDraft}
                    className={sendButtonClass}
                    title={
                      isShellMode
                        ? 'Run shell command'
                        : conversationRunDisabledReason
                          ? conversationRunDisabledReason
                        : !canQueueWhileBusy
                          ? busyQueueBlockedReason ?? 'Wait for this turn to finish'
                        : isCompacting
                          ? 'Waiting for compaction to finish'
                        : speechLocked
                          ? 'Finish speech input and queue message'
                          : 'Queue message'
                    }
                  >
                    <Send size={16} />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    if (isShellMode) {
                      void handleRunShellCommand()
                    } else {
                      void handleSend()
                    }
                  }}
                  disabled={isShellMode ? !canRunShellCommand : !canSubmitDraft}
                  className={sendButtonClass}
                  title={
                    isShellMode
                      ? 'Run shell command'
                      : conversationRunDisabledReason
                        ? conversationRunDisabledReason
                      : isResearchConversation
                      ? speechLocked
                        ? 'Finish speech input and run deep research'
                        : 'Run deep research'
                      : speechLocked
                        ? 'Finish speech input and send message'
                        : 'Send message'
                  }
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
          {isShellMode && (
            <div className="flex items-center gap-2 border-t border-amber-200/70 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-900/60 dark:text-amber-200">
              <TerminalIcon size={12} />
              <span className="font-medium uppercase tracking-[0.14em]">
                Shell mode
              </span>
              <code className="min-w-0 truncate rounded bg-amber-100/80 px-1.5 py-0.5 font-mono text-[11px] text-amber-950 dark:bg-amber-950/60 dark:text-amber-100">
                {workingDirectory}
              </code>
            </div>
          )}
        </div>
      </div>

      {isDragOver && (
        <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
          {isResearchConversation
            ? 'Research conversations currently support text prompts only.'
            : isShellMode
            ? 'Shell mode is active. Remove the leading ! before dropping files.'
            : 'Drop supported files here to attach them to the next turn.'}
        </div>
      )}

      {speechErrorMessage && (
        <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {speechErrorMessage}
        </div>
      )}

      {attachmentErrorMessage && (
        <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {attachmentErrorMessage}
        </div>
      )}

      {conversationRunDisabledReason && !attachmentErrorMessage && (
        <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {conversationRunDisabledReason}
        </div>
      )}

      {memoryNotice && (
        <div
          className={`mt-2 text-xs ${
            memoryNotice.tone === 'success'
              ? 'text-emerald-600 dark:text-emerald-400'
              : memoryNotice.tone === 'error'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {memoryNotice.text}
        </div>
      )}

      {(sessionBusy || isSubmitPending) && (
        <div className="sr-only" aria-live="polite">
          {isCompacting ? 'Compacting session context.' : 'Agent is working.'}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {attachments.map((attachment, index) => {
            const attachmentKey = buildAttachmentKey(attachment, index)
            const previewUrl =
              attachment.kind === 'image' || attachment.kind === 'video'
                ? resolveAttachmentPreviewUrl(attachment)
                : undefined
            const removeButton = (
              <button
                onClick={() => {
                  resetEscapeClearState()
                  setAttachmentErrorMessage(null)
                  discardPendingManagedAttachment(attachment)
                  setAttachments((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index),
                  )
                }}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                title="Remove attachment"
              >
                <X size={12} />
              </button>
            )

            if (attachment.kind === 'pdf') {
              const pageCount = attachment.pageCount ?? 0
              const workerLabel = attachment.workerModelId
                ? `${findGemmaCatalogEntryByTag(attachment.workerModelId)?.label ?? attachment.workerModelId} worker`
                : pdfWorkerModelId
                  ? `${selectedModel?.name ?? pdfWorkerModelId} worker`
                  : 'Worker unavailable'
              const range = attachment.processedRange
                ?? (pageCount > 0 ? defaultPdfPageRange(pageCount) : undefined)
              const validationMessage =
                pageCount > 0 && range
                  ? validatePdfPageRange(range, pageCount)
                  : null
              const advancedOpen = Boolean(pdfAdvancedOpen[attachmentKey])
              const fitStatusLabel = formatPdfFitStatusLabel(attachment.fitStatus)
              const fitStatusClasses =
                attachment.fitStatus === 'ready'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
              const rangeSummary =
                pageCount > 0 && range
                  ? attachment.processingMode === 'custom_range'
                    ? `Pages ${range.startPage}-${range.endPage} of ${pageCount}`
                    : `Full document · ${pageCount} page${pageCount === 1 ? '' : 's'}`
                  : 'Inspecting PDF'

              return (
                <div
                  key={attachmentKey}
                  className="rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/70"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                        <FileDown size={20} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                          {attachment.name}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span>{rangeSummary}</span>
                          <span>{workerLabel}</span>
                          <span>
                            {attachment.batchCount ?? 0} batch
                            {(attachment.batchCount ?? 0) === 1 ? '' : 'es'}
                          </span>
                        </div>
                        {attachment.planningReason && attachment.fitStatus !== 'ready' && (
                          <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                            {attachment.planningReason}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${fitStatusClasses}`}>
                        {fitStatusLabel}
                      </div>
                      {removeButton}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPdfAdvancedOpen((current) => ({
                          ...current,
                          [attachmentKey]: !current[attachmentKey],
                        }))
                      }}
                      className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {advancedOpen ? 'Hide advanced range' : 'Advanced range'}
                    </button>
                    {pageCount > 0 && range && attachment.processingMode === 'custom_range' && (
                      <button
                        type="button"
                        onClick={() => {
                          updatePdfAttachment(attachmentKey, (current) => ({
                            ...current,
                            processingMode: 'full_document',
                            processedRange: defaultPdfPageRange(pageCount),
                          }))
                        }}
                        className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Use full document
                      </button>
                    )}
                  </div>

                  {advancedOpen && pageCount > 0 && range && (
                    <div className="mt-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/70">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                        Custom range
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="text-xs text-zinc-600 dark:text-zinc-300">
                          <div className="mb-1">Start page</div>
                          <input
                            type="number"
                            min={1}
                            max={pageCount}
                            value={range.startPage}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value, 10)
                              if (!Number.isFinite(nextValue)) {
                                return
                              }
                              updatePdfAttachment(attachmentKey, (current) => {
                                const currentRange = current.processedRange ?? defaultPdfPageRange(pageCount)
                                return {
                                  ...current,
                                  processingMode: 'custom_range',
                                  processedRange: clampPdfPageRange({
                                    startPage: nextValue,
                                    endPage: currentRange.endPage,
                                  }, pageCount),
                                }
                              })
                            }}
                            className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-emerald-500 dark:focus:ring-emerald-950"
                          />
                        </label>
                        <label className="text-xs text-zinc-600 dark:text-zinc-300">
                          <div className="mb-1">End page</div>
                          <input
                            type="number"
                            min={1}
                            max={pageCount}
                            value={range.endPage}
                            onChange={(event) => {
                              const nextValue = Number.parseInt(event.target.value, 10)
                              if (!Number.isFinite(nextValue)) {
                                return
                              }
                              updatePdfAttachment(attachmentKey, (current) => {
                                const currentRange = current.processedRange ?? defaultPdfPageRange(pageCount)
                                return {
                                  ...current,
                                  processingMode: 'custom_range',
                                  processedRange: clampPdfPageRange({
                                    startPage: currentRange.startPage,
                                    endPage: nextValue,
                                  }, pageCount),
                                }
                              })
                            }}
                            className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-emerald-500 dark:focus:ring-emerald-950"
                          />
                        </label>
                      </div>
                      <div className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                        Gemma Desktop defaults to the full document. Narrow the range only when the batch estimate or payload fit needs help.
                      </div>
                      {validationMessage && (
                        <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                          {validationMessage}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <div
                key={attachmentKey}
                className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900"
              >
                {attachment.kind === 'image' && previewUrl && (
                  <img
                    src={previewUrl}
                    alt={attachment.name}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                )}
                {attachment.kind === 'video' && previewUrl && (
                  <img
                    src={previewUrl}
                    alt={attachment.name}
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                )}
                {attachment.kind === 'audio' && (
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                    <AudioLines size={18} />
                  </div>
                )}
                {attachment.kind === 'video' && !previewUrl && (
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                    <Film size={18} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">
                    {attachment.name}
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {attachment.kind === 'audio'
                        ? attachment.durationMs != null
                          ? `Audio ${(attachment.durationMs / 1000).toFixed(1)}s`
                          : 'Audio attachment'
                      : attachment.kind === 'video'
                          ? [
                            attachment.durationMs != null
                              ? `${Math.max(attachment.durationMs / 1000, 0).toFixed(1)}s`
                              : null,
                            `${attachment.sampledFrames?.length ?? 0} keyframe${(attachment.sampledFrames?.length ?? 0) === 1 ? '' : 's'}`,
                            attachment.sampledFrames?.[0]?.timestampMs != null
                              ? `starts ${formatAttachmentTimestampMs(attachment.sampledFrames[0].timestampMs!)}`
                              : null,
                          ].filter(Boolean).join(' · ')
                          : attachment.source === 'camera'
                            ? 'Camera photo'
                            : 'Attachment'}
                  </div>
                </div>
                {removeButton}
              </div>
            )
          })}
        </div>
      )}

      {escapeClearState === 'armed' && hasDraftContent && (
        <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Press Escape again to clear this draft.
        </div>
      )}

      {escapeClearState === 'confirm' && hasDraftContent && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span>Clear the current draft?</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetEscapeClearState}
              className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={clearComposer}
              className="rounded-md bg-zinc-900 px-2.5 py-1 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              Clear
            </button>
          </div>
        </div>
      )}

          <CameraCaptureModal
            open={cameraOpen}
            onClose={() => setCameraOpen(false)}
            onConfirm={(attachment) => {
              if (attachmentsLocked) {
                return
              }
              setAttachments((current) => [...current, attachment])
            }}
          />
        </div>
      </div>
      {!statusBarTarget && !floatingPresentation && (
        <div className="statusbar-shell flex pr-2.5">
          <div className="surface-statusbar flex min-w-0 flex-1 px-6 py-2">
            {statusRow}
          </div>
        </div>
      )}
    </>
  )
}
