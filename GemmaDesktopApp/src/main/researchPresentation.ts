import type {
  ResearchRunResult,
  ResearchRunStatus,
} from '@gemma-desktop/sdk-node'
import path from 'path'
import type {
  ResearchPanelProgressBlock,
  ResearchPanelStepStatus,
  ResearchPanelTopicStep,
  ResearchPanelViewModel,
  SessionLiveActivity,
} from './toolProgress'

export interface ResearchAppMessage {
  id: string
  role: string
  content: Array<Record<string, unknown>>
  timestamp: number
  durationMs?: number
}

const TOP_DOMAIN_LIMIT = 6
const FOLLOW_UP_SOURCE_PREVIEW_LIMIT = 8

function formatElapsedSeconds(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (seconds === 0) {
    return `${minutes}m`
  }
  return `${minutes}m ${seconds}s`
}

function parseIsoTimestamp(value?: string): number | undefined {
  if (!value) {
    return undefined
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function mapStageStatus(
  status: ResearchRunStatus['stages']['planning']['status'],
): ResearchPanelStepStatus {
  return status
}

function buildPlanLabel(
  stageStatus: ResearchPanelStepStatus,
  topicCount: number,
): string {
  if (stageStatus === 'completed') {
    return topicCount > 0
      ? `Research plan created — ${topicCount} topic${topicCount === 1 ? '' : 's'}`
      : 'Research plan created'
  }
  if (stageStatus === 'failed') {
    return 'Research planning failed'
  }
  if (stageStatus === 'cancelled') {
    return topicCount > 0
      ? `Planning cancelled after ${topicCount} topic${topicCount === 1 ? '' : 's'}`
      : 'Research planning cancelled'
  }
  if (stageStatus === 'running') {
    return 'Creating research plan…'
  }
  return 'Plan the topic breakdown'
}

function buildSourcesLabel(
  stageStatus: ResearchPanelStepStatus,
  totalSources: number,
  distinctDomains: number,
): string {
  if (stageStatus === 'completed') {
    return `Gathered ${totalSources} source${totalSources === 1 ? '' : 's'} across ${distinctDomains} domain${distinctDomains === 1 ? '' : 's'}`
  }
  if (stageStatus === 'failed') {
    return 'Source gathering failed'
  }
  if (stageStatus === 'cancelled') {
    return totalSources > 0
      ? `Gathering cancelled after ${totalSources} source${totalSources === 1 ? '' : 's'} across ${distinctDomains} domain${distinctDomains === 1 ? '' : 's'}`
      : 'Source gathering cancelled'
  }
  if (stageStatus === 'running') {
    return totalSources > 0
      ? `Gathering ${totalSources} source${totalSources === 1 ? '' : 's'} and counting…`
      : 'Gathering sources…'
  }
  return 'Gather sources'
}

function buildDepthLabel(stageStatus: ResearchPanelStepStatus): string {
  if (stageStatus === 'completed') {
    return 'Second-level sources selected'
  }
  if (stageStatus === 'failed') {
    return 'Source-depth selection failed'
  }
  if (stageStatus === 'cancelled') {
    return 'Source-depth selection cancelled'
  }
  if (stageStatus === 'running') {
    return 'Selecting second-level source pages…'
  }
  return 'Choose second-level source pages'
}

function buildSynthesisLabel(stageStatus: ResearchPanelStepStatus): string {
  if (stageStatus === 'completed') {
    return 'Final report ready'
  }
  if (stageStatus === 'failed') {
    return 'Synthesis failed'
  }
  if (stageStatus === 'cancelled') {
    return 'Synthesis cancelled'
  }
  if (stageStatus === 'running') {
    return 'Writing the final report…'
  }
  return 'Synthesize the final report'
}

function buildTopicStepLabel(
  status: ResearchPanelStepStatus,
  title: string,
): string {
  if (status === 'completed') {
    return `Done investigating: ${title}`
  }
  if (status === 'failed') {
    return `Failed: ${title}`
  }
  if (status === 'cancelled') {
    return `Cancelled: ${title}`
  }
  if (status === 'running') {
    return `Researching ${title}`
  }
  return `Queued: ${title}`
}

function normalizeTerminalStepStatus(
  runStatus: ResearchPanelViewModel['runStatus'],
  stepStatus: ResearchPanelStepStatus,
): ResearchPanelStepStatus {
  if (runStatus === 'failed' && stepStatus === 'running') {
    return 'failed'
  }
  if (runStatus === 'cancelled' && stepStatus === 'running') {
    return 'cancelled'
  }
  return stepStatus
}

function deriveLiveHint(status: ResearchRunStatus, now: number): string | undefined {
  if (status.status !== 'running') {
    return undefined
  }

  const activity = status.activities?.[status.activities.length - 1]
  if (activity?.currentAction && activity.currentAction.trim().length > 0) {
    return activity.currentAction.trim()
  }

  if (activity) {
    const lastEventAtMs = parseIsoTimestamp(activity.lastEventAt ?? activity.startedAt)
    const staleFor = lastEventAtMs != null ? now - lastEventAtMs : 0
    if (staleFor >= 45_000) {
      return `No new activity for ${formatElapsedSeconds(staleFor)}`
    }
    if (activity.assistantDeltaCount > 0) {
      return activity.phase === 'synthesis'
        ? 'Writing the final report'
        : activity.phase === 'topic' && activity.topicTitle
          ? `Writing up ${activity.topicTitle}`
          : 'Generating text'
    }
    if (activity.reasoningDeltaCount > 0) {
      return 'Model is thinking'
    }
    const startedAtMs = parseIsoTimestamp(activity.startedAt)
    const sinceStart = startedAtMs != null ? now - startedAtMs : 0
    if (sinceStart >= 15_000) {
      return `Waiting for the first token (${formatElapsedSeconds(sinceStart)})`
    }
  }

  switch (status.stage) {
    case 'planning':
      return 'Designing the research plan'
    case 'discovery':
      return status.currentPass != null
        ? `Gather pass ${status.currentPass} in progress`
        : 'Running gather passes'
    case 'depth':
      return 'Selecting second-level source pages'
    case 'workers':
      return 'Topic workers are reading sources'
    case 'synthesis':
      return 'Writing the final report'
    case 'completed':
    case 'failed':
    case 'cancelled':
      return undefined
  }
}

function buildTopicSteps(status: ResearchRunStatus): ResearchPanelTopicStep[] {
  return status.topicStatuses.map((topic) => {
    const topicStatus = normalizeTerminalStepStatus(status.status, topic.status)
    return {
      id: topic.topicId,
      title: topic.title,
      goal: topic.goal,
      summary: topic.summary,
      status: topicStatus,
      sourceCount: topic.sourceCount ?? 0,
      searchCount: topic.searchCount ?? 0,
      fetchCount: topic.fetchCount ?? 0,
      label: buildTopicStepLabel(topicStatus, topic.title),
      startedAt: parseIsoTimestamp(topic.startedAt),
      completedAt: parseIsoTimestamp(topic.completedAt),
      lastError: topic.lastError,
    }
  })
}

function buildTopDomainView(
  coverage: ResearchRunStatus['coverage'],
): {
  topDomains: ResearchPanelViewModel['sources']['topDomains']
  otherDomainCount: number
  otherDomainSourceCount: number
} {
  const all = coverage?.topDomains ?? []
  const total = coverage?.sourcesGathered ?? 0

  if (all.length === 0) {
    return { topDomains: [], otherDomainCount: 0, otherDomainSourceCount: 0 }
  }

  const top = all.slice(0, TOP_DOMAIN_LIMIT)
  const rest = all.slice(TOP_DOMAIN_LIMIT)
  const topTotal = top.reduce((sum, entry) => sum + entry.count, 0)
  const otherDomainCount = rest.length
  const otherDomainSourceCount = rest.length > 0
    ? rest.reduce((sum, entry) => sum + entry.count, 0)
    : Math.max(total - topTotal, 0)

  return { topDomains: top, otherDomainCount, otherDomainSourceCount }
}

interface BuildPanelOptions {
  promptText?: string
  now?: number
}

function buildInitialPanel(promptText?: string): ResearchPanelViewModel {
  return {
    runId: 'pending',
    runStatus: 'running',
    stage: 'planning',
    title: promptText?.trim() || undefined,
    plan: {
      status: 'running',
      label: buildPlanLabel('running', 0),
      topicCount: 0,
    },
    sources: {
      status: 'pending',
      label: buildSourcesLabel('pending', 0, 0),
      totalSources: 0,
      targetSources: 0,
      distinctDomains: 0,
      targetDomains: 0,
      topDomains: [],
      otherDomainCount: 0,
      otherDomainSourceCount: 0,
    },
    depth: {
      status: 'pending',
      label: buildDepthLabel('pending'),
    },
    topics: [],
    synthesis: {
      status: 'pending',
      label: buildSynthesisLabel('pending'),
    },
    liveHint: 'Designing the research plan',
  }
}

export function buildResearchPanelViewModel(
  status?: ResearchRunStatus,
  options: BuildPanelOptions = {},
): ResearchPanelViewModel {
  const { promptText, now = Date.now() } = options

  if (!status) {
    return buildInitialPanel(promptText)
  }

  const runStartedAt = parseIsoTimestamp(status.startedAt)
  const completedAt = parseIsoTimestamp(status.completedAt)
  const elapsedReference =
    status.status === 'running' ? now : completedAt ?? now
  const elapsedLabel =
    runStartedAt != null
      ? formatElapsedSeconds(Math.max(elapsedReference - runStartedAt, 1))
      : undefined

  const planStatus = mapStageStatus(status.stages.planning.status)
  const discoveryStatus = mapStageStatus(status.stages.discovery.status)
  const depthStatus = mapStageStatus(status.stages.depth.status)
  const workersStatus = mapStageStatus(status.stages.workers.status)
  const synthesisStatus = mapStageStatus(status.stages.synthesis.status)

  const topicCount = status.topicStatuses.length
  const coverage = status.coverage
  const warningMessages = status.warnings?.filter((warning) => warning.trim().length > 0) ?? []
  const totalSources = coverage?.sourcesGathered ?? 0
  const distinctDomains = coverage?.distinctDomains ?? 0
  const targetSources = coverage?.targetSources ?? 0
  const targetDomains = coverage?.targetDomains ?? 0
  const domainView = buildTopDomainView(coverage)

  // Treat the "sources" step as encompassing discovery and ongoing worker fetches —
  // it's only truly complete when the whole run stops gathering new sources.
  const rawSourcesStatus: ResearchPanelStepStatus =
    discoveryStatus === 'failed'
      ? 'failed'
      : status.stage === 'synthesis'
        || status.stage === 'completed'
        || status.stage === 'failed'
        || status.stage === 'cancelled'
        ? discoveryStatus === 'completed' || totalSources > 0
          ? 'completed'
          : discoveryStatus
        : status.stage === 'workers'
          ? workersStatus === 'completed' && discoveryStatus === 'completed'
            ? 'completed'
            : 'running'
          : discoveryStatus
  const sourcesStatus = normalizeTerminalStepStatus(status.status, rawSourcesStatus)
  const normalizedPlanStatus = normalizeTerminalStepStatus(status.status, planStatus)
  const normalizedDepthStatus = normalizeTerminalStepStatus(status.status, depthStatus)
  const normalizedSynthesisStatus = normalizeTerminalStepStatus(status.status, synthesisStatus)

  const liveHint = deriveLiveHint(status, now)

  const title =
    promptText?.trim()
    || status.topicStatuses[0]?.goal
    || status.topicStatuses[0]?.title

  return {
    runId: status.runId,
    runStatus: status.status,
    stage: status.stage,
    title: title || undefined,
    modelLabel: `${status.modelId} via ${status.runtimeId}`,
    startedAt: runStartedAt,
    completedAt,
    elapsedLabel,
    plan: {
      status: normalizedPlanStatus,
      label: buildPlanLabel(normalizedPlanStatus, topicCount),
      topicCount,
    },
    sources: {
      status: sourcesStatus,
      label: buildSourcesLabel(sourcesStatus, totalSources, distinctDomains),
      totalSources,
      targetSources,
      distinctDomains,
      targetDomains,
      topDomains: domainView.topDomains,
      otherDomainCount: domainView.otherDomainCount,
      otherDomainSourceCount: domainView.otherDomainSourceCount,
      currentPass: status.currentPass,
      passCount: status.passCount,
    },
    depth: {
      status: normalizedDepthStatus,
      label: buildDepthLabel(normalizedDepthStatus),
    },
    topics: buildTopicSteps(status),
    synthesis: {
      status: normalizedSynthesisStatus,
      label:
        warningMessages.length > 0 && normalizedSynthesisStatus === 'completed'
          ? 'Final report ready with warnings'
          : buildSynthesisLabel(normalizedSynthesisStatus),
    },
    liveHint,
    errorMessage: status.error,
    warningMessages,
    artifactDirectory: status.artifactDirectory,
  }
}

export function buildResearchPanelContent(
  status?: ResearchRunStatus,
  options: BuildPanelOptions = {},
): Array<Record<string, unknown>> {
  const panel = buildResearchPanelViewModel(status, options)
  const block: ResearchPanelProgressBlock = {
    type: 'research_panel',
    panel,
  }
  return [block as unknown as Record<string, unknown>]
}

export function buildResearchLiveActivity(
  status: ResearchRunStatus | undefined,
): SessionLiveActivity | null {
  if (!status || status.status !== 'running') {
    return null
  }

  const stage =
    status.stage === 'planning'
    || status.stage === 'discovery'
    || status.stage === 'depth'
    || status.stage === 'workers'
    || status.stage === 'synthesis'
      ? status.stage
      : undefined

  const activeActivity = status.activities?.[status.activities.length - 1]
  if (activeActivity) {
    return {
      source: 'research',
      state:
        activeActivity.assistantDeltaCount > 0
          ? 'streaming'
          : activeActivity.reasoningDeltaCount > 0
            ? 'thinking'
            : 'waiting',
      stage,
      topicTitle: activeActivity.topicTitle,
      attempt: activeActivity.attempt,
      startedAt:
        parseIsoTimestamp(activeActivity.startedAt)
        ?? parseIsoTimestamp(status.startedAt)
        ?? Date.now(),
      lastEventAt: parseIsoTimestamp(activeActivity.lastEventAt),
      firstTokenAt: parseIsoTimestamp(activeActivity.firstTokenAt),
      lastChannel:
        activeActivity.assistantDeltaCount > 0
          ? 'assistant'
          : activeActivity.reasoningDeltaCount > 0
            ? 'reasoning'
            : undefined,
      assistantUpdates: activeActivity.assistantDeltaCount,
      reasoningUpdates: activeActivity.reasoningDeltaCount,
      lifecycleEvents: activeActivity.lifecycleCount,
      activeToolLabel:
        activeActivity.currentAction
        ?? (stage === 'discovery' || stage === 'workers'
          ? stage === 'discovery'
            ? 'Gathering evidence'
            : 'Analyzing topics'
          : stage === 'synthesis'
            ? 'Synthesizing'
            : stage === 'planning'
              ? 'Planning'
              : undefined),
      activeToolName:
        stage === 'discovery' || stage === 'workers'
          ? 'web_research_agent'
          : stage,
      runningToolCount: 1,
      completedToolCount: 0,
      recentProgressCount:
        activeActivity.assistantDeltaCount
        + activeActivity.reasoningDeltaCount
        + activeActivity.lifecycleCount
        + activeActivity.toolCallCount
        + activeActivity.toolResultCount,
      lastProgressAt: parseIsoTimestamp(activeActivity.lastEventAt),
    }
  }

  const stageRecord =
    stage != null
      ? status.stages[stage]
      : undefined

  return {
    source: 'research',
    state: 'working',
    stage,
    startedAt:
      parseIsoTimestamp(stageRecord?.startedAt)
      ?? parseIsoTimestamp(status.startedAt)
      ?? Date.now(),
    assistantUpdates: 0,
    reasoningUpdates: 0,
    lifecycleEvents: 0,
    activeToolLabel:
      stageRecord?.worker?.currentAction
      ?? (stage === 'discovery' || stage === 'workers'
        ? stage === 'discovery'
          ? 'Gathering evidence'
          : 'Analyzing topics'
        : stage === 'synthesis'
          ? 'Synthesizing'
          : stage === 'planning'
            ? 'Planning'
            : undefined),
    activeToolName:
      stage === 'discovery' || stage === 'workers'
        ? 'web_research_agent'
        : stage,
    runningToolCount: 1,
    completedToolCount: 0,
    recentProgressCount: 0,
  }
}

// Kept for backwards-compatible callers. The modern research run uses
// `buildResearchPanelContent` for the primary progress display.
export function buildResearchProgressContent(
  status?: ResearchRunStatus,
  now = Date.now(),
): Array<Record<string, unknown>> {
  return buildResearchPanelContent(status, { now })
}

export function buildResearchAssistantMessage(
  result: ResearchRunResult,
  durationMs: number,
): ResearchAppMessage {
  const topicLabel = `${result.plan.topics.length} topic${result.plan.topics.length === 1 ? '' : 's'}`
  const sourceLabel = `${result.sources.length} source${result.sources.length === 1 ? '' : 's'}`
  const modelLabel = result.modelId?.trim()
    ? ` using ${result.modelId}${result.runtimeId ? ` via ${result.runtimeId}` : ''}`
    : ''
  const warningMessages = result.warnings?.filter((warning) => warning.trim().length > 0) ?? []
  const sections = [
    `Deep research completed across ${topicLabel} and ${sourceLabel}${typeof result.passCount === 'number' ? ` in ${result.passCount} pass${result.passCount === 1 ? '' : 'es'}` : ''}${modelLabel}.`,
    result.summary,
    result.finalReport,
  ].filter((entry) => entry.trim().length > 0)

  return {
    id: `research-${result.runId}`,
    role: 'assistant',
    content: [
      ...warningMessages.map((message) => ({
        type: 'warning',
        message,
      })),
      {
        type: 'text',
        text: sections.join('\n\n'),
      },
      {
        type: 'folder_link',
        path: result.artifactDirectory,
        label: 'Open research artifacts',
      },
    ],
    timestamp: Date.now(),
    durationMs,
  }
}

function formatResearchReferencePath(
  filePath: string,
  workingDirectory?: string,
): string {
  const absolutePath = path.resolve(filePath)
  if (!workingDirectory?.trim()) {
    return absolutePath
  }

  const relativePath = path.relative(path.resolve(workingDirectory), absolutePath)
  return relativePath.length > 0
    && !relativePath.startsWith('..')
    && !path.isAbsolute(relativePath)
    ? relativePath
    : absolutePath
}

function buildResearchReferenceList(
  result: ResearchRunResult,
  workingDirectory?: string,
): string[] {
  const artifactDirectory = result.artifactDirectory
  const references = [
    ['Run metadata', path.join(artifactDirectory, 'run.json')],
    ['Research plan', path.join(artifactDirectory, 'plan.json')],
    ['Final report markdown', path.join(artifactDirectory, 'final', 'report.md')],
    ['Final report JSON', path.join(artifactDirectory, 'final', 'report.json')],
    ['Source index', path.join(artifactDirectory, 'sources', 'index.json')],
    ['Evidence card index', path.join(artifactDirectory, 'evidence-cards', 'index.json')],
    ...result.plan.topics.map((topic) => [
      `Dossier for ${topic.title}`,
      path.join(artifactDirectory, 'dossiers', `${topic.id}.json`),
    ] as const),
  ] as const

  return references.map(([label, referencePath]) =>
    `- ${label}: ${formatResearchReferencePath(referencePath, workingDirectory)}`,
  )
}

function buildResearchSourcePreviewList(
  result: ResearchRunResult,
  workingDirectory?: string,
): string[] {
  const sources = result.sources.slice(0, FOLLOW_UP_SOURCE_PREVIEW_LIMIT)
  return sources.map((source) => {
    const title = source.title?.trim() || source.resolvedUrl
    const sourcePath = path.join(result.artifactDirectory, 'sources', `${source.id}.json`)
    return [
      `- ${source.id}: ${title}`,
      source.resolvedUrl,
      `file: ${formatResearchReferencePath(sourcePath, workingDirectory)}`,
    ].join(' | ')
  })
}

export function buildResearchFollowUpContextText(input: {
  promptText: string
  result: ResearchRunResult
  workingDirectory?: string
}): string {
  const { promptText, result, workingDirectory } = input
  const referenceLines = buildResearchReferenceList(result, workingDirectory)
  const sourcePreviewLines = buildResearchSourcePreviewList(result, workingDirectory)
  const artifactDirectory = formatResearchReferencePath(
    result.artifactDirectory,
    workingDirectory,
  )
  const sourcePattern = formatResearchReferencePath(
    path.join(result.artifactDirectory, 'sources', '<source-id>.json'),
    workingDirectory,
  )
  const warningLines =
    result.warnings && result.warnings.length > 0
      ? [
          'Research warnings:',
          ...result.warnings.map((warning) => `- ${warning}`),
        ]
      : []
  const sourcePreviewTail =
    result.sources.length > FOLLOW_UP_SOURCE_PREVIEW_LIMIT
      ? [`- ${result.sources.length - FOLLOW_UP_SOURCE_PREVIEW_LIMIT} more source record(s) are listed in the source index.`]
      : []

  return [
    'Deep research follow-up context',
    '',
    'This session has already completed a deep research report and is now a normal Explore conversation. Answer follow-up questions from the report and referenced artifacts. When the user asks for details, evidence, citations, contradictions, or anything beyond the summary, inspect the referenced files before answering.',
    '',
    'If the user asks to run another deep research report, tell them to start a new run from the Research panel.',
    '',
    `Original research prompt:\n${promptText.trim()}`,
    '',
    `Artifact directory: ${artifactDirectory}`,
    `Source record pattern: ${sourcePattern}`,
    '',
    'Reference files:',
    ...referenceLines,
    '',
    'Source previews:',
    ...(sourcePreviewLines.length > 0
      ? [...sourcePreviewLines, ...sourcePreviewTail]
      : ['- No source records were collected.']),
    '',
    ...warningLines,
    warningLines.length > 0 ? '' : undefined,
    `Report summary:\n${result.summary.trim()}`,
    '',
    `Final report shown to the user:\n${result.finalReport.trim()}`,
  ].filter((line): line is string => typeof line === 'string').join('\n')
}
