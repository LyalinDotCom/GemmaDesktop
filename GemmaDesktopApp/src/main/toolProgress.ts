export type ToolBlockStatus = 'pending' | 'running' | 'success' | 'error'
export type ToolProgressTone = 'info' | 'success' | 'warning'

export interface ToolProgressEntry {
  id: string
  label: string
  timestamp: number
  tone?: ToolProgressTone
}

export interface ToolWorkerTimelineEntry {
  id: string
  label: string
  detail?: string
  timestamp: number
  tone?: ToolProgressTone
}

export interface ToolWorkerCommand {
  command: string
  cwd?: string
}

export interface ToolWorkerResultData {
  sources?: string[]
  evidence?: string[]
  filesChanged?: string[]
  commands?: ToolWorkerCommand[]
}

export interface ToolWorkerDetail {
  kind: string
  label: string
  goal?: string
  childSessionId?: string
  childTurnId?: string
  currentAction?: string
  counters?: Record<string, number>
  timeline?: ToolWorkerTimelineEntry[]
  traceText?: string
  resultSummary?: string
  resultData?: ToolWorkerResultData
}

export interface ToolCallProgressBlock {
  type: 'tool_call'
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: ToolBlockStatus
  summary?: string
  startedAt?: number
  completedAt?: number
  callId?: string
  progressEntries?: ToolProgressEntry[]
  progressCounts?: Record<string, number>
  worker?: ToolWorkerDetail
}

export type ResearchPanelStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ResearchPanelDomain {
  domain: string
  count: number
}

export interface ResearchPanelTopicStep {
  id: string
  title: string
  goal?: string
  summary?: string
  status: ResearchPanelStepStatus
  sourceCount: number
  searchCount: number
  fetchCount: number
  label: string
  startedAt?: number
  completedAt?: number
  lastError?: string
}

export interface ResearchPanelViewModel {
  runId: string
  runStatus: 'running' | 'completed' | 'failed' | 'cancelled'
  stage: 'planning' | 'discovery' | 'workers' | 'synthesis' | 'completed' | 'failed' | 'cancelled'
  title?: string
  startedAt?: number
  completedAt?: number
  elapsedLabel?: string
  plan: {
    status: ResearchPanelStepStatus
    label: string
    topicCount: number
  }
  sources: {
    status: ResearchPanelStepStatus
    label: string
    totalSources: number
    targetSources: number
    distinctDomains: number
    targetDomains: number
    topDomains: ResearchPanelDomain[]
    otherDomainCount: number
    otherDomainSourceCount: number
    currentPass?: number
    passCount?: number
  }
  topics: ResearchPanelTopicStep[]
  synthesis: {
    status: ResearchPanelStepStatus
    label: string
  }
  liveHint?: string
  errorMessage?: string
  artifactDirectory?: string
}

export interface ResearchPanelProgressBlock {
  type: 'research_panel'
  panel: ResearchPanelViewModel
}

export type LiveActivityState = 'waiting' | 'thinking' | 'streaming' | 'working'

export interface SessionLiveActivity {
  source: 'session' | 'research'
  state: LiveActivityState
  stage?: 'planning' | 'discovery' | 'workers' | 'synthesis'
  topicTitle?: string
  attempt?: number
  startedAt: number
  lastEventAt?: number
  firstTokenAt?: number
  lastChannel?: 'assistant' | 'reasoning'
  assistantUpdates: number
  reasoningUpdates: number
  lifecycleEvents: number
  activeToolName?: string
  activeToolLabel?: string
  runningToolCount: number
  completedToolCount: number
  recentProgressCount: number
  lastProgressAt?: number
}

export interface DelegatedToolProgressEvent {
  parentToolCallId?: string
  parentToolName?: string
  kind: 'started' | 'event' | 'completed'
  childSessionId?: string
  childTurnId?: string
  childEventType?: string
  childPayload?: unknown
}

export interface DirectToolProgressEvent {
  callId?: string
  toolName?: string
  id?: string
  label?: string
  tone?: ToolProgressTone
}

interface ToolActivitySummary {
  activeToolName?: string
  activeToolLabel?: string
  runningToolCount: number
  completedToolCount: number
}

interface ProgressDescriptor {
  id: string
  label: string
  tone?: ToolProgressTone
  counterKey?: string
  buildCountLabel?: (count: number) => string
}

interface WorkerDescriptor {
  progress?: ProgressDescriptor | null
  timeline?: Omit<ToolWorkerTimelineEntry, 'timestamp'>
  currentAction?: string
  counterIncrements?: Array<{ key: string; delta?: number }>
  childSessionId?: string
  childTurnId?: string
}

const FILE_WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'workspace_editor_agent',
])

const INSPECT_TOOL_NAMES = new Set([
  'read_file',
  'read_files',
  'read_content',
  'search_content',
  'list_tree',
  'search_paths',
  'search_text',
  'workspace_inspector_agent',
  'workspace_search_agent',
])

const COMMAND_TOOL_NAMES = new Set([
  'workspace_command_agent',
])

const DELEGATED_TOOL_NAMES = new Set([
  'workspace_inspector_agent',
  'workspace_search_agent',
  'workspace_editor_agent',
  'workspace_command_agent',
  'web_research_agent',
])

const TOOL_LABEL_OVERRIDES = new Map<string, string>([
  ['web_research_agent', 'Running web research agent'],
  ['fetch_url', 'Fetching source'],
  ['fetch_url_safe', 'Fetching source'],
  ['search_web', 'Searching web'],
  ['materialize_content', 'Preparing content'],
  ['read_content', 'Reading content'],
  ['search_content', 'Searching content'],
  ['ask_gemini', 'Asking Gemini'],
  ['compaction', 'Compacting session'],
])

const MAX_PROGRESS_ENTRIES = 8
const MAX_WORKER_TIMELINE_ENTRIES = 12

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function toUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function buildPreview(value: unknown, maxLength = 120): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length === 0) {
      return undefined
    }
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3)}...`
      : normalized
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const preview = buildPreview(entry, maxLength)
      if (preview) {
        return preview
      }
    }
    return undefined
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['query', 'url', 'path', 'pattern', 'command', 'goal', 'summary', 'output']) {
      const preview = buildPreview(record[key], maxLength)
      if (preview) {
        return preview
      }
    }
  }

  return undefined
}

function getCounterValue(
  counts: Record<string, number> | undefined,
  key: string,
): number {
  return counts?.[key] ?? 0
}

function withProgressDescriptor(
  block: ToolCallProgressBlock,
  descriptor: ProgressDescriptor,
  timestamp: number,
): ToolCallProgressBlock {
  const progressCounts = { ...(block.progressCounts ?? {}) }
  let label = descriptor.label

  if (descriptor.counterKey) {
    const nextCount = getCounterValue(progressCounts, descriptor.counterKey) + 1
    progressCounts[descriptor.counterKey] = nextCount
    label = descriptor.buildCountLabel?.(nextCount) ?? label
  }

  const nextEntry: ToolProgressEntry = {
    id: descriptor.id,
    label,
    timestamp,
    tone: descriptor.tone,
  }

  const progressEntries = [...(block.progressEntries ?? [])]
  const existingIndex = progressEntries.findIndex((entry) => entry.id === descriptor.id)
  if (existingIndex >= 0) {
    const existing = progressEntries[existingIndex]
    if (
      existing
      && existing.label === nextEntry.label
      && existing.tone === nextEntry.tone
    ) {
      return block
    }
    progressEntries[existingIndex] = nextEntry
  } else {
    progressEntries.push(nextEntry)
  }

  return {
    ...block,
    progressEntries: progressEntries.slice(-MAX_PROGRESS_ENTRIES),
    progressCounts,
  }
}

function buildDelegatedWorkerLabel(toolName: string): string {
  switch (toolName) {
    case 'workspace_inspector_agent':
      return 'Workspace inspector agent'
    case 'workspace_search_agent':
      return 'Workspace search agent'
    case 'workspace_editor_agent':
      return 'Workspace editor agent'
    case 'workspace_command_agent':
      return 'Workspace command agent'
    case 'web_research_agent':
      return 'Web research agent'
    default:
      return 'Worker'
  }
}

function buildGenericStartedLabel(toolName: string): string {
  switch (toolName) {
    case 'workspace_inspector_agent':
      return 'Starting workspace inspector agent'
    case 'workspace_search_agent':
      return 'Starting workspace search agent'
    case 'workspace_editor_agent':
      return 'Starting workspace editor agent'
    case 'workspace_command_agent':
      return 'Starting workspace command agent'
    case 'web_research_agent':
      return 'Starting web research agent'
    default:
      return `Starting ${formatToolActivityLabel(toolName)?.toLowerCase() ?? 'worker'}`
  }
}

function createToolWorkerDetail(
  toolName: string,
  input: Record<string, unknown>,
  timestamp: number,
): ToolWorkerDetail | undefined {
  if (!DELEGATED_TOOL_NAMES.has(toolName)) {
    return undefined
  }

  const goal =
    typeof input.goal === 'string'
      ? input.goal
      : buildPreview(input)

  const currentAction = buildGenericStartedLabel(toolName)

  return {
    kind: toolName,
    label: buildDelegatedWorkerLabel(toolName),
    goal,
    currentAction,
    counters: {
      assistantUpdates: 0,
      reasoningUpdates: 0,
      lifecycleEvents: 0,
      toolCalls: 0,
      toolResults: 0,
    },
    timeline: [
      {
        id: 'worker-start',
        label: currentAction,
        timestamp,
      },
    ],
  }
}

function withWorkerTimeline(
  worker: ToolWorkerDetail,
  entry: ToolWorkerTimelineEntry,
): ToolWorkerDetail {
  const timeline = [...(worker.timeline ?? [])]
  const existingIndex = timeline.findIndex((candidate) => candidate.id === entry.id)
  if (existingIndex >= 0) {
    const existing = timeline[existingIndex]
    if (
      existing
      && existing.label === entry.label
      && existing.detail === entry.detail
      && existing.tone === entry.tone
    ) {
      return worker
    }
    timeline[existingIndex] = entry
  } else {
    timeline.push(entry)
  }

  return {
    ...worker,
    timeline: timeline.slice(-MAX_WORKER_TIMELINE_ENTRIES),
  }
}

function withWorkerDescriptor(
  block: ToolCallProgressBlock,
  descriptor: WorkerDescriptor | null,
  timestamp: number,
): ToolCallProgressBlock {
  if (!descriptor) {
    return block
  }

  let nextBlock = descriptor.progress
    ? withProgressDescriptor(block, descriptor.progress, timestamp)
    : block
  let worker =
    nextBlock.worker
    ?? createToolWorkerDetail(nextBlock.toolName, nextBlock.input, nextBlock.startedAt ?? timestamp)

  if (!worker) {
    return nextBlock
  }

  if (descriptor.childSessionId) {
    worker = {
      ...worker,
      childSessionId: descriptor.childSessionId,
    }
  }

  if (descriptor.childTurnId) {
    worker = {
      ...worker,
      childTurnId: descriptor.childTurnId,
    }
  }

  if (descriptor.currentAction) {
    worker = {
      ...worker,
      currentAction: descriptor.currentAction,
    }
  }

  if (descriptor.counterIncrements && descriptor.counterIncrements.length > 0) {
    const counters = { ...(worker.counters ?? {}) }
    for (const increment of descriptor.counterIncrements) {
      counters[increment.key] = getCounterValue(counters, increment.key) + (increment.delta ?? 1)
    }
    worker = {
      ...worker,
      counters,
    }
  }

  if (descriptor.timeline) {
    worker = withWorkerTimeline(worker, {
      ...descriptor.timeline,
      timestamp,
    })
  }

  if (nextBlock.worker === worker && nextBlock === block) {
    return block
  }

  nextBlock = {
    ...nextBlock,
    worker,
  }

  return nextBlock
}

function buildGenericProgressDescriptor(
  parentToolName: string,
  childEventType: string | undefined,
  childPayload: unknown,
): ProgressDescriptor | null {
  const payload = toUnknownRecord(childPayload)
  const childToolName =
    typeof payload.toolName === 'string' ? payload.toolName : undefined

  if (childEventType === 'tool.call' && childToolName) {
    return {
      id: `child-tool-${childToolName}`,
      label: formatToolActivityLabel(childToolName) ?? titleCase(normalizeToolName(childToolName)),
    }
  }

  if (childEventType === 'tool.result' && childToolName) {
    return {
      id: `child-result-${childToolName}`,
      label:
        parentToolName === 'workspace_editor_agent'
          ? 'Prepared file updates'
          : `Completed ${formatToolActivityLabel(childToolName) ?? titleCase(normalizeToolName(childToolName))}`,
      tone: 'success',
    }
  }

  if (childEventType === 'content.delta') {
    const channel =
      payload.channel === 'assistant' || payload.channel === 'reasoning'
        ? payload.channel
        : undefined

    if (channel === 'assistant') {
      if (parentToolName === 'workspace_editor_agent') {
        return {
          id: 'child-summarizing',
          label: 'Drafting file updates',
        }
      }
      if (parentToolName === 'workspace_command_agent') {
        return {
          id: 'child-summarizing',
          label: 'Preparing command plan',
        }
      }
      return {
        id: 'child-summarizing',
        label: 'Summarizing findings',
      }
    }

    if (channel === 'reasoning') {
      return {
        id: 'child-thinking',
        label: 'Thinking through next steps',
      }
    }
  }

  if (childEventType === 'runtime.lifecycle') {
    return {
      id: 'child-runtime',
      label: 'Waiting on runtime',
    }
  }

  return null
}

function buildResearchProgressDescriptor(
  childEventType: string | undefined,
  childPayload: unknown,
): ProgressDescriptor | null {
  const payload = toUnknownRecord(childPayload)
  const childToolName =
    typeof payload.toolName === 'string' ? payload.toolName : undefined

  if (childEventType === 'tool.call' && childToolName === 'search_web') {
    return {
      id: 'research-search',
      label: 'Searching web',
    }
  }

  if (childEventType === 'tool.result' && childToolName === 'search_web') {
    return {
      id: 'research-search',
      label: 'Searching web',
      counterKey: 'searchQueries',
      buildCountLabel: (count) =>
        `Searched ${count} quer${count === 1 ? 'y' : 'ies'}`,
      tone: 'success',
    }
  }

  if (
    childEventType === 'tool.call'
    && (childToolName === 'fetch_url' || childToolName === 'fetch_url_safe')
  ) {
    return {
      id: 'research-fetch',
      label: 'Fetching sources',
    }
  }

  if (
    childEventType === 'tool.result'
    && (childToolName === 'fetch_url' || childToolName === 'fetch_url_safe')
  ) {
    return {
      id: 'research-fetch',
      label: 'Fetched 1 source',
      counterKey: 'fetchedSources',
      buildCountLabel: (count) =>
        `Fetched ${count} source${count === 1 ? '' : 's'}`,
      tone: 'success',
    }
  }

  if (childEventType === 'content.delta') {
    const channel =
      payload.channel === 'assistant' || payload.channel === 'reasoning'
        ? payload.channel
        : undefined

    if (channel === 'assistant') {
      return {
        id: 'research-synthesis',
        label: 'Synthesizing findings',
      }
    }

    if (channel === 'reasoning') {
      return {
        id: 'research-thinking',
        label: 'Thinking through findings',
      }
    }
  }

  if (childEventType === 'runtime.lifecycle') {
    return {
      id: 'research-runtime',
      label: 'Waiting on runtime',
    }
  }

  return buildGenericProgressDescriptor('web_research_agent', childEventType, childPayload)
}

function buildDelegatedWorkerDescriptor(
  event: DelegatedToolProgressEvent,
): WorkerDescriptor | null {
  const toolName = event.parentToolName ?? 'worker'
  const payload = toUnknownRecord(event.childPayload)
  const childToolName =
    typeof payload.toolName === 'string' ? payload.toolName : undefined

  if (event.kind === 'started') {
    const label =
      toolName === 'web_research_agent'
        ? 'Starting web research agent'
        : buildGenericStartedLabel(toolName)
    return {
      progress: {
        id: toolName === 'web_research_agent' ? 'web-research-agent-start' : 'worker-start',
        label,
      },
      timeline: {
        id: 'worker-start',
        label,
      },
      currentAction: label,
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  if (event.kind === 'completed') {
    const label =
      toolName === 'web_research_agent'
        ? 'Web research agent finished'
        : 'Worker finished'
    return {
      progress: {
        id: toolName === 'web_research_agent' ? 'web-research-agent-finished' : 'worker-finished',
        label,
        tone: 'success',
      },
      timeline: {
        id: 'worker-finished',
        label,
        tone: 'success',
      },
      currentAction: toolName === 'web_research_agent' ? 'Web research complete' : 'Worker complete',
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  const progress =
    toolName === 'web_research_agent'
      ? buildResearchProgressDescriptor(event.childEventType, event.childPayload)
      : buildGenericProgressDescriptor(toolName, event.childEventType, event.childPayload)

  if (event.childEventType === 'tool.call' && childToolName) {
    const label =
      toolName === 'web_research_agent' && childToolName === 'search_web'
        ? 'Searching web'
        : toolName === 'web_research_agent' && (childToolName === 'fetch_url' || childToolName === 'fetch_url_safe')
          ? 'Fetching sources'
          : formatToolActivityLabel(childToolName)
            ?? titleCase(normalizeToolName(childToolName))
    return {
      progress,
      timeline: {
        id: `child-tool-call-${childToolName}`,
        label,
        detail: buildPreview(payload.input),
      },
      currentAction: label,
      counterIncrements: [{ key: 'toolCalls' }],
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  if (event.childEventType === 'tool.result' && childToolName) {
    const label =
      toolName === 'web_research_agent' && childToolName === 'search_web'
        ? 'Search completed'
        : toolName === 'web_research_agent' && (childToolName === 'fetch_url' || childToolName === 'fetch_url_safe')
          ? 'Fetched source'
          : `Completed ${formatToolActivityLabel(childToolName) ?? titleCase(normalizeToolName(childToolName))}`
    const counterIncrements = [{ key: 'toolResults' }]
    if (toolName === 'web_research_agent' && childToolName === 'search_web') {
      counterIncrements.push({ key: 'searchQueries' })
    }
    if (toolName === 'web_research_agent' && (childToolName === 'fetch_url' || childToolName === 'fetch_url_safe')) {
      counterIncrements.push({ key: 'fetchedSources' })
    }
    return {
      progress,
      timeline: {
        id: `child-tool-result-${childToolName}`,
        label,
        detail: buildPreview(payload.structuredOutput ?? payload.output),
        tone: 'success',
      },
      currentAction: label,
      counterIncrements,
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  if (event.childEventType === 'content.delta') {
    const channel =
      payload.channel === 'assistant' || payload.channel === 'reasoning'
        ? payload.channel
        : undefined
    if (!channel) {
      return null
    }
    const label =
      channel === 'assistant'
        ? (
            toolName === 'workspace_editor_agent'
              ? 'Drafting file updates'
              : toolName === 'workspace_command_agent'
                ? 'Preparing command plan'
                : toolName === 'web_research_agent'
                  ? 'Synthesizing findings'
                  : 'Summarizing findings'
          )
        : toolName === 'web_research_agent'
          ? 'Thinking through findings'
          : 'Thinking through next steps'
    return {
      progress,
      timeline: {
        id: channel === 'assistant' ? 'assistant-output' : 'reasoning-output',
        label,
      },
      currentAction: label,
      counterIncrements: [
        {
          key: channel === 'assistant' ? 'assistantUpdates' : 'reasoningUpdates',
        },
      ],
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  if (event.childEventType === 'runtime.lifecycle') {
    return {
      progress,
      timeline: {
        id: 'runtime-lifecycle',
        label: 'Waiting on runtime',
      },
      currentAction: 'Waiting on runtime',
      counterIncrements: [{ key: 'lifecycleEvents' }],
      childSessionId: event.childSessionId,
      childTurnId: event.childTurnId,
    }
  }

  return progress
    ? {
        progress,
        childSessionId: event.childSessionId,
        childTurnId: event.childTurnId,
      }
    : null
}

function extractCommandResults(record: Record<string, unknown>): ToolWorkerCommand[] {
  const commands = Array.isArray(record.commands) ? record.commands : []
  if (commands.length > 0) {
    const collected: ToolWorkerCommand[] = []
    for (const entry of commands) {
      const command = toUnknownRecord(entry)
      if (typeof command.command !== 'string') {
        continue
      }
      collected.push({
        command: command.command,
        cwd: typeof command.cwd === 'string' ? command.cwd : undefined,
      })
    }
    return collected
  }

  const executions = Array.isArray(record.executions) ? record.executions : []
  const collected: ToolWorkerCommand[] = []
  for (const entry of executions) {
    const execution = toUnknownRecord(entry)
    if (typeof execution.command !== 'string') {
      continue
    }
    collected.push({
      command: execution.command,
      cwd: typeof execution.cwd === 'string' ? execution.cwd : undefined,
    })
  }
  return collected
}

function applyToolResultToWorker(
  block: ToolCallProgressBlock,
  payload: {
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    structuredOutput?: unknown
  },
  timestamp: number,
  toolStatus: 'success' | 'error',
): ToolWorkerDetail | undefined {
  const worker =
    block.worker
    ?? createToolWorkerDetail(block.toolName, block.input, block.startedAt ?? timestamp)

  if (!worker) {
    return undefined
  }

  const metadata = payload.metadata ?? {}
  const structured = toUnknownRecord(payload.structuredOutput)
  const counters = { ...(worker.counters ?? {}) }
  const resultData: ToolWorkerResultData = { ...(worker.resultData ?? {}) }

  if (typeof metadata.childSessionId === 'string') {
    worker.childSessionId = metadata.childSessionId
  }
  if (typeof metadata.childTurnId === 'string') {
    worker.childTurnId = metadata.childTurnId
  }
  if (typeof metadata.childTrace === 'string' && metadata.childTrace.trim().length > 0) {
    worker.traceText = metadata.childTrace
  }

  const resultSummary =
    typeof structured.summary === 'string' && structured.summary.trim().length > 0
      ? structured.summary
      : payload.error
        ?? payload.output

  if (resultSummary) {
    worker.resultSummary = resultSummary
  }

  if (block.toolName === 'web_research_agent') {
    const sources = toStringArray(structured.sources)
    if (sources.length > 0) {
      resultData.sources = sources
      counters.sourcesUsed = sources.length
    }
  }

  if (block.toolName === 'workspace_inspector_agent' || block.toolName === 'workspace_search_agent') {
    const evidence = toStringArray(structured.evidence)
    if (evidence.length > 0) {
      resultData.evidence = evidence
      counters.evidenceCount = evidence.length
    }
  }

  if (block.toolName === 'workspace_editor_agent') {
    const filesChanged =
      Array.isArray(structured.appliedWrites)
        ? structured.appliedWrites
          .map((entry) => {
            const write = toUnknownRecord(entry)
            return typeof write.path === 'string' ? write.path : null
          })
          .filter((entry): entry is string => Boolean(entry))
        : toStringArray(structured.filesChanged)

    if (filesChanged.length > 0) {
      resultData.filesChanged = filesChanged
      counters.filesChanged = filesChanged.length
    }
  }

  if (block.toolName === 'workspace_command_agent') {
    const commands = extractCommandResults(structured)
    if (commands.length > 0) {
      resultData.commands = commands
      counters.commandsRun = commands.length
    }
  }

  worker.resultData = Object.keys(resultData).length > 0
    ? resultData
    : worker.resultData
  worker.counters = counters
  worker.currentAction = toolStatus === 'error' ? 'Worker failed' : 'Worker complete'

  return withWorkerTimeline(worker, {
    id: 'result-final',
    label: toolStatus === 'error' ? 'Worker failed' : 'Worker complete',
    detail: resultSummary ? buildPreview(resultSummary, 180) : undefined,
    timestamp,
    tone: toolStatus === 'error' ? 'warning' : 'success',
  })
}

function updateMatchingToolBlock(
  blocks: ToolCallProgressBlock[],
  callId: string | undefined,
  updater: (block: ToolCallProgressBlock) => ToolCallProgressBlock,
): { blocks: ToolCallProgressBlock[]; changed: boolean } {
  if (!callId) {
    return { blocks, changed: false }
  }

  let changed = false
  const nextBlocks = blocks.map((block) => {
    if (block.callId !== callId) {
      return block
    }

    const nextBlock = updater(block)
    if (nextBlock !== block) {
      changed = true
    }
    return nextBlock
  })

  return { blocks: nextBlocks, changed }
}

export function createInitialSessionLiveActivity(
  startedAt: number,
): SessionLiveActivity {
  return {
    source: 'session',
    state: 'waiting',
    startedAt,
    assistantUpdates: 0,
    reasoningUpdates: 0,
    lifecycleEvents: 0,
    runningToolCount: 0,
    completedToolCount: 0,
    recentProgressCount: 0,
  }
}

export function formatToolActivityLabel(toolName?: string): string | undefined {
  if (!toolName) {
    return undefined
  }

  if (TOOL_LABEL_OVERRIDES.has(toolName)) {
    return TOOL_LABEL_OVERRIDES.get(toolName)
  }

  if (FILE_WRITE_TOOL_NAMES.has(toolName)) {
    return 'Updating files'
  }

  if (INSPECT_TOOL_NAMES.has(toolName)) {
    return 'Inspecting project'
  }

  if (COMMAND_TOOL_NAMES.has(toolName)) {
    return 'Running commands'
  }

  return titleCase(normalizeToolName(toolName))
}

export function summarizeToolActivity(
  blocks: ToolCallProgressBlock[],
): ToolActivitySummary {
  const toolBlocks = blocks.filter((block) => block.type === 'tool_call')
  const runningBlocks = toolBlocks.filter((block) => block.status === 'running')
  const completedToolCount = toolBlocks.filter(
    (block) => block.status === 'success' || block.status === 'error',
  ).length
  const activeBlock = runningBlocks[runningBlocks.length - 1]
  const activeProgress = activeBlock?.progressEntries?.[activeBlock.progressEntries.length - 1]

  return {
    activeToolName: activeBlock?.toolName,
    activeToolLabel:
      activeBlock?.worker?.currentAction
      ?? activeProgress?.label
      ?? (activeBlock?.toolName
        ? formatToolActivityLabel(activeBlock.toolName)
        : undefined),
    runningToolCount: runningBlocks.length,
    completedToolCount,
  }
}

export function refreshLiveActivityFromToolBlocks(
  activity: SessionLiveActivity,
  blocks: ToolCallProgressBlock[],
  timestamp: number,
  progressDelta = 0,
): SessionLiveActivity {
  const summary = summarizeToolActivity(blocks)

  return {
    ...activity,
    state:
      activity.assistantUpdates > 0
        ? 'streaming'
        : activity.reasoningUpdates > 0
          ? 'thinking'
          : 'working',
    lastEventAt: timestamp,
    activeToolName: summary.activeToolName,
    activeToolLabel: summary.activeToolLabel,
    runningToolCount: summary.runningToolCount,
    completedToolCount: summary.completedToolCount,
    recentProgressCount: activity.recentProgressCount + progressDelta,
    lastProgressAt: progressDelta > 0 ? timestamp : activity.lastProgressAt,
  }
}

export function appendToolCallBlock(
  blocks: ToolCallProgressBlock[],
  payload: {
    toolName?: string
    input?: Record<string, unknown>
    callId?: string
  },
  timestamp: number,
): ToolCallProgressBlock[] {
  const toolName = payload.toolName ?? 'unknown'
  const input = payload.input ?? {}

  return [
    ...blocks,
    {
      type: 'tool_call',
      toolName,
      input,
      status: 'running',
      startedAt: timestamp,
      callId: payload.callId,
      worker: createToolWorkerDetail(toolName, input, timestamp),
    },
  ]
}

export function applyToolResultToBlocks(
  blocks: ToolCallProgressBlock[],
  payload: {
    callId?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    structuredOutput?: unknown
  },
  timestamp: number,
): ToolCallProgressBlock[] {
  if (!payload.callId) {
    return blocks
  }

  return blocks.map((block) => {
    if (block.callId !== payload.callId) {
      return block
    }

    const toolError = payload.metadata?.toolError === true
    const toolStatus = payload.error || toolError ? 'error' : 'success'
    const nextWorker = applyToolResultToWorker(block, payload, timestamp, toolStatus)

    return {
      ...block,
      output: payload.output ?? payload.error ?? '',
      status: toolStatus,
      completedAt: timestamp,
      worker: nextWorker,
    }
  })
}

export function applyDirectToolProgressToBlocks(
  blocks: ToolCallProgressBlock[],
  payload: DirectToolProgressEvent,
  timestamp: number,
): { blocks: ToolCallProgressBlock[]; changed: boolean } {
  if (!payload.callId || typeof payload.label !== 'string' || payload.label.trim().length === 0) {
    return { blocks, changed: false }
  }

  const label = payload.label.trim()

  return updateMatchingToolBlock(
    blocks,
    payload.callId,
    (block) => withProgressDescriptor(
      block,
      {
        id:
          payload.id?.trim()
          || `tool-progress-${normalizeToolName(payload.toolName ?? block.toolName)}-${normalizeToolName(label)}`,
        label,
        tone: payload.tone,
      },
      timestamp,
    ),
  )
}

export function applyDelegatedProgressToBlocks(
  blocks: ToolCallProgressBlock[],
  event: DelegatedToolProgressEvent,
  timestamp: number,
): { blocks: ToolCallProgressBlock[]; changed: boolean } {
  return updateMatchingToolBlock(
    blocks,
    event.parentToolCallId,
    (block) => withWorkerDescriptor(
      block,
      buildDelegatedWorkerDescriptor(event),
      timestamp,
    ),
  )
}
