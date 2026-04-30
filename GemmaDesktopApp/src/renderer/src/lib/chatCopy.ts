import {
  buildSessionBootstrapCard,
  splitInlineDebugLogs,
  type InlineDebugCard,
} from '@/lib/debugTimeline'
import { buildTurnDurationLabel } from '@/lib/turnStatus'
import type {
  ChatMessage,
  DebugLogEntry,
  DebugSessionSnapshot,
  MessageContent,
} from '@/types'

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringifyContentValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  if (value == null || typeof value === 'boolean') {
    return ''
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyContentValue(item)).join('')
  }

  return formatJson(value)
}

function renderContentBlock(content: MessageContent): string {
  switch (content.type) {
    case 'text':
      return stringifyContentValue(content.text)
    case 'image':
      return [
        `[Image${content.filename ? `: ${content.filename}` : ''}]`,
        ...(content.source ? [`Source: ${content.source}`] : []),
        ...(content.url ? [`URL: ${content.url}`] : []),
      ].join('\n')
    case 'pdf':
      return [
        `[PDF: ${content.filename}]`,
        `Mode: ${content.processingMode === 'full_document' ? 'Full document' : 'Custom range'}`,
        `Pages: ${content.processedRange.startPage}-${content.processedRange.endPage} of ${content.pageCount}`,
        `Worker: ${content.workerModelId ?? 'Unknown'}`,
        `Batches: ${content.batchCount}`,
        `Fit status: ${content.fitStatus}`,
        `URL: ${content.url}`,
      ].join('\n')
    case 'audio':
      return [
        `[Audio: ${content.filename}]`,
        ...(content.durationMs != null ? [`Duration: ${content.durationMs} ms`] : []),
        ...(content.normalizedMediaType ? [`Normalized: ${content.normalizedMediaType}`] : []),
        ...(content.url ? [`URL: ${content.url}`] : []),
      ].join('\n')
    case 'video':
      return [
        `[Video: ${content.filename}]`,
        ...(content.durationMs != null ? [`Duration: ${content.durationMs} ms`] : []),
        `Prepared keyframes: ${content.sampledFrameCount}`,
        ...(content.sampledFrameTimestampsMs && content.sampledFrameTimestampsMs.length > 0
          ? [`Keyframe timestamps: ${content.sampledFrameTimestampsMs.join(', ')}`]
          : []),
        `URL: ${content.url}`,
      ].join('\n')
    case 'thinking':
      return ['[Thinking]', stringifyContentValue(content.text)].join('\n')
    case 'code':
      return [
        `[Code${content.filename ? `: ${content.filename}` : ''}]`,
        `Language: ${content.language}`,
        stringifyContentValue(content.code),
      ].join('\n')
    case 'file_edit':
      return [
        `[${content.changeType === 'created' ? 'Created' : 'Edited'}: ${content.path}]`,
        `Lines: +${content.addedLines} -${content.removedLines}`,
        stringifyContentValue(content.diff),
      ].join('\n')
    case 'diff':
      return [
        `[Diff: ${content.filename}]`,
        stringifyContentValue(content.diff),
      ].join('\n')
    case 'file_excerpt':
      return [
        `[File Excerpt: ${content.filename}]`,
        `Language: ${content.language}`,
        `Start Line: ${content.startLine}`,
        stringifyContentValue(content.content),
      ].join('\n')
    case 'tool_call':
      return [
        `[Tool: ${content.toolName}]`,
        `Status: ${content.status}`,
        ...(content.worker?.label ? [`Worker: ${content.worker.label}`] : []),
        ...(content.worker?.goal ? [`Goal: ${content.worker.goal}`] : []),
        ...(content.worker?.resultSummary ? [`Worker result: ${content.worker.resultSummary}`] : []),
        'Input:',
        formatJson(content.input),
        ...(content.output
          ? ['Output:', stringifyContentValue(content.output)]
          : []),
      ].join('\n')
    case 'error':
      return [
        '[Error]',
        stringifyContentValue(content.message),
        ...(content.details ? [stringifyContentValue(content.details)] : []),
      ].join('\n')
    case 'warning':
      return ['[Warning]', stringifyContentValue(content.message)].join('\n')
    case 'folder_link':
      return [
        `[Folder: ${content.label}]`,
        stringifyContentValue(content.path),
      ].join('\n')
    case 'research_panel':
      return [
        '[Research Progress]',
        content.panel.title ?? 'Research',
        `Status: ${content.panel.runStatus}`,
        `Stage: ${content.panel.stage}`,
        ...(content.panel.liveHint ? [content.panel.liveHint] : []),
        ...(content.panel.errorMessage ? [content.panel.errorMessage] : []),
      ].join('\n')
    case 'shell_session':
      return [
        `[Shell: !${content.command}]`,
        `Directory: ${content.workingDirectory}`,
        `Status: ${content.status}`,
        ...(content.exitCode != null ? [`Exit code: ${content.exitCode}`] : []),
        ...(content.transcript.trim().length > 0
          ? ['Transcript:', content.transcript.trimEnd()]
          : []),
      ].join('\n')
    default:
      return ''
  }
}

export function applyLatestAssistantPrimaryModelFallback(
  messages: ChatMessage[],
  primaryModelId?: string | null,
): ChatMessage[] {
  const normalizedPrimaryModelId = primaryModelId?.trim()
  if (!normalizedPrimaryModelId) {
    return messages
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') {
      continue
    }

    if (message.primaryModelId?.trim()) {
      return messages
    }

    return messages.map((entry, entryIndex) =>
      entryIndex === index
        ? { ...entry, primaryModelId: normalizedPrimaryModelId }
        : entry,
    )
  }

  return messages
}

export function serializeChatMessage(message: ChatMessage): string {
  const roleLabel =
    message.role === 'user'
      ? 'User'
      : message.role === 'assistant'
        ? 'Gemma'
        : 'System'
  const sections = [
    `${roleLabel} • ${new Date(message.timestamp).toLocaleString()}`,
    ...message.content
      .map((content) => renderContentBlock(content).trim())
      .filter((value) => value.length > 0),
    ...(message.role === 'assistant'
      ? [
          buildTurnDurationLabel(
            message.content,
            message.durationMs,
            message.primaryModelId,
          ) ?? '',
        ]
      : []),
  ].filter((section) => section.length > 0)

  return sections.join('\n\n')
}

export function serializeChatHistory(messages: ChatMessage[]): string {
  return messages.map((message) => serializeChatMessage(message)).join('\n\n---\n\n')
}

function serializeSessionMetadata(args: {
  sessionTitle?: string
  workingDirectory?: string
}): string {
  const rows = [
    ['Conversation', args.sessionTitle?.trim()],
    ['Local directory', args.workingDirectory?.trim()],
  ]
    .filter(([, value]) => value && value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)

  return rows.join('\n')
}

export function serializeAssistantTurn(
  messages: ChatMessage[],
  assistantMessageId: string,
): string {
  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === 'assistant',
  )

  if (assistantIndex < 0) {
    return ''
  }

  const assistantMessage = messages[assistantIndex]
  if (!assistantMessage) {
    return ''
  }
  const previousUserMessage = [...messages.slice(0, assistantIndex)]
    .reverse()
    .find((message) => message.role === 'user')

  return [
    ...(previousUserMessage ? [serializeChatMessage(previousUserMessage)] : []),
    serializeChatMessage(assistantMessage),
  ].join('\n\n---\n\n')
}

function serializeDebugCard(card: InlineDebugCard): string {
  return [
    `[Debug: ${card.title}]`,
    ...(card.subtitle ? [card.subtitle] : []),
    '',
    card.body,
  ].join('\n')
}

function splitConversationTurns(messages: ChatMessage[]): {
  introMessages: ChatMessage[]
  turns: Array<{ user: ChatMessage; responses: ChatMessage[] }>
} {
  const introMessages: ChatMessage[] = []
  const turns: Array<{ user: ChatMessage; responses: ChatMessage[] }> = []

  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ user: message, responses: [] })
      continue
    }

    if (turns.length === 0) {
      introMessages.push(message)
      continue
    }

    turns[turns.length - 1]?.responses.push(message)
  }

  return { introMessages, turns }
}

export function serializeSessionHistory(args: {
  messages: ChatMessage[]
  debugEnabled: boolean
  debugLogs: DebugLogEntry[]
  debugSession: DebugSessionSnapshot | null
  sessionTitle?: string
  workingDirectory?: string
}): string {
  const {
    messages,
    debugEnabled,
    debugLogs,
    debugSession,
    sessionTitle,
    workingDirectory,
  } = args
  const metadata = serializeSessionMetadata({ sessionTitle, workingDirectory })

  if (!debugEnabled) {
    return [
      metadata,
      serializeChatHistory(messages),
    ].filter((section) => section.length > 0).join('\n\n---\n\n')
  }

  const sections: string[] = []
  const timeline = splitInlineDebugLogs(debugLogs)
  const conversation = splitConversationTurns(messages)
  const bootstrapCard = buildSessionBootstrapCard(debugSession, sessionTitle)

  if (metadata.length > 0) {
    sections.push(metadata)
  }

  if (bootstrapCard) {
    sections.push(serializeDebugCard(bootstrapCard))
  }

  for (const card of timeline.interstitialLogs[0] ?? []) {
    sections.push(serializeDebugCard(card))
  }

  for (const message of conversation.introMessages) {
    sections.push(serializeChatMessage(message))
  }

  conversation.turns.forEach((turn, turnIndex) => {
    const turnLogs = timeline.turnLogs[turnIndex]
    const betweenTurnLogs = timeline.interstitialLogs[turnIndex + 1] ?? []

    sections.push(serializeChatMessage(turn.user))

    for (const card of turnLogs?.beforeResult ?? []) {
      sections.push(serializeDebugCard(card))
    }

    for (const response of turn.responses) {
      sections.push(serializeChatMessage(response))
    }

    for (const card of turnLogs?.afterResult ?? []) {
      sections.push(serializeDebugCard(card))
    }

    for (const card of betweenTurnLogs) {
      sections.push(serializeDebugCard(card))
    }
  })

  return sections.join('\n\n---\n\n')
}
