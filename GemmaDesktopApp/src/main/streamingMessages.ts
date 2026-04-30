import type { ToolResult } from '@gemma-desktop/sdk-core'
import type { FileEditContentBlock } from '../shared/fileEdits'
import {
  sanitizeRenderableContentBlocks,
  stripAssistantTransportArtifacts,
} from '../shared/assistantTextArtifacts'
import {
  buildInterruptedAssistantMessage,
  CANCELLED_TURN_ID_SUFFIX,
  CANCELLED_TURN_WARNING,
} from './interruptedTurns'
import { extractFileEditBlocksFromToolResult } from './fileEdits'
import type { IncomingAttachment } from './sessionAttachments'
import type { ToolCallProgressBlock } from './toolProgress'
import type { AppMessage } from './sessionStore'

export type StreamingTextBlock = {
  type: 'text'
  text: string
  rawText?: string
}

export type StreamingThinkingBlock = {
  type: 'thinking'
  text: string
  summary?: string
  rawText?: string
}

export type StreamingToolCallBlock = ToolCallProgressBlock

export type StreamingFileEditBlock = FileEditContentBlock & {
  sourceToolCallId?: string
}

export type StreamingWarningBlock = {
  type: 'warning'
  message: string
}

export type StreamingContentBlock =
  | StreamingTextBlock
  | StreamingThinkingBlock
  | StreamingToolCallBlock
  | StreamingFileEditBlock
  | StreamingWarningBlock

export function isStreamingToolCallBlock(
  block: StreamingContentBlock,
): block is StreamingToolCallBlock {
  return block.type === 'tool_call'
}

export function normalizeUnknownRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

export function serializeStreamingBlocks(
  blocks: StreamingContentBlock[],
  options?: { cancelled?: boolean },
): Array<Record<string, unknown>> {
  return sanitizeRenderableContentBlocks(
    blocks.reduce<Array<Record<string, unknown>>>((serialized, block) => {
      if (block.type === 'tool_call') {
        const { callId: _, ...rest } = block
        if (options?.cancelled && (rest.status === 'running' || rest.status === 'pending')) {
          serialized.push({ ...rest, status: 'error' })
          return serialized
        }
        serialized.push(rest)
        return serialized
      }
      if (block.type === 'file_edit') {
        const { sourceToolCallId: _, ...rest } = block
        serialized.push(rest)
        return serialized
      }
      if ((block.type === 'text' || block.type === 'thinking') && block.text.length === 0) {
        return serialized
      }
      if (block.type === 'text' || block.type === 'thinking') {
        const { rawText: _, ...rest } = block
        serialized.push(rest)
        return serialized
      }
      serialized.push(block)
      return serialized
    }, []),
  )
}

export function appendStreamingDelta(
  blocks: StreamingContentBlock[],
  type: 'text' | 'thinking',
  delta: string,
): string {
  if (delta.length === 0) {
    return ''
  }

  const last = blocks[blocks.length - 1]
  if (last?.type === type) {
    const previousText = last.text
    const nextRawText = `${last.rawText ?? last.text}${delta}`
    const nextText = stripAssistantTransportArtifacts(nextRawText)
    last.rawText = nextRawText
    last.text = nextText
    return nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : ''
  }

  const nextText = stripAssistantTransportArtifacts(delta)
  if (nextText.length === 0) {
    return ''
  }

  blocks.push({ type, text: nextText, rawText: delta })
  return nextText
}

export function buildFallbackStreamingBlocks(result: {
  text: string
  reasoning?: string
  toolResults: ToolResult[]
  workingDirectory?: string
}): StreamingContentBlock[] {
  const blocks: StreamingContentBlock[] = []

  const sanitizedReasoning = result.reasoning
    ? stripAssistantTransportArtifacts(result.reasoning)
    : ''
  if (sanitizedReasoning) {
    blocks.push({ type: 'thinking', text: sanitizedReasoning })
  }

  const sanitizedText = result.text
    ? stripAssistantTransportArtifacts(result.text)
    : ''
  if (sanitizedText) {
    blocks.push({ type: 'text', text: sanitizedText })
  }

  for (const toolResult of result.toolResults) {
    const fileEditBlocks = result.workingDirectory
      ? extractFileEditBlocksFromToolResult({
          toolName: toolResult.toolName,
          structuredOutput: toolResult.structuredOutput,
          workingDirectory: result.workingDirectory,
        }).map((block) => ({
          ...block,
          sourceToolCallId: toolResult.callId,
        }))
      : []
    if (fileEditBlocks.length > 0) {
      blocks.push(...fileEditBlocks)
      continue
    }
    blocks.push({
      type: 'tool_call',
      toolName: toolResult.toolName,
      input: {},
      output: toolResult.output,
      status: isErroredToolResult(toolResult) ? 'error' : 'success',
      callId: toolResult.callId,
    })
  }

  return blocks
}

export function isErroredToolResult(toolResult: ToolResult): boolean {
  const metadata = normalizeUnknownRecord(toolResult.metadata)
  if (metadata.toolError === true) {
    return true
  }

  const structured = normalizeUnknownRecord(toolResult.structuredOutput)
  return structured.ok === false || typeof structured.error === 'string'
}

function stripProvisionalToolTextBlocks(
  blocks: StreamingContentBlock[],
): StreamingContentBlock[] {
  return blocks.filter((block, index) => {
    if (block.type !== 'text') {
      return true
    }

    let sawToolCall = false
    for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
      const next = blocks[cursor]
      if (!next || next.type === 'thinking') {
        continue
      }

      if (next.type === 'tool_call' || next.type === 'file_edit') {
        sawToolCall = true
        continue
      }

      if (next.type === 'text') {
        return !sawToolCall
      }

      return true
    }

    return true
  })
}

export function finalizeStreamingBlocks(
  blocks: StreamingContentBlock[],
  result: {
    text: string
    reasoning?: string
    toolResults: ToolResult[]
    workingDirectory?: string
  },
): StreamingContentBlock[] {
  if (blocks.length === 0) {
    return buildFallbackStreamingBlocks(result)
  }

  const finalized = stripProvisionalToolTextBlocks(
    blocks.map((block) => ({ ...block })),
  )
  const hasThinking = finalized.some((block) => block.type === 'thinking')
  const hasText = finalized.some((block) => block.type === 'text')
  const sanitizedReasoning = result.reasoning
    ? stripAssistantTransportArtifacts(result.reasoning)
    : ''
  const sanitizedText = result.text
    ? stripAssistantTransportArtifacts(result.text)
    : ''

  if (sanitizedReasoning && !hasThinking) {
    finalized.unshift({ type: 'thinking', text: sanitizedReasoning })
  }

  if (sanitizedText && !hasText) {
    finalized.push({ type: 'text', text: sanitizedText })
  }

  for (const toolResult of result.toolResults) {
    const fileEditBlocks = result.workingDirectory
      ? extractFileEditBlocksFromToolResult({
          toolName: toolResult.toolName,
          structuredOutput: toolResult.structuredOutput,
          workingDirectory: result.workingDirectory,
        }).map((block) => ({
          ...block,
          sourceToolCallId: toolResult.callId,
        }))
      : []
    const existingFileEditIndex = finalized.findIndex(
      (block) => block.type === 'file_edit' && block.sourceToolCallId === toolResult.callId,
    )
    const idx = finalized.findIndex(
      (block) =>
        block.type === 'tool_call'
        && block.callId === toolResult.callId,
    )

    if (fileEditBlocks.length > 0) {
      if (idx >= 0) {
        finalized.splice(idx, 1, ...fileEditBlocks)
        continue
      }
      if (existingFileEditIndex >= 0) {
        continue
      }
      finalized.push(...fileEditBlocks)
      continue
    }

    if (idx >= 0) {
      const block = finalized[idx]
      if (block && isStreamingToolCallBlock(block)) {
        finalized[idx] = {
          ...block,
          output: toolResult.output,
          status: isErroredToolResult(toolResult) ? 'error' : 'success',
        }
        continue
      }
    }

    finalized.push({
      type: 'tool_call',
      toolName: toolResult.toolName,
      input: {},
      output: toolResult.output,
      status: isErroredToolResult(toolResult) ? 'error' : 'success',
      callId: toolResult.callId,
    })
  }

  const stillMissingUserFacingText = !finalized.some(
    (block) => block.type === 'text' || block.type === 'file_edit',
  )
  if (stillMissingUserFacingText && result.toolResults.length > 0) {
    finalized.push({
      type: 'text',
      text:
        'Completed tool work, but the model did not produce a final written response. Review the tool output above.',
    })
  }

  return finalized
}

export function buildCancelledAssistantMessage(
  turnId: string,
  blocks: StreamingContentBlock[],
  durationMs?: number,
): AppMessage | null {
  return buildInterruptedAssistantMessage({
    turnId,
    content: serializeStreamingBlocks(blocks, { cancelled: true }),
    timestamp: Date.now(),
    durationMs,
    idSuffix: CANCELLED_TURN_ID_SUFFIX,
    warningMessage: CANCELLED_TURN_WARNING,
  }) as AppMessage | null
}

export function buildCompletedAssistantMessageFromBlocks(
  turnId: string,
  blocks: StreamingContentBlock[],
  durationMs?: number,
): AppMessage | null {
  const content = sanitizeRenderableContentBlocks(
    serializeStreamingBlocks(
      finalizeStreamingBlocks(blocks, {
        text: '',
        toolResults: [],
      }),
    ),
  )

  if (content.length === 0) {
    return null
  }

  return {
    id: turnId,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    durationMs,
  }
}

export function appMessageContentMatches(
  left: AppMessage['content'],
  right: AppMessage['content'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function buildUserMessagePreviewText(
  text: string,
  attachments: Array<Pick<IncomingAttachment, 'kind' | 'name'>> = [],
): string {
  const textPreview = text.trim().slice(0, 120)
  if (textPreview.length > 0) {
    return textPreview
  }

  const firstAttachment = attachments[0]
  if (!firstAttachment) {
    return ''
  }

  return `[${firstAttachment.kind}] ${firstAttachment.name || 'attachment'}`
}
