import type { DebugLogEntry, DebugSessionSnapshot } from '@/types'

export type DebugTone = 'slate' | 'indigo' | 'amber' | 'rose' | 'emerald'

export interface InlineDebugCard {
  id: string
  title: string
  subtitle: string
  badge: string
  tone: DebugTone
  body: string
  placement: 'before-result' | 'after-result'
}

export interface InlineDebugTurn {
  beforeResult: InlineDebugCard[]
  afterResult: InlineDebugCard[]
}

export interface InlineDebugSplit {
  interstitialLogs: InlineDebugCard[][]
  turnLogs: InlineDebugTurn[]
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderSection(title: string, body: string): string {
  return [`=== ${title} ===`, body.trim().length > 0 ? body : '(empty)'].join('\n')
}

function formatSystemPrompt(session: DebugSessionSnapshot | null): string {
  if (!session) {
    return 'No active session.'
  }

  if (session.systemPromptSections.length === 0) {
    return 'No resolved system prompt for this session.'
  }

  return session.systemPromptSections
    .map((section) =>
      `[${section.id ? `${section.source}:${section.id}` : section.source}]\n${section.text}`,
    )
    .join('\n\n')
}

function formatToolSurface(session: DebugSessionSnapshot | null): string {
  if (!session) {
    return 'No active session.'
  }

  if (session.tools.length === 0) {
    return 'No tools are active for this session mode.'
  }

  return session.tools
    .map((tool) =>
      [
        `name: ${tool.name}`,
        `description: ${tool.description}`,
        'input_schema:',
        formatJson(tool.inputSchema),
      ].join('\n'),
    )
    .join('\n\n')
}

function isBootstrapMessage(
  value: Record<string, unknown>,
): boolean {
  const role = typeof value.role === 'string' ? value.role : null
  return role === 'system' || role === 'developer'
}

function formatBootstrapMessages(session: DebugSessionSnapshot | null): string {
  if (!session) {
    return 'No active session.'
  }

  const bootstrapMessages = session.requestPreview.messages.filter((entry) =>
    isBootstrapMessage(entry),
  )

  if (bootstrapMessages.length === 0) {
    return 'System prompt is shown above; no separate bootstrap request messages were captured.'
  }

  return formatJson(bootstrapMessages)
}

function formatMode(value: DebugSessionSnapshot['mode']): string {
  return typeof value === 'string' ? value : formatJson(value)
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function isHighFrequencyLog(log: DebugLogEntry): boolean {
  return (
    log.event === 'content.delta'
    || log.event === 'session.event.content_delta'
    || log.event === 'session.event.content_delta_append'
    || log.event.endsWith('.stream.stream')
  )
}

function isTurnTerminalLog(log: DebugLogEntry): boolean {
  return (
    log.event === 'session.event.turn_complete'
    || log.event === 'sessions.send-message.error'
    || log.event === 'sessions.send-message.cancelled'
    || log.event === 'session.event.generation_cancelled'
  )
}

function shouldHideInlineLog(log: DebugLogEntry): boolean {
  return (
    isHighFrequencyLog(log)
    || log.event === 'session.event.user_message'
    || log.event === 'sessions.get.request'
    || log.event === 'sessions.get.response'
    || log.event === 'sessions.create.request'
    || log.event === 'sessions.create.response'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractToolName(log: DebugLogEntry): string | null {
  if (!isRecord(log.data)) {
    return null
  }

  if (typeof log.data.toolName === 'string') {
    return log.data.toolName
  }

  const payload = isRecord(log.data.payload) ? log.data.payload : null
  if (payload && typeof payload.toolName === 'string') {
    return payload.toolName
  }

  return null
}

function getCardTone(log: DebugLogEntry): DebugTone {
  if (
    log.event.endsWith('.error')
    || log.event.includes('cancelled')
    || log.event.includes('error')
  ) {
    return 'rose'
  }

  if (log.event === 'tool.call' || log.event === 'tool.result') {
    return 'amber'
  }

  if (log.event.startsWith('tool.subsession.')) {
    return 'amber'
  }

  if (log.event.startsWith('runtime.')) {
    return 'indigo'
  }

  if (
    log.event === 'sessions.turn.metrics'
    || log.event === 'session.event.turn_complete'
  ) {
    return 'emerald'
  }

  if (log.event.startsWith('sessions.compaction.')) {
    return 'amber'
  }

  return 'slate'
}

function getCardBadge(log: DebugLogEntry): string {
  if (log.event.startsWith('runtime.')) {
    return 'API'
  }

  if (log.event === 'tool.call' || log.event === 'tool.result') {
    return 'TOOL'
  }

  if (log.event.startsWith('tool.subsession.')) {
    return 'WORKER'
  }

  if (log.event.startsWith('plan.')) {
    return 'PLAN'
  }

  if (log.event.startsWith('sessions.compaction.')) {
    return 'COMPACT'
  }

  if (
    log.event === 'sessions.turn.metrics'
    || log.event.startsWith('session.event.')
  ) {
    return 'STATE'
  }

  return log.layer.toUpperCase()
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function getCardTitle(log: DebugLogEntry): string {
  if (log.event === 'sessions.send-message.request') {
    return 'Turn started'
  }

  if (log.event === 'session.event.generation_started') {
    return 'Generation started'
  }

  if (log.event === 'sessions.turn.metrics') {
    return 'Turn metrics'
  }

  if (log.event === 'session.event.turn_complete') {
    return 'Agent idle'
  }

  if (log.event === 'sessions.send-message.error') {
    return 'Turn failed'
  }

  if (log.event === 'sessions.send-message.cancelled') {
    return 'Turn cancelled'
  }

  if (log.event === 'session.event.generation_cancelled') {
    return 'Generation cancelled'
  }

  if (log.event === 'session.event.generation_stopping') {
    return 'Generation stopping'
  }

  if (log.event.startsWith('runtime.')) {
    if (log.event.endsWith('.request')) {
      return 'API request'
    }
    if (log.event.endsWith('.response')) {
      return 'API response'
    }
    if (log.event.endsWith('.error')) {
      return 'API error'
    }
    if (log.event.endsWith('.stream')) {
      return 'API stream'
    }
  }

  if (log.event === 'tool.call') {
    const toolName = extractToolName(log)
    return toolName ? `Tool call · ${toolName}` : 'Tool call'
  }

  if (log.event === 'tool.result') {
    const toolName = extractToolName(log)
    return toolName ? `Tool result · ${toolName}` : 'Tool result'
  }

  if (log.event === 'tool.subsession.started') {
    const toolName = extractToolName(log)
    return toolName ? `Worker started · ${toolName}` : 'Worker started'
  }

  if (log.event === 'tool.subsession.event') {
    const toolName = extractToolName(log)
    return toolName ? `Worker event · ${toolName}` : 'Worker event'
  }

  if (log.event === 'tool.subsession.completed') {
    const toolName = extractToolName(log)
    return toolName ? `Worker completed · ${toolName}` : 'Worker completed'
  }

  if (log.event === 'plan.question.requested') {
    return 'Plan question requested'
  }

  if (log.event === 'plan.question.answered') {
    return 'Plan question answered'
  }

  if (log.event === 'plan.execution.prepared') {
    return 'Execution handoff prepared'
  }

  if (log.event === 'sessions.update.response') {
    return 'Session reconfigured'
  }

  if (log.event.startsWith('sessions.compaction.')) {
    return `Compaction ${humanizeIdentifier(log.event.replace('sessions.compaction.', ''))}`
  }

  return humanizeIdentifier(log.event)
}

function getCardPlacement(log: DebugLogEntry): InlineDebugCard['placement'] {
  if (
    log.event === 'sessions.turn.metrics'
    || log.event === 'session.event.turn_complete'
    || log.event === 'sessions.send-message.error'
    || log.event === 'sessions.send-message.cancelled'
    || log.event === 'session.event.generation_cancelled'
    || log.event === 'session.event.generation_stopping'
  ) {
    return 'after-result'
  }

  return 'before-result'
}

function formatLogBody(log: DebugLogEntry): string {
  return [
    `timestamp: ${new Date(log.timestamp).toISOString()}`,
    `summary: ${log.summary}`,
    `layer: ${log.layer}`,
    `direction: ${log.direction}`,
    `event: ${log.event}`,
    `turn_id: ${log.turnId ?? '(none)'}`,
    'data:',
    formatJson(log.data),
  ].join('\n')
}

function buildInlineDebugCard(log: DebugLogEntry): InlineDebugCard | null {
  if (shouldHideInlineLog(log)) {
    return null
  }

  return {
    id: log.id,
    title: getCardTitle(log),
    subtitle: [
      formatTimestamp(log.timestamp),
      getCardBadge(log),
      log.summary,
    ]
      .filter((entry) => entry.trim().length > 0)
      .join(' • '),
    badge: getCardBadge(log),
    tone: getCardTone(log),
    body: formatLogBody(log),
    placement: getCardPlacement(log),
  }
}

export function buildSessionBootstrapCard(
  session: DebugSessionSnapshot | null,
  sessionTitle?: string,
): InlineDebugCard | null {
  if (!session) {
    return null
  }

  const body = [
    renderSection(
      'Session',
      [
        `title: ${sessionTitle ?? '(untitled session)'}`,
        `mode: ${formatMode(session.mode)}`,
        `runtime: ${session.runtimeId}`,
        `model: ${session.modelId}`,
        `cwd: ${session.workingDirectory}`,
        `started: ${String(session.started)}`,
        `saved_at: ${session.savedAt}`,
        `max_steps: ${session.maxSteps}`,
        `history_messages: ${session.historyMessageCount}`,
      ].join('\n'),
    ),
    renderSection('Resolved System Prompt', formatSystemPrompt(session)),
    renderSection('Active Tools', formatToolSurface(session)),
    renderSection('Bootstrap Messages', formatBootstrapMessages(session)),
    renderSection('Runtime Settings', formatJson(session.requestPreview.settings)),
  ].join('\n\n')

  return {
    id: `session-bootstrap:${session.sessionId}`,
    title: 'Session bootstrap',
    subtitle: [
      session.runtimeId,
      session.modelId,
      formatMode(session.mode),
    ].join(' • '),
    badge: 'SESSION',
    tone: 'slate',
    body,
    placement: 'before-result',
  }
}

export function splitInlineDebugLogs(logs: DebugLogEntry[]): InlineDebugSplit {
  const interstitialLogs: InlineDebugCard[][] = [[]]
  const rawTurnGroups: InlineDebugCard[][] = []
  let activeTurnIndex: number | null = null

  for (const log of logs) {
    if (log.event === 'sessions.send-message.request') {
      activeTurnIndex = rawTurnGroups.length
      rawTurnGroups.push([])
    }

    const card = buildInlineDebugCard(log)
    if (card) {
      if (activeTurnIndex == null) {
        interstitialLogs[interstitialLogs.length - 1]?.push(card)
      } else {
        rawTurnGroups[activeTurnIndex]?.push(card)
      }
    }

    if (isTurnTerminalLog(log) && activeTurnIndex != null) {
      activeTurnIndex = null
      interstitialLogs.push([])
    }
  }

  while (interstitialLogs.length < rawTurnGroups.length + 1) {
    interstitialLogs.push([])
  }

  return {
    interstitialLogs,
    turnLogs: rawTurnGroups.map((group) => ({
      beforeResult: group.filter((card) => card.placement === 'before-result'),
      afterResult: group.filter((card) => card.placement === 'after-result'),
    })),
  }
}
