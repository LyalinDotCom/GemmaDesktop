import { randomUUID } from 'crypto'
import type { SessionMessage } from '@gemma-desktop/sdk-core'
import {
  EXIT_PLAN_MODE_TOOL,
  type AppSessionMode,
  type ConversationKind,
} from './tooling'

const PLAN_EXIT_TOOL_NAME_SET = new Set([
  EXIT_PLAN_MODE_TOOL,
])

const PLACEHOLDER_SESSION_TITLE = 'New Conversation'
const MAX_PLAN_SUMMARY_LENGTH = 280
const MAX_PLAN_DETAILS_LENGTH = 4000
const TRAILING_PLAN_FOLLOW_UP_PATTERN =
  /^(?:\*\*)?(?:would you like me(?: to)?|should i(?: refine| continue)?|shall i|do you want me to|let me know if you'd like me to|if you'd like,?\s*i can)\b/i
const PLAN_HANDOFF_PREFIXES = [
  'Planning handoff',
  'Implement the approved plan now.',
] as const

function truncateLine(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= maxLength) {
    return trimmed
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function formatLabelList(values: string[], maxItems = 4): string | undefined {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)

  if (normalized.length === 0) {
    return undefined
  }

  if (normalized.length <= maxItems) {
    return normalized.join(', ')
  }

  return `${normalized.slice(0, maxItems).join(', ')} +${normalized.length - maxItems} more`
}

function stripTrailingPlanFollowUp(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/)

  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1]?.trim() ?? ''
    if (lastLine.length === 0) {
      lines.pop()
      continue
    }

    const normalizedLine = lastLine
      .replace(/^[>*\s`#-]+/, '')
      .replace(/[*_`]+$/, '')
      .trim()

    if (!TRAILING_PLAN_FOLLOW_UP_PATTERN.test(normalizedLine)) {
      break
    }

    lines.pop()
    while (lines.length > 0 && (lines[lines.length - 1]?.trim() ?? '') === '') {
      lines.pop()
    }
  }

  return lines.join('\n').trim()
}

export function extractPlanSummaryFromText(text: string): string | undefined {
  const firstParagraph = text
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .find((entry) => entry.length > 0)

  if (!firstParagraph) {
    return undefined
  }

  if (firstParagraph.length <= MAX_PLAN_SUMMARY_LENGTH) {
    return firstParagraph
  }

  return `${firstParagraph.slice(0, MAX_PLAN_SUMMARY_LENGTH - 3).trimEnd()}...`
}

export function extractPlanDetailsFromText(text: string): string | undefined {
  const trimmed = stripTrailingPlanFollowUp(text)
  if (trimmed.length === 0) {
    return undefined
  }

  if (PLAN_HANDOFF_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return undefined
  }

  const normalized = trimmed.replace(/\n{3,}/g, '\n\n')
  if (normalized.length <= MAX_PLAN_DETAILS_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_PLAN_DETAILS_LENGTH - 3).trimEnd()}...`
}

export function isPlanExitToolName(toolName?: string): boolean {
  return typeof toolName === 'string' && PLAN_EXIT_TOOL_NAME_SET.has(toolName)
}

export function buildPlanExitSessionTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim()
  if (trimmed.length === 0 || trimmed === PLACEHOLDER_SESSION_TITLE) {
    return 'Act Handoff'
  }

  return trimmed.endsWith(' (Act)')
    ? trimmed
    : `${trimmed} (Act)`
}

export interface PlanExitHandoffMessageInput {
  sourceSessionId: string
  sourceTitle: string
  sourceLastMessage?: string
  workingDirectory: string
  conversationKind: ConversationKind
  workMode: AppSessionMode
  selectedSkillNames: string[]
  selectedToolNames: string[]
  summary: string
  details?: string
}

export interface PlanExitKickoffMessageInput {
  summary: string
  details?: string
  workMode: AppSessionMode
}

export function buildPlanExitKickoffMessage(
  input: PlanExitKickoffMessageInput,
): string {
  const summary =
    input.summary.trim().length > 0
      ? input.summary.trim()
      : 'Continue with the approved plan.'
  const action =
    input.workMode === 'build'
      ? 'Implement the approved plan now.'
      : 'Continue with the approved plan now.'
  const sections = [
    action,
    '',
    'Approved plan summary:',
    summary,
  ]

  if (input.details?.trim()) {
    sections.push('', 'Approved plan details:', input.details.trim())
  }

  sections.push(
    '',
    'Execution rules:',
    '- Treat the approved plan in this message and any assistant handoff message in this conversation as the source of truth.',
    '- Start implementing now instead of restarting planning unless a missing requirement blocks execution.',
    '- If setup or scaffolding is needed, use non-interactive commands and flags. If a setup command is cancelled or waits for input, do not repeat it unchanged.',
    '- If you change package.json or project scripts, make sure the referenced entry files and runnable scripts actually exist before you stop.',
  )

  return sections.join('\n')
}

export function buildPlanExitHandoffMessage(
  input: PlanExitHandoffMessageInput,
): SessionMessage {
  const normalizedSourceTitle =
    input.sourceTitle.trim().length > 0
    && input.sourceTitle.trim() !== PLACEHOLDER_SESSION_TITLE
      ? input.sourceTitle.trim()
      : 'Untitled conversation'
  const basics = [
    `Source session title: ${normalizedSourceTitle}`,
    `Working directory: ${input.workingDirectory}`,
    `Conversation kind: ${input.conversationKind}`,
    `Target work mode: ${input.workMode}`,
  ]

  const lastMessage = input.sourceLastMessage?.trim()
  if (lastMessage) {
    basics.push(`Last conversation preview: ${truncateLine(lastMessage, 160)}`)
  }

  const skills = formatLabelList(input.selectedSkillNames)
  if (skills) {
    basics.push(`Selected skills: ${skills}`)
  }

  const tools = formatLabelList(input.selectedToolNames)
  if (tools) {
    basics.push(`Selected tools: ${tools}`)
  }

  const sections = [
    'Planning handoff',
    '',
    'Approved plan summary:',
    input.summary.trim().length > 0
      ? input.summary.trim()
      : 'Continue with the approved plan.',
  ]

  if (input.details?.trim()) {
    sections.push('', 'Approved plan details:', input.details.trim())
  }

  sections.push(
    '',
    'Previous conversation basics:',
    ...basics.map((line) => `- ${line}`),
    '',
    'This fresh work session intentionally starts from the approved plan summary and details above instead of the earlier full transcript.',
  )

  return {
    id: `message-${randomUUID()}`,
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: sections.join('\n'),
      },
    ],
    createdAt: new Date().toISOString(),
    metadata: {
      handoff: {
        kind: 'plan_exit',
        sourceSessionId: input.sourceSessionId,
        targetWorkMode: input.workMode,
      },
    },
  }
}
