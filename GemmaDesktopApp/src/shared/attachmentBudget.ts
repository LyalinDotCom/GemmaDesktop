import type { AttachmentSupport } from './attachmentSupport'
import type { AttachmentKind } from '@gemma-desktop/sdk-core'

export interface AttachmentBudgetItem {
  kind: AttachmentKind
  name: string
  size: number
  durationMs?: number
  pageCount?: number
  batchCount?: number
  fitStatus?: string
  sampledFrameCount?: number
}

export interface AttachmentBudgetAssessment {
  estimatedTokens: number
  issues: string[]
}

function estimateAttachmentTokens(
  attachment: AttachmentBudgetItem,
  support: AttachmentSupport | undefined,
): number {
  switch (attachment.kind) {
    case 'image':
      return support?.image ? 3_000 : 0
    case 'audio': {
      if (!support?.audio) {
        return 0
      }
      const seconds = Math.max((attachment.durationMs ?? 0) / 1000, 0)
      return Math.max(4_000, Math.round(seconds * 32))
    }
    case 'video':
      return 1_200 + Math.max(attachment.sampledFrameCount ?? 0, 0) * 500
    case 'pdf':
      return Math.max(
        6_000,
        Math.min(
          Math.max(attachment.pageCount ?? 1, 1) * 900,
          36_000,
        ),
      )
    default:
      return 0
  }
}

export function assessAttachmentBudget(input: {
  attachments: AttachmentBudgetItem[]
  support?: AttachmentSupport
  contextLength?: number
}): AttachmentBudgetAssessment {
  const contextLength = Math.max(input.contextLength ?? 32_768, 1)
  const issues: string[] = []
  let estimatedTokens = 0

  for (const attachment of input.attachments) {
    const estimate = estimateAttachmentTokens(attachment, input.support)
    estimatedTokens += estimate

    if (attachment.kind === 'pdf' && attachment.fitStatus === 'too_large') {
      issues.push(`${attachment.name} is too large for the current PDF processing budget.`)
      continue
    }

    if (estimate >= contextLength * 0.25) {
      issues.push(
        `${attachment.name} may consume a large share of the model context (${estimate.toLocaleString()} estimated tokens).`,
      )
    }
  }

  if (estimatedTokens >= contextLength * 0.5) {
    issues.unshift(
      `These attachments are estimated to use about ${estimatedTokens.toLocaleString()} tokens against a ${contextLength.toLocaleString()} token context window.`,
    )
  }

  return {
    estimatedTokens,
    issues,
  }
}
