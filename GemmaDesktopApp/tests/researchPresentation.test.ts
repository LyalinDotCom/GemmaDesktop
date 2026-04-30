import { describe, expect, it } from 'vitest'
import {
  buildResearchAssistantMessage,
  buildResearchLiveActivity,
  buildResearchPanelContent,
  buildResearchPanelViewModel,
} from '../src/main/researchPresentation'
import type {
  ResearchPanelProgressBlock,
  ResearchPanelViewModel,
} from '../src/main/toolProgress'
import type {
  ResearchRunResult,
  ResearchRunStatus,
} from '@gemma-desktop/sdk-node'

function buildStatus(
  overrides: Partial<ResearchRunStatus> = {},
): ResearchRunStatus {
  const startedAt = new Date(1_000).toISOString()
  return {
    runId: 'run-1',
    parentSessionId: 'session-1',
    runtimeId: 'ollama-native',
    modelId: 'gemma4:26b',
    profile: 'deep',
    status: 'running',
    stage: 'planning',
    artifactDirectory: '/tmp/research-artifacts',
    startedAt,
    stages: {
      planning: {
        status: 'running',
        startedAt,
        worker: {
          kind: 'planning',
          label: 'Research coordinator',
          goal: 'Plan the topic breakdown for this research run.',
          assistantDeltaCount: 0,
          reasoningDeltaCount: 0,
          lifecycleCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          timeline: [],
        },
      },
      discovery: {
        status: 'pending',
      },
      depth: {
        status: 'pending',
      },
      workers: {
        status: 'pending',
      },
      synthesis: {
        status: 'pending',
      },
    },
    topicStatuses: [],
    ...overrides,
  }
}

function firstPanel(blocks: Array<Record<string, unknown>>): ResearchPanelViewModel {
  expect(blocks).toHaveLength(1)
  const block = blocks[0] as unknown as ResearchPanelProgressBlock
  expect(block.type).toBe('research_panel')
  return block.panel
}

describe('research presentation', () => {
  it('emits an initial research_panel block before the run reports status', () => {
    const panel = firstPanel(
      buildResearchPanelContent(undefined, { promptText: '  What is DeepMind up to?  ' }),
    )

    expect(panel.title).toBe('What is DeepMind up to?')
    expect(panel.plan.status).toBe('running')
    expect(panel.plan.label).toBe('Creating research plan…')
    expect(panel.sources.status).toBe('pending')
    expect(panel.sources.topDomains).toEqual([])
    expect(panel.topics).toEqual([])
    expect(panel.synthesis.status).toBe('pending')
    expect(panel.liveHint).toBe('Designing the research plan')
  })

  it('projects coverage + topic status into a step-oriented view model', () => {
    const status = buildStatus({
      stage: 'workers',
      stages: {
        planning: {
          status: 'completed',
          startedAt: new Date(1_000).toISOString(),
          completedAt: new Date(2_000).toISOString(),
        },
        discovery: {
          status: 'completed',
          startedAt: new Date(2_000).toISOString(),
          completedAt: new Date(3_000).toISOString(),
        },
        depth: {
          status: 'completed',
          startedAt: new Date(3_000).toISOString(),
          completedAt: new Date(3_500).toISOString(),
        },
        workers: {
          status: 'running',
          startedAt: new Date(3_000).toISOString(),
        },
        synthesis: {
          status: 'pending',
        },
      },
      coverage: {
        targetSources: 30,
        sourcesGathered: 24,
        targetDomains: 10,
        distinctDomains: 5,
        families: [
          { id: 'official', label: 'Official', required: true, sourceCount: 6, covered: true },
        ],
        topDomains: [
          { domain: 'deepmind.google', count: 12 },
          { domain: 'blog.google', count: 6 },
          { domain: 'techcrunch.com', count: 3 },
          { domain: 'wikipedia.org', count: 2 },
          { domain: 'arxiv.org', count: 1 },
        ],
      },
      topicStatuses: [
        {
          topicId: 'topic-1',
          title: 'Gemma 4 release',
          goal: 'Explain what Gemma 4 brings.',
          status: 'completed',
          summary: 'Gemma 4 ships under Apache 2.0.',
          searchCount: 3,
          fetchCount: 5,
          sourceCount: 8,
        },
        {
          topicId: 'topic-2',
          title: 'Gemini 3 roadmap',
          goal: 'Trace Gemini 3 family updates.',
          status: 'running',
          searchCount: 2,
          fetchCount: 4,
          sourceCount: 6,
        },
      ],
      passCount: 2,
      currentPass: 2,
    })

    const panel = firstPanel(
      buildResearchPanelContent(status, {
        promptText: 'DeepMind March-April 2026',
        now: Date.parse(status.startedAt) + 45_000,
      }),
    )

    expect(panel.title).toBe('DeepMind March-April 2026')
    expect(panel.plan.status).toBe('completed')
    expect(panel.sources.status).toBe('running')
    expect(panel.sources.totalSources).toBe(24)
    expect(panel.sources.distinctDomains).toBe(5)
    expect(panel.sources.topDomains.slice(0, 2)).toEqual([
      { domain: 'deepmind.google', count: 12 },
      { domain: 'blog.google', count: 6 },
    ])
    expect(panel.sources.otherDomainCount).toBe(0) // 5 domains fit under the top limit
    expect(panel.depth.status).toBe('completed')
    expect(panel.topics).toHaveLength(2)
    expect(panel.topics[0]).toMatchObject({
      id: 'topic-1',
      status: 'completed',
      label: 'Done investigating: Gemma 4 release',
      sourceCount: 8,
    })
    expect(panel.topics[1]).toMatchObject({
      status: 'running',
      label: 'Researching Gemini 3 roadmap',
    })
    expect(panel.synthesis.status).toBe('pending')
    expect(panel.liveHint).toBe('Topic workers are reading sources')
    expect(panel.elapsedLabel).toBe('45s')
  })

  it('rolls extra domains into an "other domains" summary and surfaces live hints', () => {
    const status = buildStatus({
      stage: 'discovery',
      stages: {
        planning: {
          status: 'completed',
        },
        discovery: {
          status: 'running',
        },
        depth: { status: 'pending' },
        workers: { status: 'pending' },
        synthesis: { status: 'pending' },
      },
      coverage: {
        targetSources: 50,
        sourcesGathered: 30,
        targetDomains: 15,
        distinctDomains: 10,
        families: [],
        topDomains: [
          { domain: 'deepmind.google', count: 8 },
          { domain: 'blog.google', count: 6 },
          { domain: 'techcrunch.com', count: 5 },
          { domain: 'wired.com', count: 4 },
          { domain: 'theverge.com', count: 3 },
          { domain: 'arstechnica.com', count: 2 },
          { domain: 'wikipedia.org', count: 1 },
          { domain: 'arxiv.org', count: 1 },
        ],
      },
      activities: [
        {
          phase: 'topic',
          attempt: 1,
          topicId: 'topic-1',
          topicTitle: 'Gemma 4',
          startedAt: new Date(1_000).toISOString(),
          lastEventAt: new Date(2_000).toISOString(),
          label: 'Topic worker',
          assistantDeltaCount: 3,
          reasoningDeltaCount: 0,
          lifecycleCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          timeline: [],
        },
      ],
    })

    const panel = firstPanel(
      buildResearchPanelContent(status, { now: Date.parse(status.startedAt) + 5_000 }),
    )

    expect(panel.sources.topDomains).toHaveLength(6)
    expect(panel.sources.otherDomainCount).toBe(2)
    expect(panel.sources.otherDomainSourceCount).toBe(2) // 1 + 1 in the tail
    expect(panel.sources.label).toContain('Gathering 30 sources')
    expect(panel.liveHint).toBe('Writing up Gemma 4')
  })

  it('produces a research live activity snapshot for the header indicator', () => {
    const status = buildStatus({
      stage: 'workers',
      stages: {
        planning: { status: 'completed' },
        discovery: { status: 'completed' },
        depth: { status: 'completed' },
        workers: {
          status: 'running',
          startedAt: new Date(3_000).toISOString(),
        },
        synthesis: { status: 'pending' },
      },
      activities: [
        {
          phase: 'topic',
          attempt: 1,
          topicId: 'topic-1',
          topicTitle: 'NASA Mission Status',
          startedAt: new Date(4_000).toISOString(),
          lastEventAt: new Date(5_000).toISOString(),
          label: 'Topic worker',
          assistantDeltaCount: 0,
          reasoningDeltaCount: 0,
          lifecycleCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          timeline: [],
        },
      ],
    })

    expect(buildResearchLiveActivity(status)).toMatchObject({
      source: 'research',
      stage: 'workers',
      topicTitle: 'NASA Mission Status',
    })
  })

  it('flags a stalled run via liveHint', () => {
    const status = buildStatus({
      activities: [
        {
          phase: 'topic',
          attempt: 1,
          topicId: 'topic-1',
          topicTitle: 'Stalled topic',
          startedAt: new Date(4_000).toISOString(),
          lastEventAt: new Date(5_000).toISOString(),
          label: 'Topic worker',
          assistantDeltaCount: 0,
          reasoningDeltaCount: 0,
          lifecycleCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          timeline: [],
        },
      ],
    })

    const panel = buildResearchPanelViewModel(status, { now: 51_000 })
    expect(panel.liveHint).toMatch(/No new activity/)
  })

  it('shows the source-depth stage as its own research step', () => {
    const status = buildStatus({
      stage: 'depth',
      stages: {
        planning: { status: 'completed' },
        discovery: { status: 'completed' },
        depth: {
          status: 'running',
          startedAt: new Date(3_000).toISOString(),
          worker: {
            kind: 'depth',
            label: 'Source-depth scout',
            goal: 'Select second-level source pages.',
            assistantDeltaCount: 0,
            reasoningDeltaCount: 4,
            lifecycleCount: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            timeline: [],
            currentAction: 'Selecting source-depth targets',
          },
        },
        workers: { status: 'pending' },
        synthesis: { status: 'pending' },
      },
      activities: [
        {
          phase: 'depth',
          attempt: 1,
          startedAt: new Date(3_000).toISOString(),
          lastEventAt: new Date(4_000).toISOString(),
          label: 'Source-depth scout',
          currentAction: 'Selecting source-depth targets',
          assistantDeltaCount: 0,
          reasoningDeltaCount: 4,
          lifecycleCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          timeline: [],
        },
      ],
    })

    const panel = buildResearchPanelViewModel(status, { now: 5_000 })
    expect(panel.depth).toMatchObject({
      status: 'running',
      label: 'Selecting second-level source pages…',
    })
    expect(panel.liveHint).toBe('Selecting source-depth targets')
    expect(buildResearchLiveActivity(status)).toMatchObject({
      source: 'research',
      stage: 'depth',
      state: 'thinking',
    })
  })

  it('normalizes cancelled runs so unfinished steps stop looking active', () => {
    const status = buildStatus({
      status: 'cancelled',
      stage: 'cancelled',
      completedAt: new Date(11_000).toISOString(),
      stages: {
        planning: {
          status: 'completed',
          startedAt: new Date(1_000).toISOString(),
          completedAt: new Date(2_000).toISOString(),
        },
        discovery: {
          status: 'completed',
          startedAt: new Date(2_000).toISOString(),
          completedAt: new Date(3_000).toISOString(),
        },
        depth: {
          status: 'completed',
          startedAt: new Date(3_000).toISOString(),
          completedAt: new Date(3_500).toISOString(),
        },
        workers: {
          status: 'running',
          startedAt: new Date(4_000).toISOString(),
        },
        synthesis: {
          status: 'running',
          startedAt: new Date(9_000).toISOString(),
        },
      },
      coverage: {
        targetSources: 20,
        sourcesGathered: 12,
        targetDomains: 8,
        distinctDomains: 3,
        families: [],
        topDomains: [
          { domain: 'deepmind.google', count: 5 },
          { domain: 'blog.google', count: 4 },
          { domain: 'arxiv.org', count: 3 },
        ],
      },
      topicStatuses: [
        {
          topicId: 'topic-1',
          title: 'Gemma 4 release',
          status: 'completed',
          sourceCount: 8,
        },
        {
          topicId: 'topic-2',
          title: 'Gemini 3 roadmap',
          status: 'running',
          sourceCount: 4,
        },
      ],
    })

    const panel = buildResearchPanelViewModel(status)

    expect(panel.runStatus).toBe('cancelled')
    expect(panel.plan.status).toBe('completed')
    expect(panel.sources.status).toBe('completed')
    expect(panel.topics[1]).toMatchObject({
      status: 'cancelled',
      label: 'Cancelled: Gemini 3 roadmap',
    })
    expect(panel.synthesis.status).toBe('cancelled')
    expect(panel.synthesis.label).toBe('Synthesis cancelled')
    expect(panel.liveHint).toBeUndefined()
    expect(panel.elapsedLabel).toBe('10s')
  })

  it('builds a final assistant message with the report body and artifact link', () => {
    const result = {
      runId: 'run-1',
      profile: 'deep',
      artifactDirectory: '/tmp/research-artifacts',
      plan: {
        objective: 'Research Artemis mission coverage.',
        topics: [
          {
            id: 'official-artemis-updates-1',
            title: 'Official Artemis Updates',
            goal: 'Track official mission updates.',
            priority: 1,
            searchQueries: ['Artemis mission official updates'],
          },
        ],
        risks: [],
        stopConditions: [],
      },
      sources: [
        {
          id: 'source-1',
          requestedUrl: 'https://www.nasa.gov/artemis/',
          resolvedUrl: 'https://www.nasa.gov/artemis/',
          kind: 'webpage',
          extractedWith: 'fetch',
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ['official-artemis-updates-1'],
          contentPreview: 'NASA Artemis update preview.',
        },
      ],
      dossiers: [],
      finalReport: '# Report\n\nArtemis remains on track.',
      summary: 'NASA says the mission remains on track.',
      sourceIds: ['source-1'],
      confidence: 0.82,
      completedAt: new Date().toISOString(),
    } satisfies ResearchRunResult

    const message = buildResearchAssistantMessage(result, 42_000)

    expect(message.id).toBe('research-run-1')
    expect(message.durationMs).toBe(42_000)
    expect(message.content[0]).toMatchObject({ type: 'text' })
    expect((message.content[0] as { text: string }).text).toContain(
      'Deep research completed across 1 topic and 1 source.',
    )
    expect(message.content[1]).toEqual({
      type: 'folder_link',
      path: '/tmp/research-artifacts',
      label: 'Open research artifacts',
    })
  })
})
