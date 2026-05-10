import { describe, expect, it } from 'vitest'
import {
  buildLiveActivityMetrics,
  buildLiveActivityPresentation,
  deriveLiveActivityLabel,
} from '../../src/renderer/src/lib/liveActivityPresentation'
import type { LiveActivitySnapshot } from '../../src/renderer/src/types'

function makeActivity(
  overrides: Partial<LiveActivitySnapshot> = {},
): LiveActivitySnapshot {
  return {
    source: 'session',
    state: 'working',
    startedAt: 1_000,
    assistantUpdates: 0,
    reasoningUpdates: 0,
    lifecycleEvents: 0,
    runningToolCount: 0,
    completedToolCount: 0,
    recentProgressCount: 0,
    ...overrides,
  }
}

describe('live activity presentation', () => {
  it('never renders Quiet while an active tool is running', () => {
    const label = deriveLiveActivityLabel(makeActivity({
      lastEventAt: 50_000,
      activeToolName: 'edit_file',
      activeToolLabel: 'Updating files',
      runningToolCount: 1,
    }), 100_000)

    expect(label).toBe('Still working')
    expect(label).not.toBe('Quiet')
  })

  it('renders stale active runs as Still working', () => {
    const presentation = buildLiveActivityPresentation(makeActivity({
      lastEventAt: 20_000,
      runningToolCount: 1,
      activeToolName: 'web_research_agent',
      activeToolLabel: 'Running web research agent',
    }), 70_000)

    expect(presentation.label).toBe('Still working')
    expect(presentation.note).toContain('still active')
  })

  it('prefers tool-specific labels over generic working labels', () => {
    const label = deriveLiveActivityLabel(makeActivity({
      lastEventAt: 5_000,
      activeToolName: 'web_research_agent',
      activeToolLabel: 'Running web research agent',
      runningToolCount: 1,
    }), 10_000)

    expect(label).toBe('Running web research agent')
  })

  it('renders delegated worker actions ahead of generic working labels', () => {
    const label = deriveLiveActivityLabel(makeActivity({
      lastEventAt: 5_000,
      activeToolName: 'web_research_agent',
      activeToolLabel: 'Fetching sources',
      runningToolCount: 1,
    }), 10_000)

    expect(label).toBe('Fetching sources')
  })

  it('uses grounded tool context for detail text and hover notes', () => {
    const presentation = buildLiveActivityPresentation(makeActivity({
      lastEventAt: 5_000,
      activeToolName: 'search_text',
      activeToolLabel: 'Inspecting project',
      activeToolContext: 'thinkingSummary.generate',
      runningToolCount: 1,
    }), 10_000)

    expect(presentation.label).toBe('Inspecting project')
    expect(presentation.detail).toBe('thinkingSummary.generate')
    expect(presentation.note).toBe('Inspecting project: thinkingSummary.generate')
    expect(presentation.metrics).toEqual(
      expect.arrayContaining([
        { label: 'Context', value: 'thinkingSummary.generate' },
      ]),
    )
  })

  it('includes chunk counts, first token timing, and tool progress fields in the hover metrics', () => {
    const activity = makeActivity({
      state: 'streaming',
      lastEventAt: 7_000,
      firstTokenAt: 4_000,
      assistantUpdates: 12,
      reasoningUpdates: 5,
      activeToolName: 'web_research_agent',
      activeToolLabel: 'Running web research agent',
      runningToolCount: 1,
      completedToolCount: 2,
      recentProgressCount: 7,
      lastProgressAt: 8_000,
    })
    const metrics = buildLiveActivityMetrics(activity, 10_000, 'Streaming reply')

    expect(metrics).toEqual(
      expect.arrayContaining([
        { label: 'First token', value: '3s' },
        { label: 'Assistant updates', value: '12 chunks' },
        { label: 'Reasoning updates', value: '5 chunks' },
        {
          label: 'Active tool',
          value: 'Running web research agent (web_research_agent)',
        },
        { label: 'Running tools', value: '1 tool' },
        { label: 'Completed tools', value: '2 tools' },
        { label: 'Progress events', value: '7 events' },
        { label: 'Last progress', value: '2s ago' },
      ]),
    )
  })
})
