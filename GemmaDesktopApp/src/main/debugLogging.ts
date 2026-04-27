interface EventLike {
  type: string
  payload?: unknown
}

interface DebugLogLike {
  event: string
  data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textPreview(value: unknown, maxLength = 160): {
  length: number
  preview: string
} {
  const text = typeof value === 'string' ? value : ''
  return {
    length: text.length,
    preview: text.slice(0, maxLength),
  }
}

function summarizeToolCallPayload(payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {}
  const input = isRecord(record.input) ? record.input : null

  return {
    step: record.step,
    callId: record.callId,
    toolName: record.toolName,
    inputKeys: input ? Object.keys(input) : [],
  }
}

function summarizeToolResultPayload(payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {}
  const resultSummary = textPreview(
    typeof record.error === 'string' ? record.error : record.output,
  )
  const metadata = isRecord(record.metadata) ? record.metadata : null

  return {
    step: record.step,
    callId: record.callId,
    toolName: record.toolName,
    outputLength: resultSummary.length,
    outputPreview: resultSummary.preview,
    errored: typeof record.error === 'string',
    metadata: metadata
      ? {
          childSessionId: metadata.childSessionId,
          childTurnId: metadata.childTurnId,
          childTraceLength:
            typeof metadata.childTrace === 'string'
              ? metadata.childTrace.length
              : 0,
          sourceCount: Array.isArray(metadata.sources)
            ? metadata.sources.length
            : undefined,
        }
      : undefined,
  }
}

function summarizeContentCompletedPayload(
  payload: unknown,
): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {}
  const textSummary = textPreview(record.text)
  const reasoningSummary = textPreview(record.reasoning)
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : []

  return {
    step: record.step,
    textLength: textSummary.length,
    textPreview: textSummary.preview,
    reasoningLength: reasoningSummary.length,
    reasoningPreview: reasoningSummary.preview,
    toolCallCount: toolCalls.length,
  }
}

function summarizeTurnCompletedPayload(
  payload: unknown,
): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {}
  const usage = isRecord(record.usage) ? record.usage : null

  return {
    steps: record.steps,
    warningCount: Array.isArray(record.warnings) ? record.warnings.length : 0,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        }
      : undefined,
  }
}

function summarizeSubsessionChildPayload(
  childEventType: string | undefined,
  childPayload: unknown,
): unknown {
  switch (childEventType) {
    case undefined:
      return childPayload
    case 'content.delta': {
      const payload = isRecord(childPayload) ? childPayload : {}
      return {
        step: payload.step,
        channel: payload.channel,
        ...textPreview(payload.delta),
      }
    }
    case 'tool.call':
      return summarizeToolCallPayload(childPayload)
    case 'tool.result':
      return summarizeToolResultPayload(childPayload)
    case 'content.completed':
      return summarizeContentCompletedPayload(childPayload)
    case 'turn.completed':
      return summarizeTurnCompletedPayload(childPayload)
    default:
      return childPayload
  }
}

function getChildEventType(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined
  }

  if (typeof data.childEventType === 'string') {
    return data.childEventType
  }

  const payload = isRecord(data.payload) ? data.payload : null
  return payload && typeof payload.childEventType === 'string'
    ? payload.childEventType
    : undefined
}

export function summarizeSdkEventForDebug(event: EventLike): unknown {
  switch (event.type) {
    case 'content.delta': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return {
        step: payload.step,
        channel: payload.channel,
        ...textPreview(payload.delta),
      }
    }
    case 'content.completed':
      return summarizeContentCompletedPayload(event.payload)
    case 'tool.call':
      return summarizeToolCallPayload(event.payload)
    case 'tool.result':
      return summarizeToolResultPayload(event.payload)
    case 'tool.subsession.event': {
      const payload = isRecord(event.payload) ? event.payload : {}
      const childEventType =
        typeof payload.childEventType === 'string'
          ? payload.childEventType
          : undefined

      return {
        toolName: payload.toolName,
        childSessionId: payload.childSessionId,
        childTurnId: payload.childTurnId,
        childEventType,
        childPayload: summarizeSubsessionChildPayload(
          childEventType,
          payload.childPayload,
        ),
      }
    }
    case 'turn.completed':
      return summarizeTurnCompletedPayload(event.payload)
    case 'turn.step.started': {
      const payload = isRecord(event.payload) ? event.payload : {}
      return { step: payload.step }
    }
    default:
      return event.payload ?? event
  }
}

export function shouldPersistDebugLog(entry: DebugLogLike): boolean {
  if (
    entry.event === 'content.delta'
    || entry.event === 'session.event.content_delta_append'
    || entry.event === 'session.event.live_activity'
  ) {
    return false
  }

  if (entry.event === 'tool.subsession.event') {
    const childEventType = getChildEventType(entry.data)
    return childEventType !== 'content.delta'
  }

  return true
}
