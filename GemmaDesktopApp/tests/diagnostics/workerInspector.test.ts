import { describe, expect, it } from 'vitest'
import {
  buildToolBlockCollapsedSummary,
  buildWorkerMetricItems,
  buildWorkerResultSections,
  buildWorkerTechnicalDetails,
  deriveToolBlockAutoExpansion,
} from '../../src/renderer/src/lib/workerInspector'

describe('worker inspector helpers', () => {
  it('prefers the live worker action in collapsed summaries', () => {
    const summary = buildToolBlockCollapsedSummary({
      worker: {
        kind: 'web_research_agent',
        label: 'Web research agent',
        currentAction: 'Fetching sources',
      },
      progressEntries: [
        {
          id: 'progress',
          label: 'Searching web',
          timestamp: 1_000,
        },
      ],
      summary: 'Check release notes',
      input: {
        goal: 'Check release notes',
      },
    })

    expect(summary).toBe('Fetching sources')
  })

  it('derives automatic expansion changes for active worker cards', () => {
    expect(deriveToolBlockAutoExpansion({
      expanded: false,
      fullHeight: false,
      isActive: true,
      autoExpandWhenActive: true,
      userToggled: false,
    })).toEqual({
      expanded: true,
      fullHeight: false,
    })

    expect(deriveToolBlockAutoExpansion({
      expanded: true,
      fullHeight: true,
      isActive: false,
      autoExpandWhenActive: true,
      userToggled: false,
    })).toEqual({
      expanded: false,
      fullHeight: false,
    })

    expect(deriveToolBlockAutoExpansion({
      expanded: false,
      fullHeight: false,
      isActive: true,
      autoExpandWhenActive: true,
      userToggled: true,
    })).toBeNull()
  })

  it('builds worker metrics and result sections from structured worker data', () => {
    const metrics = buildWorkerMetricItems({
      kind: 'workspace_editor_agent',
      label: 'Workspace editor agent',
      counters: {
        filesChanged: 2,
        toolCalls: 3,
        assistantUpdates: 4,
      },
    })
    const sections = buildWorkerResultSections({
      kind: 'workspace_command_agent',
      label: 'Workspace command agent',
      resultData: {
        filesChanged: ['src/components/ToolCallBlock.tsx'],
        commands: [
          {
            command: 'npm test -- workerInspector',
            cwd: 'GemmaDesktopApp',
          },
        ],
      },
    })

    expect(metrics).toEqual([
      { label: 'Files', value: '2' },
      { label: 'Tool calls', value: '3' },
      { label: 'Assistant', value: '4' },
    ])
    expect(sections).toEqual([
      {
        label: 'Files changed',
        values: ['src/components/ToolCallBlock.tsx'],
      },
      {
        label: 'Commands',
        values: ['npm test -- workerInspector (GemmaDesktopApp)'],
      },
    ])
  })

  it('exposes child ids for the technical disclosure', () => {
    expect(buildWorkerTechnicalDetails({
      kind: 'web_research_agent',
      label: 'Web research agent',
      childSessionId: 'session_child',
      childTurnId: 'turn_child',
    })).toEqual([
      { label: 'Child session', value: 'session_child' },
      { label: 'Child turn', value: 'turn_child' },
    ])
  })
})
